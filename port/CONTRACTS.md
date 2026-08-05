# SNOWFLOW Three.js port — BINDING CONTRACTS

Every implementation agent must follow this document exactly. Parallel agents implement
subsystems **without seeing each other's code**; anything cross-cutting is pinned here.
If a subsystem spec in `port/specs/` conflicts with this document on a cross-cutting matter
(conventions, names, formats, ordering), **this document wins**; for subsystem-internal
behavior the spec wins. Source of truth for constants is always the original code at
`/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo` — copy numbers verbatim,
never re-derive.

## 0. Ground rules

- **G1 — Stub tolerance.** Every module must be import-safe and no-op gracefully during
  bring-up: constructors must not throw when a peer texture/material handle is `null` or a
  callback is absent; `update`/`sync` must early-out on missing resources; a material whose
  peer sampler is missing binds `gfx.blackTex` / `gfx.whiteTex` (§9.6). Never let a missing
  peer crash boot.
- **G2 — Zero per-frame allocation.** Module-scope scratch vectors/arrays, pre-sized staging
  buffers, mutate uniform `.value` objects in place. Never re-create Vector3/Matrix4/arrays in
  `update`/`sync`.
- **G3 — Verbatim numbers.** Every tuned constant (biases, envelopes, colors, rates) is copied
  digit-for-digit from the source. Do not simplify, do not normalize, do not fix documented
  oddities.
- **G4 — Names are contracts.** Module paths, class names, method names, uniform names,
  attribute names, texture names, settings keys: exactly as listed here. Consumers bind by
  name without seeing the provider's code.
- **G5 — WGSL→GLSL mechanical rules** (apply everywhere): `select(f, t, cond)` → `cond ? t : f`
  (operand order reverses!); `textureLoad(t, vec2i(x,y), 0)` → `texelFetch(t, ivec2(x,y), 0)`;
  `textureSampleLevel` → `textureLod`; `textureSampleGrad` → `textureGrad`;
  `dpdx/dpdy` → `dFdx/dFdy`; `inverseSqrt` → `inversesqrt`; `vec2f/vec3f/vec4f/mat3x3f/mat4x4f`
  → `vec2/vec3/vec4/mat3/mat4`; `f32()/i32()` → `float()/int()`; `atan2(y,x)` → `atan(y,x)`;
  `any(v != v)` → `any(isnan(v))`; vector compares → `lessThan`/`greaterThan` etc.;
  `array<vec4f,N>` uniform → `uniform vec4 name[N]`; Babylon boilerplate
  (`uniforms.` prefix, `vertexInputs/vertexOutputs/fragmentInputs/fragmentOutputs`,
  `#include<...>` store) → plain GLSL `in/out/uniform` + registry includes (§6);
  `fragmentInputs.position.xy` → `gl_FragCoord.xy`; WGSL `v * m` translates **verbatim** to
  GLSL `v * m` (both row-vector×matrix) — never rewrite to `m * v`.

---

## 1. Coordinate system & matrix policy

**Decision: keep the source's Babylon left-handed world and view conventions everywhere.
Three.js is used as a rasterizer only.** No Three transform math feeds any shader.

- **1.1 World.** X right, Y up, **+Z forward at yaw 0**. Forward from yaw =
  `(sin yaw, 0, cos yaw)`; bearings = `atan2(dx, dz)`. All JS world math ports byte-identical
  from the source. All meshes sit at **identity** world matrices forever
  (`matrixAutoUpdate = false`, `frustumCulled = false`); vertex shaders output world space
  directly (skinning textures / procedural placement), there is **no model matrix anywhere**.
- **1.2 Matrix storage.** Column-major flat `Float32Array(16)`, translation at elements
  12–14 — Babylon's GPU layout, GLSL `mat4` layout, and `THREE.Matrix4.elements` layout are
  all identical. GPU-side `M * v` works unchanged.
- **1.3 Matrix builders.** `core/mat4.js` provides (§9.3) `lookAtLH`, `perspectiveFovLH`,
  `orthoOffCenterLH` — LH view/projection with **GL clip z ∈ [−1, +1]** (NOT WebGPU's [0,1]).
  All cameras (main + shadow) are built with these. `Babylon A.multiplyToRef(B, out)` in
  source code = `mulMat4(out, B, A)` here (i.e. `view.multiplyToRef(proj)` →
  `mulMat4(viewProj, proj, view)`).
- **1.4 NDC / winding.** Because LH view+proj reproduce Babylon's clip x,y exactly (WebGPU NDC
  is y-up like GL), screen-space winding matches the source. Rule: **index buffers are copied
  verbatim from the source builders; materials that culled in Babylon
  (`backFaceCulling = true`, the default) use `side: THREE.FrontSide`; materials with
  `backFaceCulling = false` use `THREE.DoubleSide`.** Babylon's LH default is
  `sideOrientation` CCW + cull back, which is exactly Three's `FrontSide`
  (`gl.frontFace(CCW)` + cull back); `BackSide` flips the front face to CW and draws
  precisely the faces Babylon culled — never use it for default-orientation Babylon
  meshes. (An earlier revision of this rule was inverted, seeded by a stale
  "clockwise is front-facing" comment in the original clipmapMesh.js; it made the
  terrain render see-through.) When in doubt during bring-up, `DoubleSide` is the
  safe fallback.
- **1.5 Depth conventions.**
  - Main-camera depth buffer: standard GL, near→0 far→1 window depth. No reversed-Z.
  - **Shadow cascades store `gl_FragCoord.z`** (window depth [0,1]) in the R channel of an
    R32F **color** target, cleared to 1.0. Caster fragment shaders write
    `out vec4(gl_FragCoord.z, 0.0, 0.0, 1.0)`.
  - **Shadow lookup** (`lib/shadowLookup.glsl`): project world by `cascadeMatrices[c]`,
    `ndc = clip.xyz / clip.w`, reject outside `|ndc.xy| > 1` or `ndc.z ∉ [−1, 1]`, then
    compare depth `d = ndc.z * 0.5 + 0.5` against the stored map (with the source's
    receiver-plane + bias math, bias divided by `cascadeParams[c].x` depthRange metres,
    unchanged).
  - **Shadow UV: `uv = ndc.xy * 0.5 + vec2(0.5)` — NO Y flip.** The source's
    `0.5 + ndc.y*0.5` line compensated a Babylon RTT flip that WebGL FBOs do not have; here
    the unflipped mapping is correct in both axes. render-post must validate once via CPU
    readback of cascade 0 (terrain `debugView: "shadowMap"` exists for this).
  - **Prepass / post view space is LH, +z forward, positive metres.** With an LH projection,
    `clip.w == +viewZ`; prepass writes `vViewZ = clip.w`. `postCommon`'s
    `viewFromDepth(uv, z, projInfo) = vec3(ndc.x*projInfo.x, ndc.y*projInfo.y, 1.0) * z`
    ports verbatim; SSR's `R.z < 0.02` test and normal `cross(dx, dy)` order port verbatim.
  - `invView` = inverse of the LH view matrix (`invertRigid`); `invViewProjection` (cascade
    fit) = `invertMat4(viewProj)`. The cascade-fit NDC corner cube uses **z = ±1** (GL).
