// -----------------------------------------------------------------------------
// snowWake — the shape of the snow-surf wake.
//
// Shared by the beauty pass, the depth pass and the fragment erosion, for the
// same reason `snowDeform` is shared: three copies of a surface definition will
// eventually disagree, and the symptom — a shadow that is not quite the shape of
// the thing casting it — is both subtle and impossible to attribute.
//
// The wake is a swept surface. Its spine is the path the board has taken,
// resampled every ~0.3 m into a small data texture; its cross-section is a
// breaking wave, integrated here from a turning tangent rather than authored as
// a spline, so a single `curl` parameter takes it continuously from a low heaped
// berm to a fully overhanging plunging lip.
//
// Spine texture layout, one column per sample, column 0 = the bow:
//
//   row 0   (x, y, z, distance behind the bow, metres)
//   row 1   (rightX, rightZ, amplitude left, amplitude right)
//   row 2   (curl left, curl right, age 0..1, unused)
//
// Amplitude and curl are resolved per side on the CPU, because which side of the
// board is the *outside* of the turn is a question about the carve, not about
// geometry, and the answer is one number that both sides need.
//
// Requires <snowNoise> (for `noise2`) to be included by the enclosing shader
// before this chunk.
// -----------------------------------------------------------------------------

/// Steps in the cross-section integral. Twenty is well past the point where the
/// midpoint rule stops mattering on a curve this smooth, and the cost is a
/// rounding error against the vertex count.
const int WAKE_STEPS = 20;

/// Normalises the integral so the crest lands near 1.0, which is what lets
/// amplitude be one number in metres rather than a per-curl table. It is not
/// exact across the curl range on purpose — a mild bank comes out a little taller
/// and much wider than a plunging one, which is what a mild bank does.
const float WAKE_NORM = 3.35;

/// The section is squashed across, not scaled uniformly.
///
/// Left to its own proportions the curve is wider than it is tall, and at 2.4 m
/// of amplitude that is a three-metre-wide ramp: legible as terrain, not as
/// something thrown. Steepening it is the difference between a bank and a wave.
const float WAKE_LATERAL = 0.70;

/// Cross-section of a breaking wave, in (lateral, up), unit height.
///
/// The curve is defined by its *tangent angle* rather than by its position: the
/// tangent sweeps from just below horizontal at the base, through vertical
/// partway up the face, to well past 180 degrees at the tip — so the lip hangs
/// back over the face it came off, which is the whole read of a breaking wave and
/// is not something a heightfield can express at all.
///
/// At `curl` = 1 the sweep reaches 284 degrees: the tip sits at 47% of the
/// crest's lateral offset and 65% of its height, so it genuinely overhangs.
/// Stop short of ~270 and the tip is still outboard of the crest, which reads
/// as a rounded ridge.
///
/// The 1.65 exponent puts most of the arc length into the face and compresses the
/// hook into the last fifth. A linear sweep gives a circle, which reads as a
/// rolled tube of snow rather than as something thrown.
vec2 wakeSection(float q, float curl) {
    float th0 = -0.24;                   // base flares outward and slightly down
    float th1 = 1.65 + curl * 3.30;      // 95 deg (heap) .. 284 deg (plunging)
    vec2 p = vec2(0.0, 0.0);
    float dt = q / float(WAKE_STEPS);
    for (int i = 0; i < WAKE_STEPS; i++) {
        float t = (float(i) + 0.5) * dt;
        float th = th0 + (th1 - th0) * pow(t, 1.65);
        // The section thins as it climbs, so the lip is fine and the base broad.
        p += vec2(cos(th), sin(th)) * (1.0 - 0.40 * t) * dt;
    }
    return vec2(p.x * WAKE_LATERAL, p.y) * WAKE_NORM;
}

