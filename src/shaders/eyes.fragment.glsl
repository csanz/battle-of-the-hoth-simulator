// The viewport band's light: a hot core line inside a soft red bloom, the
// cockpit slit of a machine that is looking at you. Additive over the beauty
// pass but depth-tested — unlike the tuning rings, an eye must go dark when
// the head turns away or a dune stands in front of it.

precision highp float;
precision highp int;

in vec2 vUV;
in float vFade;
in float vSeed;

uniform float time;

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

    // The crew. Dark figures crossing the lit glass, now and then: each band
    // runs two walkers on their own slow clocks, most of each lap spent
    // off-slit so the movement stays an occasional glimpse rather than a
    // metronome. A figure is a soft full-height occluder — at any distance
    // this reads, which is all a silhouette has to do.
    float crew = 0.0;
    for (int i = 0; i < 2; i++) {
        float fi = float(i);
        float sp = 0.045 + 0.035 * fract(vSeed * 7.31 + fi * 0.37);
        float ph = fract(time * sp + vSeed * 0.613 + fi * 0.5);
        float cx = ph * 3.4 - 1.7;   // most of the lap is spent off the slit
        float w = 0.09 + 0.04 * fi;
        crew += (1.0 - smoothstep(w * 0.45, w, abs(vUV.x - cx)))
            * step(abs(cx), 1.02);
    }
    col *= 1.0 - min(crew, 1.0) * 0.85;

    // Dim on purpose — the film's viewports are barely-lit glass, not lamps —
    // and gone with range (vFade), so the eyes are a reward for getting close.
    fragColor = vec4(col * 0.85 * vFade, 1.0);
}