- **1.6 Camera state (single source of truth).** `rig.camera` is a **plain object owned by
  `core/camera.js`** (NOT a THREE.PerspectiveCamera):
  ```
  rig.camera = {
    position: THREE.Vector3,
    fov: number,          // vertical, RADIANS (source convention; walkers/overlay read this)
    aspect: number, minZ: 0.12, maxZ: 4200,
    view: Matrix4, projection: Matrix4,           // LH, GL-z; projection carries TAA jitter
    viewProjection: Matrix4, invView: Matrix4, invViewProjection: Matrix4,
  }
  ```
  `rig.update(...)` recomputes `view` (from the rig basis via `lookAtLH`-equivalent /
  `setFrame`+`invertRigid`) and an **unjittered** `projection` each frame. Then
  `post.update(...)` adds jitter to `projection.elements[8] += jx; [9] += jy`, recomputes
  `viewProjection`/inverses, and publishes unjittered copies for TAA. **After `post.update`,
  nothing may touch any of these matrices until `post.endFrame()`.** All materials bind
  `viewProjection` from here (§7.1).
- **1.7 Three token camera.** `gfx.threeCamera` is a bare `THREE.Camera` passed to
  `renderer.render`; `gfx` copies `rig.camera.projection` → `threeCamera.projectionMatrix`
  and `rig.camera.view` → `threeCamera.matrixWorldInverse` each frame **for Three's internal
  sorting only**. It is never a source of truth; no shader reads Three's auto-uniforms
  (RawShaderMaterial guarantees this).

## 2. Color, texture and blend policy

- **2.1 Renderer:** `renderer.outputColorSpace = THREE.LinearSRGBColorSpace`;
  `renderer.toneMapping = THREE.NoToneMapping`. sRGB encoding happens **exactly once**, inside
  `post/tonemap.fragment.glsl` (which also owns exposure/contrast/AgX). The sharpen pass runs
  on encoded 8-bit values and renders to the canvas (`setRenderTarget(null)`).
- **2.2 Every texture** (DataTexture, DataArrayTexture, render target): `colorSpace =
  THREE.NoColorSpace`, `flipY = false`, `premultiplyAlpha = false`, `generateMipmaps = false`
  unless this document says otherwise. Albedo WebP bytes are uploaded **linear as authored**
  (the tuned look; `srgbAlbedo` option exists but defaults off).
- **2.3 Float data textures** (bones, cloth, bolts, spray, wake, water, crystal, brush):
  `RGBAFormat` + `FloatType`, `NearestFilter` min+mag, `ClampToEdgeWrapping`, no mips. Update
  path: mutate the persistent backing `Float32Array`, set `texture.needsUpdate = true`, once
  per frame max.
- **2.4 HDR render targets:** RGBA16F (`HalfFloatType`) unless the registry (§5) says R32F/
  RGBA32F. Requires `EXT_color_buffer_float` (checked at boot; fatal if absent).
  `OES_texture_float_linear` gates bilinear on 32F targets (heightTex, cascades): check once
  in `gfx`; if absent, warn `"[snowflow] float32-filterable unavailable; height will step"`
  and fall back to `NearestFilter` on those targets only.
- **2.5 Blend states** (exact):
  - opaque: `transparent:false`, depth test+write on.
  - crystals: `transparent:true`, `blending:NormalBlending`, **`depthWrite:true`**, depthTest on.
  - water: `transparent:true`, NormalBlending, `depthWrite:false`.
  - jet plume & bolts: `transparent:true`, **`blending:AdditiveBlending`**, `depthWrite:false`,
    depthTest on.
  - spray: `transparent:true`, NormalBlending, `depthWrite:false`, depthTest on.
- **2.6 Clear color:** beauty target cleared to linear `(0.02, 0.03, 0.05, 1)`.

## 3. Capabilities

Checked once in `core/gfx.js` at boot, published as `gfx.caps = { floatLinear:bool,
parallelCompile:bool }`. `EXT_color_buffer_float` absent → `loading.fail("WebGL2 float render
targets are unavailable in this browser.")`. No WebGL2 context → `loading.fail("WebGL2 is not
available in this browser.")` (jet.html/index.html `#nogpu` copy updated accordingly).

## 4. Frame graph

### 4.1 Boot order (mirrors source `main.js` exactly — preserve every side effect)

