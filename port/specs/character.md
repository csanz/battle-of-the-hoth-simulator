# Porting spec — `character` subsystem (Babylon.js/WebGPU → Three.js/WebGL2)

Source files (do not modify):

- `src/character/build.js` — procedural geometry (body, fur shells, cloth render mesh)
- `src/character/character.js` — orchestrator: meshes, materials, transform texture, uniforms
- `src/character/cloth.js` — verlet garment sim (CPU)
- `src/character/controller.js` — locomotion physics (walk + surf), gait events
- `src/character/figure.js` — skeleton, bind pose, procedural locomotion/IK posing (CPU)
- `src/character/snowContact.js` — writes deformation brushes + spray from locomotion state
- Shaders: `src/shaders/char.vertex.wgsl`, `char.fragment.wgsl`, `charDepth.vertex.wgsl`,
  `charPrepass.vertex.wgsl`, `cloth.vertex.wgsl`, `clothDepth.vertex.wgsl`,
  `clothPrepass.vertex.wgsl`, `fur.vertex.wgsl`, `fur.fragment.wgsl`,
  `src/shaders/lib/charSkin.wgsl` (shared include `snowCharSkin`)

---

## 1. Purpose & behavior

The character subsystem is the playable figure: a ~1.79 m hooded, robed
snow-bender that walks, runs, and snow-surfs across the procedural terrain.
There are **no authored assets** — no rig file, no animation clips, no meshes,
no textures. Everything is procedural:

1. **Locomotion** (`CharacterController`) integrates a 2D velocity on the
   terrain heightfield with two blended modes:
   - **WALK**: camera-relative WASD, walk 2.5 m/s / sprint 5.4 m/s, accel
     26 m/s², decel 30 m/s², facing eased toward travel direction
     (`angleDamp` rate 11).
   - **SURF**: momentum-carrying board mode (toggled by `input.surf`). Thrust
     11 m/s² along facing, top speed 19.5 m/s (×1.95 boost while sprint held),
     turn rate 2.35 rad/s, lateral grip 7.5/s with residual drift, quadratic
     drag, slope assist `-(n·fwd) * 26`. When `S.speeder !== false` the surf
     step becomes the flying-speeder variant (A/D steers outright, camera yaw
     dragged along, W throttle-gated thrust, S reverse-brake).
   - `surf` blend eased via `expDamp` (in-rate 2.6, out-rate 3.4). Position `y`
     snapped softly to `terrain.heightAt` (rate 26). Derived signals: `speed`,
     `speed01` (clamped speed/19.5), `speedRaw`, `acceleration`, `lean`
     (lateral accel / 26 clamped, ×(0.35+0.65·surf), damped 6.5), `carve`
     (same target, damped 9), `streak01 = surf * clamp((speed-7)/11, 0, 1)`.
   - **Distance-driven gait**: `gaitPhase` advances by
     `dist / (1.55 * (0.72 + 0.28 * min(1, speed/5.4)))` per frame, so stride
     length equals ground speed by construction (no foot sliding). Footfall
     events fire at phase 0.0 (left) and 0.5 (right). `stepping` is false while
     surfing or above 1.2× run speed (glide). `footfall/footIndex/footPos/
     footImpact` are one-frame event outputs.

2. **Figure posing** (`Figure.update(dt, controller)`) poses an 18-bone
   skeleton every frame entirely from controller state:
   - **Foot planting is exact**: on entering stance a foot's world position is
     recorded in `plant` and held fixed; the leg reaches it with analytic
     two-bone IK (thigh 0.44 m, shin 0.37 m; reach clamped to 99.5% to avoid
     knee lock). Swing interpolates plant→next-plant on a smoothstepped arc
     with a sine lift (0.055 + 0.12·run). Duty factor `0.66 - 0.20*run`.
     Surf blends both feet onto board positions (lateral ±0.17, along ±0.11).
   - Body attitude: pitch into acceleration (clamped fwdAcc −9..22, ×0.012,
     plus 0.10·run, plus surf crouch terms), roll from `lean`, pelvis bob at
     2× stride frequency, crouch, snow `sink` (damped toward 0.045+0.055·surf).
     Pelvis yaw counter-twists ±0.13·run·sin(2π·phase) against the chest
     (chest twist = −1.5×). Head counter-pitches −0.62× chest pitch (head
     stabilisation); the hood is a lagged copy of the head (yaw damp 11,
     pitch damp 9).
   - Arms: two-bone IK (upper 0.28 m, fore 0.26 m) to a target blending walk
     swing (counter-phase to legs), a cast pose (reads `ch.cast`,
     `ch.castAim{X,Y,Z}` written by the spell system; right hand leads), and a
     surf pose (arms out/forward, trailing arm rises with carve). Elbow pole
     back-and-out.
   - Output per bone: `world` (4×4), `skin = world * invBind` (what geometry is
     skinned by), `joint` (world joint positions — cloth collision reads these).
     Bone local +Y runs joint→child; frames built by `setFrameFromDir` from
     position + Y axis + Z (front) reference; X = Y×Z.
   - `handPosition(which, out, od)` returns the hand world position (offset
     (0, 0.09, 0) through the hand bone) for spell emitters.
   - One-frame flags `touchdown[2]` fire on plant; `snowContact` consumes them.

