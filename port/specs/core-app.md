# Porting spec — subsystem `core-app`

Source repo: `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo` (Babylon.js 9.18 / WebGPU / WGSL, Vite, ES modules).
Target: Three.js `WebGLRenderer` (WebGL2, GLSL ES 3.0, raw `ShaderMaterial`/`RawShaderMaterial`, `WebGLRenderTarget` sims/post).

Files covered:

- `src/main.js` — entry point, boot sequence, frame orchestration
- `src/jet.js` + `jet.html` — flight-test variant page
- `index.html` — main page, boot-screen DOM/CSS
- `src/core/assets.js` — CDN asset resolution
- `src/core/camera.js` — third-person spring-arm camera rig
- `src/core/gpuUtil.js` — shader-readiness helpers
- `src/core/input.js` — keyboard/mouse/touch input struct
- `src/core/loading.js` — loading-screen driver
- `src/core/mat4.js` — flat-array 4x4 rigid-transform math
- `src/core/openingShot.js` — pinned opening shot + F2 capture
- `src/core/perf.js` — frame stats, draw counter, frame graph
- `src/core/settings.js` — the `S` settings store, schema, presets
- `src/shaders/registry.js` — WGSL shader/include registration
- `package.json`

`core-app` is the *conductor*: it owns no render targets and no meshes of its own (the boot-screen DOM aside). It creates the engine/scene/camera, constructs every other subsystem in a precise order, runs the warm-up, and drives the per-frame update/render order. Porting it correctly is mostly about reproducing **ordering** and **conventions**, not graphics techniques.

---

## 1. Purpose & behavior

### 1.1 Boot sequence (`boot()` in `src/main.js`)

Exact order — later subsystems depend on earlier ones existing, and the loading bar weights are tied to these steps:

1. Grab `<canvas id="view">`. If `!navigator.gpu` → `loading.fail("WebGPU is not available in this browser.")` and stop. *(Port: test for WebGL2 instead, or drop the gate.)*
2. **Mobile detection**: `window.matchMedia("(pointer: coarse)").matches` → `applyPreset("balanced")` and `S.resolutionScale = 0.7`. Must happen **before any subsystem is built** — `deformResolution` is read once at terrain construction.
3. Kick off async downloads **without awaiting**: `audio.load()`, `loadWalkerAsset("models/walker")`, and — only if `S.speeder === true` (captured once into const `FLYING`) — `loadWalkerAsset("models/speeder")`. When speeder is off, nothing speeder-related is fetched, decoded, compiled or constructed.
4. `loading.phase("creating device", 0.05)`.
5. Create engine: `new WebGPUEngine(canvas, { antialias: false, stencil: false, powerPreference: "high-performance", enableAllFeatures: true, setMaximumLimits: true })`, `await engine.initAsync()`. Failure → `loading.fail("WebGPU device initialisation failed.")`.
   - `antialias:false` is deliberate: TAA in the post chain handles edges. Port: `new THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: "high-performance" })`.
