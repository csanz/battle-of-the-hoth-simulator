// The viewport band's light: a hot core line inside a soft red bloom, the
// cockpit slit of a machine that is looking at you. Additive over the beauty
// pass but depth-tested — unlike the tuning rings, an eye must go dark when
// the head turns away or a dune stands in front of it.

precision highp float;
precision highp int;

in vec2 vUV;
in float vFade;

layout(location = 0) out vec4 fragColor;

void main() {
    float u = abs(vUV.x);
    float v = abs(vUV.y);
    // The strip: firm ends, soft vertical falloff.
    float bar = (1.0 - smoothstep(0.78, 1.0, u)) * (1.0 - smoothstep(0.25, 1.0, v));
    // The core: a hotter line down the middle, so it reads as glass over
    // light rather than red paint.
    float core = (1.0 - smoothstep(0.70, 0.95, u)) * (1.0 - smoothstep(0.0, 0.45, v));
    vec3 col = vec3(1.0, 0.13, 0.05) * (bar * 0.55 + core * 0.9);
    // Dim on purpose — the film's viewports are barely-lit glass, not lamps —
    // and gone with range (vFade), so the eyes are a reward for getting close.
    fragColor = vec4(col * 0.85 * vFade, 1.0);
}
