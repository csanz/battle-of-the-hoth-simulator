# SNOWFLOW → Three.js port plan

Source: `/Users/csanz/SynologyDrive/Projects/Apps/csanz/snowflow_demo` — Babylon.js 9.18 / WebGPU / WGSL.
Target: this repo (`snowflow_demo2`) — Three.js `WebGLRenderer` (WebGL2), GLSL ES 3.0, Vite.

Companion document: **`port/CONTRACTS.md` is binding.** This file explains the *why* and the
sequencing; CONTRACTS.md pins every cross-cutting decision implementation agents must follow.
Where the two disagree, CONTRACTS.md wins.

---

## 1. Goal

A **pixel-and-behavior-faithful replica**. Same landform, same lighting numbers, same tuned
constants, same frame ordering, same debug views, same boot screen, same audio behavior. The
demo's look is the product of hundreds of hand-tuned constants interlocking across subsystems
(exposure 0.105 against snow ≈ 12 linear, AgX shoulder, shadowBias per material, HDR jet
constants…). We therefore do not "adapt to Three idioms" — we port the source architecture
verbatim and use Three only as a thin WebGL2 device layer:

- Every material is a `RawShaderMaterial` with explicit uniforms. No Three built-in materials,
  lights, shadow maps, tone mapping, or color management anywhere.
- Every render pass is explicit code in a fixed order. Babylon's implicit scheduling
  (customRenderTargets registration order + rendering groups) becomes an explicit pass list.
- All gameplay/world/shader math keeps the source's **left-handed, +Z-forward** convention
  byte-for-byte (see §4). Three's scene graph is used only as a draw-list container.

Non-goals: no visual improvements, no "fixing" documented oddities (the un-decoded albedo, the
absent walkerStep sample, the absolute-metres DoF far band), no new features.

## 2. Renderer decision: WebGL2 + GLSL ES 3.0 raw shaders

`THREE.WebGLRenderer({ canvas, antialias: false, stencil: false, powerPreference: "high-performance" })`.

Why this and not alternatives:

- **No storage textures, no compute anywhere in the source.** Every sim (deform, bakes, post) is
  a fragment pass over a render target. The whole demo is expressible in WebGL2; WebGPU-only
  features are not used.
