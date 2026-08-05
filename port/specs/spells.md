# Porting spec — subsystem `spells`

Source: `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/spells/*.js`
Shaders: `water.vertex/fragment.wgsl`, `crystal.vertex/fragment.wgsl`, `crystalDepth.vertex.wgsl`,
`crystalPrepass.vertex.wgsl`, `lib/water.wgsl` (`snowWater`), `lib/crystal.wgsl` (`snowCrystal`),
`lib/spellLights.wgsl` (`snowSpellLights`).
Target: Three.js `WebGLRenderer` (WebGL2, GLSL ES 3.0, `RawShaderMaterial`, `WebGLRenderTarget`).

---

## 1. Purpose & behavior

The spell system is five player-triggered effects ("bending" spells, keys 1–5), plus three
shared renderers/pools they all use:

- **`WaterBody`** — one mesh, one draw call, drawing up to **8 "strands"** of bent water.
  A strand is a swept surface along a spine (a 64-sample Catmull-Rom curve) with per-sample
  radius, parallel-transported reference frame, twist, foam, age, and vertical flatten.
  Two profiles: `PROFILE_TUBE = 0` (closed tube, 24 rings around the section) and
  `PROFILE_SHEET = 1` (open breaking-wave sheet re-using the wake's `wakeSection` integral).
  Strand data lives in a small float RGBA data texture updated from the CPU each frame; the
  static mesh carries only `(column, ring, strand)` integer lattice coordinates and the vertex
  shader places every vertex from the texture. A released/unused strand has zeroed rows —
  radius 0 collapses all its triangles to a point so the rasterizer skips them (plus the
  vertex shader early-outs on a per-strand `alive` flag for perf).
- **`CrystalField`** — a fixed pool of **96** hexagonal ice prisms in one data-driven mesh
  (13 verts each: base ring of 6, shoulder ring of 6, apex). Grows/sublimes over time; renders
  blended **with depth-write on** (transparency vs. terrain but no crystal-over-crystal blend);
  casts shadows into cascades 0–1 and writes the depth prepass with a specular mask of 1
  (ice is the only mirror surface — the reflection pass keys off this mask).
- **`SpellLights`** — a 4-slot CPU pool of dynamic point lights declared per frame by the
  spells and pushed as uniforms into every consumer material (terrain snow, character body and
  cloth, wake, spray, walkers, plus the water and crystal materials themselves).

The five spells (all pure CPU logic writing into shared pools; none owns GPU resources):

1. **Sweep (key 1)** — a crescent-shaped sheet of slush (fixed 5.5 m curvature radius, arc
   half-angle opening 0.52→0.96 rad as it spreads) launched flat along the aim, decelerating
   from ~11.5 m/s to walking pace over `LIFE = 2.4 s`, peak crest height 2.15 m. Uses the
   SHEET profile, milkiness 0.48. Each frame it: writes 48 spine columns following the terrain
   height (sunk 0.13 m), ploughs a channel + berms into the deformation field per metre
   travelled (one rank of 13 brushes per 0.25 m), emits crest spray (120 particles/m, cap
   150/frame), declares one light riding the crest centre (radius 9.5 m, color 0.42/0.74/1.0,
   intensity `13*env`), and adds 0.12 camera trauma at cast.
2. **Ribbon (key 2, HOLD)** — a held stream of water tracking the right hand. The spine is a
   *record of where the tip has been*: a ring buffer of 46 samples committed every 0.20 m of
   tip travel, plus the live tip written as column 0. The tip is a critically-damped spring
   (k=210, damping ratio 0.92) chasing a target = hand + 2.5 m along camera forward + a 2:1
   Lissajous figure-eight (amplitudes 1.70/0.92 with two incommensurate harmonics 0.41/0.73)
   in the camera's right/up plane; phase advances at 2.55 rad/s. Tube profile,
   `RADIUS = 0.205 m`, elliptical section (`SECTION_ASPECT = 1.55` via `flatten`), radius
   modulated by recorded tip speed (mass conservation: `stretch = clamp(1.35 - spd*0.055,
   0.55, 1.35)`), taper `smooth01(u/0.10) * pow(1-u, 1.05)`, twist `time*2.4 + dist*1.35`.
   Ground clearance flattens the section and adds foam; it scores thin lines into the snow
   (head-end 10 samples only, every 1/60 s) and sheds droplets along the body (130/s scaled).
   **On release the body is thrown**: same head point/velocity, but steered onto the aim
   (rate 5.5/s), thrust `62*exp(-3t)`, gravity, quadratic drag, speed cap 21 m/s; the tail
   drains at an increasing rate. On ground impact it **splashes**: 280–470 droplets in a wide
   low fan biased downrange, a wet shallow brush mark (packing 1.0, ice 0.85), 0.09 trauma,
   `splashCount++` (polled by the soundscape). Ribbon declares **no** light (deliberate).
3. **Bloom (key 3)** — a targeted eruption at the aim point (ground ray capped at 22 m, 13 m
   fallback). A 5.6 m column (tube, 34 columns, girth 0.66 m, milkiness 0.42) rises in ~0.34 s,
   holds, and collapses back down its own axis; it leans ~0.16 rad in a random direction with
   sinusoidal sway. At `t = 0.10 s` the one-shot burst fires: a crater brush (radius 1.15 m,
   depression 0.52, rim 0.40, packing 0.72, ice 0.30) plus 4 scattered outer-ring brushes,
   430 thrown particles, 0.28 trauma. Two lights: crater (radius 11, intensity `22*env`) and
   column head (radius 7.5, intensity `9*env`). Then a 3.4 s fallout curtain: fine
   high-drag (4.6/s) grains emitted over a 3.6 m disc, 2.2–6.4 m up, 360/s scaled.
4. **Crystallise (key 4)** — plants 34 prisms over 0.85 s along a golden-angle spiral
   (angle `i*2.39996323 + seed`, radius `0.18 + sqrt(n01)*2.05`), heights `1.75 * (1-n01*0.58)
   * rand(0.6..1.4)` m, leaning outward. Immediately glazes the ground under the formation
   (large brush: radius 1.55 m, packing 0.85, **ice 1.0** — the terrain state's ice channel
   decays on a ~15-minute constant, so the slick outlives the geometry). Crystals grow in
   0.45–1.0 s, stand `34 + rand*8` s, sublimate (retreat, not fade) over 6 s. Light: bright
   while forming (`0.35 + 12*form`), then a low flickering ember. Frost spray during planting.
   The *spell object* goes inactive after `PLANT_TIME + 1.6 s`; crystals age on their own.
5. **Vortex (key 5)** — three helical tubes (`HELICES = 3`, 64 columns each = 3 strands)
   wound around the player (who it follows), radius profile `(2.55 - 1.15h) * (0.78 +
   0.34*bell(h*1.2))` (waisted, not conical), height 4.8 m, 1.35 turns, spin rate
   `5.2 + 2.4*env` rad/s. Timeline: ramp 0.55 s, hold 3.0 s, fade 1.1 s. Tube radius is thin
   (0.125 m base) — the mass is the grains: up to 2600 particles/s emitted *on the helices*
   with the helix's tangential velocity (`7.5 - 2.6h` m/s) and short life (~0.3–0.56 s) so
   straight-line integration stays on the spiral. Strips snow from a growing ring (0.9→3.1 m)
   with **negative-depth brushes** while holding, and puts it back (negative depression +
   berm) while fading. Milkiness 0.88 (lifted snow, nearly opaque). One light at chest height,
   intensity `9*env`. 0.10 trauma at cast.

**Casting/dispatch** (`SpellSystem`): reads `input.spellPressed` (1–5, edge) and
`input.spellHeld2` (ribbon hold, polled). Aim = camera rig forward. Keys 3/4 target via
`aimPoint()` — a coarse ray-march (0.6 m steps + 8 bisection refinements) against the CPU
height mirror `terrain.heightAt(x,z)`. A `castBlend` 0..1 eased value plus aim direction is
written onto the character controller (`ch.cast`, `ch.castAimX/Y/Z`) to drive the casting
pose. `castCount`/`lastCast` are published monotonic counters polled by the soundscape.

**Frame order is load-bearing** (see `SpellSystem.update` and main.js): lights.begin() →
dispatch input → each spell `.update(dt)` (they write strands, brushes, spray, lights) →
push light uniforms into all registered consumers → `water.update()` (upload data texture +
uniforms) → `crystals.update()`. The whole `spells.update()` runs **after** the shadow refit
(so water/ice carry this frame's cascade matrices) and **before** `terrain.update()` (so the
brushes are staged when the deformation sim pass runs).

## 2. Public API

### `SpellSystem` (`spellSystem.js`)
- `new SpellSystem(scene, sky, shadows, terrain, controller, figure|null, rig, spray)` —
  constructs `SpellLights`, `WaterBody`, `CrystalField`, the five spells, and the shared
  `SpellContext` (`{controller, figure, rig, terrain, deform: terrain.deform, spray, water,
  crystals, lights, time, sprayScale, handPosition(which, out, off)}`).
- `update(dt, cameraPos: Vector3)` — once per frame in the order above.
- `cast(key: 1..5)` — programmatic cast (console/rebinds); key 2 = `holdRibbon(true)`.
- `holdRibbon(held: boolean)` — edge-detects trigger/release for the ribbon.
- `addConsumers(...materials)` — register any material that declares the spell-light
  uniforms; `lights.apply()` is pushed into each after all spells have declared.
- `registerPrepass(depthPass)` — registers only the crystals (water is refractive and must
  not write screen-space depth).
- `warmUp(x, y, z)` / `finishWarmUp()` — compiles water (both profiles!) and crystal
  pipelines behind the loading screen with real standing geometry, torn down after the
  warm-up frames actually rendered it.
- `dispose()`.
- Read-only: `activeCount`, `triangles`, `castCount`, `lastCast`, `castBlend`, `aim`,
  `debugRibbon` (console override to hold the ribbon).
- `_handPosition(which, out, off)` — figure hand position, or a synthesized point 0.35 m in
  front of the chest ±0.28 m sideways at +1.25 m when the figure is hidden.

### `SpellLights` (`spellLights.js`)
- `MAX_SPELL_LIGHTS = 4` (must match `SPELL_LIGHT_MAX` in the shader lib).
- `SPELL_LIGHT_UNIFORMS = ["spellLightPos", "spellLightCol", "spellLightCount"]`.
- Fields: `pos: Float32Array(16)` (x,y,z,radius per slot), `col: Float32Array(16)`
  (r,g,b,intensity — intensity is pre-multiplied by `scale`), `count`, `scale`.
- `begin()` — zero the count (start of frame). `add(x,y,z,radius,r,g,b,intensity)` — silently
  dropped when full or when intensity/radius ≤ 0. `apply(material)` — `setArray4` both
  arrays (always the full 4 slots) + `setFloat("spellLightCount", count)`.

### `WaterBody` (`waterBody.js`)
- Constants: `STRAND_MAX = 8`, `STRAND_COLS = 64` (data columns), `LATTICE_COLS = 176`
  (mesh columns — ~2.75 verts per data sample so the spline curvature renders smooth),
  `RING = 24` (section verts, seam duplicated: ring 23 = θ=2π), `PROFILE_TUBE = 0`,
  `PROFILE_SHEET = 1`.
- `acquire(): strandIndex | -1`, `release(s)`, `clear(s)`.
- `column(s, c, x, y, z, radius, rx, ry, rz, twist, dist, age, foam, flatten)` — write one
  spine sample into the CPU staging array (3 texture rows per strand).
- `setParams(s, profile, milkiness, alpha, count)` — per-strand vec4 uniform
  (`strandParams[s]`); count < 2 disables.
- `update(dt, cameraPos)` — counts live strands (`alpha > 0.003 && count >= 2`), toggles
  mesh visibility (`live > 0 && S.showSpells !== false`), uploads the data texture and
  pushes all uniforms.
- `liveStrands`, `triangles`, `warmUp(x,y,z)`, `finishWarmUp()`, `dispose()`.
- Mesh: one static position buffer of `(col, ring, strand)` triples, Uint32 indices,
  `(176-1)*(24-1)*6*8` indices total (~63k triangles). `alwaysSelectAsActiveMesh`, frozen
  world matrix, no bounding sync. Rendering group 2 (after opaque), `alphaIndex = 0`
  (water before spray), alpha blend (`ALPHA_COMBINE` = premultiplied-style standard
  src-alpha/one-minus-src-alpha), **no depth write**, **no face culling**.

### `CrystalField` (`crystals.js`)
- Constants: `CRYSTAL_MAX = 96`, `VERTS = 13`, `RING = 6`, `CRYSTAL_CASCADES = 2`.
- `plant(x, y, z, ax, ay, az, height, radius, growSeconds, life)` — next-free-slot ring
  scan; drops the new crystal when the pool is full. Writes 3 texture rows:
  row0 `(x,y,z,height)`, row1 `(axis xyz, radius)`, row2 `(growth, seed, tint, 0)` where
  `seed = (i*0.618034 + x*0.137 + z*0.311) % 1`. CPU-side: `age`, `life`, `grow`, `alive`.
- `update(dt, cameraPos)` — ages: grow `a/grow`, hold `1`, sublimate `1 - (a-life)/6`
  (dead at t ≥ 1); writes `growth` into row 2; uploads when visible or dirty.
- `registerPrepass(depthPass)`, `warmUp`, `finishWarmUp`, `dispose`, `liveCount`,
  `triangles` (= liveCount * 18).
- Mesh: `(crystal, vertex, 0)` positions, 18 triangles per crystal (6 side quads + 6 tip
  tris). Rendering group 1 (with the opaque terrain), alpha blend **with** forced depth
  write, no culling.

### Spell classes (`sweep.js`, `ribbon.js`, `bloom.js`, `crystallize.js`, `vortex.js`)
All share: `constructor(ctx)`, `update(dt)`, `cancel()`, `active` flag.
- `Sweep.trigger(ax, az)` — flat unit aim direction.
- `Ribbon.trigger()` / `release()` / `cancel()`; `held`, `thrown`, `blend`, `splashCount`.
- `Bloom.trigger(x, y, z)`, `Crystallize.trigger(x, y, z)` — ground target point.
- `Vortex.trigger()` — centred on the player.

### `bending.js` — shared math (all allocation-free)
`clamp01`, `clampRange`, `smooth01` (Hermite), `bell(t) = sin²(πt)`, `expDamp(cur, target,
rate, dt)`, `transport(out, o, r, t0, t1)` (parallel transport of a right vector by the
minimal rotation t0→t1, Rodrigues; passes the frame through unchanged when tangents are
parallel), `groundRay(terrain, o, d, maxDist)` (0.6 m march + 8 bisection steps; treats a
buried origin as above so a ray from inside a drift exits it), `aimPoint(out, terrain, o, d,
maxDist, fallback)`.

### Settings consumed (exact keys in `src/core/settings.js`)
`S.showSpells` (default true; gates dispatch + both mesh visibilities), `S.spellLight`
(→ `lights.scale`, 0–3), `S.spellSpray` (→ `ctx.sprayScale`, 0–2.5), `S.waterDepthTint`
(0–3), `S.fogDensity` (0.0072), `S.fogHeightFalloff` (0.045), `S.fogStart` (24),
`S.aerialStrength` (1.0), `S.ambientIntensity` (1.0), `S.sssStrength` (1.0),
`S.glintIntensity` (0.55), `S.glintGrazing` (0.72), `S.showCharacter` (hand fallback).
main.js also forces `S.showSpells = false` when `S.speeder === true`.

### Input contract (`src/core/input.js`)
`input.spellPressed` — 0 or 1..5, valid for one frame (cleared in `endFrame`).
`input.spellHeld2` — true while the ribbon key is down (cleared on pointer-lock loss etc.).

## 3. Data flow (cross-subsystem)

**Consumed:**
- `terrain.heightAt(x, z)` — CPU height mirror. Used every frame by every spell (spine
  placement, targeting rays, particle spawn heights).
- `terrain.deform.brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge)`
  — staged into the deformation sim's brush array; must be called before `terrain.update()`
  runs the sim pass. Vortex uses **negative depth** and negative compression (restoring).
- `spray.emit(x, y, z, vx, vy, vz, size, life, kind, drag)` — spray-particle pool
  (kind 0 = powder billboard, 1 = hard droplet/clod).
- `sky.lut` — 2D lat-long ProceduralTexture, HALF_FLOAT, wrapU repeat / wrapV clamp,
  mipmapped. Sampled by both water and crystal fragments for refraction, reflection, and
  aerial perspective (below-horizon texels hold the solved snow bounce — this is what makes
  the "refraction without a scene copy" trick work).
- `sky.sunDir: Vector3`, `sky.sunRadiance: Color3`, `sky.sh: Float32Array(36)` (9×vec4 SH,
  uniform `shR`).
- `shadows` (`CASCADE_COUNT = 3`): `maps[0..2]` (2048² R32F RTTs storing NDC depth as
  color, PCSS-style lookup), `matrixData` (Float32Array 48, `cascadeMatrices`), `splits`
  (→ `cascadeSplits` vec4), `paramData` (Float32Array 12, `cascadeParams`), `texelSize`
  (1/2048). `shadows.registerCaster(mesh, makeMaterialFn, cascades)` for the crystal depth
  materials.
- `depthPass.registerCaster(mesh, material)` — camera-space prepass, HALF_FLOAT RG target
  (R = linear view Z from clip w, G = specular mask).
- `rig.forward/right/up`, `rig.camera.position`, `rig.addTrauma(f)`, `rig.groundAt`.
- `controller.position`, `controller.facing`; `figure.handPosition(which, out, off)`.
- `input` (above); `expDamp` from `core/camera.js`; `whenReady`/`bindMatrixArray` from
  `core/gpuUtil.js` (bindMatrixArray pokes Babylon's ShaderMaterial internals to bind a
  mat4 array — in Three this is just a `uniforms.cascadeMatrices.value` mat4[3]).

**Produced for others:**
- **Spell-light uniforms** into every consumer material (`spellLightPos: vec4[4]`,
  `spellLightCol: vec4[4]`, `spellLightCount: float`). Consumers registered in main.js:
  `terrain.material`, `figure.bodyMat`, `figure.clothMat`, `wake.material`,
  `spray.material`, every walker material (via `walkers.onMaterial` callback). Those
  materials include `snowSpellLights` and call `spellLighting` / `spellLightingSurface` /
  `spellLightingParticle`.
- `controller.cast`, `controller.castAimX/Y/Z` — casting pose blend read by the figure.
- `castCount`, `lastCast`, `ribbon.splashCount` — polled by `audio/soundscape.js`.
- Deformation brushes and spray emissions (into subsystems above).
- Crystal depth into shadow cascades 0–1 and the camera depth prepass (mask = 1 enables the
  screen-space reflection pass's early-out; **only** crystals set a non-zero mask).
- `activeCount`, `triangles`, `water.liveStrands` — overlay stats.

**GPU resources owned:**
- `waterTex` — RawTexture RGBA **FLOAT32**, 64×24 (STRAND_COLS × STRAND_MAX*3), nearest,
  clamp/clamp, no mips. Row layout for strand *s* (rows 3s..3s+2):
  row 0 `(x, y, z, radius)`, row 1 `(rightX, rightY, rightZ, twist)`,
  row 2 `(distAlong_m, age01, foam01, flatten)`. Re-uploaded every frame the mesh is
  visible (`texSubImage2D` from the persistent Float32Array).
- `crystalTex` — RawTexture RGBA FLOAT32, 96×3, nearest, clamp, no mips. Row 0
  `(x,y,z,height)`, row 1 `(axis, radius)`, row 2 `(growth, seed, tint, spare)`. Uploaded
  when visible or dirty.
- Water mesh (~33.8k verts / ~63k tris static) + `spellWater` material.
- Crystal mesh (1248 verts / 1728 tris static) + `iceCrystal` material + 2 shadow depth
  materials + 1 prepass material.

## 4. Shader inventory

### `lib/water.wgsl` (`snowWater` include)
- `waterTexel(tex, row, col)` — `textureLoad` (→ GLSL `texelFetch(tex, ivec2(col,row), 0)`).
- `waterRow(tex, row, count, u)` — **Catmull-Rom** interpolation through the samples
  (deliberately not linear/smoothstep — smoothstep's zero derivative at knots ripples the
  differenced normal at the sample pitch). Clamped end conditions (`max(i1-1,0)`,
  `min(i1+1/2,last)`).
- `waterSpine(tex, base, count, u)` — same Catmull-Rom for row-0 xyz.
- `waterSpineTangent(...)` — the **analytic derivative** of the Catmull-Rom (a finite
  difference gives chord error periodic in the knot spacing → scalloped tubes). Falls back
  to +Y when degenerate.
- `waterRelief(u, theta, t)` / `waterReliefOpen(u, v, t)` — 2-octave gradient-noise
  displacement, frequencies **in cycles per strand** (band-limited to the lattice, on
  purpose). Tube variant samples the noise *around a circle* (`vec2(cosθ, sinθ) * 0.85/1.5`)
  so the field is periodic across the seam.
- `waterPoint(tex, base, count, profile, u, q, t)` — spine + re-orthogonalised transported
  right + `up = cross(tangent, right)`. Tube: `pos + right*cosθ*rr + up*sinθ*rr*flatten`
  with `θ = q*2π + twist`, `rr = radius*(1 + relief*0.22)`. Sheet: `wakeSection(q, twist)`
  from the `snowWake` include (an integral of a turning tangent, `WAKE_STEPS` Euler steps —
  a loop, ports directly), offset in `(right, worldY)`, relief `*0.13*smoothstep(0.1,0.7,q)`.

### `water.vertex.wgsl`
Attributes `position = (column, ring, strand)`. Uniforms `viewProjection`, `cameraPos`,
`waterCols` (=176), `waterRings` (=24), `waterTime`, `strandParams: vec4[8]`. Per-vertex:
early-out branch on strand liveness (`sp.z > 0.001 && sp.w >= 2` — keep it; it saved
1.4 ms), 4 evaluations of `waterPoint` (position + central differences with sign-flipped
offsets near the patch edges so the pair never straddles the clamp), normal =
`cross(Pq, Pu)` normalized with epsilon fallback, tube normals oriented outward against
`P - waterSpine(...)` (sheet normals left as-is; fragment flips toward the eye). Varyings:
`vWorld, vNormal, vQ, vU, vRadius, vFoam, vMilk, vAlpha, vViewDist`.

### `water.fragment.wgsl`
Discard when `vAlpha ≤ 0.003 || vRadius ≤ 0.0005`. Technique per fragment:
1. Two-sided normal (`faceforward` toward V) + two ripple octaves and one fine octave of
   `noised` gradient noise on oblique world-projected coordinates
   `fp = (dot(world, (0.88,0.31,-0.36)), dot(world, (0.24,0.79,0.56)))`, each faded by the
   screen-space footprint (`length of dpdx/dpdy of world.xz`) to kill shimmer.
2. Optical path `clamp(vRadius*(1.25 + 1.9*(1-NdotV)) * waterDepthTint, 0.01, 3.0)`;
   Beer–Lambert `transmit = exp(-WATER_ABSORB * path)` with
   `WATER_ABSORB = (3.40, 0.72, 0.34)` (artistically exaggerated).
3. **Refraction with dispersion, no scene copy**: `refract(-V, N, 1/η)` at η = 1.3300 /
   1.3330 / 1.3400 per channel; TIR (zero vector, test `dot(r,r) > 0.5`) falls back to the
   mirror direction; one `textureSampleLevel(skyLUT, ..., lod 1.6)` per channel via
   `dirToLatLong`; `color = behind * transmit`.
4. Internal scatter: `backScatter(N,L,V,0.55,2.6,1.0) * sun * (1/π) * scatterTint *
   (0.55 + 1.3*milk) * sssStrength * mix(0.30,1,shadow)` where
   `scatterTint = mix((0.40,0.80,1.0),(0.72,0.94,1.0),exp(-path*1.6))`; plus SH ambient
   through the same tint.
5. Slush: when `milk > 0.002`, a full diffuse+SH+subsurface snow response with albedo
   `(0.86,0.90,0.96)` mixed in by `milk * 0.85`.
6. Foam: noise-broken (`noise2` at ×22 and ×61) white lit layer mixed by foam.
7. Fresnel sky reflection: `min(fresnelSchlick(NdotV, 0.02), 0.72)` (capped — full Schlick
   deletes the volume at the silhouette), sampled at lod 0.7, attenuated by
   `(1 - foam*0.7)*(1 - milk*0.88)`. GGX sun glint with roughness
   `mix(0.055, 0.68, max(foam*0.55, milk))`. `snowGlints` sparkle keyed to
   `glintIntensity/glintGrazing`.
8. `spellLightingSurface` when `spellLightCount > 0.5` (the body lit by its own emitter).
9. Alpha: `taper = clamp(vRadius/0.055, 0, 1)`;
   `alpha = mix(taper * mix(0.74, 0.97, 1-NdotV), taper, max(foam, milk*0.9)) * vAlpha`;
   discard < 0.004. Deliberately near-opaque — the refracted lookup already carries the
   background, and blending it in again washes the body out.
10. `applyAerial(...)` fog/aerial perspective, then `vec4(color, alpha)` out.
Also uses `sunShadow(world, geoN, viewDist, noiseRot)` from `snowShadowLookup` (3-cascade
PCSS over the R32F cascade maps, `ign()` interleaved-gradient-noise rotation), shadowSoftness
1.4, shadowBias 0.03 (crystals: 1.3 / 0.012).

### `lib/spellLights.wgsl` (`snowSpellLights`)
`SPELL_LIGHT_MAX = 4`. `spellAttenuation(dist2, radius)` — windowed inverse square:
`win = (1 - (d²/r²)²)²`, denominator `dist2 + 0.25` (soft core so on-snow emitters don't
burn a white disc), exactly 0 at the radius. Three entry points:
- `spellLighting(world, N, V, albedo, thickness, sssStrength, sssRadius, pos[4], col[4],
  count)` — for **snow**: wrapped diffuse (wrap 0.66) + the same `snowSubsurface`
  transmission lobe the sun uses (spells light snow *from inside* the drift).
- `spellLightingSurface(world, N, V, albedo, f0, roughness, wrap, ...)` — non-snow
  surfaces: wrapped diffuse + GGX. No transmission.
- `spellLightingParticle(world, N, albedo, ...)` — single wide-wrap (0.8) diffuse for spray.
Loop is `for i < 4 { if (i >= count) break; }` — fine in GLSL ES 3.0 as-is.

### `lib/crystal.wgsl` (`snowCrystal`)
`CRYSTAL_RING = 6`, `CRYSTAL_VERTS = 13`. `crystalLocal(v, height, radius, seed)` — apex
(v = 12) jittered off-axis by `hash22`; ring verts at 60° spacing rotated by `seed*2π`, per-
spoke radial wobble `0.72 + 0.56*hash21(...)`; shoulder ring at `0.68 r`, `0.58 h`.
`crystalPoint(tex, i, v)` — reads rows 0..2, growth curves: height `g²(3-2g)` (fast), radius
`0.22 + 0.78*smoothstep(0.25, 1, g)` (lags — "spears up, then thickens"); frame built from
the growth axis with a stable perpendicular. Integer division `v / CRYSTAL_RING` and
`v - ring*CRYSTAL_RING` — GLSL ES 3.0 int ops are fine.

### `crystal.vertex.wgsl`
`textureLoad` rows 0 and 2, `crystalPoint`, varyings `vWorld, vBase, vHeight01
(= clamp((P.y - base.y)/height, 0, 1)), vSeed, vGrowth, vViewDist`. No normal emitted.

### `crystal.fragment.wgsl`
Facet normal from `normalize(cross(dpdx(world), dpdy(world)))` flipped toward V — exact flat
facets with hard edges (the look of ice). Then, same skeleton as water with ice constants:
frost band in the bottom fifth (`(1 - smoothstep(0.01, 0.22, vHeight01)) * (0.45 +
0.6*grain)`, grain = `noise2(world.xz*34 + seed*19)`); path `clamp((0.16 + 0.42*(1-h01)) *
(0.7 + 2*(1-NdotV)), 0.02, 1.4)`; `ICE_ABSORB = (2.35, 0.60, 0.24)`; dispersion at η =
1.3050/1.3090/1.3170, skyLUT lod 0.9; back-scatter `backScatter(N,L,V,0.42,2.2,1.0)` with
`deepTint = mix((0.42,0.74,1.0),(0.86,0.95,1.0),exp(-path*2.5))` ×1.6×sssStrength; frosted
skin layer; Fresnel (f0 0.021) with reflection lod `rough*6` where
`rough = mix(0.045, 0.42, frost)`; GGX sun; glints; `spellLightingSurface`; aerial.
Alpha: `clamp(0.46 + 0.34*(1 - exp(-path*2.2)) + 0.26*(1-NdotV) + frost*0.55, 0, 1)`.
**Blend state: alpha blending with depth write ON, depth test ON** — the whole trick.

### `crystalDepth.vertex.wgsl`
Same `crystalPoint`, `lightViewProjection` uniform, paired with `terrainDepth.fragment`
(writes `position.z` — NDC depth — into the R32F cascade color target). Has a
`CRYSTAL_CASCADE n` define (unused in the shader body; one material instance per cascade).

### `crystalPrepass.vertex.wgsl`
Same `crystalPoint`, camera `viewProjection`; varyings `vViewZ = clip.w` (linear view depth)
and `vMask = 1.0`; paired with `prepass.fragment` (`color = vec4(vViewZ, vMask, 0, 1)`).

### WGSL → GLSL ES 3.0 notes for these shaders
- `textureLoad(tex, vec2i, 0)` → `texelFetch(sampler2D, ivec2, 0)`. All data-texture reads
  are texelFetch — no filtering needed on `waterTex`/`crystalTex` (nearest, but Catmull-Rom
  is done manually in-shader, so plain unfiltered float textures work; use
  `RGBA32F`/`FloatType` `DataTexture` with `NearestFilter`, `ClampToEdgeWrapping`,
  `flipY = false`, and remember `needsUpdate = true` per frame).
- `textureSampleLevel(t, s, uv, lod)` → `textureLod(t, uv, lod)` — the skyLUT **must have
  mips** and `EXT_color_buffer_float` + `OES_texture_float_linear` (linear filtering of
  float/half-float) must be present; use HalfFloatType with `generateMipmaps`.
- `select(a, b, cond)` → `cond ? b : a` (note argument order!) or `mix` with a step for
  vectors.
- `dpdx/dpdy` → `dFdx/dFdy` (standard in ES 3.0).
- `inverseSqrt` → `inversesqrt`; `vec2i` → `ivec2`; `f32()`/`i32()` casts → `float()`/`int()`.
- `refract()` returning exact zero on TIR: identical semantics in GLSL; keep the
  `dot(r,r) > 0.5` test.
- Uniform arrays: `strandParams: array<vec4f,8>`, `shR: array<vec4f,9>`,
  `cascadeMatrices: array<mat4x4f,3>`, `cascadeParams: array<vec4f,3>`,
  `spellLightPos/Col: array<vec4f,4>` → plain GLSL uniform arrays
  (`uniform vec4 strandParams[8];` etc.) — sizes are small, no UBO needed, but a shared
  UBO for the sky/shadow/fog block is a reasonable upgrade.
- Babylon WGSL boilerplate (`vertexInputs`/`vertexOutputs`/`fragmentInputs`/
  `fragmentOutputs`, `uniforms.` prefix) must be stripped; `input.position.xy` in the
  fragment shader is `gl_FragCoord.xy`.
- `#include<...>` → your own string-concatenation / template of the ported GLSL libs.
  Dependency order for water fragment: noise → shading → spellLights → atmosphere →
  shadowLookup (`sunShadow` uses the cascade uniforms declared before its include).
- Loops with `break` on a uniform (`spellLighting`, `wakeSection`'s fixed `WAKE_STEPS`) are
  legal ES 3.0.
- No storage textures, no textureGather, no compute — everything here is vanilla
  vertex/fragment.

## 5. Babylon machinery → Three.js equivalents

| Babylon | Used for | Three.js WebGL2 equivalent |
|---|---|---|
| `ShaderMaterial` (WGSL, named uniforms/samplers) | water, crystal, depth, prepass materials | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: THREE.GLSL3`) with explicit `uniforms` |
| `RawTexture.CreateRGBATexture(..., TEXTURETYPE_FLOAT, NEAREST)` + `.update(data)` | `waterTex` 64×24, `crystalTex` 96×3 | `THREE.DataTexture(data, w, h, RGBAFormat, FloatType)`, `NearestFilter`, `ClampToEdgeWrapping`, `flipY=false`; set `needsUpdate = true` after mutating the backing array |
| `Mesh` + `VertexData` (positions = lattice indices, Uint32 indices) | water lattice, crystal pool mesh | `BufferGeometry` with a `Float32BufferAttribute` "position" holding the index triples + `Uint32BufferAttribute` index (WebGL2 supports uint32 indices natively) |
| `mesh.renderingGroupId` 1 / 2 + `scene.setRenderingAutoClearDepthStencil(1/2, false)` | draw order: crystals with opaque, water after opaque with spray | Three sorts transparent after opaque automatically; use `renderOrder` (crystals: opaque-ish order with `material.transparent = true, depthWrite = true`; water: `transparent = true, depthWrite = false, renderOrder` before spray) — or run explicit passes if the port uses a manual pass list |
| `mesh.alphaIndex = 0` (water before spray within group 2) | transparent sort override | `renderOrder` (lower first) |
| `Constants.ALPHA_COMBINE`, `needAlphaBlending()`, `disableDepthWrite`, `forceDepthWrite` | blend/depth states | `material.transparent = true`, `blending = NormalBlending`, `depthWrite = false` (water) / `true` (crystal), `depthTest = true` |
| `mat.backFaceCulling = false` | both materials | `side: THREE.DoubleSide` |
| `alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | skip culling for GPU-placed geometry | `mesh.frustumCulled = false`, `matrixAutoUpdate = false` |
| `shadows.registerCaster(mesh, makeMat, 2)` + per-cascade `ShaderMaterial` with `defines` | crystal shadow into cascades 0–1 | render the crystal mesh into the cascade `WebGLRenderTarget`s with an override depth material (one material, set `lightViewProjection` uniform per cascade — the `CRYSTAL_CASCADE` define is vestigial) |
| `depthPass.registerCaster(mesh, mat)` | crystal prepass (viewZ + mask) | draw into the prepass `WebGLRenderTarget` (RG half-float) with the prepass material |
| `bindMatrixArray(m, "cascadeMatrices", data)` | mat4[3] upload without per-frame alloc | `uniforms.cascadeMatrices.value = [Matrix4 ×3]` (or a flat Float32Array with a manual uniform) — trivial in Three |
| `whenReady(material, ...)` + standing warm-up geometry | pipeline warm-up | `renderer.compile(scene, camera)` compiles GLSL, but WebGL programs also link lazily per state — replicate the trick: render a few frames with the warm-up strands/crystal standing, then clear them. Cheaper on WebGL than WebGPU but first-use shader compile can still hitch |
| `ShaderStore` `#include<...>` registry | shared WGSL libs | string templates / `ShaderChunk`-style concatenation of your ported GLSL libs |
| `ShaderLanguage.WGSL`, `uniforms.` prefix, `FragmentInputs` | WGSL scaffolding | plain GLSL `in/out`, `uniform`, `gl_FragCoord` |
| `Vector3/Color3/Vector4` set-per-frame (`setVector3`, `setColor3`, `setArray4`, `setFloat`) | uniform pushes | direct `uniforms.x.value` writes; keep the "push everything each frame while visible" model |
| Left-handed coordinates (Babylon default) | all world-space math | The subsystem's own math is handedness-agnostic (cross products are self-consistent), **but** it exchanges world positions/directions with terrain, camera, shadows, sky. Follow the project-wide convention chosen for the port; if the port flips Z, the flip happens in the shared systems and spells inherit it untouched — do not hand-flip anything inside spells. Watch `wakeSection` and the sweep's `right = (dz, -dx)` convention if the ground plane orientation changes. |

## 6. Assets

None. The spell subsystem loads no binary, texture, or audio assets. All geometry is
procedurally built at construction; both data textures are populated from CPU arrays.
(Audio *reacts* to spells via polled counters, but lives in the soundscape subsystem.)

## 7. Porting risks & gotchas (ranked)

1. **Crystal "blended + depth-write" state.** Three.js treats `transparent: true` as
   "sort into the transparent pass, usually no depth write". Crystals need
   `transparent: true` **and** `depthWrite: true`, rendered with/right after the opaque
   terrain (Babylon group 1) and *before* the depth-testing water/spray. If the port's pass
   ordering puts all transparents together, blue smears or missing snow-through-ice will
   result. Verify draw order explicitly with `renderOrder`, and confirm the depth buffer is
   not cleared between the opaque pass and the water pass (Babylon explicitly disables
   auto depth clear for groups 1 and 2).
2. **Float texture chain.** `waterTex`/`crystalTex` are RGBA32F fetched with `texelFetch`
   (safe everywhere), but the **skyLUT is sampled with `textureLod` at fractional lods
   (0.7 / 0.9 / 1.6) and linear filtering** — requires `OES_texture_float_linear` (for
   half-float: standard in WebGL2 via `EXT_color_buffer_half_float` + linear filtering
   which is core for half-float). Also ensure the skyLUT `WebGLRenderTarget` generates
   mips (`generateMipmaps: true`, min filter `LinearMipmapLinear`) — the mid-mip blur *is*
   the water's "frosted background" look; without mips the refraction aliases hard.
3. **DataTexture `flipY` / row addressing.** Babylon RawTexture row 0 = the first row of
   the Float32Array; the shaders address rows with `texelFetch(..., ivec2(col, row))`.
   Three's `DataTexture` defaults `flipY = false` (correct) but any accidental flip or
   UNPACK_FLIP inverts strand rows (position row swapped with foam row → garbage
   geometry). Same for the 96×3 crystal texture. Write a one-strand visual test first.
4. **Catmull-Rom + analytic tangent must be ported exactly.** The comments document three
   past artifacts (smoothstep knot ripple, finite-difference frame wobble, relief past
   Nyquist → "vertebrae"). Any "simplification" here (linear interp, FD tangents,
   world-space relief frequencies) reintroduces documented visual bugs. Port
   `waterRow/waterSpine/waterSpineTangent/waterRelief` verbatim, including the clamped end
   indices and the sign-flipped central differences in the vertex shader.
5. **`select()` argument order.** WGSL `select(f, t, cond)` returns `t` when cond is true —
   the *opposite* operand order to GLSL's `mix(x, y, a)` habit and to a naive ternary
   translation. There are ~15 `select`s across these shaders (TIR fallbacks, normal
   orientation, degenerate-frame fallbacks); one flipped select gives inverted normals or
   black tubes. Translate each as `cond ? t : f` mechanically.
6. **Warm-up semantics differ but still matter.** On WebGL the expensive part is shader
   compile+link on first draw, which can be a 100 ms+ hitch on first cast. Keep the
   pattern: build both water profiles + a crystal as real standing geometry, render ~3
   hidden/loading frames, then `finishWarmUp()`. `renderer.compile()` alone does not
   exercise the exact program/state combination for RTT depth/prepass variants.
7. **Frame-order coupling.** `spells.update()` must run after the shadow cascade refit and
   before the terrain deformation sim consumes the brush queue; `lights.apply` must be
   pushed into consumers after all spells declared and before any material renders. If the
   port reorganizes the frame loop, a one-frame light lag or brushes landing a frame late
   will read as "the mark chases the wave".
8. **Uniform array upload cost.** The water material pushes ~30 uniforms every visible
   frame including a mat4[3] and vec4[9]+vec4[8]+vec4[3]+vec4[4]×2 arrays; Three re-uploads
   uniform arrays each draw. Fine at 2 materials, but if the port batches consumer
   materials, prefer a shared UBO for the sky/shadow/fog block to avoid redundant
   `uniform4fv` traffic across the ~7 spell-light consumer materials.
9. **`spellAttenuation` soft-core constant (0.25) and the intensity pre-scale** (`S.spellLight`
   baked into `col.w` on `add()`) are behavioral details tests will miss — clipped white
   discs under Bloom or a global brightness change on the overlay slider are the symptoms.
10. **Degenerate-strand safety.** Released strands are zeros: the shaders rely on radius-0
    collapse plus epsilon guards (`max(rlen,1e-8)`, tangent fallback to +Y). Keep every
    epsilon; NaN vertices on one frame after a spell ends is the failure mode. Also keep
    the vertex-shader `alive` early-out (measured 1.4 ms saved).
