// The bolt itself: a hot core in a cooler sheath, added into the frame.
//
// Additive rather than alpha-blended, because a bolt is light and light does not
// occlude what is behind it. That also means the tone mapper and the bloom get
// something genuinely bright to work with — the core is deliberately well over
// one, so it blooms the way an emitter should instead of being a red rectangle.

precision highp float;
precision highp int;

in float vT;
in float vSide;
in float vLife;

uniform vec3 boltColor;

layout(location = 0) out vec4 fragColor;

/// The fringe and the core. Three tints across the ribbon rather than one is the
/// whole difference between "a red line" and a bolt: the eye reads the hue
/// *shift* from the edge inward as heat, so the outside runs pink, the body runs
/// orange and the centre is nearly white. Additively blended and well over one,
/// so the bloom pass has something real to spread.
const vec3 FRINGE = vec3(1.0, 0.20, 0.46);
const vec3 CORE = vec3(1.0, 0.84, 0.74);

void main() {
    // Across the ribbon: 1 at the centre line, 0 at the edges.
    float across = 1.0 - abs(vSide);
    // Three profiles summed, widest first. Each is a narrower band than the last,
    // so they stack into a gradient from the pink outside to the white middle
    // without a single mix() or step in sight.
    float fringe = across;
    float glow = across * across * across;
    float core = pow(across, 14.0);

    // Along it: fade the very ends so the ribbon has no hard cap.
    float ends = smoothstep(0.0, 0.08, vT) * (1.0 - smoothstep(0.86, 1.0, vT));

    float fade = vLife * vLife;
    vec3 c = FRINGE * fringe * 1.15
          + boltColor * glow * 3.1
          + CORE * core * 5.6;

    fragColor = vec4(c * ends * fade, 1.0);
}