/// Per-side scalars at spine parameter `u`, interpolated with a smoothstep
/// weight rather than linearly.
///
/// The samples are 0.3 m apart and the amplitude envelope changes by a couple of
/// percent between them, which a linear blend turns into a C0 kink — invisible in
/// the silhouette, plainly visible as a band every 0.3 m once a normal is
/// differenced out of it. Smoothstep costs one multiply and makes the field C1.
///
/// Returns (amplitude m, curl, distance behind bow m, age 0..1).
vec4 wakeScalars(highp sampler2D tex, float count, float u, float side) {
    float n = max(count, 2.0);
    float f = clamp(u, 0.0, 1.0) * (n - 1.0);
    int i1 = int(floor(f));
    int i2 = min(i1 + 1, int(n) - 1);
    float s = smoothstep(0.0, 1.0, f - float(i1));

    vec4 b1 = texelFetch(tex, ivec2(i1, 1), 0);
    vec4 b2 = texelFetch(tex, ivec2(i2, 1), 0);
    vec4 c1 = texelFetch(tex, ivec2(i1, 2), 0);
    vec4 c2 = texelFetch(tex, ivec2(i2, 2), 0);
    float d1 = texelFetch(tex, ivec2(i1, 0), 0).w;
    float d2 = texelFetch(tex, ivec2(i2, 0), 0).w;

    bool left = side < 0.0;
    float amp = left ? mix(b1.z, b2.z, s) : mix(b1.w, b2.w, s);
    float curl = left ? mix(c1.x, c2.x, s) : mix(c1.y, c2.y, s);
    return vec4(amp, curl, mix(d1, d2, s), mix(c1.z, c2.z, s));
}

/// Spine position at `u`, Catmull-Rom through the samples.
///
/// Linear would be geometrically fine — at 19.5 m/s and the controller's turn
/// rate the sagitta over one 0.3 m segment is 1.4 mm — but the surface normal is
/// differenced out of this, and a piecewise-linear spine gives a piecewise
/// constant tangent, which bands the crest highlight at exactly the sample pitch.
vec3 wakeSpine(highp sampler2D tex, float count, float u) {
    float n = max(count, 2.0);
    float f = clamp(u, 0.0, 1.0) * (n - 1.0);
    int i1 = int(floor(f));
    float fr = f - float(i1);
    int last = int(n) - 1;

    vec3 p0 = texelFetch(tex, ivec2(max(i1 - 1, 0), 0), 0).xyz;
    vec3 p1 = texelFetch(tex, ivec2(i1, 0), 0).xyz;
    vec3 p2 = texelFetch(tex, ivec2(min(i1 + 1, last), 0), 0).xyz;
    vec3 p3 = texelFetch(tex, ivec2(min(i1 + 2, last), 0), 0).xyz;

    float t2 = fr * fr;
    float t3 = t2 * fr;
    return 0.5 * (
        (2.0 * p1)
        + (-p0 + p2) * fr
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * t2
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * t3
    );
}

/// The wake surface. `u` runs 0 (bow) to 1 (tail), `q` runs 0 (base, against the
/// trench) to 1 (tip of the lip), `side` is -1 or +1.
vec3 wakePoint(highp sampler2D tex, float count, float u, float q, float side, float t) {
    vec4 sc = wakeScalars(tex, count, u, side);
    vec3 pos = wakeSpine(tex, count, u);

    int i1 = int(clamp(u, 0.0, 1.0) * (max(count, 2.0) - 1.0));
    vec2 rgt2 = normalize(texelFetch(tex, ivec2(i1, 1), 0).xy);
    vec3 rgt = vec3(rgt2.x, 0.0, rgt2.y);
    vec3 fwd = vec3(-rgt2.y, 0.0, rgt2.x);

    vec2 sec = wakeSection(q, sc.y);

    // The two walls start close together at the bow and spread behind it, which
    // is what makes the pair read as a bow wave splitting around the board
    // rather than as two unrelated banks.
    // The base has to clear the berm the groove brush throws at 0.45-0.6 m, or
    // the wall grows out of the inside of its own trench and the first third of
    // it is buried.
    float l0 = 0.24 + 0.44 * smoothstep(0.3, 2.6, sc.z);

    // Thrown snow is not a ruled surface. A lump field displaced along the
    // section's own normal breaks the sweep up into gathered mass, and because it
    // is applied *here* rather than in the fragment shader, the vertex normal —
    // which is differenced out of this function — picks it up for free, and so
    // does the shadow the wake casts.
    //
    // Two octaves at incommensurate frequencies, and both vary up the face as
    // well as along the spine. A single octave keyed only on distance puts one
    // bump per noise cell in a dead straight line — 0.37 m apart, at the same
    // height, all the way down the wake — and the wall comes out looking like a
    // caterpillar. Weighted toward the crest, because the base is held in place
    // by the ground and it is the top that is free to gather.
    float thq = -0.24 + (1.89 + sc.y * 3.30) * pow(q, 1.65);
    vec2 secN = vec2(-sin(thq), cos(thq));
    // Unit scale, like `sec` — both are taken into metres by the same amplitude.
    // Drifting, for the same reason the erosion does: a static lump field on a
    // moving wall is the surface equivalent of a painted-on texture.
    float lump = (noise2(vec2(sc.z * 1.13 + q * 0.9 + side * 17.3, q * 1.7 + 5.1 + t * 0.30)) * 0.55
              + noise2(vec2(sc.z * 3.31 - q * 1.7 + side * 31.7 - t * 0.45, q * 4.3 + 2.7)) * 0.30
              + noise2(vec2(sc.z * 8.7 + side * 5.3, q * 9.1 + t * 0.9)) * 0.15)
             * 0.085 * smoothstep(0.12, 0.72, q);

    float lat = l0 + (sec.x + secN.x * WAKE_LATERAL * lump) * sc.x;

    // Thrown snow lags the thing that threw it, so the lip trails backward along
    // the spine. Shear rather than offset: the surface stays connected.
    float along = -q * q * 0.34 * sc.x;

    // Sunk, because the base has to meet a trench floor and a berm crest that the
    // spine's recorded ground height knows nothing about.
    return pos
        + rgt * (side * lat)
        + vec3(0.0, (sec.y + secN.y * lump) * sc.x - 0.10, 0.0)
        + fwd * along;
}

