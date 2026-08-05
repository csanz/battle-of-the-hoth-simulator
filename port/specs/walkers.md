# Porting spec — subsystem: `walkers`

Source files (Babylon.js/WebGPU original, do not modify):

- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/walkers/walker.js`
- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/walkers/walkerAsset.js`
- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/walkers/bolts.js`
- Shaders: `src/shaders/walker.vertex.wgsl`, `walker.fragment.wgsl`, `walkerDepth.vertex.wgsl`,
  `walkerPrepass.vertex.wgsl`, `bolt.vertex.wgsl`, `bolt.fragment.wgsl`, `lib/walkerSkin.wgsl`
  (registered in `src/shaders/registry.js` as `snowWalkerSkin` include; depth passes reuse
  `terrainDepth.fragment.wgsl` and `prepass.fragment.wgsl`)
- Baker: `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/tools/bakeWalker.mjs`
- Assets: `public/models/walker.bin`, `walker_albedo_{0..3}.webp`, `walker_orm_{0..3}.webp`
  (fetched via `src/core/assets.js` `fetchAsset` — Vercel Blob store first, same-origin fallback)

Target: Three.js `WebGLRenderer` (WebGL2 / GLSL ES 3.0), `RawShaderMaterial`/`ShaderMaterial`,
`WebGLRenderTarget`-based shadow cascades and depth prepass.

---

## 1. Purpose & behavior

A herd of up to 8 imported quadruped machines ("AT-AT-like walkers", ~22.5 m tall at scale 1)
lumbering across a procedural snow field toward the player. Purely scenery: they never hit the
player and have no gameplay state. Each walker is drawn **five times per frame**: beauty pass,
three shadow cascade passes, depth prepass. All five run the identical vertex-side skinning code
from one shared include so the surfaces agree by construction.

### Animation model — baked replay, not a skeleton

There is no runtime skeleton. `tools/bakeWalker.mjs` flattened the glTF node graph, inverse binds
and keyframe interpolation offline into a flat table of world-space skinning matrices: one walk
cycle, resampled at **24 fps** (`FPS = 24`), `frameCount × boneCount × 12` floats (3 basis columns
+ translation per bone, 3×4 affine), quantised to Int16. Runtime animation is: pick the two frames
around `phase`, lerp all 12 components, compose the head-look rotation (for head-chain bones only),
then multiply by the walker's world transform, and write the result into a shared RGBA32F
"transform texture". Component-wise lerp of matrices is acceptable because neighbouring frames are
< 2° apart.

The **vertex buffer stays in bind space**; the shader skins it. There is *no model matrix anywhere
in the walker pipeline* — the baked matrices arrive already multiplied by the walker's world
transform, so `walkerPoint()` output is world space, and the mesh's Object3D world matrix is
identity forever (`freezeWorldMatrix`).

### Per-walker runtime state and behavior

Solved at runtime because they depend on the world:

- **heading (`yaw`)**: aimed at the player exactly once when placed, then *never corrected* — a
  walker walks past you, it does not follow you. When it gets `RECYCLE = 520` m from the player
  (or `LEASH = 900` m from origin), `WalkerHerd.place()` re-places it on the far horizon
  (mirrored bearing `yaw + π`) and aims it once more.
- **ground**: four terrain-height probes under the footprint corners
  (`±bounds.max[0]*0.82*scale`, `±bounds.max[2]*0.82*scale` in the body frame). Mean → standing
  height; differences → stance plane slopes (`dFwd`, `dRight`). The plane is followed at
  `TILT = 0.55` and eased (`expDamp` rates: height 2.2, up-vector 1.6). First settle snaps
  (no easing). The hull sits `0.35 * scale` m *below* the smoothed ground ("feet through the
  crust"). World frame is composed by re-orthogonalising the level heading against the smoothed
  up vector: `right = cross(up, fwd)`; columns are `right*scale, up*scale, fwd*scale, position`.
- **speed**: `baseSpeed` (m/s at scale 1) was *measured* by the baker from how fast a planted foot
  slides backwards through the body frame (in-place clip). Ground speed
  `= baseSpeed * S.walkerScale * S.walkerSpeed * rateBias`, and the gait phase advances at
  `(S.walkerSpeed * rateBias) * dt / duration` — the same multiplier drives both, which is the
  entire anti-foot-skating mechanism. **Never scale one without the other.**

### Placement / opening shot

`place(walker, target)`:
- **First placement** (boot): laid out in *angles*, fractions of the horizontal half-field
  (`halfH = atan(tan(fov/2) * aspect)`, Babylon fov is vertical). Herd bearing biased toward the
  sun: `toSun = sunAzimuth(rad) - rig.yaw` (wrapped), `want = toSun * SUN_REACH(0.62)`, clamped to
  `±halfH * SUN_BIAS(0.5)`; per-walker spread `span = i - (count-1)/2` times
  `min(SPREAD_MAX(0.30), halfH * SPREAD(0.30))` radians. Lateral offset in metres = 0.
- **Recycled**: `bearing = walker.yaw + π`,
  `lateral = side * SPAWN_SPREAD(46) * scale + (i % 3) * 11 - 11`, where
  `side = (i%2? -1:1... actually (i % 2 === 0 ? 1 : -1) * ceil(i/2))`.
- Both: `depth = SPAWN_DISTANCE(200) + (i % 3) * 30`; position =
  target + `sin/cos(bearing) * depth` ± lateral rotated; `y = terrain.heightAt(x,z)`;
  `yaw = atan2(tx - x, tz - z)` (aim at player once); `phase = (i * 0.37) % 1`;
  `_settled = false`.

### Separation — by tempo, not position

All walkers converge on the player, so pairs closer than `SEPARATION(30) * S.walkerScale` metres
are eased apart **by trimming gait tempo** (`rateBias`), never by nudging position (positional push
causes visible crabbing). Per overlapping pair: `crowd = 1 - d/sep`; the one further from the
player gets `_rateWant -= crowd * 0.22`, the nearer `+= crowd * 0.12`; final clamp
`[0.55, 1.25]`; eased with `expDamp(rate = 1.4)`.

### Footfalls (for audio)

`deriveFootfalls(anim, header)` — derived from the baked clip at load, no bake data needed. Per
bone, track min/max of translation Y (component index 10 of the 12, × `transScale`) across frames.
Candidate feet: bones with vertical `range > 0.6` m, sorted by *lowest* Y (depth, not travel —
soles are the deepest things). Take up to `MAX_FOOTFALLS = 4` phases (`lowestFrame / frameCount`),
de-duplicated wrap-aware within 0.07. Each frame, `step()` counts phases crossed (wrap-aware) into
`walker.stepCount`; the soundscape *polls* `stepCount` and plays a step per increment (same
contract as spell cast counters — walkers own no mixer).

### Head derivation & look-at

`deriveHead(asset, header)` — nothing in the file names bones; geometry decides. For each bone:
centroid of the vertices it dominates (largest of the 4 weights), pushed through that bone's
frame-0 matrix (dequantised) into the standing frame; bones with < 8 vertices ignored. Head-chain
bones = live bones with `z >= bounds.max[2]*0.40 && y >= bounds.max[1]*0.55` (front and high —
takes the neck too, so no collar seam). Outputs:
- `bones`: Uint8Array flags per bone (or null if none found)
- `pivot`: `[0, pivotY, pivotZ]` — rearmost (min z) head bone, x forced to centreline
- `height`: headTop (for look-down pitch)
- `muzzles`: two Float32Array(3) at `[±1.05, chinY, noseZ + 1.2]` where
  `chinY = headBottom + (headTop-headBottom)*0.18`
- `aim`: `[0, chinY, noseZ + 1.2 + 40]` — a point straight out of the face

Per frame `_aimHead(dt, target)`: within `LOOK_RANGE = 260` m, want-yaw = bearing to player
relative to body heading, clamped `±LOOK_YAW_MAX(0.62)`, want-pitch =
`min(LOOK_PITCH_MAX(0.26), atan2(headHeight * S.walkerScale, dist))`, both scaled by proximity
fade `near = 1 - dist/LOOK_RANGE`; eased with `expDamp(rate = LOOK_EASE = 0.8)`. Builds a 3×4
`R = T(pivot) · Ry(yaw) · Rx(pitch) · T(-pivot)` in the walker's local frame. In `_writeRows` this
is composed as `world * (head * bone)` **only for flagged head bones**, so the baked gait still
rocks the head underneath the look.

### Firing

`_fire(dt)`: disabled if `S.walkerFire === false` or no muzzles. Timer-based; initial timer
`FIRE_INTERVAL * (0.4 + 0.6 * ((index * 0.41) % 1))`. If player farther than
`FIRE_RANGE(=LOOK_RANGE=260) * S.walkerScale`, re-check in 0.6 s. A burst is 2 bolts,
`FIRE_STAGGER = 0.11` s apart (alternating barrels); between bursts
`FIRE_INTERVAL(3.4) * (0.75 + rand*0.5)`. Muzzle world position/direction: local chin point →
head rotation (if active) → world 3×4. Spray: dir += `(rand-0.5)*FIRE_SPRAY(0.055)` on two axes,
re-normalised. Increments `shotCount` (polled by soundscape), calls
`herd.onShot(walker)` → `bolts.spawn(muzzle, muzzleDir)`. Deliberately *not aimed at* the player.

### LOD

`LOD_PIXELS = [420, 150]` projected hull-height pixels, hysteresis `1.22` (enter at threshold,
leave at threshold/1.22). Projection: `px = (height * S.walkerScale / dist) * pxPerMetre`,
`pxPerMetre = renderHeight / (2 tan(fov/2))` — recomputed every frame (FOV widens with speed).
The shipped bake has **one LOD** (decimation eats the legs — 57 primitives, meshoptimizer can't
collapse across primitive boundaries; see `LOD_SPEC` note in the baker), so the selector clamps to
the coarsest existing level; the machinery must survive the port (swap `BufferGeometry` on one
mesh, materials unchanged, so shadow/prepass registrations follow for free).

### Bolts (`bolts.js`)

Fixed pool of `POOL = 16` camera-facing ribbons drawn in **one draw call**, placed entirely from a
16×2 RGBA32F data texture (row 0: origin.xyz + life 0..1; row 1: dir.xyz + ribbon length).
Constants: `LIFE = 0.22` s, `REACH = 620` m (≈3 km/s), `LENGTH = 26` m ribbon, `WIDTH = 0.9` m
half-width. The lattice mesh carries one vec3 attribute per vertex: `(boltIndex, t∈{0,1},
side∈{-1,+1})`, 4 verts / 2 tris per bolt. Spawning writes 8 floats into the staging array —
no allocation, no buffer upload beyond the once-per-frame texture update.

Impact is solved **on the frame of firing**: ray-march the terrain heightfield (`MARCH_STEP = 5` m
up to REACH, then `MARCH_REFINE = 7` bisection steps), convert distance to time-of-flight at
`REACH/LIFE` m/s, store `_hitIn`. Skips: `dir.y > 0.02` (upward), muzzle already underground.
When `_hitIn` expires: `_impact(slot)` —
- spray: `(IMPACT_SPRAY=260) * S.spellSpray` grains via `spray.emit(x,y,z, vx,vy,vz, size, life,
  clod, gravityish)` in a cone biased along the bolt line and mostly up; 42% "clods".
- terrain deformation: one main `deform.brush(x, z, CRATER_RADIUS(2.4)*scale, CRATER_DEPTH(0.72),
  CRATER_BERM(0.55), compression=1.0, ice=0.95, yaw=atan2(dz,dx), elongation=1.2, edge=1.0)` +
  4 random ragged ring brushes (`radius 0.7..1.5 * scale`, depth 0.22, berm 0.4, comp 0.7,
  ice 0.35). The **ice channel** glazes the crater floor — the read is "burned, not dug".
  `scale = max(0.5, S.walkerScale)`.
- bolt life clamped to ≤ 0.04 s so it does not fly through the dune.

Per frame `update(dt, cameraPos)`: decrement lives, fire impacts, write `life/LIFE` into
`_data[i*4+3]`, upload texture, set uniforms. `mesh.isVisible = live > 0`. The `ctx.look` callback
(unused by walkers, used by the speeder's reuse of this class) overrides color/width/reach per
frame; absent, walker defaults: color `(1.0, 0.42, 0.16)`, `boltWidth = 0.9 * max(0.4,
S.walkerScale)`, `boltReach = 620 * max(0.4, S.walkerScale)`.

### Budget invariants worth preserving

- One set of vertex buffers per LOD shared by the whole herd (adding a walker = 1 mesh + 5
  materials + 4 texture rows, zero geometry).
- The whole herd's pose is **one texture upload per frame** (a few KB).
- Zero per-frame allocation (module-scope scratch vectors, pre-sized staging arrays).
- Meshes are never frustum-culled (`alwaysSelectAsActiveMesh`) — culling the beauty pass would
  also drop them out of the shadow cascades where an off-screen walker still casts across screen.

---

## 2. Public API

### `src/walkers/walker.js`

- `export const MAX_WALKERS = 8` — sizes the shared transform texture at build time.
- `export class WalkerHerd`
  - `constructor(scene, terrain, sky, shadows, asset, rig)`
    - `terrain`: needs `heightAt(x, z)` and `.deform.brush(...)`
    - `sky`: needs `.lut` (equirect sky texture with mips), `.sunDir` (Vector3), `.sunRadiance`
      (Color3), `.sh` (Float32Array 9×4 — SH irradiance coefficients as vec4s)
    - `shadows`: needs `.maps[3]` (R32F cascade textures), `.matrixData` (Float32Array 48),
      `.splits` (Float32Array 4), `.paramData` (Float32Array 12), `.texelSize` (1/2048),
      `.registerCaster(mesh, (cascade) => material, cascadeCount)`
    - `asset`: result of `loadWalkerAsset`
    - `rig`: needs `.yaw` and `.camera.fov` (vertical, radians)
  - Fields (read externally): `walkers[]` (each with `.position`, `.yaw`, `.phase`,
    `.stepCount`, `.shotCount`, `.muzzle`, `.material`, `.mesh`), `bolts`, `count`,
    `footfalls`, `boneCount`, `frameCount`, `duration`, `baseSpeed`, `height`, `bounds`,
    `walkerTex`, `albedoTex`, `ormTex`, `factors`
  - `onMaterial: ((mat) => void) | null` — called with each *new* walker's surface material when
    the herd grows after boot (live `walkerCount` slider); `main.js` sets it to
    `(m) => spells.addConsumers(m)`.
  - `onShot: (walker) => void` — default `(w) => this.bolts.spawn(w.muzzle, w.muzzleDir)`.
  - `setCount(n)` — grow lazily / park (never destroys); clamped `[0, MAX_WALKERS]`.
  - `place(walker, target)` — see §1.
  - `setSpray(sprayField)` — injects the scene's single `SprayField` into `bolts.ctx.spray`.
  - `registerPrepass(depthPass)` — registers every walker (and future ones) with the depth
    prepass; `depthPass.registerCaster(mesh, prepassMaterial)`.
  - `setVisible(v)` — herd visibility (`S.showWalker`); also hides the bolt mesh until next update.
  - `update(dt, target)` — simulation: live `walkerCount` check, `step()` all, tempo separation,
    `settle()` all (ground + world + head + fire + write texture rows), then **one**
    `walkerTex.update(texData)`.
  - `sync(cameraPos)` — per-frame uniforms + LOD selection per walker, then
    `bolts.update(lastDt, cameraPos)` (after walkers, so a bolt fired this frame is placed).
  - `get triangles` — drawn triangle count for the perf overlay (`bolts.live * 2 + per-walker
    LOD triangleCount`).
  - `async warmUp()` — compiles every pipeline behind the loading screen (`whenReady(material,
    label, [mesh, false])` for surface, all depth mats, prepass mat, then `bolts.warmUp()`).
  - `dispose()`.

### `src/walkers/bolts.js`

- `export class Bolts`
  - `constructor(scene, ctx?)` — `ctx = { terrain, spray, look? }`; omitted → bolts draw but no
    impacts. `look: () => ({r,g,b,width,reach})` read every frame (speeder reuse).
  - `spawn(originVec3, dirUnitVec3)`
  - `update(dt, cameraPos)`
  - `async warmUp()` — fakes one live bolt (life=1, dir=(0,0,1), length) so the pipeline compiles
    against real data, then zeroes it.
  - `dispose()`; fields `live`, `mesh`, `material`, `texture`.
- `export { REACH as BOLT_REACH }` (620).

### `src/walkers/walkerAsset.js`

- `export async function loadWalkerAsset(base, opts?)` — `base` is a path prefix without
  extension (e.g. `"models/walker"`); `opts.srgbAlbedo` (default false) decodes albedo bytes
  sRGB→linear via a 256-entry LUT on load (never applied to ORM). Returns `WalkerAsset` (§6).
- `export { layersFor as walkerTextureLayers }` — `max(4, materials.length)`.
- **Shared with the speeder subsystem** — the same loader and container load the speeder prop
  (`boneCount === 1`, one identity-correction "bone").

### Settings consumed (exact keys in `src/core/settings.js`, live-tweakable)

| key | default | use |
|---|---|---|
| `S.showWalker` | `true` | visibility (via `onChange("showWalker")` in main.js) |
| `S.walkerCount` | `2` | herd size, checked every `update()` (max 8) |
| `S.walkerScale` | `1.0` | uniform scale (0.4–3) |
| `S.walkerSpeed` | `1.0` | gait rate multiplier (0–5) |
| `S.walkerSnow` | `0.45` | `snowCover` uniform, snow settled on hull |
| `S.walkerFire` | `true` | cannons on/off |
| `S.sunAzimuth` | `118` (deg) | opening-shot bearing math |
| `S.fogDensity` `0.0072`, `S.fogHeightFalloff` `0.045`, `S.fogStart` `24`, `S.aerialStrength` `1.0`, `S.ambientIntensity` `1.0` | | forwarded as fragment uniforms every `sync()` |
| `S.spellSpray` | `1.0` | impact spray count multiplier (bolts) |

### Frame call order (from `src/main.js`)

1. Boot: `loadWalkerAsset("models/walker")` (parallel with other loads) → `new WalkerHerd(scene,
   terrain, sky, shadows, asset, rig)` → `onChange("showWalker", ...)` →
   `walkers.registerPrepass(depthPass)` → `walkers.setSpray(spray)` →
   `walkers.onMaterial = (m) => spells.addConsumers(m)` and
   `for (w of walkers.walkers) spells.addConsumers(w.material)` → `applyOpening(...)` (may move
   walkers/phases) → soundscape gets `walkers` to poll → `walkers.sync(...)`, `await
   walkers.warmUp()` behind the loading screen.
2. Per frame: `character` updates → **`walkers.update(dt, character.position)`** → rig/camera
   update → post/sky → `shadows.update(camera, sunDir)` → spells → terrain →
   **`walkers.sync(rig.camera.position)`** (needs this frame's camera, FOV and refit cascade
   matrices; also runs bolt update) → wake/spray → render (prepass RTT, cascades, beauty).

---

## 3. Data flow (cross-subsystem)

### Produced by walkers, consumed elsewhere

| thing | format / size | owner | update | consumers |
|---|---|---|---|---|
| `herd.walkerTex` (transform texture) | RGBA32F, `boneCount × (4 * MAX_WALKERS)` = boneCount×32, NEAREST, clamp, no mips | WalkerHerd | full re-upload once per `update()` | walker vertex shaders in all 5 passes (also the *speeder subsystem clones this exact layout* for its own texture) |
| `bolts.texture` | RGBA32F, 16×2, NEAREST, clamp | Bolts | once per `bolts.update()` | bolt vertex shader |
| beauty mesh(es) | `renderingGroupId = 1` (opaque scene group) | Walker | — | main render pass |
| bolt mesh | `renderingGroupId = 2` (alpha-blended group, additive, no depth write, depth test on) | Bolts | — | main render pass, feeds bloom (HDR colors up to ~5.6× over 1) |
| shadow casts | mesh + per-cascade depth material into `shadows.maps[0..2]` (walker casts into **all 3** cascades: `WALKER_CASCADES = 3`) | ShadowSystem RTTs | every cascade render | terrain/character/every shadow receiver |
| prepass casts | mesh + prepass material into `depthPass` RTT (writes `(viewZ, mask=0, 0, 1)`) | DepthPass | every frame | SSR/post passes reading linear depth |
| `walker.stepCount`, `walker.shotCount`, `walker.muzzle`, `walker.position` | plain numbers/Vector3, monotonically increasing counters | Walker | per sim tick | soundscape polls (owns no mixer) |
| `herd.triangles` | number | WalkerHerd | per frame | perf overlay |
| `herd.onMaterial(mat)` callback | ShaderMaterial | WalkerHerd | when herd grows | main.js → `spells.addConsumers` |
| terrain deformation brushes | `terrain.deform.brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge)` | Deformation system | on bolt impact | terrain sim (height + compression + **ice** channels; ice makes crater floors specular) |
| spray grains | `spray.emit(x,y,z, vx,vy,vz, size, life, clod, extra)` | SprayField | on bolt impact | particle sim |

### Consumed by walkers, produced elsewhere

| thing | format | owner | notes |
|---|---|---|---|
| `terrain.heightAt(x, z)` | CPU float | Terrain/heightfield | 4 probes per walker per frame + ~100 lookups per bolt fired |
| `sky.lut` | equirect sky LUT texture, sampled with explicit LOD (`mip = sqrt(roughness)*6`) | Sky | must have mips; `dirToLatLong` from atmosphere include |
| `sky.sunDir`, `sky.sunRadiance`, `sky.sh` (9 × vec4) | uniforms pushed each `sync()` | Sky | `sunRadiance` ≈ (16.9, 12.9, 6.5) HDR |
| `shadows.maps[0..2]` | R32F 2048² color RTTs storing NDC depth (not depth textures — PCSS blocker search needs filtered fetches) | ShadowSystem | sampled as `cascade0/1/2` |
| `shadows.matrixData` (48 f), `splits` (vec4), `paramData` (3 × vec4), `texelSize` (1/2048) | uniforms | ShadowSystem | pushed each `sync()`; `bindMatrixArray` avoids per-frame allocation |
| spell light uniforms | `spellLightPos: vec4[4]` (xyz, radius), `spellLightCol: vec4[4]` (rgb, intensity), `spellLightCount: f32` | SpellLights (via `spells.addConsumers(material)`) | names exported as `SPELL_LIGHT_UNIFORMS` from `src/spells/spellLights.js`; MAX 4 |
| `depthPass.registerCaster(mesh, material)` | | DepthPass | prepass fragment is the shared `prepass.fragment.wgsl` |
| shared WGSL includes | `snowNoise`, `snowShading`, `snowSpellLights`, `snowAtmosphere`, `snowShadowLookup` | render subsystem | fragment shader calls `noise2`, `ign`, `distributionGGX`, `visSmithGGXCorrelated`, `fresnelSchlick`, `shIrradiance`, `dirToLatLong`, `sunShadow`, `spellLightingSurface`, `applyAerial` — these must be ported once, shared by walker/character/speeder |
| `rig.yaw`, `rig.camera.fov`, engine render width/height | numbers | camera rig | placement + LOD math |
| `expDamp(cur, target, rate, dt)` = `target + (cur-target)*exp(-rate*dt)` | `src/core/camera.js` | framerate-independent easing |

---

## 4. Shader inventory

All are Babylon-flavoured WGSL (`attribute/uniform/varying` declarations, `vertexInputs`/
`vertexOutputs`/`fragmentInputs`/`fragmentOutputs` structs, `uniforms.<name>` UBO access,
`#include<name>` resolved from `registry.js`). Textures declared as `var name: texture_2d<f32>`
plus `nameSampler` — Babylon auto-pairs; in GLSL these become plain `uniform sampler2D`.

