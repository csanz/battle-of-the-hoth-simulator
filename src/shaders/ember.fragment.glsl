// Ember colour and falloff. Additive, HDR: bright enough that the bloom pass
// picks the streaks up, which is where the "white-hot tracer" read comes from
// — the quad itself is only a few pixels wide.

precision highp float;
precision highp int;

in vec2 vC;
in float vLife;
in float vFlick;

layout(location = 0) out vec4 fragColor;

void main() {
    float across = 1.0 - abs(vC.y);
    float head = 1.0 - vC.x;
    vec3 c = mix(vec3(1.0, 0.28, 0.04), vec3(1.0, 0.9, 0.55), vLife * vLife);
    vec3 col = c * pow(across, 1.6) * (0.30 + 0.70 * head)
        * vFlick * vLife * 24.0;
    fragColor = vec4(col, 1.0);
}
