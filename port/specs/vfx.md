# VFX subsystem — porting spec (Babylon.js/WebGPU → Three.js/WebGL2)

Source files:
- `src/vfx/particles.js` — `SprayField`, the single pooled snow-spray particle system
- `src/vfx/surfWake.js` — `SurfWake`, the snow-surf wake (wave mesh + plume emission + bow)
- Shaders: `src/shaders/spray.vertex.wgsl`, `spray.fragment.wgsl`, `wake.vertex.wgsl`,
  `wake.fragment.wgsl`, `wakeDepth.vertex.wgsl`, `wakeDepth.fragment.wgsl`,
  `wakePrepass.vertex.wgsl`, `wakePrepass.fragment.wgsl`, `src/shaders/lib/wake.wgsl`
  (registered as the `snowWake` include in `src/shaders/registry.js`)

Both modules follow one design: **the mesh carries no geometry**. Vertex attributes are
pure indices (`(particleIndex, cornerX, cornerY)` for spray; `(column, row, side)` for the
wake), and the vertex shader places every vertex by `textureLoad`-ing a small float32
RGBA data texture that the CPU rewrites each frame. Static vertex buffer, static index
buffer, zero per-frame allocation; the only per-frame GPU traffic is the data-texture
upload and uniforms.

---

## 1. Purpose & behavior

### 1.1 SprayField (particles.js)

One pooled, CPU-simulated, GPU-billboarded particle system that serves **every** source
of airborne snow in the demo: character footfalls (`character/snowContact.js`), the surf
wake plume (this subsystem), walker bolt impacts (`walkers/bolts.js`), and all five
spells (`spells/ribbon.js`, `vortex.js`, `crystallize.js`, `sweep.js`, `bloom.js`).
There is deliberately exactly one pipeline and one lighting model for airborne snow.

- **Pool**: `CAPACITY = 5120` grains, a hard cap. Emission into a full pool is silently
  dropped. Free slots are found by a bounded ring scan (`_next` wraps, live slots are
  skipped); dead particles are recycled, never compacted.
- **Per-grain state** (parallel `Float32Array`s of length CAPACITY, ×3 for vectors):
  `pos` (world, m), `vel` (m/s), `age` (s), `life` (s), `size` (m, radius), `seed`
  (0..1 hash), `kind` (0 = powder puff, 1 = heavy clod — appearance only), `drag`
  (linear drag coefficient, 1/s — deliberately independent of `kind` so a plume can
  *look* like powder but *fly* ballistically).
- **CPU simulation per frame** (`update(dt, cameraPos)`), with `h = min(dt, 1/30)`:
  - Wind target: `wa = S.windDirection * PI/180`; `wx = sin(wa)*2.4*S.windStrength`,
    `wz = cos(wa)*2.4*S.windStrength`.
  - Horizontal: exponential relaxation toward wind:
    `vel.x += (wx - vel.x) * min(1, drag*h)` (same for z).
  - Vertical: `vel.y += (-9.81 - drag*(vel.y + TERMINAL)) * h` with `TERMINAL = 1.9`
    m/s (terminal fall speed of a snow grain; drag is tuned to converge there).
  - Integrate position; then **ground settle**: if `pos.y < terrain.heightAt(x,z)`,
    clamp to ground, `vel.x *= 0.2; vel.y = 0; vel.z *= 0.2`, and age 2.5× faster
    (`age += h*2.5`). No bounce — snow landing on snow stops and fades.
  - Growth: puffs (`kind<=0.5`) expand `grow = 1 + a01*1.3`; clods do not.
  - Alpha envelope: `alpha = min(1, a01*8) * (1-a01)^2` (fast in, slow quadratic out),
    where `a01 = age/life`.
- **Data texture write** (CAPACITY × 2 RGBA32F texels):
  - row 0, texel i: `(pos.x, pos.y, pos.z, size*grow)`
  - row 1, texel i: `(age01, seed, kind, alpha)`
  - **Dead slots must still be written with size=0 and alpha=0** every frame, or last
    frame's corpse keeps rendering. Zero size collapses the quad → rasterizer emits no
    fragments (this is the particle-skip mechanism; there is no draw-count reduction).
- **Emit** (`emit(x,y,z, vx,vy,vz, size, life, kind, drag?)`): fills a slot;
  default drag when omitted: `kind>0.5 ? 1.1 : 5.2`;
  `seed = (i*0.618033 + x*0.137 + z*0.311) % 1`.
- **Rendering**: one static mesh of CAPACITY quads (4 verts, 6 indices each), rendered
  in Babylon `renderingGroupId = 2` (after all opaque + the wake), alpha-blended
  (standard `src*a + dst*(1-a)`, `ALPHA_COMBINE`), **no depth write**, no back-face
  culling, no frustum culling (`alwaysSelectAsActiveMesh`, frozen world matrix,
  identity transform — all positions are world-space).
- **Shading** (see §4): billboard shaded as a sphere (normal reconstructed from corner
  coords), sun + wrap diffuse, strong Mie forward scatter, CSM shadows, SH ambient,
  spell lights, aerial perspective. `liveCount` is published for the stats HUD.

### 1.2 SurfWake (surfWake.js)

The snow-surf centrepiece: while the character surfs, a **swept breaking-wave mesh** is
built from the path travelled, spray is emitted **from the crest the mesh is actually
drawing**, and the two walls converge just ahead of the boots to read as a bow wave.
Three outputs, one spine — deliberately one system so the plume can never drift out of
register with the wave.