### `lib/walkerSkin.wgsl` (`snowWalkerSkin` include)

4-influence linear blend skinning from the transform texture. Layout: **column = bone index,
row = matrix column (0..2 basis, 3 translation), 4 rows per walker**, `row0 = boneRow` uniform
picks the block. `walkerXform(tex, row0, idx, wt)`: for each of 4 weights > 1e-4, `textureLoad`
4 texels at `vec2i(bone, row0 + 0..3)`, accumulate weighted; renormalise by accumulated weight
(`1/max(total, 1e-4)`) so a bone dropped by the epsilon can't collapse the vertex. One blended
matrix, applied twice (`walkerPoint` = full affine, `walkerDir` = basis-only + normalize) — 16
texture loads per vertex, not 32.

GLSL ES 3.0 translation: `textureLoad(tex, vec2i(x,y), 0)` → `texelFetch(uTex, ivec2(x,y), 0)`
(legal in vertex shaders in ES 3.0). `boneRow` arrives as `f32` and is cast `i32(...)` — keep the
float uniform + int cast, or pass an int uniform. The struct-of-vec3 return type maps to a plain
`mat4x3`/four `vec3` outs or an out-parameter set.

### `walker.vertex.wgsl` (beauty)

Attributes: `position: vec3f` (bind-pose, metres), `normal: vec3f`, `uv: vec2f`, `aux: vec2f`
(x = material slot, y spare), `boneIdx: vec4f`, `boneWt: vec4f` (all **float** buffers — the
loader widens quantised data on CPU). Uniforms: `viewProjection: mat4x4f`, `cameraPos: vec3f`,
`boneRow: f32`. Varyings out: `vWorld`, `vNormal` (skinned, normalized), `vUV`, `vSlot`
(flat per-triangle in practice), `vViewDist = distance(world, cameraPos)`.
`position = viewProjection * vec4(world, 1)`.

