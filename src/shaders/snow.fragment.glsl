// -----------------------------------------------------------------------------
// The snow material.
//
// Normals arrive from four independent sources and have to be combined in the
// right order or the surface stops holding together:
//
//   macro     baked landform gradient        tens of metres → ~1 m
//   fine      analytic sastrugi and ripples  ~2 m → ~10 cm
//   detail    tiled generated grain map      ~10 cm → ~5 mm
//   deform    the terrain state buffer       whatever the player carved
//
// Macro and fine and deform are all *heightfield gradients* in world space, so
// they add as slopes before ever becoming a normal. Only the detail map is a
// tangent-space normal, and it is folded in last with reoriented normal mapping.
// Adding normals instead of slopes is the classic way to lose the landform under
// the detail.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 vWorld;
in vec2 vHeightUV;
in float vViewDist;
in float vSpacing;

// ------------------------------------------------------------------ textures
uniform sampler2D auxTex;
uniform sampler2D detailTex;
uniform sampler2D skyLUT;
uniform sampler2D cascade0;
uniform sampler2D cascade1;
uniform sampler2D cascade2;
uniform sampler2D deformTex;

// ------------------------------------------------------------------ uniforms
uniform vec3 cameraPos;
uniform vec3 sunDir;
/// Direct solar irradiance at the ground, already atmospherically extinguished
/// and in the same units the sky LUT stores radiance in.
uniform vec3 sunRadiance;

uniform vec4 shR[9];

uniform mat4 cascadeMatrices[3];
uniform vec4 cascadeSplits;
/// Per cascade: (depth range in metres, ortho width in metres, unused, unused).
uniform vec4 cascadeParams[3];
uniform float shadowTexel;
uniform float shadowSoftness;
uniform float shadowBias;

uniform float windAngle;
uniform float sastrugiAmp;
uniform float detailStrength;
uniform float glintIntensity;
uniform float glintGrazing;
uniform float sssStrength;
uniform float sssRadius;

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;

uniform vec2 worldOrigin;
uniform float worldSize;

uniform vec2 deformCenter;
uniform float deformSize;
uniform float deformTexel;
uniform float deformDepthScale;

uniform float ambientIntensity;
uniform float debugMode;
uniform vec2 screenSize;

// Spell lights. See `lib/spellLights.glsl`; zero-count on almost every frame.
uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

// The cascade projection and PCSS selection live in a shared include, because
// the character material has to run the byte-identical lookup — the UV
// convention and the receiver-plane gradient are exactly the sort of thing that
// two copies would quietly disagree about.
#include<snowShadowLookup>

layout(location = 0) out vec4 fragColor;

// -----------------------------------------------------------------------------