- **Spine**: a ring buffer of `SPINE_MAX = 96` samples laid every `SPINE_STEP = 0.30` m
  of travel. Per sample: position `(x,y,z)` (y = `terrain.heightAt` at lay time), right
  vector `(rx, rz)` (`rx = cos(facing)`, `rz = -sin(facing)`), odometer `_travel`,
  clock `_laid`, `_strength` = `ch.surf * clamp01((ch.speed - 2.2)/9.0)`, `_carve`
  (signed, + = turning right).
- **Head sample** is *live*: rewritten every frame at the bow position
  `ch.position + facingDir * BOW_LEAD` (`BOW_LEAD = 0.55` m ahead of the player). Once
  the bow has moved `SPINE_STEP` from the previous fixed sample the head freezes and a
  new live head is seeded from it. The spine is therefore a record of the path, not a
  resampling.
- **Activity gate**: laying happens only while `ch.surf > 0.06 && ch.speed > 1.6`.
  On reactivation after a gap > 0.25 s the spine is **restarted** (`_count = 0`) instead
  of reconnected (reconnecting would sweep a wall across the gap).
- **Retirement**: samples older than `LIFE = 0.88` s are dropped from the tail. Wake
  length is therefore `LIFE * speed` (≈16 m at top speed) with no second constant.
- **Per-column resolve** (`_resolve()`, CPU, per frame — this is the one place carve
  handedness is decided):
  - `dist = odo - travel[i] + BOW_LEAD` (metres behind the bow)
  - `a01 = clamp01((clock - laid[i]) / LIFE)`
  - `shape = 0.34 + 0.66*smoothstep01((dist - 0.3)/1.3)` (rises over ~1.5 m behind bow)
  - `env = (1-a01)^2` (quadratic collapse to exactly 0 at end of life)
  - `base = MAX_HEIGHT * S.wakeHeight * strength[i] * shape * env`, `MAX_HEIGHT = 2.4` m
  - `biasL = clamp(carve, -1, 1)`, `biasR = -biasL` (outside of a right turn is the
    left side)
  - `ampL/R = base * clamp(0.45 + 0.55*bias, 0.05, 1.0)`
  - `curlL/R = clamp(0.42 + 0.58*bias, 0.26, 1.0)`
  - Writes the wake data texture (96 × 3 RGBA32F), column j = j-th newest sample:
    - row 0: `(x, y, z, dist)`
    - row 1: `(rx, rz, ampL, ampR)`
    - row 2: `(curlL, curlR, a01, 0)`
  - Also caches `_ampL/_ampR/_dist/_col` per column for the plume emitter.
- **Visibility**: mesh visible iff enabled && `_count >= 2` && maxAmp > 0.01. Texture
  upload and uniform push happen only when visible.
- **Plume** (`_plume(dt)`): gated on `n >= 3 && ch.surf >= 0.15 && ch.speed >= 3.0`.
  Rates are **per metre travelled** (frame-rate independent, tracked with owed
  accumulators `_plumeOwed`, `_driftOwed`):
  - Lip spray: `88 * S.wakeSpray` per metre, ≤150 per frame. Each grain samples a
    **fractional** column position `jf = rand()*span`, `span = min(n-1, 15)` (~first
    4.5 m of wake, from column 0 so the plume attaches to the board), interpolating
    amp/right/pos/dist along the spine (fractional sampling matters: whole columns
    produce 15 visible clumps). Side chosen ∝ amp (`rand()*(aL+aR) < aL → left`),
    skipped if `aL+aR < 0.12` or chosen `amp < 0.10`. Emit position mirrors the
    shader's crest: `l0 = 0.24 + 0.44*smoothstep01((dist-0.3)/2.3)`;
    `lat = l0 + (0.35 + rand()*0.55)*amp`; height `sy + (0.30 + 0.82*sqrt(rand()))*amp`
    (sqrt biases toward the lip).
    - **curtain** (72% of draws): dense slow sheet at the crest —
      vel = `right*side*(0.4+rand*1.1) + ch.velocity.xz*0.16`, y `0.9+rand*1.8`;
      size `0.055+rand*0.085`; life `0.34+rand*0.40`; kind 0; drag **4.5**.
    - **throw** (28%): ballistic — `out = 1.2+rand*2.6`, `back = 0.4+rand*2.2`,
      18% are clods; vel = `right*side*out - fwd*back + ch.velocity.xz*0.30`,
      y `1.6+rand*3.4+amp*1.5`; size clod `0.020+rand*0.022` else `0.045+rand*0.055`;
      life clod `0.7+rand*0.5` else `0.9+rand*1.3`; drag clod `0.7` else `1.0+rand*0.8`.
      (`fwd = (-rz, rx)` — same basis the shader builds.)
  - Drift stream: `7 * S.wakeSpray` per metre, ≤14/frame, sampled over columns
    `2 .. 2+min(n-3,22)`, lateral `(rand-0.5)*1.6`, low over the trench
    (y + `0.08+rand*0.35`), slow (`(rand-0.5)*1.1` horiz, `0.25+rand*0.9` up), size
    `0.026+rand*0.036`, life `1.5+rand*1.6`, kind 0, drag 4.5 — the "trail still
    smoking" effect.
- **Rendering**: static lattice, `COLS = 128` columns × `ROWS = 18` rows × 2 sides
  (attribute = `(col, row, side ∈ {-1,+1})`), opaque, `renderingGroupId = 1`,
  no back-face culling (open curled sheet, both faces visible). The same surface
  function draws three passes: beauty, shadow cascades 0–1 (`WAKE_CASCADES = 2`), and
  the camera depth prepass. All three apply the identical time-drifting erosion
  (`wakeEroded`) so shadow and occlusion match the drawn surface.
- **Warm-up**: `warmUp()` lays a 24-sample synthetic straight spine under the player
  (amp `0.8*(1-a01)^2`, curl 0.7, right = +X) so pipeline compilation behind the
  loading screen actually rasterizes triangles; first real update overwrites it.