6. Capability check: `engine.getCaps().textureFloatLinearFiltering` — warn (do not fail) if the R32F heightfield cannot be linearly filtered. Port: `gl.getExtension("OES_texture_float_linear")`.
7. **Resolution scale**: `engine.setHardwareScalingLevel(1 / S.resolutionScale)`, applied now and re-applied via `onChange("resolutionScale", ...)`. `window.addEventListener("resize", () => engine.resize())`. Port: `renderer.setSize(w * S.resolutionScale, h * S.resolutionScale, false)` with CSS size fixed at full canvas, plus resize listener; every screen-sized render target must follow.
8. `installDrawCounter(engine)` (wraps the two draw entry points — see §5), `engine.captureGPUFrameTime(true)` (WebGPU timestamp queries; overlay shows a dash when absent), `registerShaders()` (fills Babylon's shader store — see §4).
9. `loading.phase("building scene", 0.12)`; `new Scene(engine)` with:
   - `scene.clearColor = new Color4(0.02, 0.03, 0.05, 1)`; `scene.autoClear = true`
   - `scene.setRenderingAutoClearDepthStencil(1, false)` and `(2, false)` — **depth is NOT cleared between rendering groups**. Group 0 = sky, group 1 = opaque scene, group 2 = alpha-blended water & spray which must depth-test against group 1.
   - `scene.ambientColor = new Color3(0,0,0)`; **no stock lights anywhere** — every material computes its own lighting.
10. `new CameraRig(scene, canvas)`; `scene.activeCamera = rig.camera`.
11. `loading.phase("integrating atmosphere", 0.2)`; `new Sky(scene)`; `sky.mesh.renderingGroupId = 0`; `await sky.solve()`.
12. `new ShadowSystem(scene)` (cascaded shadow maps, other subsystem).
13. `new DepthPass(scene)` — the camera-space depth prepass. **Registration order is the scheduling**: it is a custom render target created after the shadow cascades and before anything that draws, and Babylon renders custom RTTs in registration order. Port: an explicit ordered list of render passes executed each frame before the beauty pass.
14. `loading.phase("baking heightfield", 0.34)`; `new Terrain(scene, sky, shadows)`; `terrain.mesh.renderingGroupId = 1`; `await terrain.build()`; `onChange("showTerrain", v => terrain.mesh.isVisible = v)`; `depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial())`.
15. `loading.phase("placing character", 0.62)`; `new CharacterController(terrain)`; position `(0, terrain.heightAt(0,0), 0)`. If `S.speeder === true`: `rig.yaw = character.facing` (chase camera must start behind the nose).
16. `new Character(scene, terrain, sky, shadows, character)` (the figure); `figure.registerPrepass(depthPass)`; visibility rule: `figure.setVisible(S.showCharacter !== false && !FLYING)` — the figure is still *simulated* while flying (speeder reads the same controller) but never drawn. `onChange("showCharacter", showFigure)`.
17. `loading.phase("landing the walkers", 0.70)`; `new WalkerHerd(scene, terrain, sky, shadows, await walkerReady, rig)`; `onChange("showWalker", v => walkers.setVisible(v))`; `walkers.registerPrepass(depthPass)`.
18. `new SprayField(scene, terrain, sky, shadows)` (shared airborne-snow particle pool).
19. Speeder (only when `FLYING`): `new Speeder(scene, terrain, sky, shadows, await speederReady, character, spray)`; `speeder.registerPrepass(depthPass)`; `speeder.setVisible(true)`. Then `walkers.setSpray(spray)`.
20. `new SnowContact(character, terrain.deform, figure.figure, spray)` — feet/board writes into the terrain deformation state buffer.
21. `new SurfWake(scene, sky, shadows, character, spray, terrain)`; `onChange("showWake", v => wake.setEnabled(v))`; `wake.registerPrepass(depthPass)`.
22. If `FLYING`: `S.showSpells = false; S.showWake = false` (plain writes, not `set()` — no listeners fire).
23. `new SpellSystem(scene, sky, shadows, terrain, character, figure.figure, rig, spray)`; then **consumer wiring** — every material a spell can light: `spells.addConsumers(terrain.material, figure.bodyMat, figure.clothMat, wake.material, spray.material)`; `walkers.onMaterial = m => spells.addConsumers(m)` (herd can grow after boot) plus one pass over existing `walkers.walkers[i].material`; `spells.registerPrepass(depthPass)`.
24. `rig.groundAt = (x, z) => terrain.heightAt(x, z)` — injects the height sampler into the camera.
25. `applyOpening(OPENING, rig, character, walkers, terrain)` — no-op unless a shot is pinned (see §2.10).
26. `new PostChain(scene, rig.camera, depthPass, sky)`.
27. UI: `new Overlay({ rig, character })`, `createFpsMeter()`, `initInput(canvas, { onToggleOverlay, onToggleFps })`, `createTouchControls({ onToggleOverlay })`, `installShotCapture(rig, character, walkers)` (F2).
28. `new Soundscape(audio, { controller: character, spells, walkers, speeder })`; `createSoundButton(audio, { onEnable: () => soundscape.start() })`.

### 1.2 Warm-up (behind the loading screen)

`loading.phase("compiling pipelines", 0.78)`, then in order:

```
shadows.update(rig.camera, sky.sunDir);
sky.render(rig, 0);
await terrain.warmUp();
terrain.update(rig.camera.position, character.position, 0);
figure.update(0); figure.sync(rig.camera.position); await figure.warmUp();
walkers.sync(rig.camera.position); await walkers.warmUp();
if (speeder) { speeder.update(0); speeder.sync(rig.camera.position); await speeder.warmUp(); }
spray.update(0, rig.camera.position); await spray.warmUp();
await wake.warmUp();
await spells.warmUp(character.position.x + 3, character.position.y, character.position.z + 3);
await whenReady(sky.material, "sky material", [sky.mesh, false]);
await depthPass.warmUp();
post.update(0, 0, rig.distance);
for (const p of post.passes) await whenReady(p, "post:" + p.name);
```

Then `loading.phase("warming render targets", 0.92)` and **3 real frames**: `scene.render(); await loading.nextFrame();` ×3 — allocates every RT and binds every pipeline once. Then `spells.finishWarmUp()` (spell meshes had to stand through those frames for their pipelines to exist).

Port note: in WebGL2 the equivalent is `renderer.compile(scene, camera)` (or `compileAsync` with `KHR_parallel_shader_compile`) plus the same 3 warm frames. The `whenReady` polling machinery (§2.5) exists because Babylon/WebGPU compiles async; in Three most of it collapses into `compileAsync`, but keep the 3-frame warm render — it is what forces RT allocation and first-bind.

### 1.3 Run loop (`engine.runRenderLoop`)

Per frame, **exact order matters** (comments in source give the dependency reasons):

```
now = performance.now(); dtMs = min(now - prev, 100);      // clamp hitches at 100 ms
dt = S.freezeTime ? 0 : dtMs / 1000;  time += dt;
pollInput();                                                // resolve held keys → axes
tFrame = now();
character.update(dt, rig);
terrain.heightfield.clampToPlayArea(character.position);
figure.update(dt);                    // pose BEFORE contact: footprints stamp at solved boot position
contact.update(dt);
walkers.update(dt, character.position);
speeder?.tick(dt); speeder?.update(dt);
tChar = now();
_vel.copyFrom(character.velocity);
rig.update(dt, character.position, _vel, character.lean, character.speed01);
post.update(dt, character.streak01, rig.distance);          // TAA jitter — AFTER rig moves, BEFORE anything reads the view-proj
sky.update(); sky.render(rig, time);
shadows.update(rig.camera, sky.sunDir);
spells.update(dt, rig.camera.position);                     // AFTER shadow refit (carry this frame's cascades), BEFORE terrain (brushes staged for the sim pass)
tSpells = now();
terrain.update(rig.camera.position, character.position, dt);
tTerrain = now();
figure.sync(rig.camera.position);                           // AFTER shadow refit
walkers.sync(rig.camera.position);                          // also picks LOD — needs this frame's camera+fov
speeder?.sync(rig.camera.position);
wake.update(dt, rig.camera.position);                       // BEFORE spray: shed grains must be in the pool before upload
spray.update(dt, rig.camera.position);
tVfx = now();
soundscape.update(dt);                                      // pure reader, last
tAudio = now();
scene.render();
post.endFrame();
tRender = now();
mark("cpu character", tChar - tFrame); mark("cpu spells", tSpells - tChar);
mark("cpu terrain", tTerrain - tSpells); mark("cpu wake+spray", tVfx - tTerrain);
mark("cpu audio", tAudio - tVfx); mark("cpu submit", tRender - tAudio);
mark("cpu total", tRender - tFrame);
stats.gpuMs = engine.getGPUFrameTimeCounter().lastSecAverage / 1e6;
endFrameDraws();
stats.triangles = terrain.mesh.metadata?.triangles
    + (S.showCharacter && !FLYING ? figure.triangles : 0)
    + (speeder ? speeder.triangles : 0)
    + walkers.triangles
    + (wake.mesh.isVisible ? wake.mesh.metadata.triangles : 0)
    + spells.triangles
    + spray.liveCount * 2;
sample(dtMs); checkSpike(dtMs);
overlay.update(dtMs, engine); fpsMeter.update(dtMs);
endFrame();                                                 // clears input accumulators — must be LAST
```

### 1.4 Audio gate + finish

After the loop starts: `loading.phase("loading audio", 0.96)`; `await audioReady`. If `audio.hasAssets`: `await loading.gate(() => { unlocking = audio.unlock(); })` — `unlock()` **must be called synchronously inside the click handler** (Safari gesture rule). Then `await unlocking; soundscape.start()`. `soundButton.sync()`, `await loading.done()`, `soundButton.reveal()`, `setTimeout(() => overlay.resetSpikes(), 800)` (discard warm-up spikes).

### 1.5 Debug global

`globalThis.SNOWFLOW = { engine, scene, rig, character, figure, walkers, speeder, contact, spray, wake, spells, overlay, touchControls, terrain, sky, shadows, post, depthPass, audio, soundscape, S, input, perfStats: stats, captureShot, speederTuning() }`.
`speederTuning()` logs `speederFill, speederTint, speederRough, speederAmbient, speederDesat, jetSpan, jetDropY, jetBackZ, boltR, boltG, boltB, boltWidth, boltLength` as paste-able source and returns them as an object.

### 1.6 `jet.js` / `jet.html` — flight test page

`src/jet.js` is 6 setting writes + a dynamic import: `S.speeder = true; S.showWalker = false; S.showSpells = false; S.showWake = false; S.showCharacter = false; S.audioMuted = false;` then `await import("./main.js")` (main boots on import). Same boot, same systems — not a parallel path. `jet.html` is a minimal clone of the boot DOM with the same element ids (`view`, `boot`, `boot-bar`, `boot-phase`, `boot-gate`, `gate-enter`, `hint`, `nogpu`). Port: preserve the "settings singleton written before entry module import" trick — it requires that `main.js` runs its boot on import and that settings is a plain shared module.

### 1.7 `index.html`

Provides: `<canvas id="view" tabindex="0">`, hint bar (`#hint`), boot screen (`#boot` > `.boot-inner` > wordmark/tagline/`.bar`>`#boot-bar`/`#boot-phase`/`#boot-gate`>`#gate-enter`+note), `.credit` (AT-AT model attribution — **CC BY-NC-SA 4.0, the credit must travel with the work**), and `#nogpu` failure panel. CSS drives all transitions (`#boot.gone` fade 900 ms, `#boot.gated` hides bar+phase, `.gate.show`, `#hint.show`, `#nogpu.show`). The loader only toggles classes and text. Port both HTML files nearly verbatim; change the `#nogpu` copy to a WebGL2 message.

---

## 2. Public API

### 2.1 `src/main.js`
No exports. Side effect: runs `boot()` on import; `boot().catch(err => loading.fail("Startup failed — see console."))`. Publishes `globalThis.SNOWFLOW` (§1.5).

### 2.2 `src/core/settings.js`
- `export const S` — flat mutable `Record<string, number|boolean|string>` read directly every frame. Full key list with defaults is in the source (§ groups: quality, sun, atmosphere, snow, deformation, snow-surf, speeder, walker, spells, post, audio, systems, debug). **Copy the file's keys and defaults verbatim.** Keys consumed by core-app itself: `resolutionScale` (1.0), `preset` ("ultra"), `speeder` (false, read once at boot), `freezeTime` (false), `showTerrain`, `showCharacter`, `showWalker`, `showWake`, `showSpells`, `audioMuted`, plus the speeder-tuning keys listed in §1.5 (read only by `speederTuning()` here; consumed by the speeder subsystem).
- `export const SCHEMA` — widget metadata array `{group, items:[{k,l,t:"f"|"b"|"e",min,max,step,opts}]}` consumed by the settings overlay. Notable enums: `tonemap: ["agx","aces","none"]`, `debugView: ["beauty","deform","normals","depth","cascades","footprint","fineNormals","shadow","ndotl","shadowMap","albedo"]`, `speederDebug: ["off","albedo","normal","slot","ao","roughness","sun cosine","shadow"]`.
- `export const PRESETS` — `ultra: {}`, `high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true }`, `balanced: { deformResolution: 1024, resolutionScale: 0.85, ssr: false, dof: false }`.
- `export function onChange(keys: string|string[], fn: (v,k)=>void): () => void` — subscribe; returns unsubscribe.
- `export function set(k, v)` — write + notify (no-op if unchanged). Never called from the render loop.
- `export function applyPreset(name)` — sets `S.preset` then `set()`s each key in the preset.

### 2.3 `src/core/input.js`
- `export const input` — `{ moveX, moveZ, moving, lookX, lookY, zoomDelta, surf, fire, sprint, spellPressed (0|1..5, cleared each frame), spellHeld2, locked }`. Movement axes are camera-relative, clamped to unit disc. `lookX/lookY` accumulate radians (mouse delta × `LOOK_SCALE = 0.0022`) and are zeroed by `endFrame()`.
- `export const touch` — `{ present, x, z, active, sprint, surf }`; written by `ui/touchControls.js`; touch also adds directly into `input.lookX/lookY/zoomDelta`.
- `export function initInput(canvas, hooks?: { onToggleOverlay?, onToggleFps? })` — wires: pointer lock on click (suppressed once any touch is seen); pointerlockchange clears held keys; mousemove accumulates look while locked; contextmenu prevented; RMB tracked separately (`rmbHeld`); wheel (`passive:false`, `preventDefault`, `zoomDelta += deltaY * 0.0016`); keydown: F1/Backquote → overlay toggle (works unlocked), KeyF → fps meter toggle, Space `preventDefault` (it is the slide/fire trigger), Digit1–5 → `spellPressed`/`spellHeld2`; window blur clears everything (keys, rmb, surf, touch).
- `export function pollInput()` — per frame, before updates: rebuilds `moveX/moveZ` from WASD/arrows, unit-disc clamp, **touch stick wins outright while active** (not summed). `sprint = Shift || touch.sprint`. Trigger resolution: `held = rmbHeld || Space || touch.surf`; `flying = S.speeder !== false`; `input.surf = flying ? true : held` (**flying pins the surf/momentum mode permanently on**); `input.fire = flying ? held : false`.
- `export function endFrame()` — zero `lookX, lookY, zoomDelta, spellPressed`. Called at end of frame.
- `export function isDown(code): boolean`.

### 2.4 `src/core/camera.js`
- `export class CameraRig`
  - `constructor(scene, canvas)` — creates Babylon `UniversalCamera("cam", (0,3,-6))`: `minZ = 0.12`, `maxZ = 4200`, `fov = 1.02` **radians, vertical**, `inertia = 0`, no `attachControl` — the rig writes position/rotation/fov directly every frame.
  - Speeder-dependent init (checks `S.speeder !== false`): `yaw = 2.4`; `pitch = 0.42` flying / `0.17` on foot; `distance = distanceTarget = 11.5` / `6.2`; `shoulder = 0.0` / `0.85` (camera-space right offset); `pivotHeight = 4.2` / `1.62`; `groundClearanceBase = 3.4` / `1.35`.
  - Public fields read by other subsystems: `camera`, `yaw`, `pitch`, `distance`, `distanceTarget`, `pivot: Vector3`, `fov` (current, speed-widened), `forward/right/up: Vector3` (republished basis — spells aim with these), `trauma`, `groundAt: ((x,z)=>number)|null` (injected by main), `groundClearance`, `groundLift`.
  - `addTrauma(amount)` — clamped accumulate; shake = trauma² (Eiserloh style), decays at `1.15/s`.
  - `update(dt, targetPos, targetVel, lean, speed01)` — full algorithm:
    - `yaw += input.lookX`; flying only: chase swing — `steer = clamp(-input.lookX * 26, -1, 1)`, `_swing = expDamp(_swing, steer * CHASE_SWING(0.55), 3.4, dt)`, `yaw -= _swing * dt * 2.4`.
    - `pitch = clamp(pitch + input.lookY, PITCH_MIN(-0.62), PITCH_MAX(1.05))`.
    - Zoom: `distanceTarget = clamp(distanceTarget + zoomDelta * distanceTarget * 0.35, 2.6, 11.0)`; `distance = expDamp(distance, target, 9, dt)`.
    - Pivot: `targetPos + (0, pivotHeight, 0)` + velocity lead `min(1,speed01)*1.35*0.09` on x/z; first frame snaps, then critically-damped spring `springDamp(pivot, pivotVel, want, freq=7.5, damping=1.0, dt)` with internal `h = min(dt, 1/45)`.
    - FOV: `expDamp(fov, baseFov * (1 + speed01 * 0.19), 3.2, dt)`.
    - Bank: `rollTarget = -lean * 0.085`; `roll = expDamp(roll, rollTarget, 5.0, dt)`.
    - Basis (Babylon LH, +Z forward): `fwd = (sin(yaw)·cos(pitch), −sin(pitch), cos(yaw)·cos(pitch))`, `right = (cos(yaw), 0, −sin(yaw))`, `up = normalize(right × fwd)`. Copied into `this.forward/right/up`.
    - Desired eye: `pivot − fwd·distance + right·shoulder + up·0.22`.
    - Ground avoidance: 6 samples (`ARM_SAMPLES = 5`, t = 0..1) along pivot→eye; needed lift = max over samples of `(groundAt(x,z) + groundClearance·(0.35 + 0.65·t)) − y`; `groundLift = expDamp(lift, need, need>lift ? 26 : 4.5, dt)` (fast up, slow down); added to eye Y.
    - Shake: value-noise offsets on position (±0.16/0.16/0.10 × shake, at 26 Hz-ish `noise1(t·26 + offsets)`) and on rotation (pitch ±0.02, yaw ±0.02, roll ±0.05 at 31/29/23 rates).
    - Writes `cam.position`, `cam.fov`, `cam.rotation.set(pitch+…, yaw+…, roll+…)` — **Babylon Euler order is Y-then-X-then-Z (yaw, pitch, roll)**.
  - `getFlatForward(out)` / `getFlatRight(out)` — XZ-plane movement basis from yaw only.
- `export function expDamp(cur, target, rate, dt)` — `target + (cur−target)·e^(−rate·dt)`. Used by other subsystems too.
- Internal: `springDamp`, `noise1`/`hash1` (deterministic `sin`-hash value noise).

### 2.5 `src/core/gpuUtil.js`
- `export function whenReady(obj, label, args?): Promise` — polls `obj.isReady(...args)` on rAF, rejects after 25 s with a "almost always a WGSL compile error" message. Used for materials (`[mesh, useInstances]` args), procedural textures, post passes.
- `export async function bakeOnce(pt, label?)` — `await whenReady(pt); pt.render();` — compile + single render of a Babylon `ProceduralTexture` (the bake pattern used by terrain/sky). Port: fullscreen-triangle pass into a `WebGLRenderTarget`, rendered once.
- `export function bindMatrixArray(material, name, data: Float32Array)` — zero-copy binding of a pre-flattened mat4 array into a Babylon `ShaderMaterial` (pokes `material._matrixArrays[name]` after `_checkUniform`). Exists to avoid Babylon's per-call Float32Array allocation for the 3 shadow cascade matrices × 6 materials. Port: trivial — `material.uniforms[name] = { value: float32Array }` on a `RawShaderMaterial` with `mat4 name[3]`, or keep one shared `UniformsGroup`/UBO.

### 2.6 `src/core/loading.js`
Binds DOM ids `boot-bar`, `boot-phase`, `boot`, `hint`, `boot-gate`, `gate-enter`, `nogpu` at module load.
- `export function nextFrame(): Promise` — double-rAF yield.
- `export async function phase(text, to)` — sets label, monotonic max progress (bar width %), yields.
- `export function gate(onEnter?): Promise<boolean>` — shows the enter button, resolves on click/Enter/Space/NumpadEnter; **`onEnter` is called synchronously inside the handler** (audio-unlock gesture rule); resolves `false` immediately if the gate markup is absent.
- `export async function done()` — phase("ready", 1), 360 ms settle, adds `.gone`, shows `#hint`, removes boot node after 6 s.
- `export function fail(message)` — removes boot, shows `#nogpu` with message in its `<b>`.

### 2.7 `src/core/perf.js`
- `export const systemMs` — `Object.create(null)` of per-system CPU ms, written via `mark()`.
- `export const stats` — mutated in place, never reassigned: `{ last, median, mean, p99, p95, max, fps, fpsLow, drawCalls, triangles, gpuMs }`. Percentile-based (median + 1% low), recomputed at 4 Hz from a 512-entry ring buffer (`CAP = 512`), TypedArray in-place sort, zero allocation per frame.
- `export function sample(ms)` — push one frame time; triggers `recompute()` every ≥250 ms.
- `export function installDrawCounter(engine)` — wraps `engine.drawElementsType` and `engine.drawArraysType` to count real draws (Babylon's `_drawCalls` counts something else). Port: read `renderer.info.render.calls` before `renderer.info.reset()` (set `renderer.info.autoReset = false` and reset manually at frame end) — no wrapping needed.
- `export function endFrameDraws()` — latch count into `stats.drawCalls`, zero the accumulator; call once after `scene.render()`.
- `export function mark(name, ms)` — overwrite one per-system timing.
- `export const spikes = { count, sinceReset }`; `checkSpike(ms)` — counts frames exceeding `median + 4 ms`; `resetSpikes()`.
- `export class FrameGraph` — 2D-canvas bar graph (`getContext("2d", { alpha: true, desynchronized: true })`); budget guides at 11.1 ms and 16.7 ms; bars coloured `>16.7 → #e8734f`, `>11.1 → #e8b04f`, else `#6fb2e0`; median line; y-axis top eased toward `clamp(max·1.25, 22, 60)`. Pure DOM — port as-is.

### 2.8 `src/core/mat4.js`
Flat `Float32Array` 4×4 rigid transforms, explicit array + offset, zero allocation. **Column-major, Babylon-compatible layout**: elements 0–2 X axis, 4–6 Y axis, 8–10 Z axis, 12–14 translation — the same layout GLSL `mat4` expects, so it ports unchanged.
- `setFrame(out, o, px,py,pz, xx..zz)` — write a rigid frame.
- `setFrameFromDir(out, o, px,py,pz, dx,dy,dz, rx,ry,rz)` — bone-style frame: dir becomes local +Y; ref re-orthogonalised (fallback cross with world +X). **Comment states the LH convention: X right, Y up, Z forward, plain cross product completes the basis** — see risk R1.
- `mul(out, oo, a, oa, b, ob)` — rigid multiply; no aliasing.
- `invertRigid(out, oo, m, om)` — transpose rotation, negate rotated translation.
- `xformPoint(m, om, x,y,z, dst, od)` / `xformDir(...)`.

### 2.9 `src/core/assets.js`
- `DEFAULT_BASE = "https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com"` (public Vercel Blob store, `access-control-allow-origin: *`).
- `export const ASSET_BASE` — `import.meta.env?.VITE_ASSET_BASE ?? DEFAULT_BASE`, trailing slashes stripped. `VITE_ASSET_BASE=` (empty) serves from `public/`.
- `export function asset(path): string` — join base + path.
- `export function assetCandidates(path): string[]` — `[CDN url, local path]` (best first); local-only when no base.
- `export async function fetchAsset(path): Promise<Response>` — first candidate that returns `res.ok`; throws last error otherwise.

### 2.10 `src/core/openingShot.js`
- `export const OPENING: OpeningShot|null = null` — paste target. Shape: `{ camera: {yaw, pitch, distance}, player: {x, z}, walkers: [{x, z, yaw, phase?}] }`.
- `export function applyOpening(shot, rig, character, herd, terrain)` — no-op on null; else sets rig yaw/pitch/distance(+target), player x/z with `y = terrain.heightAt(x,z)`, `herd.setCount(list.length)` then per walker position/yaw/phase and flags `w._placed = true; w._settled = false`.
- `export function captureOpening(rig, character, herd): string` — emits the paste-able `export const OPENING = {...}` source block (3-decimal rounding).
- `export function installShotCapture(rig, character, herd)` — binds F2 (preventDefault) → console log + best-effort `navigator.clipboard.writeText`; returns the capture function (exposed as `SNOWFLOW.captureShot`).

### 2.11 `src/shaders/registry.js`
- `export function registerShaders()` — idempotent. Copies 15 WGSL include libs into `ShaderStore.IncludesShadersStoreWGSL` under names `snowNoise, snowTerrain, snowShading, snowShadowLookup, snowAtmosphere, snowClipmap, snowDeform, snowCharSkin, snowWalkerSkin, snowWake, snowSpellLights, snowWater, snowCrystal, snowPostCommon, snowRidge` (files: `src/shaders/lib/{noise,terrain,shading,shadowLookup,atmosphere,clipmap,deform,charSkin,walkerSkin,wake,spellLights,water,crystal,postCommon,ridge}.wgsl`), and ~45 full shaders into `ShaderStore.ShadersStoreWGSL` under Babylon's `<name>VertexShader` / `<name>PixelShader` naming. All loaded as raw strings via Vite `?raw` imports. Must run **before any material is constructed**.

### 2.12 `package.json`
`"type": "module"`; deps `@babylonjs/core ^9.18.0`, `@babylonjs/materials ^9.18.0`; dev `vite ^8.1.5`; scripts `dev/build/preview` (vite) and `bake:walker` (`node tools/bakeWalker.mjs`). Port swaps deps for `three` and keeps Vite (the `?raw` import pattern and `import.meta.env` are Vite features the registry and assets module rely on).

---

## 3. Data flow (cross-subsystem objects core-app produces/consumes)

`core-app` owns no GPU resources. Its shared surfaces are CPU-side singletons and the wiring itself:

| Object | Producer | Consumers | Notes |
|---|---|---|---|
| `S` (settings store) | settings.js | **every** subsystem, every frame | flat object, direct reads; `onChange` for rebuild-type reactions; `set()` from overlay only |
| `input` struct | input.js (keyboard/mouse) + ui/touchControls.js (touch) | character controller, speeder, spells, camera rig | polled, never evented; `endFrame()` zeroes accumulators at end of frame |
| `CameraRig` | camera.js | main loop; spells (aim via `rig.forward/right/up`); walkers (LOD via rig); sky (`sky.render(rig, time)`); overlay | also `rig.camera` = the Babylon camera whose view/proj everything renders with; `rig.distance` fed to `post.update` |
| `rig.groundAt` | injected by main from `terrain.heightAt` | camera ground avoidance | plain `(x,z)=>y` callback |
| `scene` / `engine` | main | everyone | render groups 0/1/2, no auto depth clear between 1↔2, clearColor (0.02,0.03,0.05,1) |
| `depthPass` registrations | main calls `registerCaster`/`registerPrepass` on terrain, figure, walkers, speeder, wake, spells | DepthPass → PostChain (SSR/DoF read camera depth) | order of RTT creation = render order in Babylon; must become an explicit pass list in Three |
| `spells.addConsumers(materials…)` | main | spell dynamic-light uniforms pushed into terrain/figure/cloth/wake/spray/walker materials | walkers hand materials over via `walkers.onMaterial` callback because the herd grows after boot |
| `spray` (shared particle pool) | main constructs, passes to walkers (`setSpray`), speeder, contact, wake, spells | one pool, many writers | |
| `contact` (SnowContact) | main wires `character`, `terrain.deform`, `figure.figure`, `spray` | writes into terrain deformation state buffer | |
| `stats` / `systemMs` / `spikes` | perf.js, fed by main's `mark()` calls + `sample()` | ui/overlay.js, ui/fpsMeter.js | `stats.gpuMs` from engine GPU timer; `stats.drawCalls` from wrapped draw fns; `stats.triangles` summed by main from each subsystem's counters |
| `whenReady`/`bakeOnce`/`bindMatrixArray` | gpuUtil.js | terrain, sky, figure, walkers, wake, spells, post (warm-up + cascade upload) | |
| `expDamp` | camera.js export | other subsystems import it | keep it exported |
| `mat4` helpers | mat4.js | character skeleton, walkers (bone matrices → GPU-uploaded Float32Arrays) | layout must match GLSL mat4 (it does) |
| `fetchAsset`/`asset` | assets.js | audio engine, walker/speeder asset loader | CDN-first with local fallback |
| WGSL shader store | registry.js | every material construction | becomes your GLSL registry (§4) |
| `SNOWFLOW` global | main | devtools user | keep for parity debugging |

Boot-time data handoffs: `await walkerReady` / `await speederReady` (parsed model assets from `loadWalkerAsset`) are passed into `WalkerHerd` / `Speeder` constructors; `audioReady` awaited late.

---

## 4. Shader inventory

**core-app contains no shader logic of its own.** `src/shaders/registry.js` is pure plumbing: it registers other subsystems' WGSL sources (documented in their own specs) into Babylon's stores so that (a) `#include<snowXxx>` directives inside WGSL resolve, and (b) `ShaderMaterial`/`ProceduralTexture` constructed with a shader *name* find their source under `<name>VertexShader`/`<name>PixelShader`.

What the port needs to replicate:

1. **A GLSL registry module** with the same two maps: `INCLUDES` (15 libs, names in §2.11) and `SHADERS` (~45 entries, names in §2.11's source table — e.g. `snowVertexShader/snowPixelShader`, `deformSimPixelShader`, `prepassPixelShader`, …). Keep the exact logical names so the other subsystem ports can look them up identically.
2. **An `#include` preprocessor**: Babylon substitutes `#include<name>` textually before compile. In Three, write a ~10-line `resolveIncludes(src)` that regex-replaces `#include\s*<(\w+)>` (or reuse Three's own `#include <name>` resolution by injecting the libs into `THREE.ShaderChunk` — works, but a private resolver avoids collisions with Three's chunk names). The shared-text guarantee matters: the height bake and the runtime snow material must compile *literally the same* terrain/noise code or the terrain seams pull apart.
3. **Vite `?raw` imports** carry over unchanged for `.glsl` files.
4. The five `*BakePixelShader` entries (heightBake, auxBake, detailBake, skyBake, deformSim) are fragment-only shaders used by Babylon `ProceduralTexture`s — in Three each becomes a fullscreen-triangle `RawShaderMaterial` + `WebGLRenderTarget` (see `bakeOnce`, §2.5).
5. Note for all downstream specs: there are **no storage textures and no compute shaders anywhere** — every sim is a fragment pass — so the whole demo is expressible in WebGL2. WGSL→GLSL concerns (textureLoad → texelFetch, etc.) belong to the subsystems that own the shaders.

---

## 5. Babylon-specific machinery → Three.js WebGL2 equivalents

| Babylon (as used here) | Three.js equivalent |
|---|---|
| `WebGPUEngine` + `initAsync()`; options `antialias:false, stencil:false, powerPreference:"high-performance"` | `WebGLRenderer({ canvas, antialias:false, stencil:false, powerPreference:"high-performance" })`; no async init. Set `renderer.outputColorSpace`/tonemapping to pass-through (`NoToneMapping`, linear) — the demo's post chain owns exposure/tonemap. |
| `engine.setHardwareScalingLevel(1 / S.resolutionScale)` | `renderer.setPixelRatio(1)` + `renderer.setSize(cssW·scale, cssH·scale, false)`; propagate to every screen-sized RT (post chain, depth prepass). |
| `engine.resize()` on window resize | same `setSize` path + `camera.aspect`/`updateProjectionMatrix()`. |
| `engine.getCaps().textureFloatLinearFiltering` | `gl.getExtension("OES_texture_float_linear")` (warn-only, as source does). |
| `engine.captureGPUFrameTime(true)` / `getGPUFrameTimeCounter().lastSecAverage` | `EXT_disjoint_timer_query_webgl2` (widely unavailable/blacklisted); degrade to a dash in the overlay exactly as the source already does when the counter stays 0. |
| `installDrawCounter` wrapping `drawElementsType`/`drawArraysType` | `renderer.info.render.calls` with `renderer.info.autoReset = false`, manual `renderer.info.reset()` in `endFrameDraws()`. |
| `Scene`, `scene.render()` | `THREE.Scene` + an explicit frame function that renders, in order: shadow cascades → depth prepass → beauty (groups 0/1/2) → post chain. Babylon's scene auto-schedules RTTs in registration order; **Three will not — make the pass order an explicit array.** |
| `renderingGroupId` 0/1/2 + `setRenderingAutoClearDepthStencil(1,false)/(2,false)` | Either `Object3D.renderOrder` + material `depthWrite/transparent` flags within one `renderer.render`, or three sub-scenes/layers rendered back-to-back with `renderer.autoClear = false` and one explicit `renderer.clear(true,true,false)` at frame start. Depth must persist from opaque into the blended group. |
| `scene.clearColor = Color4(0.02,0.03,0.05,1)` | `renderer.setClearColor(0x000000, 1)` with exact rgb `(0.02,0.03,0.05)` via `new THREE.Color(0.02,0.03,0.05)` — set color space carefully, this is a *linear* value. |
| `UniversalCamera` (`minZ 0.12, maxZ 4200, fov 1.02 rad vertical, inertia 0`) | `THREE.PerspectiveCamera(1.02·180/π ≈ 58.4°, aspect, 0.12, 4200)`; write `camera.fov` in **degrees** each frame from `rig.fov` radians + `updateProjectionMatrix()`. |
| `cam.rotation.set(pitch, yaw, roll)` — Babylon Euler applies **Y (yaw) → X (pitch) → Z (roll)**, LH, camera looks down **+Z** | `camera.rotation.order = "YXZ"`; map to Three's RH −Z-forward convention (see R1): with the world mirrored on Z, `three.yaw = π − babylon.yaw` style remaps or a rebuilt basis — recommended: port the rig's explicit basis math and build the camera quaternion/matrix directly (`camera.quaternion.setFromEuler` or `Matrix4.makeBasis(right, up, −forward)`), not trial-and-error sign flips on Euler angles. |
| `Vector3/Color3/Color4/Matrix/Quaternion/Scalar.Clamp` | `THREE.Vector3` etc.; `Scalar.Clamp` → `THREE.MathUtils.clamp`. Beware: `Vector3.CrossToRef(a,b,out)` = LH-consistent plain cross; Three's `crossVectors` is the same formula — differences come from the coordinate convention, not the operator. |
| `ShaderStore.ShadersStoreWGSL` / `IncludesShadersStoreWGSL`, `#include<name>` | Own registry + include resolver (§4). |
| `ShaderMaterial.isReady(mesh, useInstances)` polling via `whenReady` | `renderer.compileAsync(scene, camera)` (uses `KHR_parALLEL_shader_compile` when present) during the warm-up phases; keep the 25 s watchdog + label as compile-error diagnostics. |
| `ProceduralTexture` + `bakeOnce` | Fullscreen triangle + `RawShaderMaterial` → `WebGLRenderTarget`, rendered once. |
| `bindMatrixArray` (`_matrixArrays` poke) | Plain uniform `mat4 x[3]` array with a persistent `Float32Array` value; no hack needed. |
| Babylon **left-handed** world (X right, Y up, **Z forward**) | Three is right-handed, camera −Z forward. Decide the strategy once, globally (risk R1). |
| `engine.runRenderLoop(fn)` | `renderer.setAnimationLoop(fn)`. Keep the 100 ms dt clamp and `S.freezeTime`. |
| `mesh.isVisible`, `mesh.metadata.triangles` | `object.visible`; keep a `triangles` count per subsystem for the overlay sum. |
| Vite `?raw`, `import.meta.env.VITE_ASSET_BASE` | unchanged (keep Vite). |

---

## 6. Assets

`core-app` itself loads **no binary assets**. It orchestrates loads owned by other subsystems, all funneled through `src/core/assets.js`:

- **Asset base**: `https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com` (public Vercel Blob, CORS `*`, ~30-day cache), overridable with `VITE_ASSET_BASE` (empty string ⇒ serve from `public/`). Every load tries CDN first, then same-origin `public/` fallback (`assetCandidates`).
- **Audio** (`audio.load()`, audio subsystem): manifest + mp3s under `audio/` (~MBs; e.g. `audio/ambiance.mp3`).
- **Walker model** (`loadWalkerAsset("models/walker")`, walker subsystem): baked multi-file asset — `.bin` geometry + transform texture + webp albedos under `public/models/` (`walker.bin`, `walker_albedo_*.webp`; format reverse-engineered in the walker spec, produced by `tools/bakeWalker.mjs`).
- **Speeder model** (`loadWalkerAsset("models/speeder")`): same baked format (`speeder.bin`, `speeder_albedo_0..2.webp`); **fetched only when `S.speeder === true` at boot**.
- **Everything else is GPU-generated at load** (terrain heightfield, sky, detail textures — no image assets).
- **Licensing**: the AT-AT model is CC BY-NC-SA 4.0 (Quiznos323, Sketchfab). The credit line in `index.html`'s boot screen must be preserved in the port.

Boot-screen inline assets: the `#boot::after` grain is an inline data-URI SVG (feTurbulence); no fetch.

---

## 7. Porting risks & gotchas (ranked)

**R1 — Handedness (Babylon LH +Z-forward → Three RH −Z-forward).** The single most dangerous item, because nothing in this codebase uses Babylon's scene graph conveniences — the camera rig, `mat4.js`, movement, all shaders assume LH with +Z forward, and comments say so explicitly (`mat4.js`: "Babylon is left-handed with X right, Y up and Z forward"). Options: (a) keep all game math in the source convention and inject a single Z-mirror at the camera/projection boundary; (b) rewrite the basis math to RH. Recommend (a) or a full, *systematic* (b) — piecemeal sign-flipping across ~15 subsystems will produce mirrored terrain vs. mirrored wind vs. correct camera. Whatever is chosen must be written into every subsystem spec. Also affects: `cam.rotation.set(pitch, yaw, roll)` (Babylon Euler order YXZ), `getFlatForward` = `(sin yaw, 0, cos yaw)`, triangle winding/cull direction (Babylon LH default CW front faces vs Three CCW), and clip-space Y/NDC-depth differences (WebGPU 0..1 depth vs WebGL −1..1) baked into any shader that reconstructs position from depth.

**R2 — Render scheduling is implicit in Babylon, must become explicit.** The demo relies on (1) custom RTT registration order (shadows → depthPass → …) deciding GPU pass order, (2) rendering groups 0/1/2 with depth *not* cleared between groups, (3) `scene.render()` doing everything in one call. In Three, build one explicit frame function: shadow cascades → depth prepass (own materials per caster, registered via `registerCaster/registerPrepass`) → beauty (sky, opaque, blended, sharing one depth buffer) → post chain. Any deviation breaks SSR/DoF (which consume the prepass) and the water/spray depth-testing.

**R3 — Async shader compile / warm-up semantics.** `whenReady`-based warm-up hides multi-hundred-ms pipeline compiles behind the loading screen, and the boot deliberately renders 3 real frames to force RT allocation; `spells.finishWarmUp()` depends on those frames having happened. In WebGL the failure mode changes (synchronous jank instead of "never ready"), so it is tempting to delete the warm-up — don't. Use `renderer.compileAsync` + the same 3 warm frames, keep the phase order, and keep the 25 s labelled watchdog as a compile-error debugging aid.

**R4 — Boot-order side effects.** Three traps: the mobile preset **must** be applied before any construction (`deformResolution` read once); `S.speeder` is latched into `FLYING` once at boot (toggle = reload, and `jet.js` relies on writing `S` *before* importing `main.js`, which boots on import); `S.showSpells/showWake` are written directly (bypassing `set()`) when flying, so no listeners fire. Preserve all three exactly.

**R5 — Frame-order dependencies inside the run loop.** The comments encode hard invariants: figure before contact (footprint position), post.update (TAA jitter) after rig but before any consumer of the view-proj matrix, shadows before spells/figure/walkers sync (this-frame cascade matrices), spells before terrain (brush staging for the deform sim), wake before spray (pool upload), input `endFrame()` dead last. Reorder any of these and you get one-frame-late artifacts that are miserable to diagnose. Port the loop body verbatim, comments included.

**R6 — Resolution scale & GPU timing plumbing.** `setHardwareScalingLevel` rescales the backbuffer *and* everything derived from it; in Three you must manually resize the renderer plus every screen-sized `WebGLRenderTarget` (post chain, prepass) on both `resolutionScale` changes and window resizes. GPU frame time (`stats.gpuMs`) has no reliable WebGL2 equivalent (`EXT_disjoint_timer_query_webgl2` is widely disabled) — implement behind a feature check and let the overlay show its existing dash fallback. Draw-call counting must switch to `renderer.info` with `autoReset = false`.

**R7 — Input edge cases.** Pointer-lock-loss and window-blur must clear all held state (keys, RMB, surf, touch) or the character runs off; Space must `preventDefault` (page scroll / re-triggering the focused sound button); wheel listener must be `passive:false`; touch stick *replaces* keys rather than summing; while flying, `input.surf` is pinned `true` and Space/RMB become `input.fire`. All of this is engine-independent JS — port it verbatim, but it is easy to lose when "simplifying".

**R8 — `fov` unit mismatch.** The rig stores vertical FOV in radians and writes it every frame (speed widening); Three's `PerspectiveCamera.fov` is degrees and needs `updateProjectionMatrix()` per change. A missed conversion gives a ~1° FOV; a missed update gives no speed-FOV effect and breaks TAA jitter assumptions in the post chain (which also reads `rig.distance`).
