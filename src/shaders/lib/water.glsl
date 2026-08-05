// -----------------------------------------------------------------------------
// snowWater — the shape of a bent water body.
//
// Every spell that moves a coherent mass of water is one or more *strands*: a
// swept surface along a spine, exactly the construction the snow-surf wake uses,
// for exactly the same reason. Nothing is generated at runtime; the mesh is a
// static lattice of (column, ring, strand) and the vertex shader places every
// vertex from a small data texture. A ribbon nine metres long and a ribbon two
// metres long cost the same buffer and the same upload.
//
// Two properties this construction exists to produce:
//
//   * an unbroken arc with mass. Bent water is never a sheet of particles — it
//     is a body, with a leading edge, a trailing edge and a thickness you can
//     see through.
//   * momentum. It lags the hand that threw it and keeps going after the hand
//     stops, which falls out of the spine being a *record of where the head has
//     been* rather than a shape recomputed each frame.
//
// Data texture, three rows per strand (strand s occupies rows 3s..3s+2):
//
//   row 0   (x, y, z, radius m)
//   row 1   (rightX, rightY, rightZ, twist)  reference frame, parallel-transported
//   row 2   (distance along m, age 0..1, foam 0..1, flatten)
//
// `flatten` squashes the section vertically, which is what lets one strand be a
// round airborne tube at its head and a wide shallow sheet where it lies over the
// snow, with no second code path.
//
// Per-strand constants arrive as a uniform rather than in the texture, since
// they do not vary along the spine:
//
//   strandParams[s] = (profile, milkiness, alpha, column count)
//
// profile 0 is a closed tube, profile 1 is an open breaking sheet borrowed whole
// from the wake's own section integral — a crescent wave of slush and a carve's
// wall of snow are the same object at different scales, and there is no reason
// for two descriptions of it.
// -----------------------------------------------------------------------------

/// Fetch one texel of the strand table.
vec4 waterTexel(sampler2D tex, int row, int col) {
    return texelFetch(tex, ivec2(col, row), 0);
}

/// Interpolated row, Catmull-Rom through the samples.
///
/// Not linear, and not smoothstep either. Smoothstep is C1, which is why the
/// wake uses it, but its derivative is *zero at every knot*. Difference a normal
/// out of a surface whose radius is interpolated that way and the shading picks
/// up a ripple at exactly the sample pitch — one horizontal ring per spine
/// sample, so a column reads as a stack of discs.
///
/// Catmull-Rom is C1 as well and has no such flat spot: the tangent at a knot is
/// the chord through its neighbours, so the interpolant carries straight through
/// it. Same basis as the spine, so the two cannot disagree about `u`.
vec4 waterRow(sampler2D tex, int row, float count, float u) {
    float n = max(count, 2.0);
    float f = clamp(u, 0.0, 1.0) * (n - 1.0);
    int i1 = int(floor(f));
    float fr = f - float(i1);
    int last = int(n) - 1;

    vec4 p0 = waterTexel(tex, row, max(i1 - 1, 0));
    vec4 p1 = waterTexel(tex, row, i1);
    vec4 p2 = waterTexel(tex, row, min(i1 + 1, last));
    vec4 p3 = waterTexel(tex, row, min(i1 + 2, last));

    float t2 = fr * fr;
    float t3 = t2 * fr;
    return 0.5 * (
        (2.0 * p1)
        + (-p0 + p2) * fr
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    );
}

