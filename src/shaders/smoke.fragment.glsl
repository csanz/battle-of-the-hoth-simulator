// One soft puff. Premultiplied over, so the same draw carries both kinds of
// puff a burning craft sheds: dark smoke (low colour, real alpha — it
// *occludes* the sky behind it) and fire (hot colour, thin alpha — it adds).

precision highp float;
precision highp int;

in vec2 vUV;
in vec4 vColor;

layout(location = 0) out vec4 fragColor;

void main() {
    float d = dot(vUV, vUV);
    if (d > 1.0) discard;
    // Gaussian-ish core with a soft skirt; squared falloff reads as vapour.
    float body = (1.0 - d);
    float a = body * body * vColor.a;
    fragColor = vec4(vColor.rgb * a, a);
}