3. **Cloth simulation** (`ClothSolver`, CPU, zero-alloc): four garment panels —
   robe (36×12 grid), mantle (28×7), two sleeves (10×8) — each a **closed tube**
   of verlet particles. Per particle: bind position, one bone, and a `pinRate`
   (1/second; `Infinity` = welded to the skinned target, small values = shape
   memory). Per step: kinematic targets = bind pos through the bone's skin
   matrix; verlet integrate with gravity (−9.81), **apparent wind** (field wind
   minus character velocity, wandering bearing ±11°, 4-octave gust envelope
   0.2×–1.8×, vertical updraught term) with quadratic drag `0.085*|w|`,
   per-particle hashed turbulence with a floor `(0.18 + drag*0.25) *
   S.windStrength`, velocity damping `0.90^(60h)`; then 6 Gauss–Seidel
   iterations of anchor pull (`(1-exp(-rate*h))/6` per iteration) + distance
   constraints (ring, vertical, and soft bending two rows apart, stiffness
   0.22 on the last 3 iterations only); then capsule collision against 9
   body capsules (masked per panel) and, for panels with `groundRows`, a
   terrain clamp `heightAt + 0.012`. Sub-steps: 2 when dt > 1/55, step capped
   at 1/30. Rest lengths measured from the bind pose, which contains authored
   pleats (3 incommensurate sine frequencies) and an asymmetric hem (high in
   front, trailing behind).
   On the very first update, `Character._settleCloth()` teleports all particles
   to their skinned targets (prevents visible settling from the origin).

4. **Rendering** — three meshes, seven pipelines, one texture:
   - **Transform texture** (`charTex`): a 48×64 RGBA32F, NEAREST, CLAMP raw
     texture, staged in one `Float32Array(48*64*4)` and uploaded **once per
     frame**. Rows 0–3: bone skin matrices (texel (b, c) = column c of bone b's
     `world*invBind`; 18 bones used of 48 columns). Rows 4+: cloth node world
     positions, one rectangle per panel (robe rows 4–15, mantle 16–22,
     sleeve0 23–30, sleeve1 31–38; w component = 1). This texture is the ONLY
     per-frame GPU data path — no matrix uniforms, no vertex uploads.
   - **Body mesh** (`charBody`, ~lofted tubes: torso, belt, neck, head, scarf,
     Bezier-swept hood, arms, mitt hands, legs, boots): attributes `position`
     (bind-pose world), `normal` (area-weighted smooth), `uv` (**metres of
     surface**, not normalized), `aux` = (materialSlot, bakedAO), `boneIdx`
     (vec4, only .xy used), `boneWt` (vec4, only .xy used — 2-influence LBS).
   - **Cloth mesh** (`charCloth`): `position` = (u, v, panelIndex) — *no actual
     positions*; `uv` = weave metres; `aux` = (matId, ao lerped aoTop→aoBottom).
     Render tessellation (72×32 robe, 64×22 mantle, 26×20 sleeves) is decoupled
     from sim grids; vertex shader reconstructs the surface with bicubic
     Catmull-Rom over the panel's node rectangle in `charTex`, deriving
     position, normal, and tangent from the same 16 taps.
   - **Fur mesh** (`charFur`): shell fur for hood rim (26 cols × 22 shells) and
     two cuffs (12 cols × 18 shells). Each shell is an independent sheet with
     the offset baked into positions; `normal` = shell direction, `aux` =
     (shellParam t∈[0,1], ao), single-bone rigid. Fragment shader alpha-tests a
     hashed strand field (discard) — tapering strands of varying length.
   - All three meshes: `renderingGroupId = 1` (opaque scene), identity world
     matrix forever (`freezeWorldMatrix`), `alwaysSelectAsActiveMesh = true`
     (bounding info is meaningless — frustum culling must be disabled),
     back-face culling **off** (fragment shader flips N toward the viewer).
   - Casters: body + cloth render into shadow **cascades 0 and 1** only
     (CHAR_CASCADES = 2) with dedicated depth vertex shaders (same skinning /
     Catmull-Rom include), and into the camera depth **prepass**. Fur casts
     nothing and is not in the prepass (deliberate).
   - Material palette: 8 slots × (rgb albedo, roughness) + 8 slots × (sheen,
     anisotropy, transmission, weaveDepth), uploaded as two `vec4[8]` uniform
     arrays (values in `character.js` PALETTE/PARAMS — copy verbatim; they are
     tuned against the AgX tonemap and warm 13° sun).

