# Terrain subsystem — porting spec (Babylon.js/WebGPU/WGSL → Three.js/WebGL2/GLSL ES 3.0)

Source files:

- `src/terrain/terrain.js` — orchestrator: owns heightfield, deformation, clipmap mesh, snow/beauty material, shadow-depth materials, prepass material, detail texture.
- `src/terrain/heightfield.js` — baked macro heightfield (GPU bake + CPU readback mirror).
- `src/terrain/deformation.js` — persistent snow deformation sim (ping-pong RT + brush queue).
- `src/terrain/clipmapMesh.js` — static nested-ring clipmap geometry.
- Shaders (`src/shaders/`): `snow.vertex.wgsl`, `snow.fragment.wgsl`, `terrainDepth.vertex.wgsl`, `terrainDepth.fragment.wgsl`, `terrainPrepass.vertex.wgsl` (+ shared `prepass.fragment.wgsl`), `deformSim.fragment.wgsl`, `heightBake.fragment.wgsl`, `auxBake.fragment.wgsl`, `detailBake.fragment.wgsl`, `lib/clipmap.wgsl`, `lib/deform.wgsl`, `lib/terrain.wgsl`, `lib/noise.wgsl`, `lib/ridge.wgsl`.

Note: `lib/ridge.wgsl` (`snowRidge` include) is authored alongside the terrain noise stack but is **only included by `sky.fragment.wgsl`** (far-field raymarched mountains on the skybox). It is documented here (section 4) because it shares `lib/noise.wgsl`; the sky subsystem port must import it from the same shared source.

---

## 1. Purpose & behavior

The terrain subsystem renders an "infinite" wind-carved snow field and maintains the *terrain state buffer* — the persistent, additive record of everything that deforms the snow (footprints, the surf wake groove, spell craters, walker feet).

### 1.1 The landform (three frequency bands)

1. **Macro** (tens of metres → ~1 m): broad dunes + swell + medium drifts + sparse rock outcrops. Baked **once at load** into `heightTex` (R32F-class, 4096², covering a 2048 m × 2048 m world → 0.5 m/texel) by `heightBake.fragment.wgsl` evaluating `terrainMacro()` + `rockField()` from `lib/terrain.wgsl` / `lib/noise.wgsl`. Baked (not evaluated live) so the **CPU can read back the exact same data** for character grounding — re-implementing the noise in JS would drift by centimetres (f32 GPU vs f64 JS).
2. **Fine** (~2 m → ~10 cm): sastrugi ridges (~2.3 m wavelength, ±12 cm, ridged noise stretched along a locally-veering wind) and wind ripples (~0.42 m) and grain (~0.115 m). Evaluated **live, analytically, with exact derivatives** in both vertex shaders (height only, gated by ring spacing < 0.42 m) and the fragment shader (`terrainFineFiltered`, height+gradient, each layer faded by pixel footprint to prevent normal-map aliasing/moiré).
3. **Detail** (~10 cm → 5 mm): a generated, exactly-tiling 1024² RGBA8 grain map (`detailBake.fragment.wgsl`), sampled at three world scales (7.5, 1.7, 0.31 cycles/m) as tangent-space normals blended with reoriented normal mapping (RNM), plus a cavity channel.

Normal composition rule (critical): macro, fine and deform contributions are all **heightfield gradients** (dH/dx, dH/dz) summed *as slopes* first, then turned into one normal via `normalFromGradient` (i.e. `normalize(vec3(-gx, 1, -gz))`, lives in `lib/shading.wgsl`); only the detail map is a tangent-space normal folded in last.

### 1.2 Clipmap geometry

One static mesh, one draw call, built once (`buildClipmapMesh`): 8 rings (`LEVELS = 8`), each a (160+1)² vertex lattice (`GRID_N = 160`), innermost spacing `BASE_SPACING = 0.085` m, spacing doubling per ring. Level 0 is a solid square; levels 1..7 are annuli whose holes are cut `HOLE_SHRINK = 3` cells smaller than the ring inside them (overlap prevents cracks). Vertices carry **no real position** — attribute `position = (gridI, ringLevel, gridJ)` with gridI/gridJ ∈ [-80, 80]. Index buffer is Uint32, quad diagonals alternate per `(i+j)&1` to avoid corduroy shading. Derived constants: `GRID_HALF_N = 80`, `INNER_EXTENT = 6.8` m, `OUTER_EXTENT = 870.4` m.

Per frame the vertex shader (`placeClipmapVertex` in `lib/clipmap.wgsl`) turns the grid index into a world position:
- `spacing = baseSpacing * exp2(level)`; ring origin snaps to `2 × spacing` grid of the **lodCenter** (parity-stable snapping — snapping to 1× would let morph targets flip and shimmer).
- CDLOD morph: Chebyshev distance from ring centre, normalised by the ring extent; morph `clamp((cheb - 0.70)/0.16, 0, 1)` moves each vertex onto the next-coarser lattice (`floor(grid*0.5)*2`), completing at 0.86 before the overlap band. Post-morph effective spacing = `spacing * (1 + morph)` — this continuous value drives every band-limiting decision downstream.
- **lodCenter is the *player/character*, not the camera** (uniform `lodCenter` set from `focus` = `character.position`); this is what keeps carved trails geometrically stable while the camera orbits.

Height applied per vertex = bicubic B-spline sample of `heightTex` (four-bilinear-tap trick, `sampleHeightBicubic`) + fine layer (only where `cv.spacing < 0.42`, fade `1 - smoothstep(0.16, 0.42, spacing)`) + deformation displacement (only where `cv.spacing < 1.0`, fade `1 - smoothstep(0.5, 1.0, spacing)`, band-limited via a separable 3×3 binomial with taps `spacing` apart — see `deformHeight`).

**All three vertex shaders (beauty, shadow depth, camera prepass) must produce bit-identical world positions** — same includes, same gates, same fades — or the terrain shadow-acnes/AO-haloes against itself. This is the single most important invariant in the subsystem.

### 1.3 Deformation (the terrain state buffer)

