// -----------------------------------------------------------------------------
// snowClipmap — vertex placement and displacement for the nested-ring terrain.
//
// The whole terrain is one static vertex buffer and one draw call. Vertices
// carry only a grid index and a ring level; where they actually land is decided
// here, every frame, from the camera position. Nothing is rebuilt on the CPU,
// nothing streams.
//
// Two things make this crack-free:
//
//  1. Each ring snaps its origin to twice its own vertex spacing, so the lattice
//     never slides underneath the geometry and the surface does not swim.
//
//  2. Vertices morph toward the *next coarser* lattice across the outer band of
//     their ring (CDLOD). By the ring boundary the morph is complete, so those
//     vertices sit exactly on the coarser ring's lattice and sample exactly the
//     same height. No T-junctions, and no popping when a ring re-snaps.
//
// Included by both the beauty pass and the shadow depth pass. They must produce
// bit-identical positions or the terrain would shadow-acne against itself, which
// is precisely why this is an include and not two copies.
// -----------------------------------------------------------------------------

/// Bicubic B-spline height fetch, via the four-bilinear-tap trick.
///
/// Bilinear alone leaves diamond-shaped creases across every texel of a smooth
/// dune, which reads as visible faceting. B-spline is
/// approximating rather than interpolating, so it also gently low-passes the
/// bake, which on a landform is a bonus.
float sampleHeightBicubic(sampler2D tex, vec2 uv, float res) {
    vec2 coord = uv * res - 0.5;
    vec2 base = floor(coord);
    vec2 f = coord - base;

    vec2 f2 = f * f;
    vec2 f3 = f2 * f;
    vec2 w0 = (1.0 - 3.0 * f + 3.0 * f2 - f3) / 6.0;
    vec2 w1 = (4.0 - 6.0 * f2 + 3.0 * f3) / 6.0;
    vec2 w2 = (1.0 + 3.0 * f + 3.0 * f2 - 3.0 * f3) / 6.0;
    vec2 w3 = f3 / 6.0;

    vec2 s0 = w0 + w1;
    vec2 s1 = w2 + w3;
    vec2 o0 = (base + 0.5 - 1.0 + w1 / s0) / res;
    vec2 o1 = (base + 0.5 + 1.0 + w3 / s1) / res;

    float t00 = textureLod(tex, vec2(o0.x, o0.y), 0.0).r;
    float t10 = textureLod(tex, vec2(o1.x, o0.y), 0.0).r;
    float t01 = textureLod(tex, vec2(o0.x, o1.y), 0.0).r;
    float t11 = textureLod(tex, vec2(o1.x, o1.y), 0.0).r;

    return mix(mix(t00, t10, s1.x), mix(t01, t11, s1.x), s1.y);
}

/// World XZ → height-texture UV.
vec2 worldToHeightUV(vec2 p, vec2 origin, float size) {
    return (p - origin) / size;
}

struct ClipmapVertex {
    vec2 worldXZ;
    float spacing;   // this vertex's effective sample spacing, post-morph
    float morph;
};

/// Place a clipmap vertex in world space.
///
/// `grid` is the vertex's integer position within its ring, in [-N/2, N/2].
/// `level` is the ring index; spacing doubles each level.
ClipmapVertex placeClipmapVertex(
    vec2 grid,
    float level,
    vec2 camXZ,
    float baseSpacing,
    float gridHalfN
) {
    float spacing = baseSpacing * exp2(level);

    // Snap the ring origin to twice this level's spacing. Twice, not once, so
    // that the parity of the lattice is stable — snapping to 1x would let the
    // morph targets flip between frames and the surface would shimmer.
    float snap = spacing * 2.0;
    vec2 origin = floor(camXZ / snap) * snap;

    vec2 local = grid * spacing;

    // ---- morph toward the coarser lattice --------------------------------
    // Chebyshev distance, because the rings are square. Normalised so 1.0 is
    // the ring's outer edge.
    float extent = gridHalfN * spacing;
    float cheb = max(abs(local.x), abs(local.y)) / extent;

    // Completes at 0.86, comfortably before the overlap band where this ring
    // and the next coarser one both draw.
    float morph = clamp((cheb - 0.70) / 0.16, 0.0, 1.0);

    // The coarse lattice is every second vertex of this one.
    vec2 coarseGrid = floor(grid * 0.5) * 2.0;
    vec2 coarseLocal = coarseGrid * spacing;
    local = mix(local, coarseLocal, morph);

    ClipmapVertex outv;
    outv.worldXZ = origin + local;
    outv.spacing = spacing * (1.0 + morph);
    outv.morph = morph;
    return outv;
}