5. **Snow contact** (`SnowContact.update(dt)`): translates locomotion into
   `terrain.deform.brush(...)` calls and spray particle emission:
   - **Footfall splat**: on `figure.touchdown[i] && ch.stepping`, an elongated
     (1.7×) yawed boot brush at the *planted* position: width 0.10, depth
     `0.17 + 0.14*impact`, berm `0.10 + 0.08*impact`, compression 0.9, rim
     roughness 1.0; `impact = min(1.3, 0.35 + speed/5.4)`. Plus `_kick`:
     6+⌊impact·14⌋ spray grains thrown up-and-backward (22% heavier "clods").
   - **Walk scuff**: while `surf < 0.98` and speed > 0.25, a shallow brush at
     the body position scaled by *distance moved* (k = min(moved, 0.35)):
     radius 0.22, depth 0.20k·w, berm 0.22k·w, compression 0.8k·w, elong 1.5.
   - **Surf wake**: while `surf > 0.02`, three brushes per frame: a deep groove
     (width 0.30·(1+0.35·fast), depth 1.20k, compression 4.0k, elong 2.6,
     offset toward the lean ×0.12) and two berm-only brushes offset ±SURF_WIDTH
     ·(1.5+0.5·fast) laterally, weighted `0.5 ± lean*0.5` so the outside of a
     turn throws more (left berm gets `sideL = 0.5 + lean*0.5`).

### Per-frame order (from `main.js` — must be preserved)

```
controller.update(dt, rig)          // physics first
heightfield.clampToPlayArea(pos)
character.update(dt):               //  = Character.update
    figure.update(dt, controller)   //  pose skeleton
    [first frame: settleCloth]
    solver.update(dt, figure, ch)   //  cloth after skeleton
    uploadTransforms → charTex      //  ONE texture upload
contact.update(dt)                  // reads figure.touchdown + plant
... rig.update, post.update, sky, shadows.update (cascade refit) ...
character.sync(cameraPos)           //  = Character.sync → _pushUniforms
                                    //  AFTER shadow refit (fresh cascade
                                    //  matrices) and camera move
scene.render()
```

`update` and `sync` are deliberately split: transforms must exist before the
contact system reads feet; uniforms must be pushed after the cascades refit,
or shadows lag the figure by one frame during fast carves.

When `S.speeder === true` ("FLYING"), the figure is hidden
(`figure.setVisible(false)`) but still simulated every frame (speeder reads
the same controller); spells and wake are disabled.

---

## 2. Public API

### `CharacterController` (`controller.js`)
- `new CharacterController(terrain)` — terrain must expose
  `heightAt(x,z):number` and `normalAt(x,z,outVec3)`.
- `update(dt, rig)` — rig must expose `getFlatForward(v)`, `getFlatRight(v)`,
  `yaw` (read/write in speeder mode), `addTrauma(x)`.
- Read state: `position:Vector3`, `velocity`, `prevVelocity`, `acceleration`,
  `facing` (yaw rad), `speed`, `speed01`, `speedRaw`, `surf` (0..1),
  `surfActive`, `lean`, `carve`, `streak01`, `gaitPhase`, `stepping`,
  `footfall`, `footIndex`, `footPos:Vector3`, `footImpact`, `groundY`,
  `groundNormal:Vector3`.
- Written by spell system: `cast` (0..1), `castAimX/Y/Z`.
- Module exports: `angleDelta(a,b)`, `angleDamp(cur,target,rate,dt)`.
- Settings read: `S.speeder`, plus `input.moveX/moveZ/sprint/surf` from
  `core/input.js`.

### `Figure` (`figure.js`)
- Exports bone index constants `B_ROOT..B_FOOT_R`, `BONE_COUNT` (18),
  `HIP_HEIGHT` (0.95).
- `new Figure(terrain)`.
- `update(dt, controller)` — poses everything; caps h at 1/30.
- State read by others: `skin:Float32Array(18*16)` (column-major, translation
  at indices 12–14), `world`, `joint:Float32Array(18*3)`,
  `plant:Float32Array(6)`, `footPos`, `footWeight:Float32Array(2)`,
  `touchdown:[bool,bool]`, `sink`.
- `handPosition(which, out, offset)` — spell system uses this.

### `cloth.js`
- `ClothPanel` (spec-constructed; fields `name, cols, rows, matId, renderCols,
  renderRows, weaveU, weaveV, aoTop, aoBottom, collide, groundRows, nodeRow,
  count, bindPos, pos, prev, target, bone, pinRate, restU, restV, restB`;
  `finalise()`).
- `makePanels()` → `[robe, mantle, sleeve0, sleeve1]`.
- `new ClothSolver(panels, terrain)`; `update(dt, figure, controller)`.
- Settings read: `S.windDirection` (degrees), `S.windStrength`.

### `build.js`
- Exports material slot constants `M_ROBE=0, M_MANTLE=1, M_TUNIC=2,
  M_LEATHER=3, M_SKIN=4, M_TRIM=5, M_FUR=6`.
- `buildBody(scene)`, `buildFur(scene)`, `buildClothMesh(scene, panels)` →
  meshes with `metadata.triangles/vertices`. `hoodRimPoint(s, out)` exported
  (fur reuses the hood rim curve).