Two RGBA16F 2048² render targets (`S.deformResolution`, min 512) ping-ponged by **one full-screen pass per frame** (`deformSim.fragment.wgsl`). The window covers `COVERAGE = 80` m of world (3.9 cm texels), centred on the player, **snapped to texel boundaries** each frame, addressed **toroidally**: `uv = fract(worldXZ / size)` — the buffer is never scrolled or copied; moving the window only re-interprets which world position each texel means. Samplers must be REPEAT + bilinear.

Channels (all metres or 0..1):
- **R** depression depth (positive = pushed down)
- **G** displaced mass / berm (positive = piled up)
- **B** compression 0..1
- **A** ice 0..1

The pass does, in order:
1. **scroll**: recover world position of the texel (`texelWorld`: nearest wrap-branch to the window centre); if it was outside *last* frame's window, output zeros (fresh texel).
2. **relax** (only when `dt > 0`, see banking below): five-point Laplacian diffusion (berm rate 3× depression: `kDep = min(0.22, 0.004·k)`, `kBerm = min(0.22, 0.012·k)`, `k = clamp(refillRate·dt, 0, 1)`), asymmetric wind infill (pull from upwind neighbour at `uv - wdir·1.6·texel`, `wdir = (sin windAngle, cos windAngle)`, `kAdv = min(0.2, 0.002·k)`, dep at 0.6× of berm), mass-conserving slump (`min(berm, dep) · min(0.6, 0.002·refillRate·dt)` off both), exponential decay with time constants (seconds at refillRate=1): dep 400, berm 250, comp 300, ice 900.
3. **splat**: loop over `i32(brushCount)` brushes read from `brushTex` with `textureLoad` (3 rows × 96 columns, RGBA32F, nearest, clamp). Per brush: toroidal offset wrap, cheap AABB reject (`reach = radius · max(elongation,1) · 1.6`), rotate by yaw + squash long axis, reject `d > 1.55`, angular rim wobble (`1 + edge·0.22·noise2(...)`), depression profile `core = 1 - smoothstep(0.42, 1.0, dn)` (flat floor + fast shoulder, deliberately not Gaussian), berm ring `exp(-((dn-1.04)·3.4)²)` × granular noise, `comp += c.x·core`, `ice = max(ice, c.y·core)`.
4. **clamp**: dep to `[0, maxDepth]` (= `0.55·S.deformDepth`), berm to `[0, maxBerm]` (= `0.34·S.deformBerm`), comp/ice to [0,1].

**Relaxation time banking** (must be preserved): at frame cadence the decay change is far below one half-float ULP and rounds to a much faster ~10 s half-life. The CPU banks elapsed time (`_relaxOwed`) and only passes `dt > 0` once ≥ `RELAX_STEP = 0.4` s has accumulated; otherwise `dt = 0` (every relax term is an exact no-op at dt=0).

**Brush API**: `deform.brush(x, z, radius, depth, berm, compression, ice, yaw?, elongation?, edge?)` — world metres; up to `MAX_BRUSHES = 96` per frame; culled if outside window + 2·radius; staged into a `Float32Array(96·3·4)`; row layout (stride = 96·4 floats per row):
- row 0: `(worldX, worldZ, radius, elongation)`
- row 1: `(cos yaw, sin yaw, depth, berm)`
- row 2: `(compression, ice, edgeRoughness, seed = (x·0.37+z·0.71) % 100)`
Uploaded once per frame if dirty; the tail's radii are zeroed as a safety net (shader skips radius ≤ 0).

**Warm-up clear**: both targets start as uninitialised VRAM. Two passes with `prevCenter` set 1e6 m away make every texel take the "just scrolled in → write zero" path, clearing via the normal code path. Must run before the snow material first binds `deformTex` (NaN heights otherwise).

Read side (`lib/deform.wgsl`, shared by 3+ consumers):
- `deformUV(worldXZ, size) = fract(worldXZ / size)`
- `deformFalloff(worldXZ, centre, size) = 1 - smoothstep(0.80, 0.96, max-axis distance / half-size)` — fades authority before the toroidal seam becomes visible.
- `deformHeight(...)` = falloff-gated separable 3×3 binomial ([1,2,1]²/16) over `(G - R)` with tap offset `spacing/size` in UV, × `deformDepthScale` × falloff. The filter's first zero lands exactly at the lattice Nyquist so a ring boundary sweeping over a trail cannot facet it.

### 1.4 Fragment shading (snow.fragment.wgsl)

Full custom PBR-ish snow pipeline; per pixel:
- pixel footprint: `ddxW/ddyW = dpdx/dpdy(world)`; `footprint` = length of the two XZ tangent lengths (average axis), `footprintMin` = the *narrow* axis (used for deform gradient width so trails do not fade with view obliquity).
- macro gradient from `auxTex` (RG = dH/dx, dH/dz m/m; B = rock mask; A = exposure), plus `terrainFineFiltered` gradient, plus deformation gradient (central difference over `(G−R)` with step `max(deformTexel·2, footprintMin·1.4)` — a footprint-widening baseline instead of a distance fade; also blends the 4 neighbour fetches into the state channels when the pixel is wider than a texel: `wide = clamp(footprintMin/(deformTexel·4),0,1)·0.8`).
- `geoN` = normal *before* detail maps (matches what the depth passes rendered; used for shadow biasing).
- detail normals: 3 scales (7.5 / 1.7 / 0.31), footprint-faded (smoothstep bands 0.004–0.02, 0.02–0.12, 0.1–0.7; weights 1.0 / 0.85 / 0.6), triplanar on steep slopes (`steep = smoothstep(0.55, 0.9, 1−N.y)`), accumulated with `blendNormalRNM`, applied via an ad-hoc T/B frame scaled by `detailStrength · mix(1, 0.45, compression)`. All detail fetches use **explicit gradients** (`textureSampleGrad`) because they sit behind footprint branches.
- material: base albedo `(0.855, 0.885, 0.945)`, roughness 0.62, f0 0.028, thickness 1; modified by compression (darker/tighter/denser), ice (`(0.42,0.56,0.70)`, rough 0.07, f0 0.045), rock (slope-gated mask, dark rock colour, rough 0.85), loose berm snow (brighter and *slightly bluer* than base — carved snow must never get less blue; chunk noise at 34 cycles/m).
- lighting: wrapped diffuse (`wrapDiffuse`, wrap 0.62 → 0.15 with compression/rock), subsurface (`snowSubsurface`, only partly shadowed: `mix(0.42, 1.0, shadow)`), GGX specular (D · SmithGGXCorrelated · Schlick), SH sky irradiance (9 × vec4 `shR`) + upward bounce term (0.28 · albedo), sky-reflection specular from `skyLUT` at `mip = sqrt(roughness)·6` (lat-long mapping via `dirToLatLong`), ×2.6 on ice.
- shadows: 3-cascade PCSS via shared `lib/shadowLookup.wgsl` include (`sunShadow(world, geoN, viewDist, noiseRot)`); per-pixel rotation from interleaved gradient noise `ign(pixel)·2π`. Skipped when `NdotL ≤ −0.35`.
- spell lights: shared 4-slot pool (`spellLighting` from `lib/spellLights.wgsl`), gated on `spellLightCount > 0.5`.
- glints (`snowGlints` from shading lib), added as radiance, gated on intensity and not-rock.
- AO: analytic only (cavity + `deformDepth`), applied **to the finished radiance** (not just ambient) with a blue cave tint `mix(white, (0.55,0.72,1.0), (1−ao)·0.95)` — deliberate hue-preserving darkening.
- aerial perspective `applyAerial(...)` from `lib/atmosphere.wgsl`.
- 11 debug views keyed off float `debugMode` (map in `terrain.js`: beauty 0, deform 1, normals 2, depth 3, cascades 4, footprint 5, fineNormals 6, shadow 7, ndotl 8, shadowMap 9, albedo 10).