- **Debug**: `wake.debug = n` (`SNOWFLOW.wake.debug` from console) feeds uniform
  `wakeDebug`; modes 1–10 visualize individual lighting terms (see §4.2).

### 1.3 Construction / frame wiring (main.js)

```js
const spray = new SprayField(scene, terrain, sky, shadows);          // line ~195
const wake  = new SurfWake(scene, sky, shadows, character, spray, terrain);
onChange("showWake", v => wake.setEnabled(v));                       // settings hook
wake.registerPrepass(depthPass);
// warm-up, behind loading screen:
spray.update(0, rig.camera.position); await spray.warmUp(); await wake.warmUp();
```
Per frame (order matters):
```
character update → post.update (camera jitter) → sky.update/render →
shadows.update → spells.update → terrain.update → figure/walkers/speeder sync →
wake.update(dt, camPos)   // BEFORE spray: wake emits grains into the pool
spray.update(dt, camPos)  // then the pool is simulated + uploaded
→ soundscape → scene.render()
```
`wake.update` runs after the controller has integrated so the bow is where the
character is drawn. Spray/wake never allocate per frame. Stats: wake contributes
`mesh.metadata.triangles` when visible; spray contributes `liveCount * 2` triangles.

---

## 2. Public API

### 2.1 particles.js

- `export class SprayField`
  - `constructor(scene, terrain, sky, shadows)` — needs `terrain.heightAt(x,z)`,
    `sky.lut` (texture), `sky.sunDir` (Vector3), `sky.sunRadiance` (Color3), `sky.sh`
    (Float32Array(36) = 9 × vec4 packed SH), `shadows.maps[3]` (RTTs),
    `shadows.matrixData` (Float32Array 48), `shadows.splits` (Float32Array 4),
    `shadows.paramData` (Float32Array 12), `shadows.texelSize` (number).
  - `emit(x, y, z, vx, vy, vz, size, life, kind, drag?)` — see §1.1. **Called by six
    other subsystems** (snowContact, bolts, ribbon, vortex, crystallize, sweep, bloom).
  - `update(dt, cameraPos)` — simulate, write + upload data texture, push uniforms.
    Called once per frame, after `wake.update`. Also called once with `dt=0` before
    warm-up.
  - `warmUp(): Promise` — waits for material compile (Three: `renderer.compile` /
    `compileAsync`).
  - `dispose()`
  - Properties read externally: `liveCount` (stats), `material` (spellLights binds
    its uniforms onto it), `mesh`, `dataTex`.
- `export { CAPACITY as SPRAY_CAPACITY }` (5120).

### 2.2 surfWake.js

- `export class SurfWake`
  - `constructor(scene, sky, shadows, controller, spray, terrain)` — controller fields
    read: `position` (Vector3), `velocity` (Vector3), `speed` (number, m/s), `facing`
    (radians; forward = `(sin f, 0, cos f)`), `surf` (0..1 blend), `carve` (signed).
    Registers itself as a shadow caster:
    `shadows.registerCaster(mesh, c => this._makeDepthMaterial(c), WAKE_CASCADES=2)`.
  - `registerPrepass(depth)` — builds the prepass material and calls
    `depth.registerCaster(this.mesh, mat)`.
  - `setEnabled(v)` — wired to setting `showWake` via `onChange`.
  - `update(dt, cameraPos)` — spine advance/retire/resolve, upload, uniforms,
    `_plume(dt)`. Must run after controller integration, before render, **before
    `spray.update`**.
  - `warmUp(): Promise` — synthetic spine + compile beauty, 2 depth, 1 prepass
    pipelines.
  - `dispose()`
  - Properties read externally: `mesh` (visibility + triangle stats), `material`
    (spellLights), `debug` (console diagnostic), `prepassMat`, `_depthMats`.
- `export { COLS as WAKE_COLS, ROWS as WAKE_ROWS }` (128, 18).

### 2.3 Settings consumed (exact keys from `src/core/settings.js`, with defaults)

| Key | Default | Used by |
|---|---|---|
| `windDirection` | 42 (deg) | spray sim wind target |
| `windStrength` | 1.0 | spray sim wind target |
| `wakeHeight` | 1.0 | wake amplitude scale (×2.4 m max) |
| `wakeSpray` | 1.0 | plume + drift emission rate |
| `showWake` | (bool, via `onChange` in main.js) | `wake.setEnabled` |
| `fogDensity` | 0.0072 | both fragment shaders (aerial) |
| `fogHeightFalloff` | 0.045 | both |
| `fogStart` | 24 | both |
| `aerialStrength` | 1.0 | both |
| `ambientIntensity` | 1.0 | both |
| `sssStrength` | 1.0 | wake fragment |
| `glintIntensity` | 0.55 | wake fragment |
| `glintGrazing` | 0.72 | wake fragment |

Hard-coded per-material shadow tuning: spray `shadowSoftness=1.6, shadowBias=0.05`;
wake `shadowSoftness=1.5, shadowBias=0.018`.

---

## 3. Data flow (cross-subsystem)

### Produced by this subsystem

| Thing | Format / size | Owner | Update | Consumers |
|---|---|---|---|---|
| `spray.dataTex` | RGBA32F, 5120×2, nearest, clamp | SprayField | full re-upload every `spray.update` | spray VS only (internal) |
| `wake.dataTex` | RGBA32F, 96×3, nearest, clamp | SurfWake | uploaded when wake visible | wake/wakeDepth/wakePrepass VS (internal) |
| Wake depth into **shadow cascades 0–1** | writes `input.position.z` (light-clip z) into R of the cascade RTTs | ShadowSystem owns RTTs | every frame the cascade renders | terrain/character/everything sampling `cascade0..2` |
| Wake depth into **camera depth prepass** | writes clip-space `w` (= linear view depth, m) into R of the half-float prepass RT | DepthPass owns RT | every frame | temporal resolve, water, reflections — anything reading scene depth |
| `spray.emit(...)` service | CPU API | SprayField | on demand | snowContact, walkers/bolts, spells ×5, SurfWake |
| `spray.liveCount`, `wake.mesh.isVisible`, `mesh.metadata.triangles` | numbers | modules | per frame | stats HUD in main.js |

