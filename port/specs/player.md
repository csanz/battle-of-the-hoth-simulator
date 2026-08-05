# Porting spec — "player" subsystem (Speeder + Jet)

Source files (Babylon.js / WebGPU / WGSL original — do not modify):

- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/player/speeder.js`
- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/player/jet.js`
- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/shaders/jet.vertex.wgsl`
- `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/src/shaders/jet.fragment.wgsl`
- Shared shaders it *reuses* (owned by the walker subsystem but bound by this one):
  `walker.vertex.wgsl`, `walker.fragment.wgsl`, `walkerDepth.vertex.wgsl`,
  `walkerPrepass.vertex.wgsl`, `terrainDepth.fragment.wgsl`, `prepass.fragment.wgsl`,
  `lib/walkerSkin.wgsl` (`#include<snowWalkerSkin>`), plus fragment-side includes
  `snowNoise`, `snowShading`, `snowSpellLights`, `snowAtmosphere`, `snowShadowLookup`.
- Assets: `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/public/models/speeder.bin`
  and `speeder_albedo_{0..4}.webp` (no `speeder_orm_*` files exist — all five materials have
  `ormImage: -1`, so the ORM array is generated white).

Target: Three.js `WebGLRenderer` (WebGL2, GLSL ES 3.0, `RawShaderMaterial`/`ShaderMaterial`,
`WebGLRenderTarget`-based shadow/prepass systems).

---

## 1. Purpose & behavior

The player subsystem draws the airspeeder — the craft the player *is* when the boot-time
setting `S.speeder === true` ("FLYING" mode). It is a **presentation layer over the existing
character controller**: `CharacterController` (src/character/controller.js) still owns
position, facing, velocity, physics and clamping. The speeder never moves the player; it
decides what the player looks like from outside. When flying, the humanoid figure is hidden
(but still simulated) and the speeder is visible; when not flying, none of this subsystem is
even constructed (no fetch, no pipelines, no meshes).

Runtime behavior, per frame:

1. **Hover placement** (`Speeder.update(dt)`):
   - `yaw = controller.facing`. Forward = `(sin yaw, 0, cos yaw)`.
   - Terrain height is sampled at the **nose and tail**, ±`half = bounds.max[2] * 0.9`
     (≈ 2.385 m) along forward from `controller.position`; `ground = max(nose, tail)`.
     This makes the craft nose up over a crest and drop into a trough instead of clipping.
   - Target height: `wantY = ground + HOVER + HOVER_SPEED_LIFT * speed01 + sin(bob) * BOB_HEIGHT * (1 - speed01)`,
     with `HOVER = 2.6`, `HOVER_SPEED_LIFT = 1.5`, `BOB_HEIGHT = 0.22`. `bob` advances
     `dt * 1.6` per frame; the idle wallow fades out with speed.
   - Target roll (bank): `wantRoll = -controller.lean * BANK + sin(bob * 0.7) * BOB_ROLL * (1 - speed01)`,
     `BANK = 0.62` rad, `BOB_ROLL = 0.05` rad. `lean` (−1..1) is the same lateral-acceleration
     signal the camera banks on, so craft and horizon agree by construction.
   - Target pitch: nose **down** under power (repulsorlift, opposite of a plane):
     `along = dot(velocity.xz, fwd.xz)`;
     `wantPitch = -min(1, |along|/19) * PITCH * sign(along || 1) + slope * 0.3`,
     `PITCH = 0.16` rad, where `slope = clamp((nose - tail) / (2 * half), -0.35, 0.35)`
     — the craft partially follows the dune under it, clamped so slope never dominates.
   - Smoothing: XZ position copies the controller exactly (the craft *is* the player);
     only Y, roll and pitch ease via `expDamp(cur, target, rate, dt) = target + (cur-target)*exp(-rate*dt)`
     with rates **5.5** (Y), **4.0** (roll), **3.2** (pitch). First frame snaps
     (`_settled` flag) instead of easing from origin.
   - `_compose()` builds a 3×4 world transform (`Float32Array(12)`: three basis columns
     right/up/forward at [0..2],[3..5],[6..8] then origin at [9..11]) from yaw → pitch → roll,
     composed by hand (see code; forward = `(sy*cp, -sp, cy*cp)`, right = `(cy, 0, -sy)`,
     up = normalize(cross(fwd, right)), then right/up rotated about forward by roll).
   - `_fire(dt)` — cannons: while `input.fire` is held, fires every `FIRE_RATE = 0.14` s,
     alternating wingtips. Muzzle is `MUZZLE = { x: 0.84, y: -0.196, z: 2.58 }` craft-local
     metres (x sign alternates), transformed by the 3×4 world matrix. Direction aims at a
     point `CONVERGE = 90` m ahead on the centre line so the two streams converge. Each shot
     calls `bolts.spawn(muzzle, dir)` and increments `shotCount` (read by the soundscape).
   - `_upload()` — writes the bone transform texture (see §3). The speeder is a **one-bone
     rig**: the baked `anim` Int16 data (12 quantised floats: 9 basis × `basisScale`,
     3 translation × `transScale`) is composed with the world 3×4 and written as a
     `boneCount × 4` RGBA-float texture, one column per bone, four rows = matrix columns,
     texel (b, 3) = translation. `tex.update(data)` each frame.
   - **Throttle state machine** for the exhaust: three readable states, not a curve —
     `hover = 0.14`; `cruise = 0.30 * (input.moving ? 1 : 0) + 0.16 * speed01`;
     `reheat = (input.sprint ? 1 : 0) * (0.85 + 0.45 * speed01)`;
     `want = min(1.55, hover + cruise + reheat)`;
     `throttle = expDamp(throttle, want, boosting ? 7.0 : 2.2, dt)` — lights fast, dies slow.