Output: linear HDR radiance into the scene colour target (post chain does exposure/AgX). Alpha 1.

### 1.5 Frame sequence (from `main.js` run loop)

Order matters:
1. `character.update` → `contact.update` (queues foot brushes) → walkers/speeder (queue their brushes)
2. `rig.update`, `post.update` (TAA jitter published), `sky.update/render`, `shadows.update` (refit cascades)
3. `spells.update` (queues spell brushes — **before** terrain so this frame's brushes are staged)
4. `terrain.update(cameraPos, character.position, dt)` — runs the deform sim **then** rebinds the freshly-written target on all four materials, then pushes all uniforms (beauty + prepass + 3 depth materials)
5. `scene.render()` — renders: cascade RTTs (terrain drawn with per-cascade depth materials), depth prepass RTT (terrain drawn with prepass material), then beauty.

Boot: `new Terrain(scene, sky, shadows)` → `terrain.build()` (detail bake, height bake, aux bake, CPU readback, `shadows.setHeightBounds(min−4, max+6)`) → `depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial())` → `terrain.warmUp()` (deform warm-up first, then compile all materials) → one priming `terrain.update(...)`.

---

## 2. Public API

### `class Terrain` (`src/terrain/terrain.js`)

- `constructor(scene, sky, shadows)` — builds Heightfield, DeformationField, detail ProceduralTexture (1024², RGBA8, trilinear mips, wrap, refreshRate 0), clipmap mesh (`mesh`), snow ShaderMaterial (`material`, assigned to mesh), and registers a **per-cascade depth material factory** with `shadows.registerCaster(this.mesh, (c) => this._makeDepthMaterial(c))`. Also `setDeformTexture(deform.texture)`.
- `async build()` — sets detail bake uniforms (`resolution = 1024`, `grainScale = 0.013`), bakes detail, bakes heightfield (height + aux + readback), calls `shadows.setHeightBounds(minHeight − 4, maxHeight + 6)`.
- `makePrepassMaterial()` → ShaderMaterial (`terrainPrepass` vertex / shared `prepass` fragment); caller registers it with the depth prepass. Stored as `this.prepassMat` so `update()` and `setDeformTexture()` cover it.
- `async warmUp()` — `deform.warmUp()` first (see 1.3), rebind deform texture, then `whenReady` on snow material, prepass material, each depth material (isReady called with `[mesh, false]`).
- `setDeformTexture(tex)` — points beauty + all depth + prepass materials at the given deform target. Called on every ping-pong flip.
- `update(cameraPos: Vector3, focus: {x,z}, dt: seconds)` — advances the deform sim (`deform.update(dt, focus)`), rebinds if flipped, then uploads every uniform to all 5 materials (exact list in section 4 tables). `focus` is the character position. Also `material.wireframe = S.wireframe`.
- `heightAt(x, z)` / `normalAt(x, z, out)` — delegate to heightfield (CPU, bicubic B-spline; see below). Called by: character controller, camera rig ground clamp (`rig.groundAt`), figure/cloth, walkers, speeder, spells, wake, particles, opening shot.
- `dispose()`.
- Properties consumed externally: `terrain.mesh` (renderingGroupId set to 1 by main), `terrain.material` (spell-light consumer registration), `terrain.deform` (brush writers), `terrain.heightfield` (`clampToPlayArea`).
- `DEBUG_MODES` map (internal) — string → float for `S.debugView`.

### `class Heightfield` (`src/terrain/heightfield.js`)

Exports: `WORLD_SIZE = 2048` (m), `HEIGHT_RES = 4096`, `AUX_RES = 2048`, `PLAY_RADIUS = 620`.

- `constructor(scene)` — creates `heightTex` (ProceduralTexture "heightBake": 4096², **TEXTURETYPE_FLOAT + TEXTUREFORMAT_RG** (RG32F), bilinear, clamp, no mips, refreshRate 0) and `auxTex` ("auxBake": 2048², RGBA16F, bilinear, clamp). `origin = (−1024, −1024)`, `size = 2048`, `texelWorld = 0.5`.
- `async bake()` — height bake uniforms: `worldOrigin`, `worldSize`, `windAngle` (rad, from `S.windDirection`), `heightAmp = S.macroHeightScale`; then aux bake (`heightTex` sampler, `texelWorld`, `invHeightRes`), then `_readback()`.
- `_readback()` — `heightTex.readPixels()`; **derives channel stride from `src.length / 4096²`** (backend may widen RG→RGBA); downsamples R to 2048² with a 2×2 box (box, not point — sample-centre alignment with `heightAt`), stores `heightCPU` (Float32Array), `cpuRes = 2048`, `cpuTexel = 1.0`, and measured `minHeight`/`maxHeight`.
- `heightAt(x, z)` — **bicubic B-spline** on the CPU mirror using the identical weight polynomial the shader uses (`bsplineWeights`), clamped indices, sample coordinate `((x−origin)/size)·res − 0.5`.
- `normalAt(x, z, out)` — central difference of `heightAt` at ±`cpuTexel`, `out = normalize(−hx/2e, 1, −hz/2e)`.
- `clampToPlayArea(v)` — radial clamp to `PLAY_RADIUS`.

### `class DeformationField` (`src/terrain/deformation.js`)

Exports: `COVERAGE = 80` (m). Internals: `BRUSH_ROWS = 3`, `MAX_BRUSHES = 96`, `RELAX_STEP = 0.4` s.

- `constructor(scene)` — `res = max(512, S.deformResolution|0)` (read **once**; preset must be applied before construction), `size = 80`, `texel = size/res`, `center`/`_prevCenter` Vector2s, brush staging array + `brushTex` (RawTexture RGBA **FLOAT** 96×3, nearest, clamp, no invert-Y), two ping-pong ProceduralTextures ("deformSim": res², RGBA16F, bilinear, **wrap**, no mips, refreshRate 0, `autoClear = false`, each holding `brushTex` bound).
- `brush(x, z, radius, depth, berm, compression, ice, yaw?, elongation?, edge?)` — see 1.3. `edge` defaults to 1 (undefined) — note 0 is "clean bevel".
- `update(dt, focus)` → returns the just-written target. Snaps centre to texel grid; uploads brushes if dirty; banks relaxation; sets uniforms `prevTex`, `center`, `prevCenter`, `size`, `res`, `dt` (banked, usually 0), `brushCount`, `refillRate = S.refillRate`, `maxDepth = 0.55·S.deformDepth`, `maxBerm = 0.34·S.deformBerm`, `windAngle`; `pt.render()`; flips; resets `_brushCount = 0`.
- `warmUp()` — see 1.3.
- Properties read externally: `texture` (current state), `center` (Vector2, world XZ), `size`, `texel`.

### `buildClipmapMesh(scene)` (`src/terrain/clipmapMesh.js`)

Exports: `GRID_N = 160`, `LEVELS = 8`, `BASE_SPACING = 0.085`, `INNER_EXTENT = 6.8`, `OUTER_EXTENT = 870.4`, `GRID_HALF_N = 80`. Returns a mesh with only a `position` attribute (vec3, packed `(gridI, level, gridJ)`) and Uint32 indices; `alwaysSelectAsActiveMesh = true`, world matrix frozen, not pickable, no bounding sync; `mesh.metadata = {triangles, vertices}` (read by main.js stats).

### Settings keys consumed (exact `S.*` keys)

Read every frame by `Terrain.update`: `windDirection`, `macroHeightScale`, `sastrugiStrength`, `detailNormalStrength`, `glintIntensity`, `glintGrazing`, `sssStrength`, `sssRadius`, `fogDensity`, `fogHeightFalloff`, `fogStart`, `aerialStrength`, `ambientIntensity`, `deformDepth`, `debugView`, `wireframe`.
Read by `DeformationField`: `deformResolution` (construction only), `refillRate`, `deformDepth`, `deformBerm`, `windDirection`.
Read at bake time: `windDirection`, `macroHeightScale`.
Toggles wired in main.js: `showTerrain` → `mesh.isVisible`.
Note `windDirection`/`macroHeightScale` changed at runtime do **not** re-bake — the baked macro keeps the boot-time values; only the live fine layer and deform sim follow the slider.

---

## 3. Data flow (cross-subsystem contracts)

### Produced by terrain, consumed elsewhere

| Object | Format / size | Owner | Updates | Consumers |
|---|---|---|---|---|
| `terrain.heightfield.heightCPU` via `heightAt`/`normalAt` | Float32Array 2048², 1 m/texel | Heightfield | once at boot | character controller, camera rig (`rig.groundAt`), figure, cloth, walkers, speeder, spells, wake, spray, opening shot |
| `heightfield.minHeight/maxHeight` | floats | Heightfield | once | `shadows.setHeightBounds(min−4, max+6)` |
| `terrain.deform` (brush API + `texture`, `center`, `size`, `texel`) | RGBA16F 2048² toroidal window, 80 m | DeformationField | 1 sim pass/frame | brush writers: `character/snowContact.js`, `spells/{crystallize,ribbon,vortex,bloom,sweep}.js`, `walkers/bolts.js`; texture readers: the wake material (`vfx/surfWake.js` samples deform state), terrain's own 4 materials |
| `terrain.mesh` + `metadata.triangles` | clipmap mesh | Terrain | static | main.js (rendering group 1, stats), shadows renderList, depth prepass renderList |
| `terrain.material` | ShaderMaterial | Terrain | per frame | `spells.addConsumers` writes `spellLightPos/Col/Count` uniforms into it |
| `makePrepassMaterial()` result | ShaderMaterial | Terrain | per frame | DepthPass (`registerCaster`), writes linear viewZ (R) + ice mask (G) used by post chain SSR/DoF/TAA |

### Consumed by terrain from elsewhere

| Object | Format | Owner | Notes |
|---|---|---|---|
| `sky.lut` (`skyLUT`) | RGBA16F 512×256 equirect radiance LUT, wrapU/clampV | Sky | ambient specular + aerial perspective |
| `sky.sunDir` (Vector3), `sky.sunRadiance` (Color3), `sky.sh` (Float32Array 36 = 9×vec4 `shR`) | CPU values | Sky | uniforms per frame |
| `shadows.maps[0..2]` (`cascade0..2`) | RenderTargetTexture, R32F-stored NDC depth (as color), 2048² each | ShadowSystem | PCSS blocker search needs plain filtered fetches, **not** a comparison sampler |
| `shadows.matrixData` (Float32Array 48), `splits` (Float32Array 4), `paramData` (Float32Array 12: per cascade depthRange m, orthoWidth m, 0, 0), `texelSize` (1/2048) | CPU | ShadowSystem | bound via `bindMatrixArray` (no-alloc path) + `setVector4/setArray4` |
| `shadows.registerCaster(mesh, factory)` | API | ShadowSystem | factory called once per cascade; each cascade renders the mesh with its own material carrying `lightViewProjection` |
| `depthPass.registerCaster(mesh, material)` | API | DepthPass | RGBA16F RTT, shared `prepass` fragment writes `(viewZ, iceMask, 0, 1)` |
| `SPELL_LIGHT_UNIFORMS` = `["spellLightPos","spellLightCol","spellLightCount"]` (4×vec4 pos+radius, 4×vec4 col+intensity, float count) | uniforms | SpellSystem | pushed by spells into `terrain.material` each frame |
| `viewProjection` | mat4 | Babylon binding from active camera (carries the frame's TAA jitter) | Three port: pass `camera.projectionMatrix · viewMatrix` (with jitter applied by the post subsystem) explicitly |
| `S` settings store | plain object | core/settings.js | see §2 |

Shared WGSL includes crossing subsystem lines: `snowNoise` (terrain ⇄ sky ridge ⇄ vfx), `snowTerrain` (terrain bake + runtime + wake), `snowDeform` (terrain + wake), `snowShading`, `snowShadowLookup` (terrain + character + walker + wake — must be byte-identical lookups), `snowSpellLights`, `snowAtmosphere`, `snowRidge` (sky only).

---

## 4. Shader inventory

Babylon WGSL conventions to strip during translation: `uniform x: T;` lines are collected into an auto-generated `uniforms` struct (access `uniforms.x`); `varying`/`attribute` declarations map to out/in; entry points use `vertexInputs`/`vertexOutputs`/`fragmentInputs`/`fragmentOutputs`; `#include<name>` is Babylon's include store (registered in `src/shaders/registry.js`). In GLSL ES 3.0: plain uniforms (or UBOs), `in/out`, `#include` → string concatenation at material build time.

### 4.1 `lib/noise.wgsl` (`snowNoise`)

Hashes (`hash11/21/22/33`), unit gradient `grad2`, **gradient noise with analytic derivatives** `noised(p) → vec3(value, d/dx, d/dy)` (quintic fade, IQ formulation), `noise2`, `noise3`, `rot2`, `fbmd` (per-octave rotation 0.517 rad with chain-ruled derivative via accumulated `xform` matrix), `fbmDamped` (derivative-damped fBm — attenuates octaves by accumulated slope; the dune look), `ridgedd` (ridged with derivatives, `1−|n|` squared, octave coupling `prev = mix(1, r², 0.65)`, rotation 0.717), `sabs`, `smoothMin/Max`, `remap`, `ign` (interleaved gradient noise). GLSL notes: `vec2f→vec2` etc.; **row/column-major**: WGSL `mat2x2f(a,b,c,d)` is column-major same as GLSL `mat2`, but check every `v * m` vs `m * v` — the code uses both (`n.yz * xform` = row-vector × matrix = `transpose(xform) * n.yz` in GLSL, i.e. `vec2 r = vec2(dot(n.yz, xform[0]... )` — safest translation: `n.yz * xform` (WGSL) ≡ `xform^T · n.yz` ≡ GLSL `n.yz * xform` **only if** GLSL matrix holds the same columns; GLSL `v*m` is also row-vector×matrix, so `v * m` translates verbatim). Verify with a golden-image test of the height bake.

### 4.2 `lib/terrain.wgsl` (`snowTerrain`)

`windMat(angle, sx, sy, scale)` = anisotropic scale · rotation (`d * r`); `terrainMacro(p, w, amp)` — damped fBm dunes (5 oct, scale 58 m, ×15.5) + swell (3 oct, 210 m, ×26) + sheared medium drifts (4 oct, 13.5 m, shear `q2.x += broad·2.4`, shelter mask `clamp(0.5 − broad·0.75, 0.15, 1)`, ×2.9), all × amp; `terrainMacroD` (finite-diff, bake diff only, unused at runtime); `rockField(p, w)` — 165 m jittered cell grid, 3×3 neighbourhood, 66% culled, spherical-cap domes 7–18 m radius, ridged roughness, returns (height, mask=dome²); `windLocal(p)` — veer (±0.42 rad @ ~120 m) and stretch (2.3–4.7 @ ~80 m) noise fields; `terrainFine(p, w, exposure, amp)` — vertex-side sastrugi (ridged, 2.3 m, amp `0.125·amp·mix(0.45,1,exposure)·scour`) + ripples (0.42 m, `0.024·amp·mix(1,0.45,exposure)`) + grain (0.115 m, `0.0075·amp`), returns (h, dH/dx, dH/dz), derivatives mapped to world via `d += (layer.yz * M) · amp` (row-vector × matrix again); `terrainFineFiltered(..., fp)` — same three layers each gated by footprint smoothsteps (sastrugi 0.35–1.6, ripples 0.06–0.3, grain 0.016–0.08).

### 4.3 `lib/clipmap.wgsl` (`snowClipmap`)

`sampleHeightBicubic` (4-tap bilinear bicubic B-spline — needs **linear filtering on a float texture**: `OES_texture_float_linear` for R32F; see risks), `worldToHeightUV`, `placeClipmapVertex` (see §1.2). Pure ALU otherwise; translates directly.

### 4.4 `lib/deform.wgsl` (`snowDeform`)

`deformUV`, `deformFalloff`, `deformHeight` (3×3 binomial over `(g−r)`; loop with `i32` counters and `f32()` casts — fine in GLSL ES 3.0). Sampled with `textureSampleLevel(..., 0.0)` → GLSL `textureLod(..., 0.0)`. Requires RGBA16F with bilinear filtering + REPEAT wrap (`EXT_color_buffer_float` to render, `OES_texture_half_float_linear` is core-ish in WebGL2? — no: half-float linear filtering IS core WebGL2 for sampling; *rendering* to RGBA16F needs `EXT_color_buffer_float`).

### 4.5 `snow.vertex.wgsl`

See §1.2. Uniforms: `viewProjection`, `cameraPos`, `lodCenter`, `baseSpacing`, `gridHalfN`, `worldOrigin`, `worldSize`, `heightRes` (constant 4096 pushed as float), `windAngle`, `macroAmp` (declared; the macro is baked so it is unused in the vertex — keep or drop), `sastrugiAmp`, `deformCenter`, `deformSize`, `deformDepthScale`. Textures: `heightTex`, `auxTex` (only `.a` exposure), `deformTex`. Varyings out: `vWorld` (vec3), `vHeightUV` (vec2), `vViewDist` (f32), `vSpacing` (f32). All texture reads are `textureSampleLevel` (explicit LOD — legal in vertex stage; GLSL: `textureLod`).

### 4.6 `snow.fragment.wgsl`

See §1.4. Techniques: gradient-sum normal composition; footprint-driven band-limiting everywhere; RNM detail blending; triplanar; wrapped diffuse; GGX; SH irradiance; PCSS cascades via include; analytic AO with blue tint; aerial perspective; 11 debug modes. Blend state: opaque, depth test/write on (beauty draws after the prepass has primed depth — in Babylon here it simply draws normally in group 1).
Translation care:
- `dpdx/dpdy` → `dFdx/dFdy`. **Y-flip**: WebGPU vs WebGL differ in framebuffer orientation; `dpdy` sign flips. Everything here uses derivatives of world position for *lengths* (footprint) so signs mostly cancel, but the shadow include's receiver-plane gradients may not — audit `lib/shadowLookup.wgsl` (shadow subsystem) for `0.5 + ndc.y·0.5` vs `0.5 − ndc.y·0.5` UV conventions. The debug `shadowMapDelta` here uses `uv = (ndc.x·0.5+0.5, 0.5+ndc.y·0.5)` — Babylon WebGPU RTT convention; Three/WebGL RTTs will need `0.5 − ...` or a flipped viewport. **Depth range**: WGSL NDC z ∈ [0,1]; GL z ∈ [−1,1] — the stored cascade depth (`position.z` in fragment, already viewport-transformed to [0,1] via `gl_FragCoord.z`) is fine, but any matrix that was built for [0,1] clip (Babylon WebGPU projection) must be rebuilt for GL conventions; the comparison `ndc.z` from `clip.z/clip.w` must then be remapped `·0.5+0.5`.
- `textureSampleGrad` → `textureGrad`.
- Non-uniform-control-flow sampling: GLSL ES 3.0 *allows* implicit-derivative sampling in non-uniform flow (undefined derivatives but no validation error) — keep the explicit-gradient structure anyway; it is also what keeps mips correct.
- `select(f, t, cond)` → `mix`/ternary (argument order reversed: WGSL `select(false_val, true_val, cond)`).
- `uniform shR: array<vec4f,9>` → `uniform vec4 shR[9]` (set via `setArray4` equivalent: `new Float32Array(36)`).
- `cascadeMatrices: array<mat4x4f,3>` → `uniform mat4 cascadeMatrices[3]`.
- Scalar `f32` uniforms galore — in Three, one flat `uniforms` object on RawShaderMaterial; or pack into UBO std140 (mind vec3 padding).

### 4.7 `terrainDepth.vertex.wgsl` + `terrainDepth.fragment.wgsl`

Vertex: identical placement/displacement path as snow.vertex (same includes, same gates) but projects with `lightViewProjection`; no varyings except position. **Per-cascade material** with define `SNOW_CASCADE n` purely to force distinct programs/uniform sets so each cascade carries its own matrix without mid-frame UBO swapping (Three: three ShaderMaterial clones or one material + `onBeforeRender` uniform swap — clones are closer to the original design intent and avoid WebGL's synchronous uniform upload ordering issues; uniform swap per pass is actually fine in WebGL since uniforms upload at draw time — simplest is one material, set `lightViewProjection` between cascade passes).
Fragment: writes `vec4(gl_FragCoord.z, 0, 0, 1)` into an R32F **color** attachment (with a depth attachment for z-testing). backFaceCulling false (draw both faces).

### 4.8 `terrainPrepass.vertex.wgsl` + shared `prepass.fragment.wgsl`

Vertex: same placement path; extra outputs `vViewZ = clip.w` (linear view depth for perspective) and `vMask` = deform ice channel (A) read *straight* (no binomial), × falloff. Fragment (shared): `color = vec4(viewZ, mask, 0, 1)` into RGBA16F prepass RTT. Uses the camera `viewProjection` (with TAA jitter).

### 4.9 `deformSim.fragment.wgsl`

Full-screen quad pass (ProceduralTexture → Three: fullscreen triangle + RawShaderMaterial into a `WebGLRenderTarget`). See §1.3 for algorithm. Translation care:
- `textureLoad(brushTex, vec2i(i, row), 0)` → `texelFetch(brushTex, ivec2(i, row), 0)` (core in GLSL ES 3.0). Brush texture is RGBA32F, nearest — texelFetch ignores filtering anyway. WebGL2 float textures with nearest need no extension for *sampling*; uploading Float32Array to RGBA32F is core.
- `i32(uniforms.brushCount)` loop bound — dynamic uniform loop bound is fine in ES 3.0.
- Ping-pong: never sample the target being written (already respected). `autoClear = false` → just don't clear.
- Output RGBA16F: needs `EXT_color_buffer_float` (or `EXT_color_buffer_half_float`).
- `all(abs(...) <= vec2(...))` → `all(lessThanEqual(abs(...), vec2(...)))`.
- The pass samples `prevTex` at the **same UV** (toroidal identity): the "scroll" is purely arithmetic; keep wrap addressing on the sampler for neighbour taps near the seam.

### 4.10 `heightBake.fragment.wgsl`

One-shot full-screen bake: `p = worldOrigin + uv·worldSize`; writes `(terrainMacro + rockField.height, rockMask, 0, 1)`. Uniforms: `worldOrigin`, `worldSize`, `windAngle`, `heightAmp`. Target: RG32F 4096² (see risks re: RG32F renderability — `EXT_color_buffer_float` covers RG32F in WebGL2). Three: render once into a `WebGLRenderTarget({type: FloatType, format: RGFormat (internal RG32F)})`, then `renderer.readRenderTargetPixels` — **WebGL2 readPixels from an RG32F attachment may only support RGBA/FLOAT reads**; the original code already handles stride ≥ 1 heuristically — in Three, read as RGBA into a 4-stride buffer (or render the bake to RGBA32F and skip the guessing; 4096²·16 B = 268 MB transient — acceptable once, or bake at RGBA and immediately downsample).

### 4.11 `auxBake.fragment.wgsl`

One-shot: central differences of the *baked* height at ±1 texel (`/(2·texelWorld)`) → RG slope; wide-stencil Laplacian at ±6 texels → exposure `clamp(0.5 − lap·2.2, 0, 1)`; rock mask passthrough from height G. Uses `textureSample` (implicit LOD, fine — full-screen pass, uniform flow; GLSL `texture()`). Target RGBA16F 2048², clamp, bilinear.

### 4.12 `detailBake.fragment.wgsl`

One-shot tileable grain bake, 1024² RGBA8 with mips (generate mips after render): three packed-grain layers (`grainHeight` — jittered-cell spherical caps, periods 26/61/137 so it tiles exactly), 5 evaluations for central-difference slope, `n = normalize(−dx·grainScale, −dz·grainScale, 1)`; output `(n.x·0.5+0.5, n.y·0.5+0.5, cavity, height)`. Uniforms: `resolution = 1024`, `grainScale = 0.013`. Sampled trilinear + wrap at runtime; Z reconstructed in fragment (`unpackN`).

### 4.13 `lib/ridge.wgsl` (`snowRidge`) — consumed by sky.fragment only

Raymarched far-mountain heightfield on the skybox: `ridgeField` (7 km exclusion bowl, massif envelope, domain warp, two ridged stacks 0.30/1.05 per-km, crest sharpening `raw³·0.55 + raw·0.45`, foothill floor 0.06), `ridgeMarch` (18 geometric steps 5.5 → 45 km, ceiling early-out, crossing interpolation, "started inside near face" case), `ridgeShadow` (4 hard steps from 420 m × 2.6), `ridgeDrop` (earth curvature d²/12742000). Pure ALU; translates directly; uniforms come from the sky material (`S.showMountains`, `S.mountainHeight`). Port with the sky subsystem but from the same shared noise source as terrain.

---

## 5. Babylon-specific machinery → Three.js WebGL2 equivalents

| Babylon | Used for | Three.js equivalent |
|---|---|---|
| `ShaderMaterial` (WGSL, explicit uniform/sampler lists) | snow, terrainDepth×3, terrainPrepass | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: GLSL3`) with hand-declared uniforms. Babylon auto-binds `viewProjection` from the active camera — in Three set it manually each frame (or per pass) including TAA jitter. |
| `ProceduralTexture` (`refreshRate = 0`, `skipSceneRegistration`, `autoClear = false`) | height/aux/detail bakes, deform sim ping-pong | `WebGLRenderTarget` + fullscreen-triangle pass rendered manually (`renderer.setRenderTarget(rt); renderer.render(fsScene, fsCam)`). One-shot bakes render once at boot; deform renders once per frame before the shadow/beauty passes. |
| `RawTexture.CreateRGBATexture(..., TEXTURETYPE_FLOAT)` + `.update(data)` | brushTex 96×3 RGBA32F | `DataTexture(data, 96, 3, RGBAFormat, FloatType)`, `magFilter/minFilter = NearestFilter`, `needsUpdate = true` per dirty frame. `flipY = false`. |
| `ShadowSystem.registerCaster(mesh, factory)` + `RenderTargetTexture.setMaterialForRendering` | per-cascade depth materials | Render cascade RTs manually: for each cascade, set `mesh.material = depthMat`, set `lightViewProjection`, render into `WebGLRenderTarget` (R32F color + depth). Or `scene.overrideMaterial` per cascade pass. |
| `DepthPass` custom RTT + `registerCaster` | camera-space linear-depth prepass | Same manual pattern into an RGBA16F target, rendered before beauty; post chain consumes it. |
| `bakeOnce` / `whenReady` (async WGSL compile) | boot-time pipeline warm-up | WebGL compiles are synchronous by default; for parity use `KHR_parallel_shader_compile` + `renderer.compileAsync(scene, camera)` behind the loading screen. |
| `bindMatrixArray` (no-alloc mat4 array upload) | cascadeMatrices | Three uniforms hold references: `uniforms.cascadeMatrices.value = float32ArrayBackedMat4s` — build 3 `Matrix4`s sharing the shadow system's data, or just declare `uniform mat4 cascadeMatrices[3]` and set from an array of Matrix4 (Three flattens each upload; the kilobyte/frame garbage concern disappears if you reuse the same Matrix4 array). |
| `mat.setFloat/setVector2/.../setArray4/setColor3` per frame | uniform pushes | Mutate `.value` on the shared uniforms objects (no per-frame Three API cost). Consider one shared uniforms object referenced by all 5 terrain materials so `update()` writes each value once. |
| `Constants.TEXTUREFORMAT_RG + TEXTURETYPE_FLOAT` | heightTex RG32F | `RGFormat` + `FloatType` (internalformat RG32F). Renderable under `EXT_color_buffer_float`; linear filtering needs `OES_texture_float_linear` — **check and fall back to R16F/half float or manual 4-tap fetch** (see risks). |
| `TEXTURETYPE_HALF_FLOAT` RGBA | auxTex, deform targets, prepass | `HalfFloatType` — linear filtering is core in WebGL2; rendering needs `EXT_color_buffer_float` (universally available). |
| wrap modes (`TEXTURE_WRAP_ADDRESSMODE`) | deformTex, detailTex | `RepeatWrapping` on both axes; clamp for height/aux/brush. |
| Left-handed coords, CW = front-face | clipmap winding comment | Three is right-handed, CCW front. The terrain is generated in world space directly by the shader, so handedness only shows up in (a) triangle winding — either flip the two index orders in `buildClipmapMesh` or set `material.side`/`frontFace` appropriately; (b) the camera/cascade matrices, which come from the ported camera/shadow subsystems; (c) `cross()` order in the fragment T/B frame — unchanged math, but verify against the ported shadow include. World layout (X east, Y up, Z) is otherwise self-consistent — port the world as-is and keep Z semantics identical across subsystems. |
| `scene.setRenderingAutoClearDepthStencil`, renderingGroupId 1 | draw ordering | Three: explicit render order / manual passes; terrain draws in the opaque pass after sky. |
| `mesh.alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | skip culling for shader-placed geometry | `mesh.frustumCulled = false`, `matrixAutoUpdate = false`. |
| `ShaderStore.IncludesShadersStoreWGSL` (`#include<snowNoise>` etc.) | shared shader text | String templating: keep one `libs/` of GLSL chunks and concatenate; **one copy per include**, shared by bake/beauty/depth/prepass/wake, exactly as the original insists. |
| `engine.getRenderWidth/Height` | `screenSize` uniform | `renderer.getDrawingBufferSize()`. |
| `readPixels` on ProceduralTexture | height CPU mirror | `renderer.readRenderTargetPixels` (see 4.10 for format caveat). |
| WGSL `textureSampleLevel/Grad`, `textureLoad`, `dpdx/dpdy`, `select`, `array<vec4f,9>` uniforms | shaders | `textureLod`/`textureGrad`/`texelFetch`/`dFdx`/`dFdy`/ternary/`uniform vec4 shR[9]`. |

---

## 6. Assets

**None.** The terrain subsystem consumes no binary/texture/audio assets. Every texture is generated at boot (height/aux/detail bakes) or at runtime (deform sim). (`public/models/*.bin/webp` belong to the walker/speeder subsystems.) Inputs are: the settings store, the shared WGSL library text, and the sky/shadow products listed in §3.

---

## 7. Porting risks & gotchas (ranked)

1. **Vertex-position identity across the three passes.** Beauty, cascade depth, and camera prepass must compute bit-identical world positions (same GLSL chunk text, same gates `spacing < 0.42` / `< 1.0`, same fades, same binomial filter). Any divergence = shadow acne on every berm, or an AO/SSR halo that follows the camera. Use one shared chunk and golden-image diff the debug `shadowMap` view (mode 9) which exists precisely to measure this in metres.
2. **R32F/RG32F linear filtering and renderability.** `heightTex` is a float texture sampled with bilinear + the 4-tap bicubic trick in the *vertex* stage. WebGL2 needs `OES_texture_float_linear` (widely available on desktop, missing on some mobile GPUs) and `EXT_color_buffer_float` to render the bake. The original already warns and degrades ("height will step"). Fallback options: half-float height (loses precision over ±40 m relief — half floats resolve ~2 cm at 40 m, probably acceptable), or manual 4×4 `texelFetch` bicubic (vertex-stage cost). Also `readRenderTargetPixels` on non-RGBA float attachments is implementation-restricted — bake or blit to RGBA32F for the readback and keep the stride-derivation logic.
3. **Half-float ULP behaviour of the deform sim.** The relaxation-banking design (`dt = 0` most frames, spent in ≥ 0.4 s steps) exists because RGBA16F storage quantises slow decays. Port it verbatim; do not "simplify" to per-frame dt, and do not switch the target to full float (doubles bandwidth of an every-frame 2048² pass). Verify every relax term is an exact no-op at `dt = 0` in the GLSL version too.
4. **Coordinate/NDC convention flips (WebGPU → WebGL).** Three places: (a) shadow UV `0.5 + ndc.y·0.5` and depth `ndc.z ∈ [0,1]` assumptions inside the shadow lookup and `shadowMapDelta` — WebGL NDC is [−1,1] z and RTTs are y-up, so both the matrix construction (shadow subsystem) and the lookup must change together; (b) ProceduralTexture UV vs Three fullscreen-pass UV orientation (deform sim, bakes — self-consistent as long as write and read agree, but the CPU readback row order must match `heightAt`'s indexing: Babylon `readPixels` returns bottom-up in WebGL vs WebGPU top-down — validate `heightAt(x,z)` against a rendered frame early); (c) triangle winding (left-handed CW → right-handed CCW): flip index order or cull side.
5. **Uniform volume & per-frame upload cost.** The snow material has ~40 scalar/vector uniforms + mat4[3] + vec4[9] + vec4[3] + 8 samplers, mirrored (subset) on 4 more materials, re-pushed every frame. In WebGL this is fine at draw time but naive per-uniform `setValue` paths through Three are CPU-visible; share one uniforms object across the 5 terrain materials and mutate `.value` in place. Watch texture-unit count: 8 samplers in the fragment stage + 3 in the vertex stage is within the 16-unit minimum but audit combined usage (vertex+fragment units are separate limits in WebGL2: MAX_VERTEX_TEXTURE_IMAGE_UNITS ≥ 16 required — actually min 16 for fragment, vertex min is 16 in WebGL2; safe).
6. **Row-vector × matrix translations in the noise/terrain libs.** `deriv * xform`, `sas.yz * m3`, `dHdq * M` patterns: WGSL `v * m` = GLSL `v * m` (both mean row-vector × matrix, i.e. `transpose(m) · v`) — verbatim translation is correct, but any "helpful" rewrite to `m * v` silently rotates every derivative and the dunes light wrong while the silhouette stays right. Golden-test `heightBake` + `auxBake` output against captured WebGPU reference images.
7. **Deform sim ordering within the frame.** Brushes are queued by character/spells/walkers *before* `terrain.update`; the sim renders; the freshly-written target is bound to all four materials the same frame ("simulate first, then bind" — a frame-late bind shows as marks staggering behind fast movement). In Three, run the sim render at the top of `terrain.update` before setting uniforms, and before the cascade/prepass/beauty renders.
8. **CPU/GPU height agreement.** `heightAt` must keep: 2×2 box downsample (not point sample), the `−0.5` sample-centre convention, the identical B-spline weights, clamped edges, and stride derivation on readback. A quarter-texel mismatch sinks the character into slopes. Test: sample a grid of (x,z), compare against a GPU debug readback.
9. **`detailTex` mip generation + explicit-gradient sampling.** Three generates mips for render targets only when `generateMipmaps: true` on the RT and filtering set accordingly; the fade-in scheme *requires* correct trilinear mips and `textureGrad`. Also RGBA8 unorm here — no sRGB: create with `colorSpace = NoColorSpace` / linear, or normals decode wrong.
10. **Boot/preset ordering.** `S.deformResolution` is read once in the DeformationField constructor — apply the mobile/balanced preset before constructing Terrain, exactly as `main.js` does. Similarly `windDirection`/`macroHeightScale` freeze into the bake at boot.
11. **Wireframe + debug parity.** `material.wireframe = S.wireframe` toggles the beauty pipeline (Three: `material.wireframe` works on ShaderMaterial). Keep the debug-mode float map identical — several debug views (deform=1, footprint=5, shadow=7, shadowMap=9, albedo=10) are the intended diagnostic tooling for this port.
