// Bloom downsample, with an optional bright-pass on the first level.
//
// The thirteen-tap kernel is the one from Jimenez' Call of Duty presentation: a
// centre box plus four corner boxes, which behaves like a proper low-pass at a
// 2x reduction and does not fall apart at 4x the way a naive bilinear chain does.
//
// The Karis average on the prefilter level is not optional on this content. The
// snow material emits *discrete glints* — single pixels at many times the
// surrounding radiance, by design — and a plain mean of a 2x2 group lets one of
// them dominate the whole group. Weighting each group by 1/(1+luma) before
// averaging keeps the energy and drops the flicker.
precision highp float;
precision highp int;

in vec2 vUV;

/// The source. On the prefilter level this is the resolved scene, bound
/// explicitly; on later levels it is the previous bloom level.
uniform sampler2D sourceTex;

/// One texel of the *source*, in UV.
uniform vec2 srcTexel;
/// 1 on the first level: threshold and Karis-average. 0 on the rest.
uniform float prefilter;
/// Knee curve: (threshold, threshold - knee, 2*knee, 0.25/knee).
uniform vec4 curve;

layout(location = 0) out vec4 fragColor;

#include<snowPostCommon>

vec3 tap(vec2 uv) {
    return textureLod(sourceTex, uv, 0.0).rgb;
}

/// Soft-knee threshold. A hard cut puts a visible contour through any smooth
/// gradient that crosses it, and on a snow field almost every gradient does.
vec3 brightPass(vec3 c, vec4 curve) {
    float br = max(c.r, max(c.g, c.b));
    float rq = clamp(br - curve.y, 0.0, curve.z);
    float soft = rq * rq * curve.w;
    return c * max(soft, br - curve.x) / max(br, 1e-5);
}

void main() {
    vec2 uv = vUV;
    vec2 t = srcTexel;

    // Inner 2x2 box (weight 0.5 total) ...
    vec3 a = tap(uv + vec2(-t.x, -t.y));
    vec3 b = tap(uv + vec2( t.x, -t.y));
    vec3 c = tap(uv + vec2(-t.x,  t.y));
    vec3 d = tap(uv + vec2( t.x,  t.y));

    // ... and the four overlapping outer boxes (weight 0.125 each).
    vec3 e = tap(uv + vec2(-2.0 * t.x, -2.0 * t.y));
    vec3 f = tap(uv + vec2( 0.0,       -2.0 * t.y));
    vec3 g = tap(uv + vec2( 2.0 * t.x, -2.0 * t.y));
    vec3 h = tap(uv + vec2(-2.0 * t.x,  0.0));
    vec3 i = tap(uv);
    vec3 j = tap(uv + vec2( 2.0 * t.x,  0.0));
    vec3 k = tap(uv + vec2(-2.0 * t.x,  2.0 * t.y));
    vec3 l = tap(uv + vec2( 0.0,        2.0 * t.y));
    vec3 m = tap(uv + vec2( 2.0 * t.x,  2.0 * t.y));

    vec3 g0 = (a + b + c + d) * 0.25;
    vec3 g1 = (e + f + h + i) * 0.25;
    vec3 g2 = (f + g + i + j) * 0.25;
    vec3 g3 = (h + i + k + l) * 0.25;
    vec3 g4 = (i + j + l + m) * 0.25;

    vec3 outCol;
    if (prefilter > 0.5) {
        // Weight the five groups by their own luminance before combining, then
        // threshold once. See the note above.
        float w0 = 1.0 / (1.0 + lumaPost(g0));
        float w1 = 1.0 / (1.0 + lumaPost(g1));
        float w2 = 1.0 / (1.0 + lumaPost(g2));
        float w3 = 1.0 / (1.0 + lumaPost(g3));
        float w4 = 1.0 / (1.0 + lumaPost(g4));
        float wsum = w0 * 0.5 + (w1 + w2 + w3 + w4) * 0.125;
        outCol = (g0 * w0 * 0.5 + (g1 * w1 + g2 * w2 + g3 * w3 + g4 * w4) * 0.125)
               / max(wsum, 1e-5);
        outCol = brightPass(outCol, curve);
    } else {
        outCol = g0 * 0.5 + (g1 + g2 + g3 + g4) * 0.125;
    }

    fragColor = vec4(outCol, 1.0);
}