- **GLSL ES 3.0 has 1:1 counterparts for every WGSL construct used**: `textureLoad`→`texelFetch`,
  `textureSampleLevel`→`textureLod`, `textureSampleGrad`→`textureGrad`, `texture_2d_array`→
  `sampler2DArray`, `dpdx/dpdy`→`dFdx/dFdy`, `select(f,t,c)`→ternary (operand order reversed —
  the #1 mechanical translation hazard), uniform arrays (`vec4[9]`, `mat4[3]`) are core.
- **Raw shaders, not ShaderMaterial with Three's prelude**: the source shaders assume nothing is
  auto-bound (Babylon auto-binds only `viewProjection`, which we bind manually anyway). Three's
  onBeforeCompile/ShaderChunk machinery would fight the port; `RawShaderMaterial` +
  `glslVersion: THREE.GLSL3` gives us a clean `#version 300 es` compile unit we fully control.
- **WebGLRenderTarget everywhere**: Babylon `ProceduralTexture` (bakes, deform sim) becomes
  fullscreen-triangle passes into `WebGLRenderTarget`s via a core helper; `RenderTargetTexture`
  (cascades, prepass) becomes explicit render passes.
- Required extension: `EXT_color_buffer_float` (fail boot without it — every HDR target needs
  it). Optional: `OES_texture_float_linear` (warn + degrade, exactly as the source warns),
  `KHR_parallel_shader_compile` (warm-up), `EXT_disjoint_timer_query_webgl2` (never relied on —
  the overlay's `—` dash is the designed fallback for gpuMs).

## 3. Project layout (mirrors the source 1:1)

```
snowflow_demo2/
  package.json  .gitignore  index.html  jet.html
  public/                      # copied VERBATIM from source public/ (audio/*.mp3, models/*.bin, *.webp)
  port/                        # this planning material (not shipped)
  src/
    main.js  jet.js
    core/      settings.js input.js camera.js mat4.js gpuUtil.js gfx.js assets.js
               loading.js perf.js openingShot.js
    shaders/   registry.js  lib/*.glsl  *.glsl        (~45 shaders + 15 include chunks)
    render/    sky.js shadows.js depthPass.js
    post/      postChain.js
    terrain/   terrain.js heightfield.js deformation.js clipmapMesh.js
    character/ controller.js figure.js character.js cloth.js build.js snowContact.js
    walkers/   walker.js walkerAsset.js bolts.js
    player/    speeder.js jet.js
    spells/    spellSystem.js spellLights.js waterBody.js crystals.js bending.js
               sweep.js ribbon.js bloom.js crystallize.js vortex.js
    vfx/       particles.js surfWake.js
    audio/     engine.js manifest.js soundscape.js
    ui/        overlay.js fpsMeter.js soundButton.js touchControls.js
```

One new module with no source counterpart: **`src/core/gfx.js`** — the "engine" replacement.
It owns the renderer, the capability checks, the layer constants, the pass runner (material
swap + layer mask + render), the screen-sized render-target registry (for resolutionScale /
resize), and the Three token camera. Everything Babylon's `Engine`/`Scene` did implicitly
lives here explicitly. Its API is pinned in CONTRACTS §9.

## 4. Coordinate-system decision (summary — full rules in CONTRACTS §1)

**Keep the source's left-handed, +Z-forward world verbatim; hand-build all view/projection
matrices; use Three only as a rasterizer.** Chosen over "convert to RH" because every subsystem
(camera basis, `mat4.js`, controller facing `(sin yaw, 0, cos yaw)`, walker bearings, speeder
3×4 composition, all shader view-space math, SSR/TAA reconstruction) assumes LH +Z-forward,
often in hand-rolled world-space math with no scene-graph indirection. A systematic RH rewrite
would touch ~15 subsystems and each missed sign produces a plausible-looking wrong image — the
exact class of multi-day bug the specs warn about. With hand-built LH matrices, all JS math and
almost all shader text ports byte-identically.

Consequences (each pinned precisely in CONTRACTS):

- `core/mat4.js` grows `lookAtLH`, `perspectiveFovLH`, `orthoOffCenterLH`, general `mulMat4`
  / `invertMat4` — column-major flat arrays, **GL clip z ∈ [−1, +1]** output.
- NDC x,y match the Babylon/WebGPU build exactly (WebGPU NDC is also y-up), so screen-space
  winding is preserved: Babylon's CW-front-cull ≙ `THREE.BackSide` in this port. Most
  materials are `DoubleSide` anyway (as in the source).
- Depth-as-color in cascades stays `gl_FragCoord.z` (window [0,1]); the shadow lookup remaps
  `ndc.z*0.5+0.5` before compare. Shadow UV is `ndc.xy*0.5+0.5` with **no Y flip** (the
  Babylon flip compensated a Babylon RTT quirk that WebGL FBOs don't have).
- View space for post/prepass stays **LH, +z forward, positive metres** (clip.w of an LH
  projection *is* view z), so `postCommon`, SSR, TAA, DoF shaders port verbatim.
- Babylon `A.multiplyToRef(B, out)` ≡ `out = B·A` column-convention → our
  `mulMat4(out, projArray, viewArray)`.

## 5. Babylon concept → Three mapping

| Babylon | Three port |
|---|---|
| `WebGPUEngine` + `initAsync` | `WebGLRenderer` in `core/gfx.js`; synchronous; boot fails to `#nogpu` if no WebGL2 or no `EXT_color_buffer_float` |
| `Scene`, `scene.render()` | one `THREE.Scene` as draw-list container + an **explicit frame function**: deform sim → cascades ×3 → depth prepass → beauty (sky/opaque/blended, one depth buffer, no clears between) → post chain |
| `renderingGroupId` 0/1/2 + no depth clear between groups | Three layer bits SKY/OPAQUE/BLEND + `renderOrder` table + `renderer.autoClear=false` with one explicit clear at beauty start (CONTRACTS §4.4) |
| `RenderTargetTexture` on `scene.customRenderTargets` (order = schedule) | explicit `WebGLRenderTarget`s rendered by the frame function in fixed code order |
| `rtt.setMaterialForRendering(mesh, mat)` | pass runner swaps `mesh.material` to the registered per-pass material, renders the pass's layer, restores (CONTRACTS §4.5) |
| `ProceduralTexture` + `bakeOnce` | `FullscreenPass` helper (fullscreen triangle + RawShaderMaterial) → `WebGLRenderTarget`, rendered once (bakes) or per frame (deform sim) |
| `ShaderMaterial` (WGSL) | `RawShaderMaterial` (GLSL ES 3.0, `glslVersion: GLSL3`), uniforms explicit, `viewProjection` bound manually from the shared frame state |
| `ShaderStore` + `#include<name>` | `src/shaders/registry.js`: chunk map from Vite `?raw`/glob imports + a private `#include<name>` resolver (CONTRACTS §6) |
| Custom CSM (R32F color cascades) | identical hand-rolled system in `render/shadows.js`; **never** Three's shadow maps |
| `PostProcess` chain w/ forced-output history | hand-rolled 9-pass chain with explicitly allocated targets; TAA renders straight into `history[k]` (drop the Babylon forced-output indirection, keep the effect) |
| `engine.setHardwareScalingLevel` | `gfx.setRenderScale(s)`: `renderer.setSize(css*s, false)` + resize every registered screen-sized RT + `post.resetHistory()` |
| `installDrawCounter` / `captureGPUFrameTime` | `renderer.info` with `autoReset=false`, latched in `endFrameDraws()`; gpuMs stays 0 → overlay dash |
| `whenReady` async-compile warm-up | `renderer.compileAsync` (KHR_parallel_shader_compile when present) + the **same 3 real warm frames** + `spells.finishWarmUp()`; keep the 25 s labelled watchdog |
| `UniversalCamera` + per-frame rotation/fov writes | no Three camera as source of truth: `CameraRig` computes LH view/proj into shared `Matrix4`s each frame; `gfx.threeCamera` is a token synced for Three's internal sort only |
| sRGB/tonemap | **`renderer.outputColorSpace = LinearSRGBColorSpace`(no-op path), `toneMapping = NoToneMapping`, every texture `NoColorSpace`, `flipY=false`.** The composite pass does its own exposure/AgX/sRGB encode; sharpen operates on encoded 8-bit and writes the canvas. Nothing else may touch color |
| Vite `?raw`, `import.meta.env.VITE_ASSET_BASE` | unchanged (keep Vite) |

## 6. Phases / fan-out

**Phase 0 — scaffold + core (serial, first).** package.json/.gitignore (done here), index.html,
jet.html, `public/` copied verbatim from the source repo, all of `src/core/`, `src/shaders/registry.js`,
`src/main.js`, `src/jet.js`. main.js is written in full against CONTRACTS (it will only run once
subsystem tasks land — that is expected).

**Phase 1 — parallel subsystem ports** (each owns disjoint files, coded only against
CONTRACTS.md, never against each other's code):

1. render-post — `src/render/`, `src/post/`, their shaders, and the shared lib chunks
   `shading/shadowLookup/atmosphere/postCommon`.
2. terrain — `src/terrain/`, terrain shaders, lib chunks `noise/terrain/clipmap/deform/ridge`.
3. character — `src/character/`, char/cloth/fur shaders, lib chunk `charSkin`.
4. walkers — `src/walkers/`, walker/bolt shaders, lib chunk `walkerSkin`.
5. player — `src/player/`, jet shaders (reuses walker shaders + loader by import).
6. spells — `src/spells/`, water/crystal shaders, lib chunks `water/crystal/spellLights`.
7. vfx — `src/vfx/`, spray/wake shaders, lib chunk `wake`.
8. audio-ui — `src/audio/`, `src/ui/` (near-verbatim copy; renderer touchpoints per CONTRACTS).

**Phase 2 — integration + validation.** Boot the composed app; walk the debug views
(`S.debugView` 11 modes, `S.speederDebug` 8 modes, `wake.debug` 10 modes — they exist precisely
to validate this port); golden-image the height/aux/detail/sky bakes against WebGPU captures;
verify `heightAt` CPU/GPU agreement; verify shadow UV orientation with a cascade readback;
verify TAA stillness (no shimmer when static); A/B the tuned look.

Validation invariants worth restating (details in the specs): bit-identical clipmap vertex
placement across beauty/shadow/prepass; deform relaxation time-banking (dt=0 most frames);
one multiplier for walker speed+gait; `wakeEroded` byte-identical across passes; jitter frozen
mid-frame; sRGB exactly once (in the composite shader).