2. **Uniform publication** (`Speeder.sync(cameraPos)`, called later in the frame, after the
   shadow refit): pushes camera/sun/SH/shadow/fog/material uniforms to the surface material,
   ticks the bolts (`bolts.update(lastDt, cameraPos)`), and updates the jet with the nozzle
   position `ENGINE_NOZZLE = { spanX: 0.42, dropY: -0.124, backZ: -2.63 }` nudged by settings
   (`spanX * S.jetSpan`, `dropY + S.jetDropY`, `backZ + S.jetBackZ`), the current throttle,
   and camera position.

3. **Rendering** (driven by the scene, not by this code): the speeder body renders in the
   opaque pass (Babylon `renderingGroupId = 1`) with the walker surface shader; it also
   renders into the depth prepass and into shadow cascades 0 and 1 (registered for 2 of the
   3 cascades — a 5 m craft a few metres off the snow doesn't need the 330 m cascade). The
   jet plume and bolts render in the alpha group (`renderingGroupId = 2`) with additive
   blending and no depth write.

4. **Jet plume** (`Jet`): two nozzles × eight rungs of camera-facing quads (32 triangles,
   one draw, zero per-frame allocation). The mesh vertices carry only
   `(nozzleIndex, t 0..1, side ±1)`; four uniforms rewritten per frame place, lengthen and
   colour the plume (see §4). At idle throttle it's a stub of flame at the nozzle; under
   boost it stretches to `LENGTH = 7.5` m. HDR-bright on purpose (throat ≈ 30× emitter) so
   it outruns sunlit snow (≈12 linear) through the AgX tonemap and feeds the bloom pass.

Shading intent (walker.fragment.wgsl as configured by the speeder — this is most of the
"look"): metal-workflow GGX with cascade PCSS shadows, SH sky ambient, sky-LUT ambient
specular via `envBRDFApprox`, aerial perspective — all identical to the walker — plus
speeder-only terms driven through `matFactors` slot 7: a flat sun-coloured fill
(`matFactors[7].x = S.speederFill`) that ignores normal and shadow (needed because at a
13° sun most facets have cosine ≈ 0), and a sun de-warm
(`matFactors[7].y = S.speederDesat`) that mixes the sun beam toward its own luminance
(0 = unchanged; the walker leaves slot 7 zeroed so both terms vanish for it). `snowCover`
is forced to 0 (a warm moving craft carries no rime). `shadowBias` is 0.11 (vs the walker's
much tighter bias) because the craft shadow-tests against the near cascade it just rendered
into — a broad flat plate at grazing 13° sun angle needs a loose bias or the hull goes
black at random with camera movement. `ambientIntensity` = `S.ambientIntensity * S.speederAmbient`.
Debug views (`S.speederDebug`, list `["off","albedo","normal","slot","ao","roughness","sun cosine","shadow"]`,
index passed as float uniform `debugView`) substitute raw inputs, multiplied by
`debugGain = 1 / max(0.001, S.exposure)` so the post chain doesn't eat them.

---

## 2. Public API

### `class Speeder` (src/player/speeder.js)

```js
new Speeder(scene, terrain, sky, shadows, asset, controller, spray?)
```
- `scene` — Babylon Scene (Three: the `THREE.Scene` + renderer context).
- `terrain` — Terrain; used only for `terrain.heightAt(x, z)` (nose/tail samples) and passed
  to `Bolts` (impact march + craters).
- `sky` — Sky; reads `sky.lut` (lat-long sky LUT texture, mipmapped), `sky.sunDir` (Vector3),
  `sky.sunRadiance` (Color3, ≈ (16.9, 12.9, 6.5) linear), `sky.sh` (Float32Array 9×vec4 SH).
- `shadows` — ShadowSystem; reads `shadows.maps[0..2]` (2048² R32F RTTs), `matrixData`
  (Float32Array 48 = 3 mat4), `splits` (Float32Array 4, values [26, 95, 330, 330]),
  `paramData` (Float32Array 12 = 3 vec4), `texelSize` (1/2048); calls
  `shadows.registerCaster(mesh, (cascade) => depthMaterial, 2)`.
- `asset` — result of `loadWalkerAsset("models/speeder")` (see §6).
- `controller` — CharacterController; reads `.facing`, `.speed01`, `.lean`,
  `.velocity` (Vector3), `.position` (Vector3).
- `spray` — optional SprayField, forwarded to `Bolts` for impact spray.

Public fields: `position` (Vector3), `yaw`, `roll`, `pitch`, `bounds`, `triangles`,
`shotCount` (number, incremented per shot; soundscape reads it), `mesh`, `material`,
`bolts` (Bolts), `jet` (Jet), `tex`/`albedoTex`/`ormTex`.

Methods, in per-frame call order (from main.js render loop):
1. `tick(dt)` — just stores `_lastDt` (bolts and jet tick inside `sync`).
2. `update(dt)` — early in the frame, right after `controller.update`: hover placement,
   attitude, `_compose`, `_fire`, `_upload` (bone texture), throttle easing. No-op when
   invisible.
3. `sync(cameraPos)` — late in the frame, **after** `shadows.update(...)` (so this frame's
   cascade matrices are bound) and after the camera rig has moved: publishes all uniforms,
   re-runs `_updateFactors()` (so `speederTint`/`speederRough`/... sliders are live),
   ticks `bolts.update(lastDt, cameraPos)` and `jet.update(lastDt, world, nozzle, throttle, cameraPos)`.

Other methods:
- `registerPrepass(depth)` — builds the prepass material (vertex `walkerPrepass`, fragment
  `prepass`) and calls `depth.registerCaster(this.mesh, mat)`.
- `setVisible(v)` — toggles mesh, jet, and (off only) the bolts mesh.
- `warmUp()` — async; compiles surface, both depth cascade materials, prepass, bolts, jet
  behind the loading screen (Babylon compiles async; in Three use
  `renderer.compile`/`compileAsync` or render one warm-up frame).
- `dispose()`.

Construction wiring (main.js):
```js
const FLYING = S.speeder === true;                       // read once at boot
const speederReady = FLYING ? loadWalkerAsset("models/speeder") : null;  // starts pre-device
const speeder = FLYING ? new Speeder(scene, terrain, sky, shadows, await speederReady, character, spray) : null;
speeder?.registerPrepass(depthPass);
speeder?.setVisible(true);
// warm-up: speeder.update(0); speeder.sync(rig.camera.position); await speeder.warmUp();
// per frame: ... character.update(dt) ... speeder?.tick(dt); speeder?.update(dt);
//            ... shadows.update(...) ... speeder?.sync(rig.camera.position); ...
```
Also: when flying, `rig.yaw = character.facing` at boot (chase camera starts behind the
nose), the figure is hidden (`showCharacter && !FLYING`), and the Soundscape receives
`{ speeder }` and reads `speeder.shotCount`. A dev-console helper `speederTuning()` prints
the tuned look settings.

### `class Jet` (src/player/jet.js)

```js
new Jet(scene)
jet.update(dt, world /* Float32Array(12) 3x4 */, nozzle /* {spanX, dropY, backZ} craft-local m */,
           throttle /* 0..~1.55 */, cameraPos /* Vector3 */)
jet.setVisible(v); await jet.warmUp(); jet.dispose();
```
Constants: `NOZZLES = 2`, `RUNGS = 8`, `LENGTH = 7.5`, `WIDTH = 0.42`, `FLARE = 1.25`.
`update` accumulates `_time += dt`, computes both nozzle world origins from the 3×4 world
matrix (`origin = world * (±spanX, dropY, backZ)`), sets direction = −forward column with
`w = LENGTH`, and uploads uniforms `cameraPos` (vec3), `jetOrigin` (vec4[2], w=1),
`jetDir` (vec4: dir.xyz, length), `jetParams` (vec4: throttle, time, WIDTH, FLARE).
Note the fragment shader *also* declares `uniform jetParams` — same values, bound to both
stages (in Three: one uniform object shared by the program).

### Settings consumed (exact keys in src/core/settings.js `S`)

| Key | Default | Use |
|---|---|---|
| `speeder` | `false` | boot-time flag; true builds the whole subsystem |
| `speederAmbient` | `1.5` | multiplies `S.ambientIntensity` for this craft only |
| `speederTint` | `1.0` | albedo multiplier → `matFactors[slot].w` (textured slots) |
| `speederRough` | `0.9` | roughness override → `matFactors[slot].x` (replaces glTF's 0.5) |
| `speederFill` | `0.1` | flat sun fill → `matFactors[7].x` |
| `speederDesat` | `0.55` | sun de-warm → `matFactors[7].y` |
| `jetSpan` | `1.0` | multiplies nozzle spanX |
| `jetDropY` | `0.0` | adds to nozzle dropY (m) |
| `jetBackZ` | `0.0` | adds to nozzle backZ (m) |
| `boltR/boltG/boltB` | `1.0/0.30/0.18` | bolt body colour (via `look()` callback to Bolts) |
| `boltWidth` | `0.16` | bolt half-width (m) |
| `boltLength` | `9.0` | bolt drawn length (m) |
| `speederDebug` | `"off"` | debug view name → `debugView` uniform index |
| also read | | `fogDensity`, `fogHeightFalloff`, `fogStart`, `aerialStrength`, `ambientIntensity`, `exposure` (for `debugGain`) |

Interior (untextured, `albedoImage < 0`) slots get tint `0.18` instead of `speederTint`.
`_updateFactors()` re-runs every `sync` so all sliders are live. `metallic` comes from the
header per material (all 0 for this model); occlusion strength is hard-coded 1.

### Input consumed (src/core/input.js `input` struct)
`input.moving` (any WASD), `input.sprint` (shift), `input.fire` (mouse/space held; only set
when flying).

---

## 3. Data flow (cross-subsystem contracts)

**Consumes:**

| Thing | Owner | Format | When updated | Used for |
|---|---|---|---|---|
| `terrain.heightAt(x,z)` | terrain | JS function → metres | live | hover height (2 calls/frame), bolt ground march (inside Bolts) |
| `sky.lut` | sky | lat-long sky LUT texture, mipmapped (sampled with `textureSampleLevel` at `mip = sqrt(rough)*6`) | re-rendered per frame | ambient specular + aerial inscatter |
| `sky.sunDir` (vec3), `sky.sunRadiance` (vec3 linear), `sky.sh` (Float32Array 36 = 9 vec4) | sky | uniforms | per frame | direct + SH ambient lighting |
| `shadows.maps[0..2]` | shadows | 3 × RTT 2048², `TEXTURETYPE_FLOAT` + `TEXTUREFORMAT_RED` (R32F **colour** target storing NDC z, *not* a depth texture — PCSS blocker search needs plain fetches) | re-rendered per frame | samplers `cascade0/1/2` |
| `shadows.matrixData` (48 floats), `splits` ([26,95,330,330]), `paramData` (12 floats), `texelSize` (1/2048) | shadows | flat arrays → uniforms | per frame after refit | cascade select + PCSS |
| `shadows.registerCaster(mesh, factory, 2)` | shadows | API | boot | speeder renders into cascades 0,1 with its own depth material per cascade (define `SPEEDER_CASCADE n`, uniform `lightViewProjection`) |
| `depthPass.registerCaster(mesh, prepassMat)` | depthPass | API; prepass RTT stores `(viewZ, mask, 0, 1)`; speeder writes mask 0 | boot | TAA/SSR-style screen-space passes |
| `controller.{facing, speed01, lean, velocity, position}` | character | JS fields | per frame (before speeder.update) | placement + attitude |
| `input.{moving, sprint, fire}` | core/input | JS bools | polled per frame | throttle + guns |
| `SprayField` (optional) | vfx | object ref | — | forwarded to Bolts for impact grains |
| `SPELL_LIGHT_UNIFORMS` = `["spellLightPos","spellLightCol","spellLightCount"]` | spells | vec4[4], vec4[4], float — set on the material by the spell system (uniform names must exist in the program) | per frame | point lights on the hull |
| `S` settings + `expDamp` from core | core | — | — | see §2 |

**Produces / owns:**

| Thing | Format | Consumers |
|---|---|---|
| `this.tex` ("walkerTex" sampler) | RawTexture RGBA float32, size `boneCount × 4` = **1×4** for the speeder, nearest filtering, clamp | its own 4 pipelines (surface, 2 depth, prepass). Not shared with the walker herd — the speeder has its *own* transform texture, `boneRow = 0` |
| `albedoTex` | RawTexture2DArray RGBA8, 1024×1024×**5** layers, trilinear, wrap, aniso 16, **no mips** (deliberate — see comment in speeder.js; a live suspect for the dark-hull bug) | own surface material |
| `ormTex` | RawTexture2DArray RGBA8 1024×1024×5, **with** mips, trilinear, wrap, aniso 16; all-white (no ORM images exist) | own surface material |
| `factors` (`matFactors`) | Float32Array 32 = 8 vec4 | own surface material (slot 7 carries fill/desat) |
| its opaque draw into cascade maps 0,1 and the depth prepass | — | shadows / post subsystems |
| jet + bolt draws in alpha group | additive, no depth write | post (bloom feeds off jet HDR values) |
| `shotCount` | number | Soundscape |
| Bolts side effects | terrain craters + glazing (`ice` channel), spray grains | terrain deform, vfx (via the Bolts subsystem — see the walkers spec) |

---

## 4. Shader inventory

### jet.vertex.wgsl (subsystem-owned)
Technique: per-vertex procedural ribbon. Attribute `position: vec3f` is really
`(nozzleIndex, t, side)`. Steps:
- `id = i32(position.x + 0.5)` indexes `jetOrigin[2]`.
- Length: `len = jetDir.w * (0.14 + 0.86 * throttle²)` — slow start, fast finish; most
  growth in the top third of throttle (shift's domain).
- Wobble: `sin(time*9 + t*7 + id*2.3)*0.06*t + sin(time*13.7 + t*4)*0.04*t` (per-engine
  phase offset so the two plumes don't pulse together).
- Camera-facing basis: `wide = cross(dir, toEye)` normalised with a degenerate-case
  fallback via `select(vec3(0,1,0), wide/max(wl,1e-6), wl > 1e-4)`; `up = normalize(cross(wide, dir))`.
- Flare: `WIDTH * (0.55 + FLARE * t) * (1 - t²*0.55)`.
- `world = origin + dir*len*t + wide*(side*flare + wobble) + up*wobble*0.6`.
- Varyings: `vT`, `vSide`, `vThrottle`; clip pos = `viewProjection * vec4(world, 1)`.

GLSL notes: `select(a, b, cond)` → `cond ? b : a` (argument order flips!). Babylon-WGSL's
`vertexInputs/vertexOutputs/uniforms.` prefixes go away. `i32()` cast → `int()`. Uniform
`jetOrigin: array<vec4f,2>` → `uniform vec4 jetOrigin[2]` (std140-safe as vec4).

### jet.fragment.wgsl (subsystem-owned)
Technique: additive emissive gradient + scrolling noise, no texture inputs.
`#include<snowNoise>` supplies `noise2(vec2f) -> f32` (value noise; port the include once
for the whole project). Constants `THROAT = (1, .94, .72)`, `MID = (1, .46, .10)`,
`OUTER = (.24, .52, 1.0)`.
- `across = 1 - |vSide|`; `discard` when ≤ 0.001.
- Boil: two scrolling noise octaves
  `noise2(vec2(vSide*3 + t*6, t*9 - time*7))*0.5 + noise2(vec2(vSide*7, t*17 - time*12))*0.25`;
  `boil = 0.72 + 0.55*n`.
- Heat ramp along length: `heat = clamp(1 - t*1.35, 0, 1)`; `tint = mix(MID, THROAT, heat²)`
  then `tint = mix(OUTER, tint, clamp(across*1.5, 0, 1))` (blue cold envelope at edges).
- Core/body falloff across: `core = across⁵`, `body = across²`.
- Amount: `(0.18 + 0.82*throttle) * (1-t)² * boil`.
- Output (HDR, additive): `color = (tint*body*16 + THROAT*core*30*heat) * amount`, alpha 1.
  Alpha is irrelevant (blend is ADD ONE ONE); brightness must survive AgX + exposure — snow
  sits ≈12 linear, so the throat is intentionally an order of magnitude hotter, and bloom
  picks it up.

Blend state / pipeline (from Jet material + mesh): additive (`Constants.ALPHA_ADD` →
`THREE.AdditiveBlending`), `depthWrite: false`, depth **test on** (hidden by dunes it passes
behind), `side: THREE.DoubleSide`, drawn after opaques (`renderingGroupId 2` → e.g.
`renderOrder`/transparent queue). Frustum culling disabled (`alwaysSelectAsActiveMesh`,
frozen world matrix at identity — vertices are placed in world space by the shader; in Three
set `mesh.frustumCulled = false` and leave the mesh matrix identity).

### walker.vertex.wgsl + lib/walkerSkin.wgsl (shared with walkers; bound by speeder)
Technique: 4-influence linear-blend skinning from a float RGBA transform texture. Layout:
texel `(bone, row0 + c)` = column c of that bone's affine (xyz used, w ignored); row0 =
`uniforms.boneRow` (speeder: 0). One blended matrix per vertex (16 `textureLoad`s), then one
point + one direction transform. Weights renormalised (`1/max(total, 1e-4)`) after an
epsilon skip (`w <= 0.0001 → continue`). Matrices arrive pre-multiplied by the world
transform, so output is world space — **there is no model matrix anywhere in this pipeline**.
Varyings: `vWorld`, `vNormal`, `vUV`, `vSlot` (from `aux.x`), `vViewDist = distance(world, cameraPos)`.

GLSL notes: `textureLoad(tex, vec2i(b, r), 0)` → `texelFetch(sampler2D, ivec2(b, r), 0)` —
needs a **float texture** (`THREE.DataTexture` with `type: FloatType`, `format: RGBAFormat`,
`NearestFilter`, `needsUpdate` per frame; WebGL2 samples unfiltered float fine with nearest,
no EXT needed for fetch). The `continue`-in-loop with dynamic weights is fine in GLSL ES 3.0.

### walker.fragment.wgsl (shared; speeder-specific behavior via uniforms)
Technique: GGX metal-workflow PBR + cascaded PCSS + SH ambient + sky-LUT reflection +
aerial perspective + optional snow rime + debug views. Key structure (see §1 for the
speeder-relevant terms):
- Samplers: `albedoTex`/`ormTex` = `texture_2d_array<f32>` → GLSL `sampler2DArray`, sampled
  `texture(albedoTex, vec3(vUV, float(layer)))`; layer = material slot (0..4).
- `skyLUT` sampled with explicit LOD (`textureSampleLevel` → `textureLod`) — LUT must have
  mips in Three (`generateMipmaps: true` on its render target or manual chain).
- Cascades `cascade0..2` are plain float-red colour textures; `snowShadowLookup` include does
  cascade selection by `vViewDist` vs `cascadeSplits`, PCSS blocker search + PCF with
  `shadowTexel`, `shadowSoftness` (1.4 here), `shadowBias` (0.11 here), rotated by
  `ign(fragcoord)` (interleaved gradient noise) — all ordinary filtered fetches, no
  comparison sampler, so it ports to WebGL2 directly (use `LinearFilter` on an R32F target —
  requires `EXT_float_linear`; check availability or use half-float/RG16F, or nearest +
  manual bilinear, matching whatever the shadows-subsystem port decides).
- Uniform arrays: `shR: array<vec4f,9>`, `cascadeMatrices: array<mat4x4f,3>`,
  `cascadeParams: array<vec4f,3>`, `matFactors: array<vec4f,8>`,
  `spellLightPos/Col: array<vec4f,4>`.
- Integer ops: `slot = clamp(i32(vSlot + 0.5), 0, 7)`, `dv = i32(debugView + 0.5)` → plain
  `int()` casts in GLSL.
- Double-sided normal flip: `if (dot(N, V) < 0) N = -N;` (hatches are single-sided sheets;
  keep `side: DoubleSide`).
- Distance roughening: `roughness += 0.35 * smoothstep(40, 250, vViewDist)`, clamp [0.06, 1].
- `envBRDFApprox` (Karis split-sum) is inline in the file — copy verbatim.
- Debug substitution happens at the single exit (WGSL has no early return with
  FragmentOutputs); in GLSL you may keep the same structure.

### walkerDepth.vertex.wgsl + terrainDepth.fragment.wgsl (shadow cascade pass)
Vertex: same skinning include; single uniform `lightViewProjection: mat4x4f`; per-cascade
material instantiated with define `SPEEDER_CASCADE n` (the define exists only to make the
two cascade materials distinct programs; nothing in the shader reads it). Fragment writes
`vec4(gl_FragCoord.z-equivalent NDC z, 0, 0, 1)` into the R32F cascade colour target:
`fragmentOutputs.color = vec4f(input.position.z, 0, 0, 1)`. **WGSL `position.z` in the
fragment stage is NDC depth in [0,1]; GLSL `gl_FragCoord.z` is also [0,1] window depth, but
Babylon/WebGPU clip-space z is [0,1] while Three's projection matrices produce [-1,1] clip z
→ same window depth after viewport transform, so `gl_FragCoord.z` is the correct GLSL
equivalent — but the *shadow lookup* include compares against depths produced with the
shadow camera's projection convention; port both sides together.**

### walkerPrepass.vertex.wgsl + prepass.fragment.wgsl (depth prepass)
Vertex: skinning include; outputs `vViewZ = clip.w` (for perspective, clip w = view-space z
— exact, no reconstruction) and `vMask = 0.0`. Fragment writes `vec4(vViewZ, vMask, 0, 1)`
into the prepass float target. Straight port.

### WGSL → GLSL ES 3.0 checklist for this subsystem
- `textureLoad` → `texelFetch` (transform texture; bolt data texture in Bolts).
- `texture_2d_array` → `sampler2DArray` + 3-component coords.
- `textureSampleLevel` → `textureLod`.
- `select(f, t, cond)` → ternary with **reversed** operand order.
- `array<vec4f, N>` uniforms → `vec4 name[N]`; Babylon's `setArray4`/`bindMatrixArray` →
  plain `uniforms.name.value = Float32Array` (Three uploads arrays directly; the Babylon
  `bindMatrixArray` hack exists only to avoid Babylon's per-call copy — unnecessary in Three).
- Babylon WGSL boilerplate (`uniforms.`, `vertexInputs.`, `fragmentOutputs.color`,
  `FragmentInputs`) → standard `in/out` + `uniform` declarations; `attribute aux: vec2f` etc.
  → custom `in vec2 aux;` with matching `BufferAttribute` names (`aux`, `boneIdx`, `boneWt`).
- No storage textures, no textureGather, no compute in this subsystem.

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon | Where | Three.js WebGL2 equivalent |
|---|---|---|
| `ShaderMaterial` with `ShaderLanguage.WGSL`, named uniform/sampler lists | all 5 materials | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: THREE.GLSL3`) with explicit `uniforms` map; attribute names must match geometry attributes |
| `mesh.renderingGroupId` 1 (opaque) / 2 (alpha) | speeder body / jet, bolts | material `transparent:false` vs `transparent:true` + `renderOrder`, or explicit render-list ordering in the ported frame graph |
| `Constants.ALPHA_ADD`, `needAlphaBlending`, `disableDepthWrite` | jet (and bolts) | `blending: THREE.AdditiveBlending, depthWrite: false, depthTest: true` |
| `mat.backFaceCulling = false` | all speeder materials | `side: THREE.DoubleSide` |
| `RawTexture.CreateRGBATexture(..., TEXTURETYPE_FLOAT, NEAREST)` + `.update(data)` | bone transform texture (1×4 RGBA32F) | `THREE.DataTexture(data, boneCount, 4, RGBAFormat, FloatType)`, `NearestFilter`, `ClampToEdgeWrapping`, set `texture.needsUpdate = true` each frame (or `renderer.copyTextureToTexture` for partial) |
| `RawTexture2DArray(data, w, h, layers, RGBA, ...)` | albedo (no mips) / orm (mips) | `THREE.DataArrayTexture(data, 1024, 1024, 5)`, `format: RGBAFormat`, `type: UnsignedByteType`, wrap `RepeatWrapping`, `anisotropy: 16`; albedo: `generateMipmaps: false`, min `LinearFilter`; orm: `generateMipmaps: true`, min `LinearMipmapLinearFilter` |
| `Geometry.setVerticesData(kind/custom, data, updatable=false, stride)` | positions(3), normals(3), uv(2), `aux`(2), `boneIdx`(4), `boneWt`(4) + Uint16 indices | `THREE.BufferGeometry` with `Float32BufferAttribute`s named exactly `position`, `normal`, `uv`, `aux`, `boneIdx`, `boneWt`; `setIndex` |
| `mesh.alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | speeder, jet | `mesh.frustumCulled = false; mesh.matrixAutoUpdate = false;` (identity matrix — all placement is in the shader via the bone texture / jet uniforms) |
| `shadows.registerCaster(mesh, factory, 2)` + `RenderTargetTexture.setMaterialForRendering` | shadow cascades | render the speeder mesh into the ported cascade `WebGLRenderTarget`s with a per-cascade override material (e.g. per-target `scene.overrideMaterial` swap or a dedicated caster list that sets `mesh.material` per pass) — only cascades 0 and 1 |
| `depthPass.registerCaster(mesh, mat)` | prepass | same pattern against the ported prepass `WebGLRenderTarget` (float colour: viewZ, mask) |
| `whenReady(material, ...)` warm-up | all | `renderer.compileAsync(scene, camera)` or draw one off-screen frame during loading |
| `bindMatrixArray(mat, "cascadeMatrices", data)` | sync | `uniforms.cascadeMatrices.value = data` (Float32Array of 48; declare `uniform mat4 cascadeMatrices[3]`) — Three uploads without copying per-call ceremony |
| `setArray4`, `setVector3/4`, `setColor3`, `setFloat` | sync/update | direct `uniforms.x.value` writes; reuse the same typed arrays/Vector3s to keep zero-alloc behavior |
| Left/right-handedness | scene | Babylon scene here is left-handed-by-default convention with forward = +Z at yaw 0 (`fwd = (sin yaw, 0, cos yaw)`); all math in this subsystem is hand-rolled world-space (no Babylon matrix helpers except cross/normalize) so it ports verbatim **as long as the rest of the port keeps the same +Z-forward/+Y-up world convention and the same `viewProjection` handedness**. Do not "fix" signs locally; keep the whole port in one convention. Watch UV-V flip: Babylon and Three default texture flipY differ — the bake was authored for Babylon's convention, so set `flipY: false` on DataTextures (DataTexture default is already flipY=false) and verify against the `albedo` debug view |
| `scene.getEngine()` capability flags | none used directly | — |

---

## 6. Assets

### `public/models/speeder.bin` — "SNWK" v2 baked container (written by tools/bakeWalker.mjs, read by src/walkers/walkerAsset.js `loadWalkerAsset`)

Byte layout:
- bytes 0–3: ASCII magic `"SNWK"`.
- bytes 4–7: uint32 LE header length `H` (speeder: 1896).
- bytes 8 .. 8+H: JSON header.
- bytes 8+H .. end: payload; each section at `8 + H + section.offset`.

Header fields (actual speeder values): `version: 2`, `source: "t-47_airspeeder_snowspeeder.glb"`,
`lods: [{level:0, vertexCount:3187, triangleCount:1814, ratio:1}]`, `rigged: false`,
`boneCount: 1`, `frameCount: 1`, `duration: 0`, `height: 1.4977`,
`bounds: {min:[-2.233, -0.7488, -2.65], max:[2.233, 0.7488, 2.65]}`,
`posOffset: [-7.8677, -1.3723, -8.6132]`, `posScale: [2.6038e-4, 8.752e-5, 3.0894e-4]`,
`basisScale: 8.0048e-6`, `transScale: 1.2088e-5`, `textureSize: 1024`,
`materials[5]`: `{name, slot: 0..4, roughness: 0.5, metallic: 0, albedoImage: 0..4, ormImage: -1}`,
`layout`: array of `{name, type, count, bytes, offset}` where type ∈
{Int8Array, Uint8Array, Int16Array, Uint16Array, Uint32Array, Float32Array}.

Sections present (speeder): `position0` Int16×9561, `normal0` Int8×9561,
`texcoord0` Uint16×6374, `boneIdx0` Uint8×12748, `boneWt0` Uint8×12748,
`slot0` Uint8×3187, `indices0` Uint16×5442, `anim` Int16×12. Total file 82,932 bytes.

Dequantisation (must match exactly):
- position: `float = (int16 + 32768) * posScale[axis] + posOffset[axis]`
- normal: `int8 / 127`
- uv: `uint16 / 65535`
- boneIdx: raw uint8 → float; boneWt: `uint8 / 255` (renormalised again in-shader)
- `aux` attribute = `(slot0[i], 0)` per vertex (vec2; only .x used = material slot)
- anim (frame-major, 12 int16 per bone per frame; speeder = 1 bone × 1 frame): first 9 values
  × `basisScale` = 3×3 basis, last 3 × `transScale` = translation. For the speeder this is a
  constant bind matrix that `_upload()` composes with the live world transform every frame.

Textures: `speeder_albedo_{slot}.webp` per material with `albedoImage >= 0` (all five here);
no `speeder_orm_*` (all `ormImage: -1` → ORM array all-white 255, so `orm.rgb = (1,1,1)` and
factors decide: ao=1, roughness=`speederRough`, metal=0). Loader decodes each webp via
`createImageBitmap` + OffscreenCanvas draw at 1024×1024 (rescales if needed) into one
layer-major RGBA8 buffer (`stride = 1024*1024*4`, layer = slot). `layers = max(4, materials.length)`
= **5** for the speeder. Optional `srgbAlbedo` flag runs a byte LUT sRGB→linear; it is
**off** for the speeder (tested and ruled out — see main.js comment). In Three: keep the raw
bytes linear (`colorSpace: NoColorSpace` on the DataArrayTexture) to reproduce the current
(tuned) look — do NOT let Three tag it sRGB.

Asset fetch goes through `core/assets.js` `fetchAsset` (a public Vercel Blob store first,
same-origin `public/` fallback). The port needs the same two-tier resolution or just local
paths.

---

## 7. Porting risks & gotchas (ranked)

1. **Self-shadowing bias is load-bearing.** `shadowBias = 0.11` (surface material) is tuned
   for "broad flat hull, grazing 13° sun, tests against a cascade it renders into". If the
   ported shadow system changes depth storage (Babylon NDC z in [0,1] colour target vs a
   Three depth texture, or [-1,1] clip conventions), the bias is meaningless and the hull
   will flicker black with camera movement — the exact bug the original fixed. Port the
   shadows subsystem's storage convention first, then re-validate with the `shadow` debug
   view (`S.speederDebug = "shadow"`). Also preserve "casts into cascades 0 and 1 only".

2. **Texture color-space and mip flags are deliberate, not defaults.** Albedo array: linear
   bytes, `generateMipmaps: false` (a suspect in a past dark-hull bug — do not "helpfully"
   enable), aniso 16, wrap repeat, 5 layers. ORM: mips on, all-white. Three's default
   `flipY`/`colorSpace`/`premultiplyAlpha` handling of images differs from raw byte uploads —
   the loader decodes to raw bytes precisely to control this; keep that path
   (OffscreenCanvas → Uint8Array → DataArrayTexture) and verify with the `albedo` debug view
   (light grey textured hull = correct).

3. **Coordinate-convention coupling.** All placement math is hand-rolled world-space with
   +Z forward at yaw 0 and column-major 3×4 layout `[right|up|fwd|origin]`; the bone texture,
   jet origins, muzzle transform and `walkerSkin` include all assume it, and the skinned
   output is world space (no model matrix — meshes sit at identity with culling off). If the
   Three port flips handedness (Three is right-handed; Babylon default left-handed) or lets
   `modelViewMatrix` sneak in, the craft mirrors, the plume blows forward, or bolts leave
   from empty air. Decide one global convention for the whole port and pass `viewProjection`
   explicitly as a raw uniform, exactly as the original does.

4. **`matFactors` slot-7 side channel.** The flat fill and sun-desaturation ride in
   `matFactors[7].xy` of a shared 8×vec4 array (walker leaves it zeroed). The shader is
   shared with the walker herd — port it once, and make sure both subsystems agree on the
   8-slot layout and that the speeder's five material slots index texture layers directly.
   Uniform-array upload in Three must be a single flat Float32Array (32 floats) per frame.

5. **HDR pipeline dependency for the jet.** The plume's constants (×16 body, ×30 core)
   assume a linear HDR chain where sunlit snow ≈ 12, AgX tonemapping, and a bloom pass
   downstream, plus additive blending into an HDR (float/half-float) scene target. On an
   LDR8 target or with Three's built-in tonemapping applied per-material, the exhaust will
   either clip to white or vanish at idle. Render order matters too: opaque (group 1) then
   additive alpha (group 2) with depth test on / write off.

6. **Per-frame float-texture update path.** `tex.update(_texData)` uploads a 1×4 RGBA32F
   texture every frame; the bolts do the same with a 16×2 texture. In Three, `needsUpdate = true`
   on a DataTexture reallocates state on some paths — verify it's a cheap `texSubImage2D`
   or use `copyTextureToTexture`; also `texelFetch` on a float texture needs
   `NearestFilter` and no mips or the texture is incomplete in WebGL2.

7. **Lesser gotchas.** (a) `Jet`'s `jetParams` is declared in both vertex and fragment WGSL —
   in Three it's simply one shared uniform. (b) `input.fire` only exists when flying; keep
   the input mapping. (c) `sync` order-dependency: must run after the shadow refit and camera
   move each frame (uniforms carry *this* frame's cascade matrices). (d) `_updateFactors`
   every frame is what makes the tuning sliders live — keep it, it's 20 floats. (e) `warmUp`
   must pre-compile all five programs (surface, depth×2, prepass, jet — plus bolts) behind
   the loading screen or the first shot/boost hitches. (f) The dark-hull saga in the comments
   (speederFill/Rough/Ambient/Desat) means the current *numbers* are the tuned look — port
   them exactly, along with the debug-view scaffolding that made them tunable.
