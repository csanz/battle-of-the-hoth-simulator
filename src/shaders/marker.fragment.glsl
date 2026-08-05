// The tuning ring: a bright rim over a faint centre disc. The rim is what pins
// the point; the disc keeps it readable against bright snow when the ring
// itself lands over a sunlit dune. Additive and depth-test-free — a tool wants
// to be seen through the hull it is tuning, not occluded by it.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUV;
in vec3 vColor;

layout(location = 0) out vec4 fragColor;

void main() {
    float d = length(vUV);
    if (d > 1.0) discard;
    float rim = smoothstep(0.55, 0.8, d) * smoothstep(1.0, 0.92, d);
    float disc = (1.0 - smoothstep(0.0, 0.6, d)) * 0.22;
    float a = rim * 1.6 + disc;
    // HDR push so the ring survives the tonemap the way the bolts do.
    fragColor = vec4(vColor * a * 2.0, 1.0);
}