Spray does **not** cast shadows and does **not** write the depth prepass (it renders in
group 2, alpha-blended, depth-test-only against the opaque scene). The wake does not
receive screen-space occlusion by design (its only occlusion is the analytic barrel
term); it renders opaque in group 1.

### Consumed from other subsystems

| Thing | Provider | Details |
|---|---|---|
| `terrain.heightAt(x, z)` | Terrain | CPU ground height; spray settle + spine y |
| `sky.lut` | Sky | lat-long sky LUT (ProceduralTexture, mip-sampled with explicit LOD `sqrt(rough)*6` for reflections; also used by `applyAerial`) — sampler `skyLUT` |
| `sky.sunDir` (Vector3), `sky.sunRadiance` (Color3), `sky.sh` (Float32Array 36) | Sky | uniforms `sunDir`, `sunRadiance`, `shR: array<vec4f,9>` |
| `shadows.maps[0..2]` | ShadowSystem | 3 × RTT 2048², RED/FLOAT color (linear light-clip depth in R), bilinear, clamp, cleared to 1; samplers `cascade0..2` |
| `shadows.matrixData` (48 floats), `splits` (4), `paramData` (12), `texelSize` (1/2048) | ShadowSystem | uniforms `cascadeMatrices: array<mat4x4f,3>`, `cascadeSplits: vec4f`, `cascadeParams: array<vec4f,3>`, `shadowTexel` |
| `shadows.registerCaster(mesh, makeMaterial, nCascades)` | ShadowSystem | per-cascade override material; ShadowSystem sets `lightViewProjection` on each |
| `depthPass.registerCaster(mesh, material)` | DepthPass | material must declare `viewProjection`; camera during prepass is the TAA-jittered one |
| Spell light uniforms | SpellLights | `SPELL_LIGHT_UNIFORMS = ["spellLightPos","spellLightCol","spellLightCount"]`; SpellLights pushes `setArray4("spellLightPos", pos[16])`, `setArray4("spellLightCol", col[16])`, `setFloat("spellLightCount", n)` onto `wake.material` and `spray.material` (registered in main.js line ~233) |
| `controller` (character) | CharacterController | `position`, `velocity`, `speed`, `facing`, `surf`, `carve` |
| Camera | rig | `cameraPos` = `rig.camera.position`; spray billboard basis from view matrix rows: `camRight = (m[0],m[4],m[8])`, `camUp = (m[1],m[5],m[9])`; `viewProjection` bound by engine |

