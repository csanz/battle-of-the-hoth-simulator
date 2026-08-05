// Contrast-adaptive sharpen, after the display transform.
//
// TAA costs sharpness — it is a weighted average over eight subpixel positions,
// and however good the neighbourhood clip is, the result is softer than the
// jittered frame that went in. This is the pass that buys it back, and it belongs
// at the very end for two reasons: sharpening in linear HDR puts a dark ring
// around every specular highlight, because the overshoot there is measured in
// stops rather than in code values; and the eye judges acutance after the tone
// curve, not before it.
//
// The local min/max clamp is what makes it "adaptive": the correction is limited
// to the range already present in the 3x3 neighbourhood, so a sharp edge is
// steepened and a flat expanse of snow does not gain a halo it has no gradient to
// justify.
precision highp float;
precision highp int;

in vec2 vUV;

uniform sampler2D textureSampler;

uniform vec2 invRes;
uniform float amount;

layout(location = 0) out vec4 fragColor;

void main() {
    vec2 uv = vUV;
    vec4 c = textureLod(textureSampler, uv, 0.0);

    vec3 outCol = c.rgb;
    if (amount >= 0.001) {
        vec2 t = invRes;
        vec3 l = textureLod(textureSampler, uv - vec2(t.x, 0.0), 0.0).rgb;
        vec3 r = textureLod(textureSampler, uv + vec2(t.x, 0.0), 0.0).rgb;
        vec3 d = textureLod(textureSampler, uv - vec2(0.0, t.y), 0.0).rgb;
        vec3 u = textureLod(textureSampler, uv + vec2(0.0, t.y), 0.0).rgb;

        vec3 lo = min(c.rgb, min(min(l, r), min(d, u)));
        vec3 hi = max(c.rgb, max(max(l, r), max(d, u)));

        float k = amount * 0.32;
        outCol = clamp(c.rgb * (1.0 + 4.0 * k) - (l + r + d + u) * k, lo, hi);
    }

    fragColor = vec4(outCol, c.a);
}