### `Character` (`character.js`)
- `new Character(scene, terrain, sky, shadows, controller)`.
- `registerPrepass(depthPass)` — registers body + cloth into the depth prepass.
- `update(dt)` — figure → settle-once → cloth → charTex upload.
- `sync(cameraPos)` — per-frame uniform push (see §3 for exact uniforms).
- `setVisible(bool)`, `warmUp()` (async pipeline compilation), `dispose()`.
- `triangles` (number, for the stats overlay), `figure`, `charTex`,
  `bodyMat/clothMat/furMat`, `bodyMesh/clothMesh/furMesh`.
- Settings read: `S.showCharacter` (bool, default true), `S.windDirection`,
  `S.windStrength`, `S.fogDensity` (0.0072), `S.fogHeightFalloff` (0.045),
  `S.fogStart` (24), `S.aerialStrength` (1.0), `S.ambientIntensity` (1.0),
  `S.sssStrength` (1.0). (Defaults from `src/core/settings.js`.)
- Constants pushed in `sync`: `shadowSoftness=1.4`, `shadowBias=0.012`
  (tighter than terrain's — contact shadow at the boots), `weaveDensity=210`
  (threads/m), `furDensity=250`, `furColor=(0.74,0.755,0.795)`,
  `furDroop` = wind + gravity + reversed accel vector (see `_pushUniforms`),
  `screenSize` = render size.

### `SnowContact` (`snowContact.js`)
- `new SnowContact(controller, deformField, figure?, sprayField?)` —
  `deformField.brush(x, z, radius, depth, berm, compression, ice, yaw,
  elongation, rimRoughness)`; `spray.emit(x,y,z, vx,vy,vz, size, life, clod)`.
- `update(dt)`.

### Construction/wiring (from `main.js`)
```js
const character = new CharacterController(terrain);
const figure = new Character(scene, terrain, sky, shadows, character); // "figure" var
figure.registerPrepass(depthPass);
const contact = new SnowContact(character, terrain.deform, figure.figure, spray);
spells.addConsumers(figure.bodyMat, figure.clothMat);  // spell lights
// warm-up: figure.update(0); figure.sync(camPos); await figure.warmUp();
```

---

## 3. Data flow (cross-subsystem)

**Produced by this subsystem:**

| Thing | Format / shape | Consumers | Updates |
|---|---|---|---|
| `charTex` | 48×64 RGBA32F texture, NEAREST/CLAMP | all 7 character pipelines only (internal), but is *the* CPU→GPU path | 1 full upload per frame in `Character.update` |
| `controller` state (`position, velocity, speed01, speedRaw, surf, carve, lean, streak01, facing`, …) | JS object | camera rig, post chain (streaks/FOV), surf wake, spray, spells, walkers (player pos), speeder, soundscape, overlay | `controller.update` each frame |
| `figure.joint`, `figure.skin` | Float32Arrays | cloth solver (internal), spell system (`handPosition`) | `figure.update` |
| `figure.touchdown` + `figure.plant` | one-frame flags + positions | `SnowContact` → deformation field + spray | `figure.update` |
| deformation brushes | calls to `terrain.deform.brush(...)` | terrain deformation sim | `contact.update` each frame |
| spray emissions | calls to `spray.emit(...)` | vfx particle field | on footfalls |
| depth-prepass draws (body, cloth) | writes (viewZ, mask=0) into DepthPass RTT (RGBA16F) | post chain (TAA/DoF/etc.), reflections | every frame via depthPass render list |
| shadow-cascade draws (body, cloth) | NDC depth as R32F color into cascades 0,1 | every shadow-receiving material | every frame |

**Consumed from other subsystems:**

| Thing | Source | Used as |
|---|---|---|
| `terrain.heightAt(x,z)`, `normalAt(x,z,out)` | terrain | ground snap, foot plants, cloth ground clamp, slope assist |
| `terrain.deform` | terrain | brush target |
| `sky.lut` | Sky | sampler `skyLUT` (lat-long radiance LUT, mipmapped; sampled at `sqrt(rough)*6` mip) |
| `sky.sunDir:Vector3`, `sky.sunRadiance:Color3`, `sky.sh` (Float32Array 9×vec4) | Sky | uniforms `sunDir`, `sunRadiance`, `shR[9]` |
| `shadows.maps[0..2]` | ShadowSystem | samplers `cascade0/1/2` (2048² R32F color RTTs) |
| `shadows.matrixData` (48 floats), `splits` (4), `paramData` (12), `texelSize` | ShadowSystem | `cascadeMatrices[3]`, `cascadeSplits`, `cascadeParams[3]`, `shadowTexel` |
| `shadows.registerCaster(mesh, makeMaterial(cascade), 2)` | ShadowSystem | per-cascade depth material factory; each cascade gets its own material instance holding its own `lightViewProjection` |
| `depthPass.registerCaster(mesh, material)` | DepthPass | prepass registration |
| spell lights: uniforms `spellLightPos[4]` (xyz+radius), `spellLightCol[4]` (rgb+intensity), `spellLightCount` (float) | SpellSystem via `addConsumers(bodyMat, clothMat)` | additive lighting in char fragment |
| `ch.cast`, `ch.castAimX/Y/Z` | SpellSystem writes onto controller | arm posing |
| `input` struct (`moveX, moveZ, sprint, surf`) | core/input | controller |
| `rig` (camera) | core/camera | flat fwd/right, yaw, trauma |
| Settings `S.*` keys listed in §2 | core/settings | live-tunable |

---

## 4. Shader inventory

All character WGSL uses Babylon's WGSL ShaderMaterial conventions:
`attribute/varying/uniform` declarations are preprocessed into structs;
uniforms live in a generated UBO addressed as `uniforms.<name>`;
`vertexInputs/vertexOutputs/fragmentOutputs`; `#include<name>` pulls from
`ShaderStore` (registered in `src/shaders/registry.js`, key `snowCharSkin` →
`lib/charSkin.wgsl`). Port all of this to raw GLSL ES 3.0 with explicit
`in/out/uniform` and manual includes (string concat).

### `lib/charSkin.wgsl` (include, vertex-stage library)
- `skinPoint1/skinDir1`: fetch bone matrix columns with
  `textureLoad(tex, vec2i(bone, row), 0)` — **integer texel fetch**; GLSL:
  `texelFetch(charTex, ivec2(b, row), 0)`. Requires the texture to be
  float-sampleable un-filtered (RGBA32F + NEAREST is fine in WebGL2 without
  `OES_texture_float_linear`).
- `skinPoint(idx, wt, p)`: 2-influence LBS, normalized by `wt.x+wt.y`;
  `skinNormal` same for directions + normalize. `boneIdx` arrives as vec4f and
  is cast `i32(idx.x)` — keep attributes float in GLSL and cast with `int()`.
- `clothNode(rowBase, cols, rows, i, j)`: texel fetch with **wrapped u**
  (`(i % cols + cols) % cols` — GLSL `%` on negative ints is
  implementation-consistent in ES 3.0 for int ops but keep the double-mod
  exactly) and clamped v.
- `crBasis/crDeriv`: Catmull-Rom weights and derivative.
- `sampleCloth(rowBase, cols, rows, u, v)`: 16 texel fetches → position,
  d/du, d/dv; `nrm = normalize(cross(pv, pu))`, `tanU = normalize(pu)`.
  Returns a struct — GLSL: return via out params or a struct (ES 3.0 supports
  struct returns).

### `char.vertex.wgsl` (body beauty pass)
Skins position and normal from `charTex`; varyings `vWorld, vNormal, vUV,
vAux, vViewDist` (= distance(world, cameraPos)); clip = `viewProjection *
world`. Uniforms: `viewProjection: mat4`, `cameraPos: vec3`.

### `cloth.vertex.wgsl` (garment beauty pass)
`position.xyz = (u, v, panelIndex)`; looks up `panelParams[i32(position.z)]`
(uniform `vec4[6]`: rowBase, cols, rows, 0) and calls `sampleCloth`. Emits the
same varyings as char.vertex so **both share one fragment shader**
(`char.fragment`). Dynamic uniform-array indexing by a value derived from an
attribute — legal in GLSL ES 3.0 for uniform arrays (constant-index not
required), but keep the index clamped 0–5 for safety.

### `char.fragment.wgsl` (shared body+cloth fabric BRDF)
Technique per fragment:
1. Two-sided normal: flip N if `dot(N,V)<0` (winding not trusted). Keep `geoN`
   (pre-weave flipped normal) for the shadow lookup.
2. Material slot `clamp(i32(vAux.x + 0.5), 0, 7)` indexes `matAlbedo[8]`
   (rgb+roughness) and `matParams[8]` (sheen, aniso, transmission, weaveDepth).
3. **Procedural weave**: screen-space cotangent frame from `dpdx/dpdy` of
   world pos and of `wuv = vUV * weaveDensity` (GLSL: `dFdx/dFdy`; needs
   `precision highp`), weave normal = crossed cosine ridges with over/under
   alternation (`smoothstep(-0.35,0.35, warp*weft)`), cavity term; faded by
   pixel footprint `1 - smoothstep(0.10, 0.45, max(len(duv1),len(duv2)))`.
4. **Slub**: `noise2(vUV * vec2(9, 26))` modulates albedo ±10% and roughness.
5. AO = baked vertex AO × weave cavity.
6. Sun: shadow via `sunShadow(world, geoN, vViewDist, ign(fragCoord)*2π)`
   (shared PCSS cascade lookup include, gated `NdotL > -0.4`); diffuse =
   `wrapDiffuse(NdotL, 0.18) * albedo/π * sunRadiance * shadow`.
7. **Transmission** (if slot has it): `backScatter(N,L,V, 0.4, 4.0, 1.0) *
   albedo * transmit * sssStrength * mix(0.35, 1.0, shadow)`.
8. **Anisotropic GGX** spec: Burley remap `ax = a(1+aniso), ay = a/(1+aniso)`
   with `a = max(0.04, rough²)`, T/B from the cotangent frame,
   `visSmithGGXCorrelated`, F0 = 0.035.
9. **Charlie sheen**: `dCharlie(NdotH, 0.42)` × `vAshikhmin`, lobe clamped to
   0.25, gated by grazing factor `0.16 + 0.84*(1-NdotV)²`, tint =
   `mix(white, normalize(albedo), 0.35)`.
10. Ambient: SH irradiance (`shIrradiance(N, shR)` — 9 vec4 coefficients) ×
    `ambientIntensity`, plus snow-bounce term (0.40 × up-facing-down factor of
    horizontal SH), plus rim ambient sheen `(1-NdotV)^4 * sheen * 0.55`, plus
    ambient specular = `textureSampleLevel(skyLUT, dirToLatLong(R),
    sqrt(rough)*6)` × Karis `envBRDFApprox(0.035, rough, NdotV)` — GLSL
    `textureLod` (mipmapped LUT required).
11. Spell lights: `spellLightingSurface(...)` over up-to-4 point lights, ×ao.
12. `applyAerial(...)` fog/aerial perspective (shared include; samples skyLUT).
13. Output opaque `vec4(color, 1)` to the HDR scene target. Blend: none
    (opaque); depth test/write standard.
- `screenSize` uniform is declared but unused in the fragment body — keep or
  drop (dropping changes the UBO layout only).
- WGSL→GLSL notes: `inverseSqrt`→`inversesqrt`; `mat3x3f(c0,c1,c2)`→`mat3`;
  array uniforms (`array<vec4f,8>`, `array<mat4x4f,3>`) → `uniform vec4
  matAlbedo[8]` etc. — with RawShaderMaterial these are plain uniform arrays,
  no UBO needed (or use a UBO to match the original layout); `let/var`→
  `const/`mutable; `select`/`if` fine; `const INV_PI` inside fn → move to
  global `#define`.

### `fur.vertex.wgsl`
Single-bone skin (`skinPoint1/skinDir1` on `boneIdx.x`); shell offset already
baked into position; adds `furDroop * t²` in world space (t = `aux.x`, shell
parameter — quadratic so strands curve, not shear). Same varyings as char.

### `fur.fragment.wgsl`
Alpha-tested shell fur, opaque pipeline with `discard`:
- Strand field: `g = vUV * furDensity`; `cell = floor(g)`; hashes `hash21`,
  `hash22` give per-cell strand length `0.30 + 0.70*h` (discard if `t >
  strandLen`), jittered axis, radius `0.46 * (0.55 + 0.45*hash) *
  sqrt(taper)` with `taper = 1 - t/strandLen` (discard if outside).
- Shading: two-sided N; PCSS shadow; self-AO down the stack `0.16 + 0.84*
  depth²` (depth = t/strandLen); `wrapDiffuse(NdotL, 0.65)`; strong
  transmission `backScatter(N,L,V, 0.5, 3.0, 1.0) * 0.85`; dim wide GGX
  (`distributionGGX(NdotH, 0.75) * 0.05`); SH ambient × `vAux.y * 1.4`;
  aerial perspective. Uniform `furColor` (vec3), `furDensity` (float).
- 22 shells × discard: in WebGL2 `discard` disables early-Z on those draws —
  the fur is drawn in the beauty pass only (no prepass/shadow), so cost is
  contained; keep it that way.

### `charDepth.vertex.wgsl` / `clothDepth.vertex.wgsl` (shadow casters)
Same skinning / Catmull-Rom as beauty (shared include — **keep it shared in
the port**; divergence = peter-panning). Uniform `lightViewProjection: mat4`
(one per cascade — Babylon forces distinct Effects via
`defines: ["CHAR_CASCADE n"]`; in Three.js simply create one material
instance per cascade, or one material whose uniform you rewrite between
cascade renders). Fragment = `terrainDepth.fragment.wgsl`: writes
`gl_FragCoord.z` (WGSL `input.position.z`) into an **R32F color** attachment
(cascades are color targets so PCSS blocker search can filter; port as
`WebGLRenderTarget` with `RedFormat`/`FloatType` + a depth renderbuffer).
Note WebGPU NDC z is [0,1]; Three/WebGL is [-1,1] — the shadow system already
accounts for this on the matrix side (see its own spec); keep the convention
consistent with the ported ShadowSystem.

### `charPrepass.vertex.wgsl` / `clothPrepass.vertex.wgsl` (depth prepass)
Same skinning/reconstruction; varyings `vViewZ = clip.w` (linear view depth)
and `vMask = 0.0`; fragment = shared `prepass.fragment.wgsl` writing
`vec4(viewZ, mask, 0, 1)` into the DepthPass RTT (RGBA16F).

### WGSL constructs needing care (summary)
- `textureLoad` → `texelFetch` (int coords, explicit lod 0). All charTex reads
  are unfiltered fetches; the sampler declared alongside (`charTexSampler`) is
  never used — do not bind a filtering sampler to an RGBA32F texture in
  WebGL2 (unfilterable without extension); use NEAREST.
- Integer ops: bone index and panel index arrive as floats and are cast; the
  double-mod for wrap must survive; `i32()` → `int()`.
- No storage textures, no textureGather, no compute — everything is
  vertex-fetch + fragment.
- `dpdx/dpdy` → `dFdx/dFdy` (standard in ES 3.0).
- Struct-returning functions (`ClothSample`) are fine in ES 3.0.
- Loops in `sampleCloth` are fixed-count (4×4) — fine.
- `discard` in fur only.
- Babylon WGSL auto-UBO: in Three.js RawShaderMaterial, declare every uniform
  individually (uniform arrays for `matAlbedo[8]`, `matParams[8]`,
  `cascadeMatrices[3]` as `mat4 cascadeMatrices[3]`, `shR[9]`,
  `panelParams[6]`, `spellLightPos[4]`, `spellLightCol[4]`).

---

## 5. Babylon-specific machinery → Three.js equivalents

| Babylon | Used for | Three.js WebGL2 equivalent |
|---|---|---|
| `ShaderMaterial` with `shaderLanguage: WGSL`, named attribute/uniform/sampler lists | all 7 pipelines | `THREE.RawShaderMaterial` (GLSL ES 3.0, `#version 300 es` via `glslVersion: THREE.GLSL3`) with explicit `uniforms` dict; custom attributes on `BufferGeometry` |
| `ShaderStore` `#include<snowCharSkin>` etc. | shared skinning code | JS template-string include (prepend lib source), keep ONE source of truth shared by beauty/depth/prepass shaders |
| `RawTexture.CreateRGBATexture(..., TEXTURE_NEAREST, TEXTURETYPE_FLOAT)` + `charTex.update(data)` | transform texture | `THREE.DataTexture(data, 48, 64, RGBAFormat, FloatType)`; `magFilter=minFilter=NearestFilter`, `wrapS/T=ClampToEdgeWrapping`, `generateMipmaps=false`; per frame mutate the backing array and set `needsUpdate = true` (uploads via texSubImage2D) |
| `mesh.setVerticesData("aux", data, false, 2)` etc. | custom attributes | `geometry.setAttribute("aux", new BufferAttribute(f32, 2))`, same for `boneIdx`(4), `boneWt`(4); indices `Uint32Array` → `geometry.setIndex` (WebGL2 supports uint32 natively) |
| `mesh.alwaysSelectAsActiveMesh`, `freezeWorldMatrix`, `doNotSyncBoundingInfo` | GPU-placed geometry, identity world | `mesh.frustumCulled = false`, `mesh.matrixAutoUpdate = false` (identity) |
| `renderingGroupId = 1` + `setRenderingAutoClearDepthStencil(1,false)` | draw ordering | render-order / layer discipline in the ported frame loop (opaque group after sky, before transparents; never clear depth between) |
| `mat.backFaceCulling = false` | two-sided sheets | `material.side = THREE.DoubleSide` |
| `shadows.registerCaster(mesh, makeMat, 2)` + `RenderTargetTexture.setMaterialForRendering` + `defines: CHAR_CASCADE n` | per-cascade depth materials | ported ShadowSystem: per cascade, render the caster list into a `WebGLRenderTarget` (R32F color + depth), overriding `mesh.material` with the cascade's depth material (or `scene.overrideMaterial` per-mesh swap). One material *instance* per cascade so each holds its own `lightViewProjection` |
| `depthPass.registerCaster(mesh, mat)` | camera prepass | same pattern into the ported DepthPass RGBA16F target |
| `mat.setTexture/setFloat/setVector3/setColor3/setArray4/setVector2` | uniform pushes | write into `material.uniforms.X.value` (pre-allocate Vector3/arrays; mutate, don't re-create) |
| `bindMatrixArray(mat, "cascadeMatrices", flat48)` | zero-alloc mat4 array | keep one shared `Float32Array(48)`; Three accepts `uniforms.cascadeMatrices.value = [m0,m1,m2]` of Matrix4 — cheaper: declare `mat4 cascadeMatrices[3]` and supply the flat array via a `uniforms` value of three Matrix4s that alias the shadow system's data (copy once per frame; 48 floats is negligible) |
| `whenReady(mat, ...)` warm-up | pre-compile behind loading screen | `renderer.compile(scene, camera)` / `renderer.compileAsync` after constructing everything, plus render 2–3 warm frames offscreen |
| `Constants.TEXTURE_CLAMP_ADDRESSMODE` etc. | sampler state | Three texture properties as above |
| Left/right-handedness | Babylon default scene is **left-handed** (+Z forward); all character math is authored in that world space (facing: `x=sin(yaw), z=cos(yaw)`) | Port the whole demo in the same LH world-space convention and only flip at the camera/projection level (recommended — every subsystem shares these conventions), i.e. keep all character JS math byte-identical. Do NOT mirror per-subsystem. Winding: irrelevant here (culling off, N flipped toward V) — this subsystem is unusually handedness-tolerant |
| `Vector3/Vector2/Color3/Vector4` (Babylon math) | controller/character state | `THREE.Vector3/Vector2/Color/Vector4`; `Scalar.Clamp` → `THREE.MathUtils.clamp`; `expDamp` from core/camera port |
| WGSL NDC z ∈ [0,1] | depth writes | GL NDC z ∈ [-1,1]; handled inside the ported shadow/prepass math, not here — but re-verify `shadowBias=0.012` after the port (bias is in the cascades' depth units) |

---

## 6. Assets

**None.** No binary files, no textures, no audio. All geometry is built in JS
at boot (`buildBody`/`buildFur`/`buildClothMesh`); the palette is two 8-entry
constant tables in `character.js`; `charTex` is CPU-generated per frame.
(`models/walker`/`models/speeder` .bin assets belong to the walkers/speeder
subsystems, not this one.)

---

## 7. Porting risks & gotchas (ranked)

1. **RGBA32F texture sampling in WebGL2.** `charTex` must be created as
   `RGBAFormat`/`FloatType` with NEAREST filtering; float-linear filtering is
   an optional extension and must not be relied on. All reads are
   `texelFetch`, which is filter-independent — but Three.js will warn/misbehave
   if the texture is left with default LinearFilter. Also confirm
   `texSubImage2D` upload path fires every frame (`needsUpdate = true` after
   mutating the same backing array — Three caches by version counter, not by
   array identity).

2. **Depth-convention drift between beauty, shadow and prepass paths.** The
   original guarantees one surface across passes by sharing `charSkin.wgsl`
   between all 7 shaders. If the GLSL port copy-pastes instead of sharing the
   include string, any later fix diverges and you get peter-panning /
   self-shadow acne / TAA ghosting. Also WGSL z∈[0,1] vs GL z∈[-1,1] changes
   what `gl_FragCoord.z` means in the cascade R32F write — the cascade PCSS
   lookup (shared shadow include) and `shadowBias=0.012` must be re-validated
   against the ported ShadowSystem's matrix convention.

3. **Uniform-array indexing and layout.** `matAlbedo[slot]` (slot from a
   varying), `panelParams[int(position.z)]` (from an attribute),
   `cascadeMatrices[i]` — dynamic indexing of uniform arrays. Legal in
   ES 3.0 GLSL, but some ANGLE/driver combos are picky about non-constant
   indexing of *sampler* arrays (not used here — cascades are 3 separate
   samplers; keep them separate, do NOT fold into an array or a 2D-array
   texture without also porting the shadow include).

4. **Per-cascade depth-material plumbing.** Babylon's
   `setMaterialForRendering` + a define per cascade gives each cascade its own
   effect holding its own `lightViewProjection`. In Three you must replicate
   this: either one depth-material instance per (mesh, cascade) with its own
   uniforms object (recommended — matches the original), or rewrite one
   material's uniform between cascade passes (fragile with async uploads).
   The body registers into cascades 0–1 only (`CHAR_CASCADES=2`); fur into
   none — preserve both exclusions or pay for a 22-shell alpha depth pass.

5. **Frame-order coupling.** `Character.update` (transforms) and
   `Character.sync` (uniforms) are split around the shadow refit and camera
   move. Merging them, or calling sync before the ported ShadowSystem refits,
   reproduces the exact bug the comment warns about: shadows/cloth lag the
   figure by one frame during fast carves. Similarly `figure.update` must
   precede `contact.update` (footprints need the planted boot), and cloth
   must be solved before the texture upload.

6. **`discard`-based fur cost.** 22 shells of double-sided alpha-tested
   geometry in the beauty pass; WebGL2 loses early-Z under discard and Three
   won't sort these shells specially. If fill-rate becomes a problem on the
   GL port, draw fur last within the opaque group (it self-sorts adequately
   since shells are inside-out agnostic; it was fine on WebGPU but GL drivers
   differ). Do not enable alpha blending — the original is test-only.

7. **Derivative-based cotangent frame precision.** `dFdx/dFdy` of world
   position at 2 m scale in `highp` is fine, but the weave UVs are multiplied
   by `weaveDensity=210` before derivative — keep `highp float` everywhere in
   the fragment shader or the weave fade term (`uvFoot`) gets noisy on mobile
   GPUs.

8. **Zero-allocation discipline.** Controller/figure/cloth/upload paths
   allocate nothing per frame in the original (module-scope scratch vectors).
   The Three port should keep this — particularly avoid re-creating uniform
   values (Vector3/arrays) in `sync`, and avoid `setMatrices`-style copies
   (the original even bypasses Babylon's copy via `bindMatrixArray`).

9. **`S.speeder` interplay.** Controller behavior branches on `S.speeder`
   (flying steer/thrust model, rig.yaw writes) and `main.js` hides the figure
   when flying while still updating it. Port the branch faithfully or the
   speeder subsystem breaks even though this subsystem "looks" fine.

10. **Settle-on-first-update.** `_needSettle` teleports cloth to skinned
    targets on the first `update`. If the port's boot order calls `sync`
    or renders before the first `update`, the robe renders at the world
    origin for a frame. Keep warm-up order: `figure.update(0)` →
    `figure.sync(camPos)` → compile → warm frames.