Shared WGSL includes (owned by the render subsystem, must exist as GLSL in the port):
`snowNoise` (`noise2`, `noised`, `ign`), `snowShading` (`wrapDiffuse`, `phaseMie`,
`shIrradiance`, `snowSubsurface`, `distributionGGX`, `visSmithGGXCorrelated`,
`fresnelSchlick`, `fresnelSchlickRough`, `snowGlints`, `dirToLatLong`),
`snowShadowLookup` (`sunShadow(world, N, viewDist, noiseRot)`), `snowAtmosphere`
(`applyAerial`), `snowSpellLights` (`spellLighting`, `spellLightingParticle`),
`snowWake` (lib/wake.wgsl, this subsystem's own shared include).

---

## 4. Shader inventory

### 4.0 lib/wake.wgsl (`snowWake` include) — the surface definition

Shared verbatim by beauty, shadow, and prepass passes (three copies would drift; the
symptom is a shadow that is not the shape of its caster). Spine texture layout as §1.2.

- `wakeSection(q, curl) -> vec2f` — cross-section of a breaking wave in (lateral, up),
  unit height. Defined by **tangent angle**, integrated numerically (midpoint rule,
  `WAKE_STEPS = 20` fixed loop): `th0 = -0.24`, `th1 = 1.65 + curl*3.30` (95°→284°),
  angle swept as `th = th0 + (th1-th0)*pow(t, 1.65)` (exponent packs the hook into the
  last fifth), width factor `(1 - 0.40*t)` (thins toward the lip). Result scaled by
  `WAKE_LATERAL = 0.70` in x and `WAKE_NORM = 3.35` overall. At curl=1 the lip
  genuinely overhangs (tip at 47% of crest lateral offset, 65% of its height) — this is
  not a heightfield.
- `wakeScalars(tex, count, u, side) -> vec4f(amp, curl, dist, age01)` — per-side
  scalars at spine parameter u; **smoothstep-weighted** interpolation between adjacent
  columns (linear leaves a C0 kink that bands the differenced normal every 0.3 m).
  `textureLoad` at integer texels `(i,0) (i,1) (i,2)`; `select(mix(...w),mix(...z),left)`
  picks the side's amp, likewise curl from rows.
- `wakeSpine(tex, count, u) -> vec3f` — Catmull-Rom through row-0 positions
  (piecewise-linear would band the crest highlight at the sample pitch via the
  differenced tangent). Indices clamped to `[0, n-1]`.
- `wakePoint(tex, count, u, q, side, t) -> vec3f` — the surface. Components:
  - basis: `rgt2 = normalize(texel(i1, row1).xy)`, `rgt = (rx, 0, rz)`,
    `fwd = (-rz, 0, rx)`; note **no interpolation of the right vector** (nearest
    column only).
  - base offset `l0 = 0.24 + 0.44*smoothstep(0.3, 2.6, dist)` — walls spread behind
    the bow and clear the trench berm.
  - lump field: 3 octaves of `noise2` on incommensurate, sheared, **time-drifting**
    coordinates keyed on `(dist, q, side)`, weights 0.55/0.30/0.15, total scale
    `0.085 * smoothstep(0.12, 0.72, q)` (crest-weighted); displaced along the
    section's own normal `secN = (-sin(thq), cos(thq))` with
    `thq = -0.24 + (1.89 + curl*3.30)*pow(q,1.65)`. Being in the *vertex* stage,
    the differenced normal and the cast shadow both pick it up for free.
  - lateral: `lat = l0 + (sec.x + secN.x*WAKE_LATERAL*lump) * amp`
  - vertical: `sec.y + secN.y*lump) * amp - 0.10` (sunk 10 cm to meet the trench)
  - backward shear along spine: `along = -q²*0.34*amp` (`+ fwd*along`; lip trails)
  - final: `pos + rgt*(side*lat) + (0, y, 0) + fwd*along`.
- `wakeEroded(alongDist, q, age01, t) -> bool` — discard mask, identical in all three
  fragment stages. Threshold `brk = smoothstep(0.84,1.06,q)*mix(0.34,0.70,age01) +
  smoothstep(0.68,1.0,age01)*0.95` (lip-edge softening + end-of-life dissolve; early
  out if ≤ 0.001). Two `noise2` octaves on sheared, **counter-drifting** coordinates
  (≈3 cell crossings/s fine, 1/s coarse — the boil is deliberate and load-bearing),
  each mapped `*0.72 + 0.5`, combined `a*0.58 + b*0.42 < brk`.

### 4.1 spray.vertex.wgsl / spray.fragment.wgsl

- **VS**: `i = i32(position.x)`, corner = `position.yz` (±1). Two `textureLoad`s from
  `sprayTex` (rows 0/1). `radius = a.w`; dead grain → radius 0 → degenerate quad, no
  fragments. Per-particle spin: `ang = seed*2π + age01*(seed-0.5)*3.0`, rotates the
  **corner** (not the UV). World pos = `center + (camRight*rc.x + camUp*rc.y)*radius`.
  Varyings: `vWorld`, `vCorner` (unrotated corner), `vState = row1`, `vViewDist`.
- **FS technique** (alpha-blended, no depth write, renders after everything):
  1. Disc clip: `r2 = dot(corner, corner) > 1 → discard`.
  2. Edge wobble: `wob = 1 + 0.34*noise2(vec2(cos ang, sin ang)*2.4 + seed*37)`
     with `ang = atan2(corner.y, corner.x)`; `r = sqrt(r2)/wob`; `r > 1 → discard`.
  3. Edge profile: powder `pow(1-r², 1.6)` vs clod `smoothstep(1.0, 0.65, r)`, mixed
     by `kind`; `alpha = state.w * edge * mix(0.36, 0.55, kind)`; `< 0.004 → discard`.
  4. **Spherical normal** from billboard coords:
     `N = normalize(camRight*cx + camUp*cy + V*sqrt(1-r2))`.
  5. Lighting (all HDR-radiance units): albedo `(0.92,0.94,0.98)`;
     `wrapDiffuse(N·L, 0.75) * sun * INV_PI * shadow` with
     `shadow = sunShadow(world, N, vViewDist, ign(fragCoord)*2π)` (3-cascade PCF with
     interleaved-gradient-noise rotation);
     **forward scatter** `phaseMie(dot(-V,L), 0.55) * 0.85 * sun * albedo *
     mix(0.25,1.0,shadow) * (1 - kind*0.5)` — the >1-stop swing that makes spray read;
     SH ambient `albedo*INV_PI*shIrradiance(N, shR)*ambientIntensity`;
     spell lights via `spellLightingParticle`; `applyAerial` fog last.
  6. Output `vec4(color, alpha)`, premul-free standard blending.

### 4.2 wake.vertex.wgsl / wake.fragment.wgsl (beauty)

- **VS**: `u = col/(COLS-1)`, `q = row/(ROWS-1)`, `side = position.z`. Evaluates
  `wakePoint` **three times** for central-ish differences: offsets `du = dq =
  0.65/(N-1)` with sign flipped past the patch midpoint (`select(1,-1,u>0.5)`) so the
  stencil never straddles the clamp (which would give a zero tangent → NaN normal).
  `N = cross(Pq, Pu) * side` — **the `* side` is mandatory**: the two walls are mirror
  images and mirroring flips tangent handedness; without it the barrel occlusion lands
  on the wrong face of the left wall (the BRDF hides the bug; the occlusion doesn't).
  Degenerate normal (length < 1e-7, collapsed tail) → `(0,1,0)`.
  Varyings: `vWorld, vNormal, vQ, vAlong(=dist m), vAge, vAmp, vCurl, vViewDist`.
- **FS technique** (opaque):
  1. `wakeEroded(vAlong, q, vAge, wakeTime) → discard`.
  2. Two-sided: `facing = sign(dot(Ng, V))`, `N = Ng*facing`; `inside = facing > 0`
     is true exactly when the eye is on the **concave** side (sweep builds Ng pointing
     concave) — the one bit the shading needs that the flipped normal can't provide.
  3. Detail normals: pixel footprint from `length(dpdx(world).xz), dpdy` pairs; noise
     domain = two oblique projections `gp = (dot(world,(0.91,0.23,-0.35)),
     dot(world,(0.28,0.84,0.46)))` (planar XZ would band on a near-vertical face);
     two scales via `noised` (analytic-gradient noise): ×26 perturb 0.15 faded over
     footprint 0.012→0.09, ×5.5 perturb 0.10 faded 0.09→0.55, applied in a
     tangent basis built from N.
  4. Material: albedo `(0.895, 0.920, 0.965)`, roughness 0.80, f0 0.026,
     `thickness = mix(0.92, 0.32, smoothstep(0.15, 0.95, q))` — thick base, thin lip;
     the lip floor of 0.32 is deliberate (lower → warm SSS blowout → "brown snow").
  5. Terms: `wrapDiffuse(N·L, 0.66)`; SSS
     `snowSubsurface(N,L,V,sun,thickness, sssStrength*0.45, 1.5) * albedo *
     mix(0.18, 1.0, shadow)` (coupled hard to shadow — a free-standing wall has no lit
     neighbour feeding it); GGX spec (D * VisSmithCorrelated * Schlick, gated N·L>0);
     SH ambient + ground-bounce `shIrradiance(up)*0.30*clamp(-N.y*0.5+0.5)` term;
     sky reflection `textureSampleLevel(skyLUT, dirToLatLong(reflect(-V,N)),
     sqrt(roughness)*6)` × `fresnelSchlickRough`; spell lights (`spellLighting`, full
     BRDF version) added **before** occlusion so a spell in the barrel is darkened
     with the cave.
  6. **Analytic barrel occlusion, applied last to finished radiance**:
     `barrel = inside ? smoothstep(0.05,0.75,q)*(0.45+0.55*vCurl) : 0`;
     `occ = mix(1.0, 0.30, barrel)`;
     `caveTint = mix(white, (0.55,0.72,1.0), (1-occ)*0.95)`; `color *= occ*caveTint`.
     Two hard-won rules encoded here: it scales *everything* (not just ambient — the
     ambient is where the blue lives, attenuating one source re-weights hue), and
     darkening is tied to a proportional blue shift (dim-without-hue-shift lands on
     tan under the AgX shoulder). Do not "fix" this to textbook AO in the port.
  7. Glints (`snowGlints(world.xz, ...) * sun * shadow * 0.5`, gated on
     `glintIntensity > 0.001`), then `applyAerial`.
  8. Debug switch on `wakeDebug`: 1 direct, 2 SSS, 3 ambient, 4 sky spec, 5 sun spec,
     6 occ×12, 7 shadow×12, 8 |N·L|×12, 9 N·L unscaled, 10 inside/outside (red/green).
- Alpha 1.0 out; opaque pipeline.

### 4.3 wakeDepth.* (shadow-cascade caster, ×2 materials)

- VS: same `wakePoint` + `wakeScalars`; `position = lightViewProjection * P`.
  One material **per cascade**, forced distinct by a `WAKE_CASCADE n` define (Babylon
  caches Effects by name+defines; each cascade needs its own bound
  `lightViewProjection`). ShadowSystem calls `setMaterialForRendering` per cascade RTT.
- FS: `wakeEroded → discard`; writes `vec4(input.position.z, 0, 0, 1)` — i.e. the
  **post-viewport-transform depth** (0..1 in WebGPU) into the R channel of a
  RED/FLOAT color target (the cascades are color RTs with a depth buffer, not
  depth-texture sampling). `wakeTime` is carried through as a varying (`vTime`) so both
  halves of the pass erode at the same instant.

### 4.4 wakePrepass.* (camera depth prepass caster)

- VS: same `wakePoint`; `clip = viewProjection * P` (viewProjection here is the
  **TAA-jittered** camera's); `vViewZ = clip.w` (linear view depth in metres, exact for
  perspective).
- FS: `wakeEroded → discard`; writes `vec4(vViewZ, 0, 0, 1)` into the half-float
  prepass target (R = linear metres, G = specular mask left 0, cleared to
  `DEPTH_FAR = 9000`).

### 4.5 WGSL → GLSL ES 3.0 translation notes

- `textureLoad(tex, vec2i(x,y), 0)` → `texelFetch(tex, ivec2(x,y), 0)`. All data-texture
  reads are integer texel fetches in the **vertex shader** — fine in WebGL2 (vertex
  texture fetch is core), but the textures must be `THREE.FloatType` +
  `NearestFilter` + no mips. `RGBA32F` vertex-texture *filtering* is not needed
  (only `texelFetch`), so no `OES_texture_float_linear` dependency here. The sky LUT
  *is* linearly sampled with mips — that dependency lives in the render subsystem.
- `select(a, b, cond)` → `cond ? b : a` (**argument order reverses**; multiple uses in
  wake.wgsl, wake.vertex, wake.fragment, spray edge — easy to get backwards).
- `dpdx/dpdy` → `dFdx/dFdy`. `discard` after derivative use: keep derivative
  computations before any discard in the ported fragment (the WGSL code already
  discards early — erosion/disc-clip — before derivatives; preserve that order, it's
  legal because discarded fragments still execute helper-style in WebGL2, but avoid
  relying on derivatives after conditional flow).
- Loop in `wakeSection` is fixed-count (20) — fine in GLSL.
- `array<vec4f, 9>` / `array<mat4x4f, 3>` uniforms → plain GLSL uniform arrays
  (`uniform vec4 shR[9]; uniform mat4 cascadeMatrices[3];`). With RawShaderMaterial
  pass `Float32Array`s directly; Three uploads flat arrays fine
  (`uniforms.cascadeMatrices = { value: [Matrix4,Matrix4,Matrix4] }` or a custom
  flat-array binding — mirror `bindMatrixArray`'s no-copy intent by reusing arrays).
- `atan2` → `atan(y, x)`; `vec2f/vec3f/vec4f/mat4x4f` → `vec2/vec3/vec4/mat4`;
  `f32()/i32()` → `float()/int()`; `let/var` → const/normal.
- Babylon WGSL boilerplate (`vertexInputs`, `vertexOutputs.position`,
  `fragmentOutputs.color`, `uniforms.` prefix, `#include<...>`) all disappears; the
  `#include` registry (`registry.js`) becomes plain string concatenation of GLSL
  chunks. Keep `snowWake` a single shared chunk included by all four wake programs.
- No storage textures, no textureGather, no compute, no workgroup ops anywhere in this
  subsystem. Integer ops are limited to texel indices.
- WGSL `position.z` in the depth-caster FS is NDC-depth-after-viewport (0..1 in
  WebGPU). In GLSL that is `gl_FragCoord.z` (0..1 with default depth range) — but note
  WebGPU clip z ∈ [0,1] vs WebGL NDC z ∈ [-1,1]: the *cascade matrices* produced by
  the shadow subsystem encode the convention (Babylon builds them for [0,1] on
  WebGPU). The port's shadow subsystem decides the convention; this subsystem must
  write whatever the shadow *lookup* in `snowShadowLookup` compares against.
  Keep caster and lookup in one convention. Same for `useReverseDepthBuffer` — see
  shadows spec.

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon | Used for | Three.js WebGL2 equivalent |
|---|---|---|
| `ShaderMaterial` (WGSL, named uniform/sampler lists) | all 4 pipelines ×2 modules | `THREE.RawShaderMaterial` (GLSL ES 3.0, `glslVersion: GLSL3`) with explicit uniforms object |
| `RawTexture.CreateRGBATexture(..., TEXTURETYPE_FLOAT, NEAREST, clamp)` + `dataTex.update(data)` | spray 5120×2, wake 96×3 data textures | `THREE.DataTexture(Float32Array, w, h, RGBAFormat, FloatType)`, `magFilter=minFilter=NearestFilter`, `wrapS/T=ClampToEdgeWrapping`, `generateMipmaps=false`, set `needsUpdate=true` each frame (full re-upload; or `renderer.copyTextureToTexture` / `texSubImage2D` for partial rows if profiling demands) |
| `Mesh` + `VertexData` (positions-only attribute encoding indices) | spray quads, wake lattice | `THREE.BufferGeometry` with a single `position` `BufferAttribute` (3 floats, non-standard semantics) + `Uint32BufferAttribute` index. Uint32 indices are core in WebGL2 |
| `mesh.renderingGroupId = 1 / 2` | draw order: wake after opaque group 0, spray last | `renderOrder` (+ `material.transparent=true` for spray puts it in the transparent pass anyway); ensure spray draws after water/wake: e.g. wake `renderOrder=1`, spray `renderOrder=2` with `depthWrite=false` |
| `mat.alphaMode = ALPHA_COMBINE`, `disableDepthWrite`, `needAlphaBlending()=>true` | spray blending | `transparent: true, blending: NormalBlending, depthWrite: false, depthTest: true` |
| `backFaceCulling = false` | both | `side: THREE.DoubleSide` (but the wake FS does its own normal flip; `DoubleSide` in Three also flips `gl_FrontFacing` — the shader ignores it, fine) |
| `alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | skip culling/matrix for world-space procedural meshes | `frustumCulled = false`, `matrixAutoUpdate = false` (identity world matrix; shaders use world positions directly — do not multiply by `modelMatrix`) |
| `shadows.registerCaster(mesh, makeMat, 2)` + `RenderTargetTexture.setMaterialForRendering` + `WAKE_CASCADE n` define trick | per-cascade override materials | Render cascades manually: for each cascade `WebGLRenderTarget`, set `mesh.material = wakeDepthMat`, set that material's `lightViewProjection` uniform to the cascade's matrix, `renderer.setRenderTarget(rt); renderer.render(...)`. In Three you can reuse **one** depth material and swap the uniform between cascade renders (no Effect-cache constraint), or keep two materials for parity |
| `depthPass.registerCaster(mesh, mat)` | camera-depth prepass | same override-material pattern into the port's prepass `WebGLRenderTarget` (HalfFloat RGBA or R); prepass camera must use the jittered projection |
| `whenReady(material, ...)` warm-up | compile behind loading screen | `renderer.compileAsync(scene, camera)` or render one warm-up frame to each target with the synthetic spine / one live grain; keep the synthetic-spine trick |
| `bindMatrixArray(material, name, flatArray)` | zero-copy mat4[3] upload | Three uniform of type `mat4[3]`: store `[m0,m1,m2]` `Matrix4`s whose `.elements` views alias the shadow system's flat array, or a custom `UniformsUtils`-free flat upload via `gl.uniformMatrix4fv` in `onBeforeRender`. Simplest: `uniforms.cascadeMatrices.value` = array of Matrix4 wired once, shadow system writes into their `.elements` |
| Scene camera auto-binding of `viewProjection` | all vertex shaders | compute `projectionMatrix * matrixWorldInverse` per frame (jittered where relevant) and set explicitly on each material |
| Left-handed coords (Babylon default) | whole scene | Scene is y-up, forward `(sin facing, 0, cos facing)`; all VFX math is done in world space with explicit basis vectors, and view-matrix rows are extracted manually (`m[0],m[4],m[8]` right; `m[1],m[5],m[9]` up) — in Three (right-handed, column-major `elements`) the equivalent extraction is `e[0],e[1],e[2]` / `e[4],e[5],e[6]` **of `matrixWorldInverse` rows**, i.e. `e[0],e[4],e[8]` and `e[1],e[5],e[9]` — same element indices, verify handedness against the rest of the port's convention (z-forward sign flips propagate into `facing`, `carve` side selection, and the `* side` normal flip; test debug mode 10) |
| `Constants.TEXTURE_NEAREST_SAMPLINGMODE` etc. | texture params | Three filter/wrap enums as above |
| `scene.customRenderTargets` ordering | cascades + prepass render before main pass | explicit render sequence in the port's frame loop |

---

## 6. Assets

**None.** This subsystem consumes no binary, texture, or audio assets. Every texture it
touches is procedural (its own DataTextures, the sky LUT, the shadow cascades). All
noise is computed in-shader (`snowNoise` include). Nothing to reverse-engineer.

---

## 7. Porting risks & gotchas (ranked)

1. **Depth conventions across three passes.** The wake writes cascade depth
   (`gl_FragCoord.z` analogue) and linear view depth (`clip.w`) into color targets, and
   the shadow *lookup* (`snowShadowLookup`) and depth consumers compare against them.
   WebGPU clip z ∈ [0,1] vs WebGL [-1,1], plus Babylon's non-reverse-depth cascade
   matrices, means blindly copying constants (e.g. `shadowBias` 0.018/0.05) will
   produce acne or peter-panning. Port caster and lookup together, in one convention,
   and validate with wake debug mode 7 (shadow term).

2. **Handedness / mirror-side normal (`N = cross(Pq, Pu) * side`) and the
   `inside = facing > 0` contract.** Three is right-handed; Babylon left-handed. Any
   sign flip in forward/right (`facing`, `rx = cos f, rz = -sin f`, `fwd = (-rz, rx)`)
   silently flips which wall curls which way and puts the barrel darkening on the open
   face — the BRDF hides it, the occlusion reveals it. The source comments record this
   exact bug. Use debug mode 10 (inside=red / outside=green) as the acceptance test,
   and verify plume grains leave the *outside* of a carve.

3. **`select()` argument order.** WGSL `select(f, t, cond)` is the reverse of GLSL's
   ternary. It appears ~10 times across these shaders (side picks in `wakeScalars`,
   difference-stencil sign flips, degenerate-normal fallback, facing, barrel gate,
   debug 10). One swapped pick = wrong-side amplitudes, NaN normals at patch edges, or
   inverted erosion — all subtle.

4. **Erosion coherence across passes.** `wakeEroded` must be byte-identical (same
   noise implementation, same drifting time) in beauty, shadow, and prepass fragments,
   and `wakeTime` must be the same value in all four materials in the same frame
   (source pushes it to beauty + 2 depth mats + prepass every `_pushUniforms`). If the
   GLSL `noise2` differs from the WGSL one even slightly, shadows and occlusion tear at
   different texels than the drawn surface. Port `snowNoise` once, share the chunk,
   and drive one clock.

5. **Float data-texture update path and row layout.** Both DataTextures are full
   RGBA32F re-uploads per frame with NEAREST/clamp/no-mips, addressed by
   `texelFetch(ivec2(i, row))`. Dead spray slots must keep being written (size 0,
   alpha 0). In Three, forgetting `needsUpdate` gating, letting it generate mips, or
   using `LinearFilter` (breaks texelFetch expectations on some drivers when combined
   with float) are the classic failure modes. Also: the wake uploads only when
   visible — keep that, but remember warm-up uploads the synthetic spine while
   "invisible" logic is bypassed.

6. **Draw order and depth interaction for spray.** Spray is alpha-blended,
   depth-tested but not depth-written, must render after the wake and after
   alpha-blended water (Babylon groups 1/2 + material flags). Three's transparent-pass
   sorting is by depth by default — spray is one draw call so internal sorting is
   nonexistent (source accepts unsorted overdraw; blending is order-dependent but
   visually tolerated — do not add per-particle sorting, it wasn't there). Ensure
   `renderOrder` puts it after water/wake and that the wake (opaque, group 1) renders
   after terrain but before transparents.

7. **Per-cascade material identity.** The `WAKE_CASCADE n` define exists only to defeat
   Babylon's Effect cache so each cascade holds its own `lightViewProjection`. In Three
   this constraint vanishes — you may use one material and set the uniform between
   cascade renders — but if you keep two materials, remember both need `wakeCount` /
   `wakeTime` pushed every frame (source does, in `_pushUniforms`).

8. **Uniform-array binding.** `shR` (9×vec4), `cascadeMatrices` (3×mat4),
   `cascadeParams` (3×vec4), `spellLightPos/Col` (4×vec4) are flat Float32Arrays on the
   JS side. Recreate the zero-copy pattern of `bindMatrixArray` (alias the provider's
   arrays) rather than per-frame copies, and verify Three uploads the arrays with the
   correct GLSL declaration sizes.

9. **TAA-jittered prepass camera.** `wakePrepass` must use the same jittered
   `viewProjection` as the beauty pass that frame (Babylon binds the active camera
   during the RTT render). If the port's prepass uses the unjittered matrix the
   temporal resolve smears the wake edge.

10. **Warm-up parity.** Keep `_syntheticSpine()` + a `spray.update(0, ...)` +
    compile-and-rasterize behind the loading screen; first-use pipeline compilation of
    four programs (plus the heavyweight wake fragment) is a visible hitch otherwise.

11. **Performance shape of the wake VS.** `wakePoint` runs 3× per vertex, each with a
    20-step trig loop and multiple texel fetches (≈ 128·18·2·3 ≈ 13.8k evaluations,
    ~276k loop iterations per pass, ×3 passes). Fine on desktop GL, but do not
    "optimize" by hoisting the section integral to a LUT without checking the lump
    displacement (which perturbs along the section normal at the *sampled* q) still
    matches — normals are finite-differenced from exactly this function and any
    mismatch shows as banding at the 0.3 m sample pitch.