/// True where the wake has broken up into airborne powder and there is no
/// surface left to draw.
///
/// Two jobs, and only two:
///
///   1. Soften the very top edge, so the lip is not a clean cut across a tube.
///      A narrow band — the top sixth of the section — and lightly.
///   2. Dissolve the whole wall at the end of its life, so it goes to powder
///      rather than shrinking back into the ground or popping out.
///
/// Deliberately not a third: tearing the top *half* of the wall into chunks
/// reads as a breaking wave in a still frame and as a mesh with holes in it in
/// motion. Breakup is the plume's job — snow leaving a crest is airborne, and
/// airborne snow is particles, not geometry with bites out of it.
///
/// Called identically from the depth pass, or the wake would cast the shadow of
/// a surface it is not drawing.
bool wakeEroded(float alongDist, float q, float age01, float t) {
    float brk = smoothstep(0.84, 1.06, q) * mix(0.34, 0.70, age01)
            + smoothstep(0.68, 1.0, age01) * 0.95;
    if (brk <= 0.001) { return false; }
    // Thirteen cells across the section, not four and a half: any coarser in `q`
    // and the noise is effectively one-dimensional, so the holes come out as a
    // row of vertical slots — a comb, not a breakup.
    // 0.72 rather than 0.5 because gradient noise only reaches about +/-0.7, and
    // a threshold that never sees the ends of the range erodes evenly instead of
    // tearing.
    //
    // Both octaves are sheared off the axes. Gradient noise has its cell walls
    // aligned to its input, so sampling it on (distance, section) directly tears
    // the crest into little axis-aligned rectangles — legible as a grid the
    // moment the wave is more than a few metres long.
    //
    // And both drift with time, in opposite directions.
    //
    // A crest torn by a field that is a pure function of position is a crest full
    // of chunks that are permanently about to fall off and never do. The eye
    // reads that as a still image pasted onto a moving object, and it was the
    // single most artificial thing about the first version. Counter-drifting the
    // two octaves makes their sum boil rather than scroll: holes open, close and
    // migrate, so the lip is continuously coming apart. Roughly three cell
    // crossings a second on the fine octave, one on the coarse — fast enough to
    // read as disintegration, slow enough not to strobe.
    vec2 p = vec2(alongDist, q);
    float a = noise2(vec2(
        p.x * 6.9 + p.y * 3.1 + t * 0.9,
        p.y * 13.0 - p.x * 2.2 - t * 0.6
    )) * 0.72 + 0.5;
    float b = noise2(vec2(
        p.x * 19.0 - p.y * 9.0 + 31.7 - t * 3.1,
        p.y * 31.0 + p.x * 7.0 + t * 2.3
    )) * 0.72 + 0.5;
    return (a * 0.58 + b * 0.42) < brk;
}