/// Spine position, Catmull-Rom through the samples.
///
/// A held ribbon is drawn as an arc through the air and read at two metres, so
/// the piecewise-linear spine a linear blend gives is not good enough: the
/// tangent is piecewise constant, and the specular highlight running along the
/// top of the tube bands at exactly the sample pitch.
vec3 waterSpine(sampler2D tex, int base, float count, float u) {
    float n = max(count, 2.0);
    float f = clamp(u, 0.0, 1.0) * (n - 1.0);
    int i1 = int(floor(f));
    float fr = f - float(i1);
    int last = int(n) - 1;

    vec3 p0 = waterTexel(tex, base, max(i1 - 1, 0)).xyz;
    vec3 p1 = waterTexel(tex, base, i1).xyz;
    vec3 p2 = waterTexel(tex, base, min(i1 + 1, last)).xyz;
    vec3 p3 = waterTexel(tex, base, min(i1 + 2, last)).xyz;

    float t2 = fr * fr;
    float t3 = t2 * fr;
    return 0.5 * (
        (2.0 * p1)
        + (-p0 + p2) * fr
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    );
}

/// Analytic tangent of the spine — the exact derivative of `waterSpine`.
///
/// Not a finite difference. Sampling the spline a fraction of a *knot spacing*
/// away gives a chord rather than a tangent, and the error in a chord depends on
/// where inside the knot span it starts — so the frame wobbles with a period of
/// exactly one spine sample, and sweeping that frame along a tube scallops it at
/// every knot.
///
/// Catmull-Rom's derivative is a quadratic in the local parameter and is
/// continuous across knots, so this has no such structure at all.
vec3 waterSpineTangent(sampler2D tex, int base, float count, float u) {
    float n = max(count, 2.0);
    float f = clamp(u, 0.0, 1.0) * (n - 1.0);
    int i1 = int(floor(f));
    float fr = f - float(i1);
    int last = int(n) - 1;

    vec3 p0 = waterTexel(tex, base, max(i1 - 1, 0)).xyz;
    vec3 p1 = waterTexel(tex, base, i1).xyz;
    vec3 p2 = waterTexel(tex, base, min(i1 + 1, last)).xyz;
    vec3 p3 = waterTexel(tex, base, min(i1 + 2, last)).xyz;

    vec3 d = 0.5 * (
        (-p0 + p2)
        + 2.0 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * fr
        + 3.0 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * fr * fr
    );
    float l = length(d);
    // Degenerate only where the spine has collapsed — the tail of a strand that
    // is being retired, and the frames right after a spell ends.
    return l > 1e-7 ? d / l : vec3(0.0, 1.0, 0.0);
}

/// Surface relief on the body of the water.
///
/// Water under this much acceleration is not smooth, and a perfectly smooth tube
/// is the single thing that gives a swept mesh away.
///
/// **The frequencies are in cycles per strand, not per metre.** The lattice
/// carries a fixed number of vertices along the spine and around the section
/// whatever the strand is doing, so what a displacement field is allowed to
/// contain is fixed in *parameter* space too. Keying it to world distance means
/// the frequency in samples depends on how long the strand happens to be, and a
/// six metre column at 13 cells per metre lands at half a sample per cell — far
/// past Nyquist, where the field does not produce fine detail, it produces a
/// beat. Same rule the terrain's `deformHeight` filter enforces against the
/// clipmap lattice, for the same reason.
///
/// Detail above this belongs in the fragment shader, where the sampling rate is
/// the pixel and not the vertex. It is there: two counter-drifting ripple
/// octaves on the normal.
///
/// The balance between the two axes is not free either. Gradient noise sampled
/// with a fast first coordinate and a slow second one is *nearly one-dimensional
/// in the first* — so relief that varies quickly along the spine and slowly
/// around the section produces a ring bulge at every cell, and a tube covered in
/// ring bulges is a string of beads. Water varies far more across a stream than
/// along one, so the section frequencies here are higher than the spine ones.
///
/// **Sampled around a circle, not along `theta`.** A tube is closed: the first
/// and last rings are the same point at theta and theta + 2*PI, and plain 2D
/// noise is not periodic, so feeding the angle in directly gives two different
/// answers there — a hairline crease running the whole length of every tube.
/// Walking a circle through the noise field instead makes the function periodic
/// by construction, the same trick the deformation brush uses for its rim
/// wobble.
///
/// The circle radii set how many features fit around the section: a radius-r
/// circle has a circumference of 2*PI*r noise cells, so 0.85 gives about five
/// and 1.5 about nine — four and a half vertices per feature at the coarse
/// scale, two and a half at the fine. The `u` offset slides the circle through
/// the field, which is what makes the pattern travel along the strand.
float waterRelief(float u, float theta, float t) {
    vec2 c = vec2(cos(theta), sin(theta));
    return noise2(c * 0.85 + vec2(u * 4.0 - t * 1.6, u * 2.3)) * 0.60
         + noise2(c * 1.50 + vec2(u * 7.5 + 11.3, -u * 5.1 - t * 3.1)) * 0.40;
}

