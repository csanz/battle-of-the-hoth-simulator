// -----------------------------------------------------------------------------
// Temporal anti-aliasing.
//
// The one post-process this content genuinely cannot do without. The snow
// material's whole detail budget is spent on things that live at or below the
// pixel: two octaves of discrete crystal glints, three tiled grain scales,
// sastrugi at a decimetre, a rotated Poisson shadow filter dithered per pixel,
// and a plume of two-centimetre grains. Every one of those is built to be
// *resolved* by an accumulation rather than to survive on its own — the glint
// hash is nailed to world space and the shadow rotation is interleaved-gradient
// noise precisely so that a temporal filter can integrate them. Without one,
// the field crawls.
//
// The reprojection is depth-based rather than motion-vector based, which is a
// deliberate trade. Almost everything on screen is static world geometry, so the
// camera's own motion accounts for essentially all the parallax; the character,
// the wake and the spray are small, fast and high-contrast, which is exactly the
// case the neighbourhood clip rejects history for anyway.
// -----------------------------------------------------------------------------
precision highp float;
precision highp int;

in vec2 vUV;

uniform sampler2D textureSampler;
uniform sampler2D historyTex;
uniform sampler2D depthTex;

/// Last frame's view-projection, unjittered.
uniform mat4 prevViewProj;
/// This frame's view -> world.
uniform mat4 invView;
uniform vec2 projInfo;
uniform vec2 invRes;
/// Subpixel offset baked into this frame's projection, in NDC.
uniform vec2 jitterNdc;
/// 0 on the first frame and after a resize — the history is uninitialised VRAM
/// there, and a single NaN in it would propagate for the rest of the session.
uniform float historyValid;
uniform float enabled;
/// How much history to keep at rest, 0..1.
uniform float feedback;

layout(location = 0) out vec4 fragColor;

#include<snowPostCommon>

/// Five-tap Catmull-Rom fetch of the history.
///
/// The single largest quality decision in this file, and it is not about
/// aliasing at all — it is about accumulated blur. History is resampled at a
/// fractional offset *every frame*, and each resample is fed back into the next,
/// so a bilinear tap does not soften the image once, it convolves it with a tent
/// kernel again and again. A bicubic fetch has negative lobes that undo most of
/// that. Five bilinear taps rather than sixteen point fetches, by folding each
/// pair of weights into one offset tap.
vec3 historyCatmullRom(vec2 uv, vec2 texSize) {
    vec2 samplePos = uv * texSize;
    vec2 texPos1 = floor(samplePos - 0.5) + 0.5;
    vec2 f = samplePos - texPos1;

    vec2 w0 = f * (-0.5 + f * (1.0 - 0.5 * f));
    vec2 w1 = 1.0 + f * f * (-2.5 + 1.5 * f);
    vec2 w2 = f * (0.5 + f * (2.0 - 1.5 * f));
    vec2 w3 = f * f * (-0.5 + 0.5 * f);

    vec2 w12 = w1 + w2;
    vec2 off12 = w2 / w12;

    vec2 p0 = (texPos1 - 1.0) / texSize;
    vec2 p3 = (texPos1 + 2.0) / texSize;
    vec2 p12 = (texPos1 + off12) / texSize;

    vec3 acc = vec3(0.0);
    acc += textureLod(historyTex, vec2(p12.x, p0.y), 0.0).rgb
         * (w12.x * w0.y);
    acc += textureLod(historyTex, vec2(p0.x, p12.y), 0.0).rgb
         * (w0.x * w12.y);
    acc += textureLod(historyTex, vec2(p12.x, p12.y), 0.0).rgb
         * (w12.x * w12.y);
    acc += textureLod(historyTex, vec2(p3.x, p12.y), 0.0).rgb
         * (w3.x * w12.y);
    acc += textureLod(historyTex, vec2(p12.x, p3.y), 0.0).rgb
         * (w12.x * w3.y);

    // The negative lobes can undershoot past zero on a hard edge, and a negative
    // radiance survives the clip below as a black fringe.
    return max(acc, vec3(0.0));
}

/// The resolve, as a helper so it can return early.
vec3 resolve(vec2 uv) {
    vec3 cur = textureLod(textureSampler, uv, 0.0).rgb;

    if (enabled < 0.5 || historyValid < 0.5) { return cur; }

    // ---- reprojection -----------------------------------------------------
    // The depth stored here was rasterised through the jittered projection, so
    // the ray this pixel actually looked along is the jittered one. Removing the
    // offset before reconstructing is worth the one subtraction: at 0.5 px it is
    // the difference between history that lands on the same surface and history
    // that lands on the far side of a berm crest.
    float z = textureLod(depthTex, uv, 0.0).r;
    vec2 ndc = uv * 2.0 - 1.0 - jitterNdc;
    vec3 view = vec3(ndc.x * projInfo.x, ndc.y * projInfo.y, 1.0)
              * min(z, POST_FAR);
    vec4 world = invView * vec4(view, 1.0);

    vec4 prevClip = prevViewProj * vec4(world.xyz, 1.0);
    if (prevClip.w <= 1e-4) { return cur; }

    vec2 prevUV = (prevClip.xy / prevClip.w) * 0.5 + 0.5;

    // Off the edge of last frame is a disocclusion by definition.
    if (any(lessThan(prevUV, vec2(0.0))) || any(greaterThan(prevUV, vec2(1.0)))) { return cur; }

    // ---- neighbourhood statistics -----------------------------------------
    // Variance clipping rather than a min/max box. A box built from nine taps of
    // a field that *contains* discrete glints is enormous — one lit crystal in
    // the corner of the neighbourhood opens the box wide enough to admit any
    // ghost at all. Clipping to the local distribution instead tracks the
    // surface and ignores the outlier.
    vec3 m1 = vec3(0.0);
    vec3 m2 = vec3(0.0);
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            vec3 s = tonemapWeight(textureLod(
                textureSampler,
                uv + vec2(float(i), float(j)) * invRes, 0.0
            ).rgb);
            m1 += s;
            m2 += s * s;
        }
    }
    vec3 mu = m1 / 9.0;
    vec3 sigma = sqrt(max(vec3(0.0), m2 / 9.0 - mu * mu));
    vec3 lo = mu - sigma * 1.35;
    vec3 hi = mu + sigma * 1.35;

    vec3 raw = tonemapWeight(historyCatmullRom(prevUV, 1.0 / invRes));
    // Guard the uninitialised-history case a second time. A NaN survives a clamp.
    if (any(isnan(raw))) { raw = mu; }
    vec3 hist = clamp(raw, lo, hi);

    vec3 curW = tonemapWeight(cur);

    // ---- feedback ---------------------------------------------------------
    // Two things pull it down. Fast screen-space motion, because a long
    // reprojection is a poor prediction and the resampling blur compounds every
    // frame it is kept. And a history that had to be clipped hard, because that
    // is the signal that this pixel is not the same surface it was.
    float motion = length((prevUV - uv) / invRes); // pixels travelled
    float motionFade = 1.0 - clamp(motion / 64.0, 0.0, 1.0) * 0.35;
    float clipFade = 1.0 - clamp(length(hist - raw) * 4.0, 0.0, 1.0) * 0.45;

    float k = clamp(feedback * motionFade * clipFade, 0.0, 0.97);
    return tonemapUnweight(mix(curW, hist, k));
}

void main() {
    fragColor = vec4(resolve(vUV), 1.0);
}