### `walker.fragment.wgsl` (beauty)

Metal-workflow GGX PBR + the scene's shared environment terms. Sampled:
`albedoTex`/`ormTex` (**`texture_2d_array<f32>`**, layer = material slot), `skyLUT`,
`cascade0/1/2`. Uniforms (exact names): `cameraPos`, `sunDir`, `sunRadiance`,
`shR: array<vec4f, 9>`, `cascadeMatrices: array<mat4x4f, 3>`, `cascadeSplits: vec4f`,
`cascadeParams: array<vec4f, 3>`, `shadowTexel`, `shadowSoftness` (=1.4), `shadowBias` (=0.06,
looser than the character's — thick hull seen edge-on in cascade 2), `matFactors: array<vec4f, 8>`
(per material slot: roughness factor, metallic factor, occlusion strength, albedo tint;
slot 7 is a **speeder-only side channel**: `[7].x` flat diffuse fill, `[7].y` sun desaturation —
the walker zero-fills them so both terms vanish), `fogDensity`, `fogHeightFalloff`, `fogStart`,
`aerialStrength`, `ambientIntensity`, `snowCover`, `debugView` (0 for walker), `debugGain` (1),
`spellLightPos: array<vec4f,4>`, `spellLightCol: array<vec4f,4>`, `spellLightCount: f32`.

Algorithm, in order:
1. `slot = clamp(i32(vSlot + 0.5), 0, 7)`; two-sided normal flip (`if dot(N,V) < 0 → N = -N`) —
   hatches/toe plates are single-sided; `backFaceCulling = false` on all walker materials.
2. Sample albedo/orm arrays at `(vUV, layer=slot)`; `ao = mix(1, orm.r, fac.z)`,
   `roughness = clamp(orm.g * fac.x, 0.06, 1)`, `metal = clamp(orm.b * fac.y, 0, 1)`,
   `albedo *= fac.w` (interior slot has no maps: baker writes `albedoImage: -1`, runtime sets
   tint 0.18 so the white fallback layer reads as shadowed interior).
3. **Settled snow** (if `snowCover > 0.001`): world-space value noise
   `n1 = noise2(world.xz * 0.6 + world.y * 0.35)`, `n2 = noise2(world.xz * 2.7 - world.y * 1.1)`,
   `broken = 0.5 + 0.34 n1 + 0.16 n2`; mask `facing = smoothstep(0.18, 0.78, geoN.y)`;
   `snow = clamp(facing * snowCover * 1.6 - (1 - broken) * 0.9, 0, 1)`; lerp albedo →
   `(0.74, 0.775, 0.84)`, roughness → 0.88, metal → ×(1-snow), ao → mix toward 1 by 0.6·snow.
4. Distance specular AA: `roughness += 0.35 * smoothstep(40, 250, vViewDist)`, clamp [0.06, 1].
5. `f0 = mix(0.04, albedo, metal)`; sun shadow via shared `sunShadow(world, geoN, viewDist,
   ign(fragCoord.xy) * 2π)` PCSS, evaluated only when `NdotL > -0.15`.
6. Sun desat: `sunLit = mix(sun, luma(sun), clamp(matFactors[7].y, 0, 1))` (no-op for walker).
   Diffuse `albedo/π · sunLit · max(NdotL,0) · shadow` + GGX specular
   (`distributionGGX`, `visSmithGGXCorrelated`, `fresnelSchlick`) when NdotL > 0.
7. Ambient: SH irradiance `shIrradiance(N, shR) * ambientIntensity`, **plus snow bounce**:
   `+ shIrradiance(up) * ambientIntensity * 0.45 * clamp(-N.y*0.5+0.5, 0, 1)` (downward faces see
   an 85 %-albedo field). Diffuse ambient × ao.
8. Ambient specular: `R = reflect(-V, N)`, `textureSampleLevel(skyLUT, dirToLatLong(R),
   sqrt(roughness)*6)` × Karis `envBRDFApprox(f0, roughness, NdotV)` (defined inline in this
   file) × ambientIntensity × ao.
9. Flat fill `+ diffuseAlbedo/π · sunLit · matFactors[7].x` (0 for walker).
10. Spell lights if `spellLightCount > 0.5`: `spellLightingSurface(world, N, V, diffuseAlbedo, f0,
    roughness, 0.15, ...) * ao`.
11. `applyAerial(color, cameraPos, world, -V, L, skyLUT, sun, fogDensity, fogHeightFalloff,
    fogStart, aerialStrength)` — aerial perspective is *most of what you see* at 200 m.
12. Debug substitution at the very end (`debugView` 1..7 = albedo / packed N / slot bands / ao /
    roughness / NdotL / shadow, × `debugGain`); walker always passes 0.
    Output `vec4(color, 1)` — HDR, tonemapped later by the post chain.

GLSL notes: `texture_2d_array` → `sampler2DArray`, sampled `texture(tex, vec3(uv, float(layer)))`;
`textureSampleLevel` → `textureLod`; WGSL `select(a, b, cond)` → ternary; `const` module constants
→ `const` or `#define`; arrays of vec4/mat4 uniforms are fine in ES 3.0 (`uniform vec4 shR[9];`)
but **must be indexed with dynamically-uniform or clamped ints** — slot indexing of `matFactors`
is per-fragment; that is legal in ES 3.0 for uniforms (indexing uniforms by non-constant
expressions is allowed), just keep the clamp.

### `walkerDepth.vertex.wgsl` (shadow cascades ×3)

Attributes: `position`, `boneIdx`, `boneWt`. Uniforms: `lightViewProjection: mat4x4f`, `boneRow`.
Same skinning include; output clip position only. Babylon builds a **distinct Effect per cascade**
via `defines: ["WALKER_CASCADE " + cascade]` (the define is only a cache-key discriminator — the
shader never reads it) so each cascade's material holds its own `lightViewProjection` with no
mid-frame uniform juggling. Paired fragment: `terrainDepth.fragment.wgsl`, which writes
`vec4(fragCoord.z, 0, 0, 1)` into the R32F cascade color target (**NDC depth as color**, because
PCSS blocker search needs plain filtered reads, not comparison samples). Port: three
`RawShaderMaterial` instances per walker (or one material with per-pass uniform update between
cascade renders — but the original deliberately avoids that; with Three, uniforms are per-material
so three materials sharing one program is the natural equivalent). **Note WebGPU fragCoord.z is
0..1; a GL port's `gl_FragCoord.z` is also 0..1 — but the *matrices* in `shadows.matrixData` were
built for a 0..1 clip-z convention** (Babylon WebGPU). The shadow subsystem port must decide one
convention; the walker just consumes `lightViewProjection` and `cascadeMatrices` consistently.

### `walkerPrepass.vertex.wgsl` (depth prepass)

Attributes: `position`, `boneIdx`, `boneWt`. Uniforms: `viewProjection`, `boneRow`. Varyings:
`vViewZ = clip.w` (for perspective projection clip.w *is* view-space z — cheap linear depth),
`vMask = 0.0` (0 = matte, 1 = mirror-ice; only the reflection pass reads it). Paired fragment:
shared `prepass.fragment.wgsl` → `vec4(vViewZ, vMask, 0, 1)`.

### `bolt.vertex.wgsl`

Attribute: `position: vec3f` = `(boltIndex, t, side)`. Uniforms: `viewProjection`, `cameraPos`,
`boltWidth`, `boltReach`. Texture: `boltTex` via `textureLoad` at `(id, 0)` and `(id, 1)`.
Technique: ribbon riding the flight path — `travel = boltReach * (1 - life)`;
`tail = origin + dir*travel`, `head = tail + dir*max(len, 1)`, `world = mix(tail, head, t)`;
camera-facing width axis `wide = cross(dir, toEye)/|…|` with a fallback perpendicular when looking
down the barrel; sine taper along t (`sin(t·π)·0.55 + 0.45`) and width shrink with life
(`0.35 + 0.65·life`). **Dead-slot handling**: direction substituted *before* normalize (zero
vector → NaN spreads to the whole primitive): `select(b.xyz, (0,0,1), dead || dot < 1e-8)`; and
the final clip position of a dead bolt is `vec4(0, 0, -2, 1)` — behind the near plane in *both*
clip conventions (z/w = −2 < 0 and < −1), so the rasteriser discards it; keep that trick.
Varyings: `vT`, `vSide`, `vLife` (0 when dead). The comment about "no early return" is
Babylon-WGSL-specific; a GLSL port can structure freely but must keep the NaN guard.

### `bolt.fragment.wgsl`

Additive emissive ribbon (blend: ADD, src + dst, no depth write, depth test on). Cross profile
from `across = 1 - |vSide|`: three stacked bands — `fringe = across` × `FRINGE(1.0, 0.20, 0.46)` ×
1.15, `glow = across³` × `boltColor` × 3.1, `core = across¹⁴` × `CORE(1.0, 0.84, 0.74)` × 5.6.
Length fade `ends = smoothstep(0, 0.08, t) * (1 - smoothstep(0.86, 1, t))`; life fade `vLife²`.
Output deliberately HDR ≫ 1 so bloom gets something real. Alpha written as 1 (ignored by additive
blend).

### WGSL → GLSL ES 3.0 checklist for this subsystem

- `textureLoad` (walkerSkin, bolt vertex) → `texelFetch` — supported in ES 3.0 vertex shaders. No
  storage textures, no textureGather, no compute anywhere in this subsystem.
- `texture_2d_array` (albedo/orm) → `sampler2DArray` (core ES 3.0). Layer index as float in
  `texture(tex, vec3(uv, layer))`.
- Float data textures sampled NEAREST/unfiltered → `RGBA32F` DataTexture, `NearestFilter`; fine in
  WebGL2 without extensions (linear filtering of float would need `OES_texture_float_linear` —
  not needed here).
- `select(f, t, cond)` → `cond ? t : f` (mind the WGSL argument order: false-value first!).
- `i32(f32)` casts, integer for-loop with `continue` — fine in ES 3.0.
- Babylon auto-varying structs → explicit `out`/`in` blocks; `input.position.xy` in fragment
  (used by `ign()` noise rotation) → `gl_FragCoord.xy`.
- Uniform arrays (`shR[9]`, `cascadeMatrices[3]`, `cascadeParams[3]`, `matFactors[8]`,
  `spellLightPos[4]`, `spellLightCol[4]`) → plain uniform arrays or a UBO (recommended: one shared
  UBO for scene lighting to mirror Babylon's grouping, but plain uniforms work).

---

## 5. Babylon-specific machinery → Three.js WebGL2 equivalents

| Babylon construct | Where used | Three.js equivalent |
|---|---|---|
| `ShaderMaterial` (WGSL, named shaders from `registry.js` `ShadersStore`, `#include<...>`) | all 6 materials per walker + bolt | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: THREE.GLSL3`); resolve includes with plain string concatenation of shared GLSL chunks (port the `snow*` includes once, share across walker/character/speeder) |
| Auto-bound uniforms `viewProjection` | all vertex shaders | Not automatic in RawShaderMaterial: supply `projectionMatrix * viewMatrix` yourself (per frame, one shared `Matrix4` uniform value object referenced by all materials), or use `ShaderMaterial` built-ins and compute `viewProjection` in shader. Beware: mesh world matrix must stay identity — do **not** use `modelViewMatrix` |
| `RawTexture.CreateRGBATexture(..., TEXTURETYPE_FLOAT, NEAREST, no mips, clamp)` | `walkerTex` (boneCount × 32), `boltTex` (16 × 2) | `THREE.DataTexture(data, w, h, RGBAFormat, FloatType)`, `magFilter = minFilter = NearestFilter`, `wrapS/T = ClampToEdgeWrapping`, `generateMipmaps = false`; per-frame `texture.needsUpdate = true` re-uploads the whole thing (tiny — fine) |
| `texture.update(data)` once per frame | herd pose, bolt pool | mutate the backing `Float32Array` in place, set `needsUpdate = true` (Three re-uploads from the same array; keep the "one staging array, one upload" shape) |
| `RawTexture2DArray(data, w, h, layers, RGBA, mips=true, TRILINEAR)` + `anisotropicFilteringLevel = 16`, wrap = repeat | `albedoTex`, `ormTex` (512² × 4, Uint8) | `THREE.DataArrayTexture(data, size, size, layers)`, `format = RGBAFormat`, `type = UnsignedByteType`, `wrapS/T = RepeatWrapping`, `minFilter = LinearMipmapLinearFilter`, `magFilter = LinearFilter`, `generateMipmaps = true`, `anisotropy = min(16, renderer.capabilities.getMaxAnisotropy())`. Keep `colorSpace = NoColorSpace` (data is uploaded linear-as-authored; see risks) |
| `Geometry` + `applyToMesh` shared across meshes; custom attributes `aux`, `boneIdx`, `boneWt` | LOD levels | one `THREE.BufferGeometry` per LOD, shared by reference across all walker meshes; `setAttribute("aux", BufferAttribute(f32, 2))` etc. LOD swap = `mesh.geometry = lods[level].geometry` (cheap, materials untouched) |
| `mesh.alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo`, `isPickable = false` | walker + bolt meshes | `mesh.frustumCulled = false`, `mesh.matrixAutoUpdate = false` (leave identity), `mesh.raycast = () => {}` if needed |
| `renderingGroupId = 1` (opaque) / `2` (blended after opaque) | walker / bolts | Three sorts transparent after opaque automatically; set bolt material `transparent = true`, plus `renderOrder` if the port uses explicit groups/layers for its pass structure |
| `mat.alphaMode = ALPHA_ADD`, `disableDepthWrite = true`, `needAlphaBlending` | bolt material | `blending = THREE.AdditiveBlending`, `depthWrite = false`, `depthTest = true`, `transparent = true` |
| `backFaceCulling = false` | all walker materials | `side = THREE.DoubleSide` |
| `shadows.registerCaster(mesh, (c) => makeDepthMat(c), 3)` + `RenderTargetTexture.setMaterialForRendering` | 3 custom cascade RTTs | the custom shadow subsystem port owns this: per cascade render, either swap `mesh.material` before rendering that cascade's `WebGLRenderTarget` (restore after), or keep 3 pre-made depth materials per caster and have the cascade pass iterate `(mesh, material)` pairs. Do **not** use Three's built-in shadow maps — the demo's cascades are R32F *color* targets storing NDC depth for PCSS blocker search |
| `defines: ["WALKER_CASCADE " + c]` (per-cascade Effect separation) | depth materials | simply 3 material instances (Three uniforms are per-material; the define was only a Babylon program-cache key) |
| `depthPass.registerCaster(mesh, prepassMat)` | linear-depth prepass RTT | same material-swap pattern into the prepass `WebGLRenderTarget` (RG float target: viewZ, mask) |
| `bindMatrixArray(material, "cascadeMatrices", flat48)` (alloc-free matrix-array upload) | `sync()` | in Three, a uniform can hold a `Float32Array` directly for `mat4[3]` if the shader declares `uniform mat4 cascadeMatrices[3]` and you set `uniforms.cascadeMatrices.value = arrayOfMatrix4` — simplest alloc-free path: keep 3 `Matrix4` objects whose `.elements` alias the shadow system's flat array, or declare the uniform as `mat4[3]` and pass an array of `Matrix4` updated in place |
| `whenReady(material, label, [mesh, false])` warm-up | `warmUp()` | `renderer.compile(scene, camera)` or `renderer.compileAsync(...)` with all meshes visible once behind the loading screen; bolts still need the "fake one live bolt" trick only if any driver-level lazy compile depends on drawn output (with `compileAsync` it does not — but keep warm-up so first shot doesn't hitch) |
| `ShaderLanguage.WGSL` + `vertexInputs/fragmentOutputs` rewriting | all shaders | gone; plain GLSL |
| Babylon left-handed coordinates (default scene, +Z "into screen") | whole scene | **Three is right-handed.** The subsystem's own math is self-consistent (it builds its world 3×4 from yaw/up and works in "world" space shared with terrain/sky/camera). The port-wide decision (keep LH data and flip at the projection, or mirror Z everywhere) is made globally; for walkers specifically check: yaw convention `(sin, 0, cos)` forward, `atan2(dx, dz)` bearings, `cross(up, fwd) = right` (this cross-product identity holds in either handedness only if the whole basis flips together), baked asset facing (+Z after bake), and triangle winding with `DoubleSide` materials mostly masks winding errors on the hull but **not** on the shadow/prepass passes if those cull |
| `engine.getRenderWidth/Height()` | `_halfField`, LOD px | `renderer.getSize()` / drawing-buffer size (mind DPR — Babylon returns drawing-buffer pixels; LOD thresholds are tuned in *screen* pixels of a 1080-line target) |
| `scene`-owned mesh auto-registration | constructors | explicit `scene.add(mesh)` in the port |
| `OffscreenCanvas` + `createImageBitmap` decode of WebP into a raw RGBA array | `loadWalkerAsset.loadLayers` | identical code works in a Three port (it is engine-free); keep decode-to-bytes so the DataArrayTexture gets one contiguous layer-major buffer |

---

## 6. Assets

### `walker.bin` — "SNWK" container, version 2 (reverse-engineered from loader + baker)

```
offset 0   : 4 bytes ASCII magic "SNWK"
offset 4   : uint32 LE headerBytes (JSON length incl. space padding to 4-byte alignment)
offset 8   : JSON header, UTF-8, padded with 0x20
offset 8+headerBytes : payload (each section 4-byte aligned, offsets relative to payload start)
```

JSON header fields (all consumed at runtime):

- `version: 2` (loader hard-rejects others), `source`, `rigged: bool`
- `lods: [{ level, vertexCount, triangleCount, ratio }]` — finest first; section names are
  suffixed with `level`
- `vertexCount`, `triangleCount` (LOD0), `boneCount` (57-bone class rig; **1 for a prop**),
  `frameCount` (≈ duration × 24), `duration` (seconds; 0 for prop)
- `speed` — m/s at scale 1, gait-solved (0 for prop)
- `height` — corrected standing height (m), `bounds: { min: [3], max: [3] }` — corrected-frame
  AABB (feet on y=0, facing +Z, metres)
- `posOffset: [3]`, `posScale: [3]` — position dequantiser
- `basisScale`, `transScale` — anim dequantisers
- `textureSize` (512), `materials: [{ name, slot, roughness, metallic, albedoImage, ormImage }]`
  (image index or **−1 = no map** → white fallback layer; walker interior slot gets tint 0.18)
- `layout: [{ name, type, count, bytes, offset }]` — `type` ∈ Int8Array/Uint8Array/Int16Array/
  Uint16Array/Uint32Array/Float32Array; loader views sections in place, so alignment matters.

Payload sections, per LOD `L` (names like `position0`):

| section | type | count | dequantisation |
|---|---|---|---|
| `position{L}` | Int16 ×3/vtx | n·3 | `(q + 32768) * posScale[k] + posOffset[k]` (bind space, metres) |
| `normal{L}` | Int8 ×3/vtx | n·3 | `q / 127` |
| `texcoord{L}` | Uint16 ×2/vtx | n·2 | `q / 65535` (UVs pre-wrapped to [0,1)) |
| `boneIdx{L}` | Uint8 ×4/vtx | n·4 | as-is (→ float attr) |
| `boneWt{L}` | Uint8 ×4/vtx | n·4 | `q / 255` (bake-normalised; shader renormalises anyway) |
| `slot{L}` | Uint8 ×1/vtx | n | material slot → `aux.x` (aux.y spare, 0) |
| `indices{L}` | Uint16 if n ≤ 65535 else Uint32 | 3·tris | as-is |
| `anim` | Int16 | frameCount·boneCount·12 | per bone: 12 = 3 basis columns (×`basisScale`) then translation (×`transScale`); layout `[frame][bone][12]`, column-major 3×4 (`m[c*3 + r]`) |

The clip loops: frame N wraps to frame 0 (first == last key removed by resampling to `[0, T)`).

CPU-side widening (loader): everything → Float32Array attributes (WebGPU had no 3-component
16-bit vertex format; **a WebGL2 port could instead upload the quantised buffers directly with
normalized/int attributes and dequantise in-shader — but the faithful port keeps the widening,
which costs ~1 ms for 75 k vertices**).

### Textures

`walker_albedo_{slot}.webp`, `walker_orm_{slot}.webp` (slots 0..3; a slot with `albedoImage: -1`
has no file — its layer is white 255s). Baked at 512², WebP q84, from gltf-transform. Runtime
assembles one layer-major RGBA buffer per kind (`layers = max(4, materials.length)`), drawing each
bitmap through a 2D canvas at `textureSize` (so off-size sources still land). ORM channels:
R = occlusion, G = roughness, B = metalness, authored linear. Albedo is uploaded **as raw bytes,
NOT sRGB-decoded** by default (`srgbAlbedo` option exists but the walker's look was tuned with it
off) — the shading treats the bytes as linear.

Fetch path: `fetchAsset(base + ".bin")` etc. — remote blob store first, same-origin `public/`
fallback.

No audio assets (soundscape owns those; walkers only expose counters).

---

## 7. Porting risks & gotchas (ranked)

1. **Handedness / clip conventions.** Babylon: left-handed world, WebGPU clip z ∈ [0, 1]; Three:
   right-handed, GL clip z ∈ [−1, 1]. Every matrix the walker consumes (`viewProjection`,
   `lightViewProjection`, `cascadeMatrices`) comes from other subsystems, and the walker builds
   world-space data (yaw forward `(sin, 0, cos)`, bearings `atan2(dx, dz)`, `cross(up, fwd) =
   right`, baked +Z facing) that must live in whatever world convention the port picks. If the
   port mirrors Z, the baked asset's facing, the yaw math, the cross products *and* triangle
   winding all change together — miss one and the walker walks backwards or turns its head the
   wrong way. `DoubleSide` hides winding errors on the beauty pass but not systematically on
   depth/prepass. Decide the global convention first; port this subsystem's math verbatim inside
   it.
2. **Custom multi-pass material binding.** Babylon's `RenderTargetTexture.setMaterialForRendering`
   lets one mesh carry 5 different materials across 5 passes with zero per-frame work. Three has
   one `mesh.material`. The cascade/prepass pass implementations must swap materials (or iterate
   explicit (mesh, material) draw lists) around each `setRenderTarget` — and after an LOD geometry
   swap the same registrations must keep working (they do if passes hold the *mesh*, not the
   geometry). Also remember: 3 distinct depth materials per walker, each with its own
   `lightViewProjection` uniform value, updated after the cascade refit and *before* the cascade
   renders — walker `sync()` runs after `shadows.update()` in the frame; keep that ordering.
3. **Float texture skinning path.** RGBA32F `DataTexture` + `texelFetch` in the vertex shader is
   core WebGL2, but: (a) filtering must be NEAREST (no `OES_texture_float_linear` dependency);
   (b) `boneRow` float→int casting must round exactly (values are small integers, safe);
   (c) `needsUpdate = true` re-uploads the whole boneCount×32 texture — keep it one upload per
   frame for the whole herd, not per walker; (d) some mobile GL drivers are slow at vertex-stage
   texelFetch — the original runs 16 fetches × ~75 k verts × 5 passes; if that's a problem, an
   alternative is a UBO of bone matrices (boneCount×8 walkers×48 floats ≈ 44 KB — over the 16 KB
   min UBO guarantee, so texture stays the portable choice).
4. **Color management.** The demo's whole pipeline is "bytes in are linear, HDR out, custom
   tonemap"; albedo WebPs are deliberately *not* sRGB-decoded and `sunRadiance` ≈ (17, 13, 6.5).
   Three defaults (`outputColorSpace = SRGBColorSpace`, `texture.colorSpace` conversions,
   `toneMapping`) will silently re-grade the model. Set `NoColorSpace` on the data array textures,
   render into a float target, and let the ported post chain do exposure/tonemap — otherwise you
   will re-live the "hull is too dark" saga the `debugView` uniform exists to debug (keep
   `debugView`/`debugGain` in the port; they cost nothing and the walker passes 0/1).
5. **The two "same number" couplings.** (a) Ground speed and gait phase rate must come off one
   multiplier (`walkerSpeed × rateBias`) or feet skate — an innocent "optimise: cache speed"
   refactor breaks it. (b) Bolt time-of-flight uses `REACH/LIFE` — the same speed the ribbon is
   *drawn* at — so snow erupts exactly when the bolt arrives; change either constant in only one
   place and impacts desync. Similarly `boltReach`/`boltWidth` uniforms are scaled by
   `S.walkerScale` on the CPU each frame.
6. **Additive HDR bolts vs. render order.** Bolts must draw after all opaque (they depth-test
   against terrain/hull, never depth-write) and their output must reach the bloom input un-clamped
   (core ≈ 5.6). If the port's transparent pass renders into an LDR or post-tonemap target, bolts
   become "red rectangles". Also keep the dead-bolt guards: substitute direction *before*
   normalize (NaN infects the primitive) and collapse dead quads behind the near plane.
7. **Warm-up.** Babylon compiles async and the original awaits every pipeline behind the loading
   screen (`warmUp()`), including a faked live bolt. Three + WebGL compiles on first draw —
   without an equivalent (`renderer.compileAsync` with representative state, or a 1-frame
   off-screen prime) the first shot / first cascade render hitches by hundreds of ms.
8. **DataArrayTexture details.** Mipmapped, anisotropic (16×), repeat-wrapped `sampler2DArray`
   with per-fragment layer selection — verify `generateMipmaps` works for array textures on the
   target (it does in Three/WebGL2, but it's a less-trodden path), and that the white fallback
   layer (no file on disk) survives: the loader `fill(255)`s the whole buffer first.
9. **Screen-metric tuning constants.** `LOD_PIXELS`, the opening-shot framing (`_halfField` uses
   *drawing-buffer* aspect and vertical FOV) and `pxPerMetre` were tuned against Babylon's
   `getRenderWidth/Height`. With Three, decide whether `renderer.getSize` (CSS px) or
   `getDrawingBufferSize` (device px) matches; using the wrong one shifts LOD switches and the
   whole opening composition by the devicePixelRatio.
10. **Shared includes must be bit-faithful.** `sunShadow` (PCSS + IGN rotation via
    `gl_FragCoord`), `shIrradiance` layout (9 vec4s), `applyAerial`, `noise2`, `spellLightingSurface`
    are owned by other subsystems but the walker's look is ~80 % those terms at 200 m. Port them
    once, share the chunk source, and validate with `debugView` modes before touching walker code.