1. Grab `#view` canvas; WebGL2/EXT gate (§3).
2. Coarse-pointer check → `applyPreset("balanced")`, `S.resolutionScale = 0.7` — **before any
   construction** (`deformResolution` is read once by DeformationField's constructor).
3. Kick `audio.load()`, `loadWalkerAsset("models/walker")`; latch `const FLYING = S.speeder
   === true`; if FLYING also `loadWalkerAsset("models/speeder")`. None awaited here.
4. `loading.phase("creating device", 0.05)`; create `gfx` (renderer, caps, scene, layers,
   token camera); `gfx.setRenderScale(S.resolutionScale)`; `onChange("resolutionScale",
   ...)`; window resize handler → `gfx.resize()`.
5. `registerShaders()` (idempotent; must run before any material is constructed).
6. `loading.phase("building scene", 0.12)`; `new CameraRig(gfx, canvas)`.
7. `loading.phase("integrating atmosphere", 0.2)`; `new Sky(gfx)`; `await sky.solve()`.
8. `new ShadowSystem(gfx)`; `new DepthPass(gfx)`.
9. `loading.phase("baking heightfield", 0.34)`; `new Terrain(gfx, sky, shadows)`;
   `await terrain.build()`; `onChange("showTerrain", ...)`;
   `depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial())`.
10. `loading.phase("placing character", 0.62)`; `new CharacterController(terrain)` at
    `(0, terrain.heightAt(0,0), 0)`; if FLYING `rig.yaw = character.facing`;
    `new Character(gfx, terrain, sky, shadows, character)`; `figure.registerPrepass(depthPass)`;
    visibility `figure.setVisible(S.showCharacter !== false && !FLYING)` + onChange.
11. `loading.phase("landing the walkers", 0.70)`; `new WalkerHerd(gfx, terrain, sky, shadows,
    await walkerReady, rig)`; onChange showWalker; `walkers.registerPrepass(depthPass)`.
12. `new SprayField(gfx, terrain, sky, shadows)`; if FLYING: `new Speeder(gfx, terrain, sky,
    shadows, await speederReady, character, spray)` + registerPrepass + setVisible(true);
    `walkers.setSpray(spray)`.
13. `new SnowContact(character, terrain.deform, figure.figure, spray)`.
14. `new SurfWake(gfx, sky, shadows, character, spray, terrain)`; onChange showWake;
    `wake.registerPrepass(depthPass)`.
15. If FLYING: `S.showSpells = false; S.showWake = false` (**plain writes, not `set()`** — no
    listeners fire).
16. `new SpellSystem(gfx, sky, shadows, terrain, character, figure.figure, rig, spray)`;
    `spells.addConsumers(terrain.material, figure.bodyMat, figure.clothMat, wake.material,
    spray.material)`; `walkers.onMaterial = m => spells.addConsumers(m)` + pass over existing;
    `spells.registerPrepass(depthPass)`.
17. `rig.groundAt = (x,z) => terrain.heightAt(x,z)`; `applyOpening(OPENING, rig, character,
    walkers, terrain)`; `new PostChain(gfx, rig, depthPass, sky)`.
18. UI: `new Overlay({rig, character})`, `createFpsMeter()`, `initInput(canvas, hooks)`,
    `createTouchControls({onToggleOverlay})`, `installShotCapture(rig, character, walkers)`;
    `new Soundscape(audio, {controller: character, spells, walkers, speeder})`;
    `createSoundButton(audio, {onEnable: () => soundscape.start()})`.
19. Warm-up (`loading.phase("compiling pipelines", 0.78)`) in the **exact source order**:
    `shadows.update(rig.camera, sky.sunDir)` → `sky.render(rig, 0)` → `await terrain.warmUp()`
    → `terrain.update(camPos, character.position, 0)` → `figure.update(0)` →
    `figure.sync(camPos)` → `await figure.warmUp()` → `walkers.sync(camPos)` →
    `await walkers.warmUp()` → speeder update/sync/warmUp if present → `spray.update(0,
    camPos)` → `await spray.warmUp()` → `await wake.warmUp()` → `await spells.warmUp(px+3,
    py, pz+3)` → `await depthPass.warmUp()` → `post.update(0, 0, rig.distance)` → post pass
    compiles. Then `loading.phase("warming render targets", 0.92)` and **3 real frames**
    (`renderFrame(); await loading.nextFrame();` ×3) then `spells.finishWarmUp()`.
20. Run loop start; `loading.phase("loading audio", 0.96)`; `await audioReady`; if
    `audio.hasAssets` → `loading.gate(() => { unlocking = audio.unlock(); })` (**unlock
    synchronously inside the handler**); `await unlocking; soundscape.start()`;
    `soundButton.sync()`; `await loading.done()`; `soundButton.reveal()`;
    `setTimeout(() => overlay.resetSpikes(), 800)`; publish `globalThis.SNOWFLOW` (§12).

### 4.2 Per-frame simulation order (verbatim from source; comments are load-bearing)

```
dtMs = min(now - prev, 100);  dt = S.freezeTime ? 0 : dtMs/1000;  time += dt;
pollInput();
character.update(dt, rig);
terrain.heightfield.clampToPlayArea(character.position);
figure.update(dt);                    // pose BEFORE contact (footprints at solved boot pos)
contact.update(dt);
walkers.update(dt, character.position);
speeder?.tick(dt); speeder?.update(dt);
rig.update(dt, character.position, vel, character.lean, character.speed01);
post.update(dt, character.streak01, rig.distance);   // TAA jitter: AFTER rig, BEFORE any view-proj reader
sky.update(); sky.render(rig, time);
shadows.update(rig.camera, sky.sunDir);              // cascade refit
spells.update(dt, rig.camera.position);              // AFTER shadow refit, BEFORE terrain (brush staging)
terrain.update(rig.camera.position, character.position, dt);  // runs deform sim pass inside
figure.sync(rig.camera.position);                    // AFTER shadow refit
walkers.sync(rig.camera.position);                   // LOD needs this frame's camera+fov
speeder?.sync(rig.camera.position);
wake.update(dt, rig.camera.position);                // BEFORE spray (grains into pool)
spray.update(dt, rig.camera.position);
soundscape.update(dt);                               // pure reader, last sim step
renderFrame();                                        // §4.3
post.endFrame();
mark(...) ×7; endFrameDraws(); stats.triangles = <sum per source>;
sample(dtMs); checkSpike(dtMs); overlay.update(dtMs, gfx); fpsMeter.update(dtMs);
endFrame();                                           // input accumulators — DEAD LAST
```

### 4.3 Render pass order (`renderFrame()` in main.js, using `gfx.runPass`)

1. *(already done inside `terrain.update`: deform sim fullscreen pass, ping-pong)*
2. **Shadow cascades** — `shadows.render(gfx)`: for c in 0..2: bind `cascadeRT[c]`, clear
   color (1,1,1,1) + depth, draw every registered caster whose cascade range includes c with
   its per-cascade material (each material's `lightViewProjection` was set in
   `shadows.update`).
3. **Depth prepass** — `depthPass.render(gfx)`: bind `scenePrepass`, clear color
   (9000, 0, 0, 1) + depth, draw registered casters with their prepass materials (jittered
   `viewProjection`).
4. **Beauty** into `sceneColor`: clear color (§2.6) + depth once, then render layer SKY, then
   layer OPAQUE, then layer BLEND with `renderer.autoClear = false` (depth persists across
   all three).
5. **Post chain** — `post.render(gfx)`: ssr → taa (→ history[k]) → shafts(¼) → bloomA(¼) →
   bloomB(1/16) → bloomC(1/16) → dof → composite → sharpen → canvas.

### 4.4 Layers & renderOrder (fixed table)

Layer bits on `gfx.LAYER = { SKY:1, OPAQUE:2, BLEND:3 }` (`mesh.layers.set(bit)`; a mesh is in
exactly one). renderOrder within a layer render (Three sorts by renderOrder; transparent after
opaque within the same render call):

| object | layer | renderOrder | notes |
|---|---|---|---|
| sky cube | SKY | 0 | depthWrite:false |
| terrain, body, cloth, fur, walkers, speeder hull, wake | OPAQUE | 10 | fur last within 10s if needed (10.5) |
| crystals | OPAQUE | 20 | transparent+depthWrite:true → draws after opaques in the OPAQUE render |
| water | BLEND | 30 | |
| jet plume | BLEND | 40 | additive |
| bolts | BLEND | 41 | additive |
| spray | BLEND | 50 | always last |

Shadow/prepass passes do not use layers for selection — they iterate explicit caster lists.

### 4.5 Pass runner / material-swap contract

`gfx.runPass({ target, clearColor?, clearDepth?, casters?, layer?, camera? })`:
- If `casters` (array of `{mesh, material}`): temporarily set each `mesh.material = material`
  and render only those meshes (implementation: a dedicated pass layer bit toggled on those
  meshes, single `renderer.render`), then restore the beauty materials. Registrations hold the
  **mesh** (not geometry), so LOD geometry swaps survive.
- Else render the given layer with current materials.
This is the only mechanism for Babylon's `setMaterialForRendering`. Per-cascade materials are
**distinct material instances** each holding its own `lightViewProjection` uniform (matches
the source design; no mid-pass uniform rewrites).

## 5. Render target & GPU resource registry

All screen-sized targets register with `gfx.trackScreenTarget(rt, scale)` so
resolutionScale/resize handles them; resize also calls `post.resetHistory()`.

| name | owner | format | size | filter | wrap | mips | notes |
|---|---|---|---|---|---|---|---|
| `cascade0/1/2` | shadows | R32F color + depth RB | 2048² | Linear (Nearest if !floatLinear) | clamp | no | cleared (1,1,1,1) |
| `scenePrepass` | depthPass | RGBA16F + depth RB | render size | **Nearest** | clamp | no | cleared (9000,0,0,1); `DEPTH_FAR = 9000` |
| `sceneColor` | postChain | RGBA16F + depth RB | render size | Linear | clamp | no | beauty target |
| `taaHistory0/1` | postChain | RGBA16F | render size | Linear | clamp | no | ping-pong; zeroed on resize/reset |
| `shaftsRT` | postChain | RGBA16F | ¼ | Linear | clamp | no | |
| `bloomA` | postChain | RGBA16F | ¼ | Linear | clamp | no | |
| `bloomB`, `bloomC` | postChain | RGBA16F | 1/16 | Linear | clamp | no | |
| `dofRT` | postChain | RGBA16F | render size | Linear | clamp | no | |
| `compositeRT` | postChain | RGBA8 (UnsignedByte) | render size | Linear | clamp | no | sRGB-encoded content; sharpen reads it, writes canvas |
| `heightTex` | terrain | RG32F | 4096² | Linear (if floatLinear) | clamp | no | baked once; CPU readback via transient RGBA32F blit (§10 terrain) |
| `auxTex` | terrain | RGBA16F | 2048² | Linear | clamp | no | baked once |
| `detailTex` | terrain | RGBA8 | 1024² | trilinear | repeat | **yes** | baked once, then generateMipmaps |
| `deformA/B` | terrain | RGBA16F | `max(512, S.deformResolution)`² | Linear | **repeat** | no | ping-pong, 1 pass/frame |
| `skyLUT` | sky | RGBA16F | 512×256 | trilinear | wrapS repeat / clampT | **yes** | rebaked on sun change only |
| `skySH` | sky | RGBA32F | 64×32 | Nearest | clamp | no | CPU readback for SH |

Data textures (all per §2.3): `charTex` 48×64; `walkerTex` boneCount×32 (= 4·MAX_WALKERS
rows); speeder `tex` boneCount×4 (1×4); `boltTex` 16×2 (one per Bolts instance); `sprayTex`
5120×2; `wakeTex` 96×3; `waterTex` 64×24; `crystalTex` 96×3; `brushTex` 96×3.

Array textures: walker `albedoTex`/`ormTex` `DataArrayTexture` 512²×max(4,materials) RGBA8,
repeat, aniso 16, trilinear **with** mips; speeder `albedoTex` 1024²×5 **no mips**
(min `LinearFilter`), `ormTex` 1024²×5 with mips. All `NoColorSpace`.

## 6. Shader conventions

- **6.1 Language.** GLSL ES 3.0 via `RawShaderMaterial` with `glslVersion: THREE.GLSL3`
  (Three injects `#version 300 es`; **shader files must not contain a `#version` line**).
  Every fragment shader starts (after includes are resolved — put it in the file, before any
  `#include`): `precision highp float; precision highp int; precision highp sampler2D;`
  plus `precision highp sampler2DArray;` where used — sampler declarations default to
  `lowp` in GLSL ES 3.0, which quantizes float-texture reads (height/deform) on some
  drivers. Vertex shaders: same precision block. Fragment output:
  `layout(location = 0) out vec4 fragColor;` — name it exactly `fragColor`.
- **6.2 Files.** One `.glsl` file per source `.wgsl`, same basename, under `src/shaders/`
  (e.g. `snow.vertex.glsl`, `deformSim.fragment.glsl`) and `src/shaders/lib/*.glsl` for the
  15 include chunks: `noise, terrain, shading, shadowLookup, atmosphere, clipmap, deform,
  charSkin, walkerSkin, wake, spellLights, water, crystal, postCommon, ridge`.
- **6.3 Registry.** `src/shaders/registry.js`:
  ```js
  export function registerShaders()            // idempotent; loads all *.glsl via import.meta.glob(..., { as: "raw", eager: true })
  export function getShader(name)              // "snowVertexShader"/"snowPixelShader" naming preserved: <base>VertexShader / <base>PixelShader
  export function composeShader(source)        // recursively resolves #include<name> (names: snowNoise, snowTerrain, ... as in source registry.js)
  ```
  Include syntax in GLSL files: `#include<snowNoise>` (regex `#include\s*<(\w+)>`), resolved
  by textual substitution **before** compile; each chunk substituted at most once per compile
  unit (dedupe by name). Never use Three's `ShaderChunk`. The include mapping is exactly the
  source's: `snowNoise→lib/noise.glsl`, `snowTerrain→lib/terrain.glsl`, `snowShading→
  lib/shading.glsl`, `snowShadowLookup→lib/shadowLookup.glsl`, `snowAtmosphere→
  lib/atmosphere.glsl`, `snowClipmap→lib/clipmap.glsl`, `snowDeform→lib/deform.glsl`,
  `snowCharSkin→lib/charSkin.glsl`, `snowWalkerSkin→lib/walkerSkin.glsl`, `snowWake→
  lib/wake.glsl`, `snowSpellLights→lib/spellLights.glsl`, `snowWater→lib/water.glsl`,
  `snowCrystal→lib/crystal.glsl`, `snowPostCommon→lib/postCommon.glsl`, `snowRidge→
  lib/ridge.glsl`.
- **6.4 Material helper.** `core/gpuUtil.js` exports
  `makeMaterial({ name, vertex, fragment, uniforms, ...flags })` → `RawShaderMaterial` with
  includes resolved via `composeShader`, `glslVersion: GLSL3`. `name` used in warm-up
  diagnostics.
- **6.5 Chunk ownership** (who writes which lib file — disjoint):
  terrain task: `noise, terrain, clipmap, deform, ridge`; render-post task: `shading,
  shadowLookup, atmosphere, postCommon`; character: `charSkin`; walkers: `walkerSkin`;
  vfx: `wake`; spells: `water, crystal, spellLights`. A chunk's **function signatures are
  contracts** — they match the WGSL originals translated per G5 (e.g.
  `float noise2(vec2 p)`, `vec3 noised(vec2 p)`, `float ign(vec2 px)`,
  `vec3 shIrradiance(vec3 n, vec4 shR[9])` → in GLSL pass the global uniform: declare
  `vec3 shIrradiance(vec3 n)` reading the `shR` uniform directly if the WGSL did — follow
  each spec's stated signatures; when a chunk reads uniforms, the **including shader must
  declare them before the `#include` line** with the exact names of §7).
- **6.6 Attribute names** (BufferGeometry attributes, exact): `position`, `normal`, `uv`,
  `aux` (vec2), `boneIdx` (vec4 float), `boneWt` (vec4 float). Indices Uint16/Uint32 as
  sourced. Attributes are declared `in` in vertex shaders with matching types.
- **6.7 Fullscreen passes.** `FullscreenPass` (§9.4) draws a single fullscreen triangle with
  `in vec2 position` (clip-space −1..3 triangle) and provides `vUV` varying in [0,1],
  v = 0 at the **bottom** (GL convention). Bake shaders (`heightBake`, `auxBake`,
  `detailBake`, `skyBake`, `deformSim`, all `post/*`) consume `vUV` with this orientation.
  The sky SH CPU projection must index readback rows to match (`readRenderTargetPixels` row 0
  = bottom row = v=0): render-post must keep `latLongToDir`'s zenith-at-v convention and the
  CPU loop consistent — validate `_irradianceUp()` after first bake per its spec.

## 7. Shared uniform contracts (exact names & upload idioms)

- **7.1 Per-frame camera:** every vertex shader that projects declares
  `uniform mat4 viewProjection; uniform vec3 cameraPos;`. Values: bind the shared jittered
  `rig.camera.viewProjection` — idiom: `uniforms.viewProjection = { value:
  rig.camera.viewProjection }` (a `THREE.Matrix4` mutated in place by rig/post; Three
  re-uploads each draw). `cameraPos` from a shared Vector3 mutated in place.
- **7.2 Shadow receiver block** (declared by every shadow-receiving material, before
  `#include<snowShadowLookup>`):
  ```
  uniform vec3 sunDir; uniform mat4 cascadeMatrices[3]; uniform vec4 cascadeSplits;
  uniform vec4 cascadeParams[3]; uniform float shadowTexel; uniform float shadowSoftness;
  uniform float shadowBias; uniform sampler2D cascade0; uniform sampler2D cascade1;
  uniform sampler2D cascade2;
  ```
  Values: `cascadeMatrices.value = shadows.matrixValues` (array of 3 `Matrix4` whose
  `.elements` are `Float32Array` subarray views of `shadows.matrixData` — zero copy);
  `cascadeParams.value = shadows.paramData` (flat Float32Array(12) — Three accepts flat
  arrays for vec-array uniforms); `cascadeSplits.value = shadows.splitsVec4` (shared Vector4);
  `shadowTexel = 1/2048`. Splits are `[26, 95, 330, 330]`. Cascades are **three separate
  sampler2D uniforms — never an array**. Per-material tuning (verbatim): terrain
  softness/bias per source; character 1.4/0.012; walker 1.4/0.06; speeder 1.4/0.11; wake
  1.5/0.018; spray 1.6/0.05; water 1.4/0.03; crystal 1.3/0.012.
- **7.3 Sky/lighting block:** `uniform vec3 sunDir; uniform vec3 sunRadiance;
  uniform vec4 shR[9]; uniform sampler2D skyLUT; uniform float ambientIntensity;`.
  `shR.value = sky.sh` (flat Float32Array(36), zero copy — sky mutates in place).
- **7.4 Fog/aerial block:** `uniform float fogDensity, fogHeightFalloff, fogStart,
  aerialStrength;` — values read from `S` every `sync`.
- **7.5 Spell lights** (`SPELL_LIGHT_UNIFORMS = ["spellLightPos","spellLightCol",
  "spellLightCount"]`): `uniform vec4 spellLightPos[4]; uniform vec4 spellLightCol[4];
  uniform float spellLightCount;`. `SpellLights.apply(material)` writes
  `material.uniforms.spellLightPos.value = this.pos` (flat 16-float arrays, zero copy) and
  `spellLightCount.value = this.count`. Every consumer material **must declare all three**
  even if lights never hit it. MAX_SPELL_LIGHTS = 4.
- **7.6 matFactors:** `uniform vec4 matFactors[8]` in the walker fragment shader — slot
  layout `(roughnessFactor, metallicFactor, occlusionStrength, albedoTint)`; **slot 7 is the
  speeder side channel** `([7].x = flat fill, [7].y = sun desaturation)`; the walker
  zero-fills slot 7. Flat Float32Array(32) upload.
- **7.7 Skinning:** `uniform sampler2D walkerTex; uniform float boneRow;` (walker/speeder,
  cast `int(boneRow)` in shader); `uniform sampler2D charTex;` (character). Layout contracts
  per §5 + subsystem specs.
- **7.8 Shadow caster materials** declare `uniform mat4 lightViewProjection;` — set by
  `ShadowSystem.update` every frame per cascade instance.
- **7.9 Prepass materials** declare `viewProjection` (jittered) and output through the shared
  `prepass.fragment.glsl` (`fragColor = vec4(vViewZ, vMask, 0.0, 1.0)`); varyings named
  exactly `vViewZ`, `vMask`.

## 8. Settings — key list preserved verbatim

`src/core/settings.js` is **copied from the source file verbatim** (S, SCHEMA, PRESETS,
onChange, set, applyPreset — same code, same comments allowed to be trimmed but keys/defaults
byte-identical). Keys for reference:

- quality: `preset` "ultra", `resolutionScale` 1.0
- sun: `sunAzimuth` 118, `sunElevation` 13.0, `sunIntensity` 4.2, `sunTempWarm` 1.0,
  `ambientIntensity` 1.0, `ambientBlue` 1.0
- atmosphere: `fogDensity` 0.0072, `fogHeightFalloff` 0.045, `fogStart` 24,
  `aerialStrength` 1.0, `windDirection` 42, `windStrength` 1.0, `showMountains` true,
  `mountainHeight` 2150, `shaftStrength` 0.30
- snow: `glintIntensity` 0.55, `glintGrazing` 0.72, `sssStrength` 1.0, `sssRadius` 1.0,
  `detailNormalStrength` 1.0, `macroHeightScale` 1.0, `sastrugiStrength` 1.0
- deformation: `deformDepth` 1.0, `deformBerm` 1.0, `refillRate` 1.0, `deformResolution` 2048
- snow-surf: `wakeHeight` 1.0, `wakeSpray` 1.0, `windStreaks` true, `streakStrength` 1.0
- speeder: `speeder` false, `overlayOpen` false, `speederAmbient` 0.0, `speederTint` 0.9,
  `speederRough` 0.86, `speederFill` 0.08, `speederDesat` 0.67, `jetSpan` 3.0,
  `jetDropY` 0.18, `jetBackZ` 0.35, `jetWidth` 1.0, `jetLength` 1.0, `jetFlare` 1.0,
  `boltR` 1.0, `boltG` 0.30, `boltB` 0.18, `boltWidth` 0.16, `boltLength` 9.0,
  `speederDebug` "off"
  (resynced 2026-08-05 to the source working tree — the earlier list here was
  transcribed from an intermediate source state; `S.jetWidth`/`S.jetLength`/`S.jetFlare`
  multiply the jet plume's base WIDTH/LENGTH/FLARE constants, and `S.overlayOpen` is set
  true by `jet.js` and read once in `main.js` after `loading.done()` to auto-open the
  tuning overlay; jetSpan slider max is 8)
- walker: `showWalker` true, `walkerCount` 2, `walkerScale` 1.0, `walkerSpeed` 1.0,
  `walkerSnow` 0.45, `walkerFire` true
- spells: `showSpells` true, `spellLight` 1.0, `spellSpray` 1.0, `waterDepthTint` 1.0
- post: `taa` true, `ssr` true, `dof` true, `bloom` true, `grain` true, `sharpen` true,
  `tonemap` "agx", `exposure` 0.105, `contrast` 1.14, `bloomStrength` 0.22,
  `grainStrength` 0.022, `sharpenStrength` 0.55
- audio: `audioMuted` false, `masterVolume` 0.8, `ambienceVolume` 0.34, `musicVolume` 0.34,
  `sfxVolume` 1.0
- systems: `showTerrain` true, `showCharacter` true, `showWake` true, `showLightShafts` true,
  `wireframe` false, `freezeTime` false
- debug: `debugView` "beauty"

PRESETS: `ultra:{}`, `high:{deformResolution:2048, resolutionScale:1.0, ssr:true, dof:true}`,
`balanced:{deformResolution:1024, resolutionScale:0.85, ssr:false, dof:false}`.

## 9. Core module APIs (`src/core/`) — provided by the scaffold task

### 9.1 `settings.js`
`export const S`, `export const SCHEMA`, `export const PRESETS`,
`export function onChange(keys, fn) → unsubscribe`, `export function set(k, v)`,
`export function applyPreset(name)`. Semantics identical to source.

### 9.2 `input.js` (verbatim port)
`export const input = { moveX, moveZ, moving, lookX, lookY, zoomDelta, surf, fire, sprint,
spellPressed, spellHeld2, locked }`; `export const touch = { present, x, z, active, sprint,
surf }`; `export function initInput(canvas, hooks?: {onToggleOverlay?, onToggleFps?})`;
`export function pollInput()`; `export function endFrame()`; `export function isDown(code)`.
All source behaviors preserved: LOOK_SCALE 0.0022, pointer lock, blur clears everything,
wheel passive:false ×0.0016, Space preventDefault, Digit1–5, touch stick wins outright,
flying pins `surf=true` and maps held→`fire`.

### 9.3 `mat4.js`
Flat Float32Array column-major helpers, all `(out, outOffset, ...)` style as source:
`setFrame`, `setFrameFromDir`, `mul` (rigid), `invertRigid`, `xformPoint`, `xformDir` —
ported verbatim — plus new full-4×4 helpers:
```
export function mulMat4(out, a, b)            // out = a * b, column-convention, plain arrays/.elements
export function invertMat4(out, m)            // general inverse
export function lookAtLH(out, eyeX,eyeY,eyeZ, tX,tY,tZ, upX,upY,upZ)
export function perspectiveFovLH(out, fovY, aspect, near, far)   // GL clip z in [-1,1]
export function orthoOffCenterLH(out, l, r, b, t, near, far)     // GL clip z in [-1,1]
```
These operate on any length-16 array incl. `Matrix4.elements`.

### 9.4 `gpuUtil.js`
```
export function makeMaterial(opts) → RawShaderMaterial          // §6.4
export class FullscreenPass {
  constructor(gfx, { name, fragment, uniforms })                 // shared fs-triangle geometry
  render(target /* WebGLRenderTarget|null */)                    // sets RT, draws once
  get material()
}
export async function whenReady(gfx, materialOrPass, label, drawFn?)  // compileAsync wrapper,
        // 25s watchdog rejecting with `label` + "almost always a GLSL compile error"
export async function bakeOnce(pass, target, label?)             // compile + single render
export async function compileAll(gfx)                            // renderer.compileAsync(scene, threeCamera)
```
`bindMatrixArray` is intentionally absent — use the aliased-`Matrix4` idiom of §7.2.

### 9.5 `gfx.js` (the engine replacement)
```
export class Gfx {
  constructor(canvas)         // WebGLRenderer (antialias:false, stencil:false, high-performance),
                              // caps check (§3), NoToneMapping/Linear output, info.autoReset=false
  renderer; scene;            // THREE.WebGLRenderer, THREE.Scene
  threeCamera;                // token THREE.Camera (§1.7)
  caps = { floatLinear, parallelCompile };
  LAYER = { SKY:1, OPAQUE:2, BLEND:3 };
  whiteTex; blackTex;         // 1×1 fallbacks for stub tolerance (G1)
  addMesh(mesh, layerBit, renderOrder)      // sets layers/renderOrder/frustumCulled=false/matrixAutoUpdate=false, scene.add
  runPass(opts)               // §4.5
  makeRenderTarget(name, w, h, opts)        // opts: {type, format, internalFormat?, filter, wrap, depth, mips}
  trackScreenTarget(rt, scale = 1)          // auto-resize with render size
  setRenderScale(s); resize();              // canvas + tracked RTs; calls onResize listeners
  onResize(fn) → unsubscribe
  get renderWidth(); get renderHeight();    // drawing-buffer pixels (device px × scale)
  syncTokenCamera(rigCamera)                // copies matrices into threeCamera (called by main each frame)
}
export function createGfx(canvas) → Gfx | null   // null → caller loading.fail(...)
```

### 9.6 `camera.js`
```
export class CameraRig {
  constructor(gfx, canvas)     // state per source: speeder-dependent init values verbatim
  camera;                      // §1.6 plain object
  yaw; pitch; distance; distanceTarget; pivot: Vector3; fov;      // fov RADIANS
  forward; right; up;          // Vector3 basis, republished each update (spells aim with these)
  trauma; groundAt = null;     // (x,z)=>y injected by main
  addTrauma(amount)
  update(dt, targetPos, targetVel, lean, speed01)   // full source algorithm incl. LH basis:
       // fwd=(sin y·cos p, −sin p, cos y·cos p), right=(cos y,0,−sin y), up=normalize(right×fwd);
       // writes camera.position, rebuilds camera.view via setFrame(right,up,fwd,eye)+invertRigid,
       // rebuilds UNJITTERED camera.projection via perspectiveFovLH(fov, aspect, 0.12, 4200)
  getFlatForward(out); getFlatRight(out)
}
export function expDamp(cur, target, rate, dt)      // target + (cur−target)·e^(−rate·dt)
```

### 9.7 `assets.js` (verbatim port)
`export const ASSET_BASE` (default `https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com`,
`VITE_ASSET_BASE` override, empty ⇒ local); `export function asset(path)`;
`export function assetCandidates(path)`; `export async function fetchAsset(path)`.

### 9.8 `loading.js` (verbatim port)
`nextFrame()`, `phase(text, to)`, `gate(onEnter?) → Promise<boolean>` (**onEnter called
synchronously in the click handler**), `done()`, `fail(message)`. DOM ids: `boot`,
`boot-bar`, `boot-phase`, `boot-gate`, `gate-enter`, `hint`, `nogpu`.

### 9.9 `perf.js`
`export const systemMs`, `export const stats` (mutated in place: `{last, median, mean, p99,
p95, max, fps, fpsLow, drawCalls, triangles, gpuMs}`), `sample(ms)`, `mark(name, ms)`,
`export const spikes`, `checkSpike(ms)`, `resetSpikes()`, `export class FrameGraph`
(verbatim 2D-canvas port), and the WebGL2 draw counter:
`export function installDrawCounter(gfx)` (sets `renderer.info.autoReset = false`),
`export function endFrameDraws()` (latch `renderer.info.render.calls` into
`stats.drawCalls`, then `renderer.info.reset()`). `stats.gpuMs` stays 0 (overlay dash).

### 9.10 `openingShot.js` (verbatim port)
`export const OPENING = null`, `applyOpening(shot, rig, character, herd, terrain)`,
`captureOpening(rig, character, herd)`, `installShotCapture(rig, character, herd)` (F2).

## 10. Subsystem module APIs

Constructor first-arg convention: Babylon's `scene` parameter becomes `gfx` everywhere.
All other parameters, method names and per-frame call signatures are the **source's**,
as restated below. Everything listed is required; `dispose()` on every class.

### `src/render/sky.js`
```
export class Sky {
  constructor(gfx)
  sunDir: Vector3; sunColor: Color; sunRadiance: Color; sunScale: number;
  groundBounce: Color; sh: Float32Array(36); lut /* skyLUT texture */; mesh; material;
  syncFromSettings(); update() → bool; async solve(); bake(); async projectSH();
  render(rig, time);
}
```
Sky mesh on LAYER.SKY, renderOrder 0, depthWrite:false, DoubleSide,
`clip.z = clip.w * 0.999999` trick preserved (valid in GL clip space).

### `src/render/shadows.js`
```
export const CASCADE_COUNT = 3;
export class ShadowSystem {
  constructor(gfx)                       // RESOLUTION 2048, SPLITS [26,95,330]
  maps: [rt0.texture, rt1.texture, rt2.texture];
  matrices: Matrix4[3]; matrixData: Float32Array(48); matrixValues: Matrix4[3] /* aliased, §7.2 */;
  splits: Float32Array(4) /* [26,95,330,330] */; splitsVec4: Vector4;
  params: Vector4[3]; paramData: Float32Array(12);   // (depthRangeM, orthoWidthM, 0, 0)
  texelSize = 1/2048; resolution = 2048; lightDir: Vector3;   // = −sunDir
  setHeightBounds(min, max);
  registerCaster(mesh, makeMaterial /* (cascadeIndex)=>material */, cascades = 3);
  update(camera /* rig.camera */, sunDir);   // fit per source: sphere fit, relative radius
       // quantize, texel snap BEFORE view build, analytic height-bounds depth (MARGIN 12,
       // fy clamp −0.0349), lookAtLH + orthoOffCenterLH (GL z), mulMat4(out, proj, view);
       // pushes lightViewProjection into every caster material for that cascade
  render(gfx);                                // §4.3 step 2
}
```

### `src/render/depthPass.js`
```
export const DEPTH_FAR = 9000;
export class DepthPass {
  constructor(gfx)                 // scenePrepass RT per §5, tracked screen-size
  rtt;                             // { texture } — bound as depthTex by post
  size: Vector2;
  registerCaster(mesh, material);
  render(gfx);                     // §4.3 step 3
  async warmUp();
}
```

### `src/post/postChain.js`
```
export class PostChain {
  constructor(gfx, rig, depthPass, sky)
  speedStreak; focusDist; passes;  // passes iterable for warm-up (each has .name)
  update(dt, streak?, focus?);     // §1.4 of render-post spec: unjittered matrices captured,
                                   // sun UV, bloom knee (3.0/1.4), Halton-8 jitter into
                                   // rig.camera.projection.elements[8]/[9], history flip
  render(gfx);                     // §4.3 step 5; TAA renders directly into history[k]
  endFrame();                      // prevViewProj latch; historyValid 0→0.5→1
  resetHistory();
}
```
Beauty target `sceneColor` is owned here and exposed as `post.sceneColor` (main renders
beauty into it; ssr reads it). All pass toggles early-out **in-shader** (`enabled < 0.5` →
copy); never detach passes. Composite outputs sRGB; sharpen renders to canvas.

### `src/terrain/*`
```
terrain.js:      export class Terrain {
  constructor(gfx, sky, shadows); async build(); makePrepassMaterial();
  async warmUp(); setDeformTexture(tex);
  update(cameraPos, focus, dt);          // runs deform sim pass FIRST, rebinds, pushes uniforms
  heightAt(x, z); normalAt(x, z, out);
  mesh; material; deform; heightfield;   // mesh on LAYER.OPAQUE renderOrder 10
}
heightfield.js:  export const WORLD_SIZE=2048, HEIGHT_RES=4096, AUX_RES=2048, PLAY_RADIUS=620;
  export class Heightfield { constructor(gfx); async bake(); heightAt; normalAt;
    clampToPlayArea(v); heightCPU; cpuRes; cpuTexel; minHeight; maxHeight; origin; size; texelWorld; }
deformation.js:  export const COVERAGE = 80;
  export class DeformationField { constructor(gfx);   // res read ONCE from S.deformResolution
    brush(x, z, radius, depth, berm, compression, ice, yaw?, elongation?, edge?);
    update(dt, focus) → texture; warmUp(); texture; center: Vector2; size; texel; }
clipmapMesh.js:  export const GRID_N=160, LEVELS=8, BASE_SPACING=0.085, INNER_EXTENT=6.8,
  OUTER_EXTENT=870.4, GRID_HALF_N=80; export function buildClipmapMesh(gfx) → mesh
  (position = (gridI, level, gridJ), Uint32 indices, metadata.triangles/vertices)
```
Height readback: render heightBake into RG32F `heightTex`; for CPU mirror, blit/re-render
into a transient RGBA32F 4096² target, `readRenderTargetPixels` (stride derived from
`length/4096²` as source), 2×2 box downsample to 2048², dispose transient. Keep the −0.5
sample-centre convention and identical B-spline weights. Deform relaxation time-banking
(RELAX_STEP 0.4 s, dt=0 otherwise) verbatim. All three terrain vertex shaders share the
`snowClipmap`/`snowDeform` chunks — bit-identical placement (spec risk #1).

### `src/character/*`
```
controller.js: export class CharacterController { constructor(terrain); update(dt, rig);
   position; velocity; prevVelocity; acceleration; facing; speed; speed01; speedRaw; surf;
   surfActive; lean; carve; streak01; gaitPhase; stepping; footfall; footIndex; footPos;
   footImpact; groundY; groundNormal; cast; castAimX; castAimY; castAimZ; }
   export function angleDelta(a,b); export function angleDamp(cur,target,rate,dt);
figure.js:    export const BONE_COUNT = 18, HIP_HEIGHT = 0.95; bone index consts B_*;
   export class Figure { constructor(terrain); update(dt, controller);
     skin; world; joint; plant; footPos; footWeight; touchdown; sink;
     handPosition(which, out, offset); }
cloth.js:     export class ClothPanel; export function makePanels();
   export class ClothSolver { constructor(panels, terrain); update(dt, figure, controller); }
build.js:     export const M_ROBE=0..M_FUR=6; buildBody(gfx); buildFur(gfx);
   buildClothMesh(gfx, panels); hoodRimPoint(s, out);
character.js: export class Character { constructor(gfx, terrain, sky, shadows, controller);
   registerPrepass(depthPass); update(dt); sync(cameraPos); setVisible(v); async warmUp();
   triangles; figure; charTex; bodyMat; clothMat; furMat; bodyMesh; clothMesh; furMesh; }
snowContact.js: export class SnowContact { constructor(controller, deformField, figure?, spray?);
   update(dt); }
```
Body+cloth cast into cascades 0–1 (`CHAR_CASCADES = 2`) and prepass; **fur casts nothing and
is not in the prepass**. One depth-material instance per (mesh, cascade). charTex layout per
§5 (rows 0–3 bone skin matrices, rows 4+ cloth panels: robe 4–15, mantle 16–22, sleeve0
23–30, sleeve1 31–38).

### `src/walkers/*`
```
walker.js:      export const MAX_WALKERS = 8;
  export class WalkerHerd { constructor(gfx, terrain, sky, shadows, asset, rig);
    walkers[]; bolts; count; footfalls; boneCount; frameCount; duration; baseSpeed; height;
    bounds; walkerTex; albedoTex; ormTex; factors; triangles;
    onMaterial; onShot; setCount(n); place(walker, target); setSpray(spray);
    registerPrepass(depthPass); setVisible(v); update(dt, target); sync(cameraPos);
    async warmUp(); }
bolts.js:       export class Bolts { constructor(gfx, ctx? /* {terrain, spray, look?} */);
    spawn(origin, dir); update(dt, cameraPos); async warmUp(); live; mesh; material; texture; }
  export { REACH as BOLT_REACH };   // 620
walkerAsset.js: export async function loadWalkerAsset(base, opts?) → WalkerAsset;
  export { layersFor as walkerTextureLayers };
```
Walkers cast into all 3 cascades, shadowBias 0.06. Walker meshes LAYER.OPAQUE order 10;
bolts LAYER.BLEND order 41. Speed/gait single-multiplier and REACH/LIFE couplings verbatim.
SNWK v2 `.bin` parsing per walkers spec §6 (magic "SNWK", uint32 header len, JSON header,
aligned sections, dequantisation formulas verbatim).

### `src/player/*`
```
speeder.js: export class Speeder { constructor(gfx, terrain, sky, shadows, asset, controller, spray?);
  position; yaw; roll; pitch; bounds; triangles; shotCount; mesh; material; bolts; jet;
  tex; albedoTex; ormTex;
  tick(dt); update(dt); sync(cameraPos); registerPrepass(depthPass); setVisible(v);
  async warmUp(); }
jet.js:     export class Jet { constructor(gfx);
  update(dt, world /* Float32Array(12) 3×4 */, nozzle, throttle, cameraPos);
  setVisible(v); async warmUp(); }
```
Speeder reuses walker shaders + loader by import (no file duplication). Casts into cascades
0–1 only, shadowBias 0.11, matFactors slot 7 = (S.speederFill, S.speederDesat). Jet on
LAYER.BLEND order 40, additive, HDR constants (×16 body, ×30 core) verbatim.

### `src/spells/*`
```
spellSystem.js: export class SpellSystem { constructor(gfx, sky, shadows, terrain, controller,
    figure|null, rig, spray); update(dt, cameraPos); cast(key); holdRibbon(held);
    addConsumers(...materials); registerPrepass(depthPass); async warmUp(x,y,z);
    finishWarmUp(); activeCount; triangles; castCount; lastCast; castBlend; aim; ribbon; }
spellLights.js: export const MAX_SPELL_LIGHTS = 4;
  export const SPELL_LIGHT_UNIFORMS = ["spellLightPos","spellLightCol","spellLightCount"];
  export class SpellLights { pos: Float32Array(16); col: Float32Array(16); count; scale;
    begin(); add(x,y,z,radius,r,g,b,intensity); apply(material); }
waterBody.js:   export const STRAND_MAX=8, STRAND_COLS=64, LATTICE_COLS=176, RING=24,
  PROFILE_TUBE=0, PROFILE_SHEET=1;
  export class WaterBody { acquire(); release(s); clear(s);
    column(s,c,x,y,z,radius,rx,ry,rz,twist,dist,age,foam,flatten);
    setParams(s,profile,milkiness,alpha,count); update(dt,cameraPos); liveStrands; triangles;
    warmUp(x,y,z); finishWarmUp(); }
crystals.js:    export const CRYSTAL_MAX=96, VERTS=13, RING=6, CRYSTAL_CASCADES=2;
  export class CrystalField { plant(...); update(dt, cameraPos); registerPrepass(depthPass);
    warmUp; finishWarmUp; liveCount; triangles; }
bending.js:     clamp01, clampRange, smooth01, bell, expDamp, transport, groundRay, aimPoint.
sweep/ribbon/bloom/crystallize/vortex.js: class per spell — constructor(ctx), update(dt),
  cancel(), active; trigger signatures per spells spec §2.
```
Crystals: LAYER.OPAQUE order 20 (transparent + depthWrite:true). Water: LAYER.BLEND order 30.
Crystals are the **only** prepass caster writing mask = 1. Spell update ordering inside
`SpellSystem.update`: lights.begin → dispatch → spells → lights.apply to all consumers →
water.update → crystals.update.

### `src/vfx/*`
```
particles.js: export class SprayField { constructor(gfx, terrain, sky, shadows);
    emit(x,y,z,vx,vy,vz,size,life,kind,drag?); update(dt, cameraPos); async warmUp();
    liveCount; material; mesh; dataTex; }
  export { CAPACITY as SPRAY_CAPACITY };   // 5120
surfWake.js:  export class SurfWake { constructor(gfx, sky, shadows, controller, spray, terrain);
    registerPrepass(depth); setEnabled(v); update(dt, cameraPos); async warmUp();
    mesh; material; debug; prepassMat; }
  export { COLS as WAKE_COLS, ROWS as WAKE_ROWS };   // 128, 18
```
Wake: LAYER.OPAQUE order 10, casts cascades 0–1 (`WAKE_CASCADES=2`), `wakeEroded` byte-shared
across beauty/depth/prepass fragments, one `wakeTime` clock pushed to all four materials.
Spray: LAYER.BLEND order 50, no shadow cast, no prepass, dead slots zero-written every frame.
Spray billboard basis from the LH view matrix: `camRight = (v[0], v[4], v[8])`,
`camUp = (v[1], v[5], v[9])` of `rig.camera.view.elements`.

### `src/audio/*` and `src/ui/*` (near-verbatim; renderer-free)
APIs exactly as audio-ui spec §2: `AudioEngine`/`LoopVoice`/`audio` singleton,
`AUDIO_MANIFEST` (table verbatim incl. `needs:"speeder"` entries and the intentionally
absent `walkerStep`), `Soundscape`, `Overlay`, `createFpsMeter`, `createSoundButton`,
`createTouchControls`. Two renderer touch-points:
- `Overlay.update(dtMs, gfx)` — "res" readout from `gfx.renderWidth/renderHeight`.
- draw/tri stats come from `perf.js` (§9.9); gpuMs stays 0 → `—` dash.
Overlay/fpsMeter take **milliseconds**; Soundscape takes **seconds**; soundscape runs last in
sim; unlock is synchronous-in-gesture (§4.1 step 20).

## 11. Asset policy

- `public/` is copied **verbatim** from
  `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo/public/` (audio mp3s,
  `models/walker.bin` + webps, `models/speeder.bin` + webps). No re-encoding.
- Loaders parse the same formats: SNWK v2 container (walkers spec §6), WebP decode via
  `createImageBitmap` + OffscreenCanvas into raw layer-major RGBA8 bytes (keeps color
  handling out of the browser's hands), mp3 via `decodeAudioData`.
- All fetches go through `core/assets.js` `fetchAsset`/`assetCandidates` (CDN-first, local
  `public/` fallback, `VITE_ASSET_BASE` override).
- The AT-AT credit line (CC BY-NC-SA 4.0, Quiznos323) **must** be preserved in both HTML
  boot screens.

## 12. Debug global

`globalThis.SNOWFLOW = { gfx, scene: gfx.scene, rig, character, figure, walkers, speeder,
contact, spray, wake, spells, overlay, touchControls, terrain, sky, shadows, post, depthPass,
audio, soundscape, S, input, perfStats: stats, captureShot, speederTuning() }` —
`speederTuning()` verbatim from source. Keep every debug view: `S.debugView` (11 modes,
float map identical to source), `S.speederDebug` (8 modes + `debugGain = 1/max(0.001,
S.exposure)`), `wake.debug` (10 modes). These are the port's acceptance tooling.
