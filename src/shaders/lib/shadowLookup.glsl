// -----------------------------------------------------------------------------
// snowShadowLookup — the receiving half of the cascaded shadow maps.
//
// Lifted out of the snow material once the character needed the identical
// lookup. Two independent copies of this would be a slow-motion disaster: the
// Y convention, the receiver-plane gradient and the normal offset are all
// things that are invisible to inspection and wrong in ways that only show up
// as "the shadows swim a bit". One include, one convention.
//
// Contract — every material that includes this must declare, BEFORE the include:
//
//   uniform vec3 sunDir;                  (points *toward* the sun)
//   uniform mat4 cascadeMatrices[3];
//   uniform vec4 cascadeSplits;
//   uniform vec4 cascadeParams[3];        (depth range m, ortho width m, -, -)
//   uniform float shadowTexel;
//   uniform float shadowSoftness;
//   uniform float shadowBias;
//   uniform sampler2D cascade0;
//   uniform sampler2D cascade1;
//   uniform sampler2D cascade2;
//
// and must include <snowShading> first, for `pcssShadow`.
// -----------------------------------------------------------------------------

/// Project into one cascade and run PCSS. Returns 1.0 (lit) outside the
/// cascade's extent, so callers can fall through to a coarser one.
float sampleCascadeTex(
    sampler2D tex,
    mat4 m,
    vec4 params,
    vec3 world,
    vec3 geoN,        // the surface the *depth pass* rendered, not the shading normal
    float biasWorld,
    float softness,
    float noiseRot
) {
    float depthRange = params.x;
    float orthoWidth = params.y;
    float texelWorld = orthoWidth * shadowTexel;

    // ---- the light's own basis -------------------------------------------
    // Reconstructed here rather than passed in, so it cannot drift out of sync
    // with the matrix. This mirrors `lookAtLH` in shadows.js exactly:
    // forward is the direction the light travels, right = up x forward, and the
    // world up is only swapped out for a near-zenith sun, which this scene's
    // 0.5-45 degree elevation range never reaches.
    vec3 lf = -sunDir;
    vec3 lr = normalize(cross(vec3(0.0, 1.0, 0.0), lf));
    vec3 lu = cross(lf, lr);

    // Surface normal in that basis. `nl.z` is the cosine between the normal and
    // the light's direction of travel, so it goes to zero exactly at the
    // terminator — where the plane is edge-on to the light and its depth
    // gradient is genuinely infinite. Clamped to a slope of 6 (about 80 degrees),
    // past which extrapolating further would start detaching real shadows from
    // their casters rather than preventing acne.
    vec3 nl = vec3(dot(geoN, lr), dot(geoN, lu), dot(geoN, lf));
    float nz = (nl.z >= 0.0) ? max(nl.z, 1e-3) : min(nl.z, -1e-3);
    vec2 grad = clamp(vec2(-nl.x / nz, -nl.y / nz), vec2(-6.0), vec2(6.0));

    // Stored-depth units of light-space travel per unit UV. The maps hold
    // window depth (0..1 across `depthRange` metres), so the conversion factor
    // is the same one the WebGPU build used.
    vec2 planeNdcPerUV = vec2(grad.x, grad.y) * orthoWidth / depthRange;

    // ---- normal-offset bias ----------------------------------------------
    // Move the receiver off the surface by a texel's worth before projecting,
    // scaled by how obliquely the light meets it. This is what absorbs the
    // depth quantisation of the map itself, and because it is expressed in this
    // cascade's own texels it needs no per-cascade multiplier: 3 cm in cascade 0,
    // where contact shadows must stay attached, and 40 cm out in cascade 2 where
    // a texel covers that much ground anyway.
    float sinL = sqrt(clamp(1.0 - nl.z * nl.z, 0.0, 1.0));
    vec3 biased = world + geoN * (texelWorld * 1.5 * max(sinL, 0.2));

    vec4 clip = m * vec4(biased, 1.0);
    vec3 ndc = clip.xyz / clip.w;
    if (any(greaterThan(abs(ndc.xy), vec2(1.0))) || ndc.z < -1.0 || ndc.z > 1.0) { return 1.0; }

    // NDC -> UV, with NO Y flip. The Babylon source used `0.5 + ndc.y * 0.5`
    // to compensate an engine-side clip-Y negation on render targets; WebGL
    // FBOs have no such flip, so the first-principles mapping (v = 0 at the
    // bottom) is correct in both axes here. Validate once against a CPU
    // readback of cascade 0 — the symptom of getting this wrong is shadows
    // sliding with camera angle, mirrored about the cascade centre.
    vec2 uv = ndc.xy * 0.5 + vec2(0.5);

    // The maps store gl_FragCoord.z — window depth — so the comparison depth
    // is the same [0,1] remap of GL's [-1,1] NDC z.
    return pcssShadow(
        tex, uv, ndc.z * 0.5 + 0.5, shadowTexel,
        depthRange, orthoWidth, softness, noiseRot, biasWorld, planeNdcPerUV
    );
}

/// Pick a cascade and evaluate PCSS, cross-fading over the last 12% of each
/// slice so the filter width never visibly steps.
///
/// The cascades are separate bindings rather than one atlas so the lookup stays
/// a compile-time texture reference. The branch costs almost nothing: cascade
/// choice is a function of view distance, so it is coherent across essentially
/// every wavefront.
float sunShadow(vec3 world, vec3 geoN, float viewDist, float noiseRot) {
    // A small constant bias, and nothing else. Slope scaling and per-cascade
    // texel-footprint multipliers are both handled inside `sampleCascadeTex`,
    // exactly and in world units, by the receiver-plane gradient and the
    // texel-sized normal offset. Stacking more on top only peter-pans the
    // shadows off their casters.
    float biasWorld = shadowBias;

    vec4 sp = cascadeSplits;
    float soft = shadowSoftness;

    if (viewDist >= sp.z) { return 1.0; }

    if (viewDist < sp.x) {
        float s = sampleCascadeTex(cascade0, cascadeMatrices[0],
                                   cascadeParams[0], world, geoN, biasWorld, soft, noiseRot);
        float blendStart = sp.x * 0.88;
        if (viewDist <= blendStart) { return s; }
        float s2 = sampleCascadeTex(cascade1, cascadeMatrices[1],
                                    cascadeParams[1], world, geoN, biasWorld, soft, noiseRot);
        return mix(s, s2, clamp((viewDist - blendStart) / (sp.x - blendStart), 0.0, 1.0));
    }

    if (viewDist < sp.y) {
        float s = sampleCascadeTex(cascade1, cascadeMatrices[1],
                                   cascadeParams[1], world, geoN, biasWorld, soft, noiseRot);
        float blendStart = sp.y * 0.88;
        if (viewDist <= blendStart) { return s; }
        float s2 = sampleCascadeTex(cascade2, cascadeMatrices[2],
                                    cascadeParams[2], world, geoN, biasWorld, soft, noiseRot);
        return mix(s, s2, clamp((viewDist - blendStart) / (sp.y - blendStart), 0.0, 1.0));
    }

    float s = sampleCascadeTex(cascade2, cascadeMatrices[2],
                               cascadeParams[2], world, geoN, biasWorld, soft, noiseRot);
    // Fade the last cascade out at its far edge rather than cutting to lit.
    return mix(s, 1.0, smoothstep(sp.z * 0.85, sp.z, viewDist));
}
