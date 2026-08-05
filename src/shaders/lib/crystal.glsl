// -----------------------------------------------------------------------------
// snowCrystal — the shape of a grown ice formation.
//
// One crystal is a six-sided tapered prism with a point on it: a base ring
// sitting in the snow, a shoulder ring where the taper starts, and an apex. That
// is the whole model, and it is deliberately the whole model — the read comes
// from the *cluster*, from the light through it, and from the fact that it grows.
// A more elaborate single crystal costs vertices and buys nothing at the range
// this is seen from.
//
// Shared by the beauty pass and the shadow pass, for the same reason everything
// else here is: a formation whose shadow is a different shape from the formation
// is worse than no shadow at all.
//
// Data texture, three rows, one column per crystal:
//
//   row 0   (x, y, z, height m)
//   row 1   (axisX, axisY, axisZ, base radius m)
//   row 2   (growth 0..1, seed, tint, spare)
//
// `growth` is not a uniform scale. A crystal shoots up first and thickens after,
// the way real freezing does along the fastest-growing axis, so height and radius
// run on two different curves off the one parameter.
// -----------------------------------------------------------------------------

/// Vertices per crystal: two rings of six plus an apex.
const int CRYSTAL_RING = 6;
const int CRYSTAL_VERTS = 13;

/// Local position of vertex `v` of a crystal, in the crystal's own frame
/// (+Y along the growth axis).
///
/// The per-crystal `seed` breaks the hexagon: each of the six radial directions
/// gets its own length, so no two crystals in a cluster share a silhouette and
/// none of them is a regular hexagon — which reads as manufactured immediately.
vec3 crystalLocal(int v, float height, float radius, float seed) {
    if (v >= CRYSTAL_VERTS - 1) {
        // Apex, nudged off the axis so the point is not perfectly centred.
        vec2 j = hash22(vec2(seed, 7.31)) - 0.5;
        return vec3(j.x * radius * 0.5, height, j.y * radius * 0.5);
    }

    int ring = v / CRYSTAL_RING;          // 0 = base, 1 = shoulder
    int k = v - ring * CRYSTAL_RING;
    float ang = float(k) * 1.04719755 + seed * 6.2831853;   // 60 degrees apart
    float wob = 0.72 + 0.56 * hash21(vec2(float(k) + seed * 31.0, seed * 17.0));

    float r = ring == 1 ? radius * wob * 0.68 : radius * wob;
    float y = ring == 1 ? height * 0.58 : 0.0;
    return vec3(cos(ang) * r, y, sin(ang) * r);
}

/// World position of vertex `v` of crystal `i`.
vec3 crystalPoint(sampler2D tex, int i, int v) {
    vec4 a = texelFetch(tex, ivec2(i, 0), 0);
    vec4 b = texelFetch(tex, ivec2(i, 1), 0);
    vec4 c = texelFetch(tex, ivec2(i, 2), 0);

    float g = clamp(c.x, 0.0, 1.0);
    // Height leads, girth follows. A crystal that scales uniformly reads as a
    // model being lerped in; one that spears up and then thickens reads as ice
    // forming, because that is what ice does.
    float gh = g * g * (3.0 - 2.0 * g);
    float gr = smoothstep(0.25, 1.0, g);
    float height = a.w * gh;
    float radius = b.w * (0.22 + 0.78 * gr);

    vec3 local = crystalLocal(v, height, radius, c.y);

    // Frame from the growth axis. Any stable perpendicular will do; the shape is
    // already randomised about the axis by `seed`.
    vec3 axis = normalize(dot(b.xyz, b.xyz) < 1e-6 ? vec3(0.0, 1.0, 0.0) : b.xyz);
    vec3 ref2 = abs(axis.y) < 0.9 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 0.0, 1.0);
    vec3 ex = normalize(cross(ref2, axis));
    vec3 ez = cross(axis, ex);

    return a.xyz + ex * local.x + axis * local.y + ez * local.z;
}