/// Diagnostic: how far the depth map and the receiver disagree, in metres.
///
/// Projects exactly as `sampleCascadeTex` does — same normal offset, same
/// cascade selection — but takes the single centre tap and returns
/// (stored - receiver) scaled to world metres. Near zero means the two passes
/// are describing the same surface and any remaining artefact is a bias or
/// filter question. Hundreds of metres means they are not, and no amount of
/// bias tuning is going to help.
float shadowMapDelta(vec3 world, vec3 geoN, float viewDist) {
    vec4 sp = cascadeSplits;
    mat4 m = cascadeMatrices[2];
    vec4 params = cascadeParams[2];
    int idx = 2;
    if (viewDist < sp.x) { m = cascadeMatrices[0]; params = cascadeParams[0]; idx = 0; }
    else if (viewDist < sp.y) { m = cascadeMatrices[1]; params = cascadeParams[1]; idx = 1; }

    vec3 lf = -sunDir;
    vec3 lr = normalize(cross(vec3(0.0, 1.0, 0.0), lf));
    vec3 nl3 = vec3(dot(geoN, lr), dot(geoN, cross(lf, lr)), dot(geoN, lf));
    float sinL = sqrt(clamp(1.0 - nl3.z * nl3.z, 0.0, 1.0));
    vec3 biased = world + geoN * (params.y * shadowTexel * 1.5 * max(sinL, 0.2));

    vec4 clip = m * vec4(biased, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    // GL clip: ndc.z spans [-1, 1] (the WebGPU source had [0, 1]); the stored
    // depth is window-space [0, 1], so remap before comparing.
    // 1e9 flags "this point is not inside the cascade at all".
    if (any(greaterThan(abs(ndc.xy), vec2(1.0))) || ndc.z < -1.0 || ndc.z > 1.0) { return 1e9; }

    vec2 uv = vec2(ndc.x * 0.5 + 0.5, 0.5 + ndc.y * 0.5);
    float d = 0.0;
    if (idx == 0) { d = textureLod(cascade0, uv, 0.0).r; }
    else if (idx == 1) { d = textureLod(cascade1, uv, 0.0).r; }
    else { d = textureLod(cascade2, uv, 0.0).r; }

    return (d - (ndc.z * 0.5 + 0.5)) * params.x;
}

/// Unpack a two-channel tangent-space normal.
vec3 unpackN(vec2 rg) {
    vec2 xy = rg * 2.0 - 1.0;
    return vec3(xy, sqrt(max(0.0, 1.0 - dot(xy, xy))));
}

/// Triplanar detail-normal fetch. Snow on a steep rock face has no sensible
/// planar projection, and stretching the grain up a 60-degree slope is instantly
/// legible as a smear.
///
/// Gradients are passed in rather than taken here: every call site sits behind a
/// footprint test, and implicit-derivative sampling under non-uniform control
/// flow is undefined. Explicit gradients keep full mip filtering — which
/// this absolutely needs, since the whole point of the fade-in is anti-aliasing.
vec3 detailNormal(
    vec3 world, vec3 N, float scale, float blendSteep,
    vec3 ddxW, vec3 ddyW
) {
    vec3 n = unpackN(textureGrad(
        detailTex, world.xz * scale,
        ddxW.xz * scale, ddyW.xz * scale
    ).xy);

    if (blendSteep > 0.01) {
        vec3 a = unpackN(textureGrad(
            detailTex, world.xy * scale,
            ddxW.xy * scale, ddyW.xy * scale
        ).xy);
        vec3 b = unpackN(textureGrad(
            detailTex, world.zy * scale,
            ddxW.zy * scale, ddyW.zy * scale
        ).xy);
        vec3 w = abs(N);
        float sum = w.x + w.y + w.z;
        n = normalize(mix(n, (a * w.z + b * w.x + n * w.y) / sum, blendSteep));
    }
    return n;
}

void main() {
    vec3 world = vWorld;
    float viewDist = vViewDist;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    // World-space size of this pixel — drives every filtering decision below.
    // Taken once here, in uniform control flow, and threaded down to the texture
    // fetches that sit behind footprint tests.
    vec3 ddxW = dFdx(world);
    vec3 ddyW = dFdy(world);
    float footprint = max(length(vec2(length(ddxW.xz), length(ddyW.xz))), 1e-4);

    // The *narrow* axis of that footprint, which is a very different number.
    //
    // At grazing incidence a pixel's world footprint is a long thin sliver: one
    // axis blows up while the other stays small. `footprint` above averages the
    // two, so simply tilting the camera down towards the horizon inflates it by
    // an order of magnitude — and anything keyed off it fades out, even though
    // the surface is no further away and is still perfectly resolvable across the
    // sliver's short axis. For the natural detail layers that trade is fine and
    // deliberate. For carved snow it is not: it means the trail changes shape
    // when you move the camera and not the player, which reads as a bug because
    // it is one. This is the same reasoning anisotropic texture filtering runs on.
    float footprintMin = max(min(length(ddxW.xz), length(ddyW.xz)), 1e-4);

    // ---------------------------------------------------------------- slopes
    vec4 aux = textureLod(auxTex, vHeightUV, 0.0);
    vec2 grad = aux.xy;
    float rockMask = aux.z;
    float exposure = aux.w;

    vec3 fine = terrainFineFiltered(
        world.xz, windAngle, exposure, sastrugiAmp, footprint
    );
    grad += fine.yz;

    // ------------------------------------------------------------ deformation
    // Depression, displaced berm mass and compression, written by feet, the
    // surf wake and every spell. Read here so lighting responds to carved snow
    // exactly as it does to natural relief.
    float compression = 0.0;
    float iceAmount = 0.0;
    float deformDepth = 0.0;
    float deformBerm = 0.0;

    float dWeight = deformFalloff(world.xz, deformCenter, deformSize);
    if (dWeight > 0.001) {
        vec2 dUV = deformUV(world.xz, deformSize);
        vec4 c = textureLod(deformTex, dUV, 0.0);

        // Gradient of (berm - depression), by central difference.
        //
        // The step *widens with the pixel* rather than being fixed at two texels
        // behind a distance fade. Two texels differenced at 30 m is a normal
        // sampled far below the pixel's own footprint, so it aliases. Fading it
        // out fixes the aliasing but stops the trail existing about fifteen
        // metres out, and a run should be visible from across the field.
        //
        // Widening the baseline is the better answer: it is the low-pass filter
        // the fade was standing in for. The difference stays bounded while the
        // divisor grows, so the gradient rolls off smoothly with distance instead
        // of being switched off, and the trail survives as a tonal line long
        // after it has stopped being a shape.
        //
        // Keyed to the narrow footprint axis, so the width tracks how far away the
        // snow is and not how obliquely it is being looked at.
        float step2 = max(deformTexel * 2.0, footprintMin * 1.4);
        float eUV = step2 / deformSize;

        vec4 dxA = textureLod(deformTex, dUV + vec2(eUV, 0.0), 0.0);
        vec4 dxB = textureLod(deformTex, dUV - vec2(eUV, 0.0), 0.0);
        vec4 dzA = textureLod(deformTex, dUV + vec2(0.0, eUV), 0.0);
        vec4 dzB = textureLod(deformTex, dUV - vec2(0.0, eUV), 0.0);
        float sx = (dxA.g - dxA.r) - (dxB.g - dxB.r);
        float sz = (dzA.g - dzA.r) - (dzB.g - dzB.r);

        // The four neighbours are already fetched, so blending them into the
        // state channels once the pixel is wider than a texel costs nothing and
        // stops a distant trail breaking into a dotted line.
        float wide = clamp(footprintMin / (deformTexel * 4.0), 0.0, 1.0) * 0.8;
        vec4 df = mix(c, (c + dxA + dxB + dzA + dzB) * 0.2, wide);

        deformDepth = df.r * dWeight;
        deformBerm = df.g * dWeight;
        compression = clamp(df.b, 0.0, 1.0) * dWeight;
        iceAmount = clamp(df.a, 0.0, 1.0) * dWeight;

        grad += vec2(sx, sz) / (2.0 * step2) * deformDepthScale * dWeight;
    }

    vec3 N = normalFromGradient(grad);

    // The surface the *depth pass* rendered: macro landform, the analytic fine
    // layer and carved snow, but nothing finer. The shading normal below picks up
    // three tiled grain scales on top of this, and biasing the shadow lookup
    // against that would describe a surface orders of magnitude higher in
    // frequency than the one in the depth map — the offset would point off in a
    // different direction on every pixel and reintroduce the noise it exists to
    // remove.
    vec3 geoN = N;

    // ---------------------------------------------------------- detail normals
    // Three tiling scales, each faded by footprint so the finest only exists
    // when it is actually resolvable, and cross-faded so no scale ever pops in.
    float steep = smoothstep(0.55, 0.9, 1.0 - N.y);
    if (detailStrength > 0.001) {
        vec3 acc = vec3(0.0, 0.0, 1.0);

        float f0w = 1.0 - smoothstep(0.004, 0.02, footprint);
        if (f0w > 0.001) {
            vec3 d = detailNormal(world, N, 7.5, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3(0.0, 0.0, 1.0), d, f0w));
        }
        float f1 = 1.0 - smoothstep(0.02, 0.12, footprint);
        if (f1 > 0.001) {
            vec3 d = detailNormal(world, N, 1.7, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3(0.0, 0.0, 1.0), d, f1 * 0.85));
        }
        float f2 = 1.0 - smoothstep(0.1, 0.7, footprint);
        if (f2 > 0.001) {
            vec3 d = detailNormal(world, N, 0.31, steep, ddxW, ddyW);
            acc = blendNormalRNM(acc, mix(vec3(0.0, 0.0, 1.0), d, f2 * 0.6));
        }

        // Lift the tangent-space result onto the geometric normal.
        vec3 up = (abs(N.y) > 0.99) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
        vec3 T = normalize(cross(up, N));
        vec3 B = cross(N, T);
        float s = detailStrength * mix(1.0, 0.45, compression);
        N = normalize(N + (T * acc.x + B * acc.y) * s);
    }

    float cavity = textureGrad(
        detailTex, world.xz * 1.7,
        ddxW.xz * 1.7, ddyW.xz * 1.7
    ).z;

    // ------------------------------------------------------------- material
    // Snow albedo sits in a narrow, high, slightly blue band. It is never 1.0:
    // pushing albedo to white is what produces the blown-out clipped highlights
    // that read as "untextured white blob" rather than as snow.
    vec3 albedo = vec3(0.855, 0.885, 0.945);
    float roughness = 0.62;
    vec3 f0 = vec3(0.028);
    float thickness = 1.0; // 1 = deep drift, 0 = thin crust

    // Compressed snow: denser, darker, tighter specular, scatters less.
    albedo = mix(albedo, vec3(0.62, 0.665, 0.755), compression * 0.85);
    roughness = mix(roughness, 0.34, compression);
    thickness = mix(thickness, 0.35, compression);

    // Refrozen ice: smooth and genuinely reflective.
    albedo = mix(albedo, vec3(0.42, 0.56, 0.70), iceAmount * 0.8);
    roughness = mix(roughness, 0.07, iceAmount);
    f0 = mix(f0, vec3(0.045), iceAmount);
    thickness = mix(thickness, 0.15, iceAmount);

    // Exposed rock. Snow keeps its grip on the flatter faces, so the mask is
    // gated by slope rather than applied flat.
    float rockExposed = rockMask * smoothstep(0.32, 0.66, 1.0 - N.y);
    if (rockExposed > 0.001) {
        float rn = noise2(world.xz * 2.3) * 0.5 + 0.5;
        vec3 rockCol = mix(vec3(0.055, 0.058, 0.068), vec3(0.115, 0.112, 0.118), rn);
        albedo = mix(albedo, rockCol, rockExposed);
        roughness = mix(roughness, 0.85, rockExposed);
        thickness = mix(thickness, 0.0, rockExposed);
    }

    // --- carved-snow surface state -----------------------------------------
    // Freshly displaced mass is the opposite of trodden snow: it has just been
    // broken up and thrown, so it is loose, bright and rough. Without this the
    // berms shade identically to the trench and the whole trail flattens into
    // one grey smear.
    //
    // Both numbers here must not make carved snow *less blue*, which is the one
    // axis this material cannot afford to lose. Drain the cool cast out of a
    // heavily worked patch and it reads as bare ground even while its luminance
    // goes up — a warm-grey patch surrounded by blue-white snow is not snow.
    //
    //  1. The loose colour was a *whiter* white — B/R 1.078 against snow's 1.105
    //     — so brightening toward it desaturated. It is now brighter than snow in
    //     every channel and very slightly bluer, which is also the truer answer:
    //     freshly broken snow has more surface per unit volume and scatters more,
    //     and snow's scattering is what its blue comes from.
    //  2. Roughness at 0.78 cut the ambient sky specular, through both the
    //     roughness-dependent Fresnel and a blurrier mip. That term is one of the
    //     bluest things in the frame, and a berm loses it exactly where the eye
    //     is comparing it against snow that still has it. Loose snow is still
    //     rougher than packed — it should be — just not by enough to strip the
    //     sky out of it.
    if (deformBerm > 0.002) {
        float loose = clamp(deformBerm * 5.0, 0.0, 1.0);
        albedo = mix(albedo, vec3(0.895, 0.920, 0.965), loose * 0.55);
        roughness = mix(roughness, 0.78, loose * 0.7);
        thickness = mix(thickness, 1.0, loose * 0.6);
        // Broken snow has crystal faces pointing everywhere, which is where the
        // chunky granular read at a trail edge actually comes from.
        float chunk = noise2(world.xz * 34.0) * 0.5 + 0.5;
        albedo *= 1.0 - loose * 0.10 * chunk;
    }

    // Micro-occlusion in the grain crevices, and stronger in carved edges. See
    // the note where this is applied, at the bottom: it scales the whole
    // radiance, not the ambient, and it carries a blue shift with it.
    //
    // Analytic only, deliberately. A snow field is the worst possible content
    // for a screen-space occlusion pass: an open, smooth, high-albedo surface
    // viewed at grazing angles, so the estimator has almost no real occluders to
    // find and what it returns is dominated by its own view-dependent bias — a
    // broad, soft darkening keyed to distance from the camera, which slides
    // across the ground when the camera moves and nothing else does.
    float ao = mix(1.0, cavity, 0.35 * (1.0 - smoothstep(0.02, 0.25, footprint)))
             * (1.0 - clamp(deformDepth * 1.9, 0.0, 1.0) * 0.38);

    // ------------------------------------------------------------- lighting
    float NdotL = dot(N, L);
    float NdotV = clamp(dot(N, V), 1e-4, 1.0);

    // Stable per-pixel rotation for the shadow filter. IGN over pixel coords is
    // exactly the noise TAA is built to resolve.
    vec2 pix = gl_FragCoord.xy;
    float noiseRot = ign(pix) * 6.28318530718;

    float shadow = 1.0;
    if (NdotL > -0.35) {
        shadow = sunShadow(world, geoN, viewDist, noiseRot);
    }

    const float INV_PI = 0.31830988618;

    // --- direct diffuse, wrapped -------------------------------------------
    // Snow's mean free path is millimetres, so light wraps well past the
    // geometric terminator. This is why snow shadow edges are soft even where
    // the shadow map is pin sharp.
    float wrapAmount = mix(0.62, 0.15, max(compression, rockExposed));
    float diff = wrapDiffuse(NdotL, wrapAmount);
    vec3 direct = albedo * INV_PI * sunRadiance * diff * shadow;

    // --- subsurface --------------------------------------------------------
    vec3 sss = snowSubsurface(
        N, L, V, sunRadiance, thickness,
        sssStrength * (1.0 - rockExposed), sssRadius
    );
    // Only partly shadowed: scattered light arrives through the snow, so a
    // shadowed drift lip still glows. Killing this with the shadow term is what
    // makes shadowed snow go flat and grey.
    direct += sss * albedo * mix(0.42, 1.0, shadow);

    // --- direct specular ---------------------------------------------------
    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float NdotH = clamp(dot(N, H), 0.0, 1.0);
        float VdotH = clamp(dot(V, H), 0.0, 1.0);
        float D = distributionGGX(NdotH, roughness);
        float Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        vec3 F = fresnelSchlick(VdotH, f0);
        direct += sunRadiance * D * Vis * F * NdotL * shadow;
    }

    // --- ambient -----------------------------------------------------------
    // Sky irradiance from SH. Strongly blue by construction, which is the other
    // half of the warm-light / cool-shadow split that sells snow.
    vec3 irradiance = shIrradiance(N, shR) * ambientIntensity;

    // Snow bounces onto itself: a huge, bright, near-white surround. Without a
    // bounce term the troughs go far too dark for a material with 0.85 albedo.
    float bounceUp = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3(0.0, 1.0, 0.0), shR)
                * ambientIntensity * 0.28 * bounceUp * albedo;

    vec3 ambient = albedo * INV_PI * irradiance;

    // Ambient specular from the sky, at a roughness-selected mip.
    vec3 R = reflect(-V, N);
    float mip = sqrt(roughness) * 6.0;
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(R), mip).rgb;
    vec3 Fr = fresnelSchlickRough(NdotV, f0, roughness);
    ambient += skyRefl * Fr * ambientIntensity * mix(1.0, 2.6, iceAmount);

    vec3 color = direct + ambient;

    // --- spell light -------------------------------------------------------
    // Same wrapped diffuse and the same transmission lobe the sun drives, so a
    // ribbon of lit water lying across a berm glows *through* the crest instead
    // of merely putting a bright patch on the near face. That through-scatter is
    // the whole reason the term is here rather than being a stock point light.
    //
    // The occlusion below scales this along with everything else: a spell casting
    // into an open field and a spell casting into the bottom of its own crater
    // are lighting very different amounts of visible snow.
    if (spellLightCount > 0.5) {
        color += spellLighting(
            world, N, V, albedo, thickness,
            sssStrength * (1.0 - rockExposed), sssRadius,
            spellLightPos, spellLightCol, spellLightCount
        );
    }

    // --- glints ------------------------------------------------------------
    // Last, and added as radiance rather than modulated into the BRDF, because
    // a glint is a specular highlight from a crystal facet that the shading
    // normal does not represent.
    if (glintIntensity > 0.001 && rockExposed < 0.5) {
        float g = snowGlints(
            world.xz, N, V, L, footprint,
            glintIntensity, glintGrazing
        );
        color += sunRadiance * g * shadow * (1.0 - iceAmount * 0.6) * 0.55;
    }

    // ---- occlusion, applied last and to everything -------------------------
    //
    // Two rules, the same two the surf wake's fragment shader carries. Both are
    // about hue rather than brightness.
    //
    //  1. It scales the *finished radiance*, not the ambient. The textbook says
    //     occlusion darkens ambient and leaves direct light alone, and in this
    //     scene that is actively wrong: the ambient is where all the blue lives —
    //     the sky is strongly blue-shifted by construction — and the sun is a
    //     13-degree beam at roughly 17:13:6. Attenuating one and not the other
    //     does not darken a surface, it re-weights a cool source against a warm
    //     one. A trench floor at 40% ambient and 100% sun is not a dark trench,
    //     it is a *brown* trench, and it lands there because AgX stops rolling
    //     saturation off half a stop below its shoulder.
    //
    //  2. Wherever it does darken, it goes blue in proportion. Light reaching
    //     into a hollow in snow has scattered through snow to get there, and snow
    //     absorbs red over any appreciable path — which is why a real snow cave
    //     is blue and not grey. The tint is the same `deepTint` the subsurface
    //     term uses, and tying it to the darkening rather than to `deformDepth`
    //     means the two can never drift apart.
    vec3 caveTint = mix(vec3(1.0), vec3(0.55, 0.72, 1.0), (1.0 - ao) * 0.95);
    color *= ao * caveTint;

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sunRadiance,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    // ------------------------------------------------------------------ debug
    if (debugMode > 0.5) {
        if (debugMode < 1.5) {
            // Depression and berm are metres and berms are the shallower of the
            // two, so both are scaled to fill the range rather than shown raw —
            // otherwise the channel that matters most reads as black.
            color = vec3(deformDepth * 2.5, deformBerm * 5.0, compression * 0.6);
        } else if (debugMode < 2.5) {
            color = N * 0.5 + 0.5;
        } else if (debugMode < 3.5) {
            color = vec3(viewDist / 400.0);
        } else if (debugMode > 4.5 && debugMode < 5.5) {
            // Pixel footprint, log-scaled: green ~1 cm, yellow ~10 cm, red ~1 m.
            // Every detail fade in this shader is keyed off this value, so being
            // able to see it directly turns "why is there no detail here" from a
            // guess into a reading.
            float lf = log2(footprint);
            color = vec3(
                clamp((lf + 3.3) / 3.3, 0.0, 1.0),
                clamp(1.0 - abs(lf + 4.6) / 2.0, 0.0, 1.0),
                clamp(-(lf + 5.0) / 2.0, 0.0, 1.0)
            );
        } else if (debugMode > 5.5 && debugMode < 6.5) {
            // Fine + detail normal only, with the macro landform removed, so
            // the high-frequency content can be judged on its own.
            vec3 fineN = normalFromGradient(fine.yz);
            color = fineN * 0.5 + 0.5;
        } else if (debugMode > 6.5 && debugMode < 7.5) {
            // The sun visibility term on its own — cast shadow only, with no
            // N.L, no albedo, no ambient and no fog. This is the one view that
            // separates "this surface faces away from the sun" from "something
            // is occluding it", which are the two completely different causes of
            // a dark frame and are otherwise indistinguishable by eye.
            //
            // Red where the surface is back-lit (NdotL < 0), because there the
            // shadow term is not what is making it dark and reading the grey
            // value would be misleading.
            color = (NdotL <= 0.0) ? vec3(0.35, 0.06, 0.06) : vec3(shadow);
        } else if (debugMode > 7.5 && debugMode < 8.5) {
            // Lambert term alone, same framing as the shadow view above: this is
            // the *other* half of why a pixel is dark.
            color = vec3(max(NdotL, 0.0));
        } else if (debugMode > 9.5) {
            // Albedo alone, before a single lighting term touches it. The one
            // view that separates "this surface is lit badly" from "this surface
            // is the wrong colour", which are otherwise indistinguishable — and
            // on carved snow specifically, where four independent channels
            // (compression, ice, displaced mass, rock) all write here, it is the
            // only way to see which of them is talking.
            color = albedo;
        } else if (debugMode > 8.5) {
            // Depth-map agreement, in metres.
            //   blue    = point falls outside every cascade box
            //   grey    = map and receiver agree within 0.5 m
            //   red     = map claims an occluder in front, brighter with distance
            //   green   = map sits behind the receiver (should be impossible on
            //             a closed heightfield, so it means the projection is off)
            float dz = shadowMapDelta(world, geoN, viewDist);
            if (dz > 1e8) {
                color = vec3(0.0, 0.15, 0.6);
            } else {
                float mag = clamp(abs(dz) / 12.0, 0.0, 1.0);
                float agree = 1.0 - smoothstep(0.0, 0.5, abs(dz));
                color = vec3(agree * 0.45)
                      + ((dz < 0.0) ? vec3(mag, 0.0, 0.0) : vec3(0.0, mag, 0.0));
            }
        } else {
            vec3 c = vec3(float(viewDist < cascadeSplits.x),
                          float(viewDist < cascadeSplits.y),
                          float(viewDist < cascadeSplits.z));
            color = color * 0.6 + c * 0.25;
        }
    }

    fragColor = vec4(color, 1.0);
}