/// The same field for an *open* section, where there is no seam to close and the
/// section parameter is a plain coordinate rather than an angle.
float waterReliefOpen(float u, float v, float t) {
    return noise2(vec2(u * 4.0 - t * 1.6, v * 2.60)) * 0.60
         + noise2(vec2(u * 7.5 - t * 3.1, v * 4.40 + 11.3)) * 0.40;
}

/// A point on the strand surface.
///
/// `u` runs 0 (head) to 1 (tail), `q` runs around the section (tube) or up the
/// face (sheet). Called from the vertex shader four times per vertex — once for
/// the position and three more for the differenced normal — which is still
/// cheaper than the spine fetch it shares.
vec3 waterPoint(
    sampler2D tex,
    int base,
    float count,
    float profile,
    float u,
    float q,
    float t
) {
    vec4 r0 = waterRow(tex, base, count, u);
    vec4 r1 = waterRow(tex, base + 1, count, u);
    vec4 r2 = waterRow(tex, base + 2, count, u);

    vec3 pos = waterSpine(tex, base, count, u);
    float radius = r0.w;
    float dist = r2.x;
    float flatten = max(r2.w, 0.02);

    // Exact spline tangent — see the note on `waterSpineTangent`. A finite
    // difference here is what scalloped every tube at its sample pitch.
    vec3 tangent = waterSpineTangent(tex, base, count, u);

    // The stored right vector is parallel-transported on the CPU, which is what
    // stops the section spinning as the spine curves. Re-orthogonalised here
    // because the interpolation between two transported frames does not preserve
    // the right angle exactly.
    vec3 rgt = r1.xyz - tangent * dot(r1.xyz, tangent);
    float rlen = length(rgt);
    rgt = rlen > 1e-5
        ? rgt / max(rlen, 1e-8)
        : normalize(cross(tangent, vec3(0.0, 0.0, 1.0)) + vec3(1e-5, 0.0, 0.0));
    vec3 up = cross(tangent, rgt);

    if (profile < 0.5) {
        // ---- closed tube --------------------------------------------------
        float theta = q * 6.28318530718 + r1.w;
        // Relief scaled by the radius, so a thin trailing wisp is not covered in
        // the same centimetre-scale lumps as a metre-wide column.
        float rel = waterRelief(clamp(u, 0.0, 1.0), theta, t);
        float rr = radius * (1.0 + rel * 0.22);
        return pos + rgt * (cos(theta) * rr) + up * (sin(theta) * rr * flatten);
    }

    // ---- open breaking sheet ----------------------------------------------
    // The wake's own section: a curve defined by its turning tangent, so `twist`
    // takes it continuously from a low heaped bank to a lip that hangs back over
    // its own face. `right` is the outward radial and the section stands in the
    // vertical plane containing it.
    vec2 sec = wakeSection(q, r1.w);
    float rel = waterReliefOpen(clamp(u, 0.0, 1.0), q * 3.0, t) * 0.13 * smoothstep(0.1, 0.7, q);
    return pos
        + rgt * ((sec.x + rel) * radius)
        + vec3(0.0, (sec.y + rel * 0.5) * radius * flatten, 0.0);
}
