// -----------------------------------------------------------------------------
// snowRidge — the far-field mountains.
//
// The constraint is that the range must never read as flat, and that is what
// rules out the two cheap answers. A silhouette cut out of the sky reads as a
// sticker. A band
// of noise shaded by its own azimuth gradient reads as corrugated cardboard,
// because a ridge's *form* comes from slopes facing toward and away from the sun,
// and a one-dimensional profile has no such thing.
//
// So this raymarches an actual two-dimensional heightfield, on the skybox, in
// world space. It costs nothing in geometry, it is behind everything by
// construction, and because the field is real:
//
//   * ridges occlude other ridges, so the range has depth rather than a single
//     outline;
//   * the normal is analytic, so faces light and shade correctly against the low
//     sun;
//   * a short second march toward the sun gives the range its own cast shadows,
//     which is most of what makes a mountain read as a solid rather than a
//     gradient;
//   * extinction is integrated per pixel over the true distance, so nearer
//     massifs sit in front of hazier ones without any hand-placed layers.
//
// It is confined to a narrow band of view directions around the horizon and
// early-outs above the tallest possible peak, so it touches a few per cent of the
// frame.
//
// Distances are in metres. The range sits from 9 km to 45 km, well beyond the
// 870 m clipmap, so nothing here can ever intersect the terrain.
// -----------------------------------------------------------------------------

/// Tallest a peak can be, metres. The march's early-out depends on this being a
/// true bound, so it is derived from the amplitude rather than guessed.
float ridgeCeiling(float amp) {
    return amp * 1.05;
}

/// Height of the range at a world XZ, in metres, with its analytic gradient.
/// Returns vec3(height, dH/dx, dH/dz).
///
/// Three layers, and the first one is the one that stops this reading as a wall:
/// a slow massif field decides *where there is a range at all*, so the horizon
/// gets massifs and gaps and long low saddles instead of an unbroken row of
/// triangles.
vec3 ridgeField(vec2 p, float amp) {
    // Kilometres. The whole range is authored at this scale.
    vec2 q = p * 0.001;
    float kq = 0.001;

    // ---- the bowl ----------------------------------------------------------
    // The range is excluded from a seven-kilometre disc centred on the world
    // origin, and the player is confined to a 620 m play radius inside it — so
    // the field is guaranteed to be empty everywhere the march begins.
    //
    // This is not decoration, it is what makes the march correct. Without it a
    // massif can start closer than the near plane, the ray begins *inside* the
    // rock, and every such ray gets clamped to the same distance — which draws
    // the near faces of those massifs as flat-topped vertical slabs at exactly
    // the near plane. They looked like buildings on the horizon.
    float rad = length(p);
    float bt = clamp((rad - 7000.0) / 6000.0, 0.0, 1.0);
    float bowl = bt * bt * (3.0 - 2.0 * bt);
    if (bowl <= 0.0) { return vec3(0.0); }
    vec2 dbowl = (bt > 0.0 && bt < 1.0)
        ? (p / max(rad, 1.0)) * (6.0 * bt * (1.0 - bt) / 6000.0)
        : vec2(0.0);

    // ---- where there is a range at all ------------------------------------
    vec3 massif = fbmd(q * 0.10 + vec2(11.3, 4.7), 2, 2.13, 0.52);
    float mk = 0.10 * kq;
    float t = clamp((massif.x + 0.34) / 0.70, 0.0, 1.0);
    float env = t * t * (3.0 - 2.0 * t);
    // d(smoothstep)/dx = 6t(1-t)/width, chained through the massif's own slope.
    vec2 denv = (t > 0.0 && t < 1.0)
        ? massif.yz * mk * (6.0 * t * (1.0 - t) / 0.62)
        : vec2(0.0);

    // ---- domain warp -------------------------------------------------------
    // The single largest difference between "ridged noise" and "mountains".
    //
    // An unwarped ridged field runs its crests in straight, roughly parallel
    // lines, because the lattice underneath it does — and the eye reads that as
    // procedural immediately, however many octaves are stacked on top. Displacing
    // the lookup by a slower noise makes every ridgeline curve, fork and run out
    // into a spur, which is what real ranges do.
    //
    // The height gradient below ignores this warp's Jacobian, so the normals are
    // rotated slightly against the true surface. On a matte 10-45 km away that is
    // not resolvable, and carrying the chain rule through two extra fields would
    // cost more than the shading error is worth.
    vec3 w1 = noised(q * 0.26 + vec2(2.7, 8.1));
    vec3 w2 = noised(q * 0.26 + vec2(19.4, 3.6));
    vec2 qw = q + vec2(w1.x, w2.x) * 1.35;

    // ---- the peaks ---------------------------------------------------------
    // Four octaves, not three. At three the lowest octave dominates and the
    // range reads as smooth meringue mounds: no crest line anywhere, and a
    // mountain without a crest line has no scale.
    vec3 r = ridgedd(qw * 0.30, 4, 2.09, 0.50);
    float rk = 0.30 * kq;
    // A second, finer set at a different phase. One ridged stack alone gives
    // every peak the same profile; two at incommensurate scales does not.
    vec3 s = ridgedd(qw * 1.05 + vec2(31.0, 17.0), 3, 2.11, 0.50);
    float sk = 1.05 * kq;

    float raw = r.x * 0.78 + s.x * 0.22;
    vec2 draw = r.yz * (0.78 * rk) + s.yz * (0.22 * sk);

    // Sharpen the crests and widen the valleys. Ridged noise squares its ridge
    // term, which rounds the top and is right for sastrugi; a mountain wants the
    // opposite bias. Chain-ruled so the normals follow.
    float peaks = raw * raw * raw * 0.55 + raw * 0.45;
    vec2 dpeaks = draw * (3.0 * raw * raw * 0.55 + 0.45);

    // A *small* floor under the envelope: low foothills in the gaps between
    // massifs rather than absolute nothing, which reads as a cut-out.
    //
    // Small is the operative word. At 0.22 this was a continuous four-hundred
    // metre barrier at the near edge of the range, and since every ray at the
    // horizon meets it immediately, the result was a flat-topped vertical wall
    // wrapped right around the field. The gaps have to genuinely open, or rays
    // can never reach the massifs behind them and the range has no depth at all.
    float e = 0.06 + 0.94 * env;
    float h = peaks * e;
    vec2 dh = dpeaks * e + peaks * denv * 0.94;
    return vec3(
        h * bowl * amp,
        (dh * bowl + h * dbowl) * amp
    );
}

/// Earth curvature drop at a horizontal distance, metres. Small at these ranges
/// — 50 m at 25 km — but it is what sinks the farthest massifs' feet below the
/// horizon and lets the near ones stand in front of them.
float ridgeDrop(float d) {
    return d * d / 12742000.0;
}

struct RidgeHit {
    bool hit;
    float dist;     // horizontal metres to the hit
    float height;   // world Y of the surface there
    vec3 normal;
    vec2 pos;       // world XZ of the hit
};

/// March the range along a view ray.
///
/// Steps grow geometrically, which is the right distribution for a field whose
/// features subtend a roughly constant angle: a fixed step wastes most of its
/// samples in the far half where a kilometre is a pixel.
RidgeHit ridgeMarch(vec3 camPos, vec3 dir, float amp) {
    RidgeHit outv;
    outv.hit = false;
    outv.dist = 0.0;
    outv.height = 0.0;
    outv.normal = vec3(0.0, 1.0, 0.0);
    outv.pos = vec2(0.0);

    float hl = length(dir.xz);
    if (hl < 1e-4) { return outv; }

    vec2 step2 = dir.xz / hl;
    float slope = dir.y / hl;        // metres of rise per metre of ground

    // Where the range starts.
    //
    // Set by how large a massif should read, not by taste: a 1.8 km peak at
    // 9 km subtends 11 degrees, which is about what a real range does across a
    // frame. At 3.8 km the same peak subtends 26 and fills the sky.
    const float D_NEAR = 5500.0;
    const float D_FAR = 45000.0;
    const int STEPS = 18;

    // A ray already above the tallest possible peak and still climbing can never
    // hit. This is the branch the sky above the range takes, and it is why the
    // whole effect costs a few per cent of the frame.
    float ceiling = ridgeCeiling(amp);
    if (camPos.y + slope * D_NEAR > ceiling && slope >= 0.0) { return outv; }

    float growth = pow(D_FAR / D_NEAR, 1.0 / float(STEPS));

    // Prime the crossing state from a real sample rather than a constant.
    //
    // A ray at the horizon meets the near face of a massif on the *first* step,
    // and with `prevGap` initialised to a made-up 1.0 the interpolation below
    // returned a distance somewhere between the near plane and nothing in
    // particular. It showed up as vertical striping down the whole range, which
    // looks like a shading bug and is arithmetic.
    float prevD = D_NEAR;
    float prevGap = camPos.y + slope * D_NEAR
                  - (ridgeField(camPos.xz + step2 * D_NEAR, amp).x - ridgeDrop(D_NEAR));

    if (prevGap < 0.0) {
        // Started inside the near face. That is a legitimate hit, at D_NEAR.
        outv.dist = D_NEAR;
        outv.pos = camPos.xz + step2 * D_NEAR;
        vec3 f = ridgeField(outv.pos, amp);
        outv.height = f.x - ridgeDrop(D_NEAR);
        outv.normal = normalize(vec3(-f.y, 1.0, -f.z));
        outv.hit = true;
        return outv;
    }

    float d = D_NEAR * growth;

    for (int i = 1; i < STEPS; i++) {
        vec2 p = camPos.xz + step2 * d;
        float h = ridgeField(p, amp).x - ridgeDrop(d);
        float rayY = camPos.y + slope * d;
        float gap = rayY - h;

        if (gap < 0.0) {
            // Interpolate the crossing rather than accepting the step. At 12%
            // growth a step is hundreds of metres wide out here, and taking its
            // far end would quantise every silhouette into visible terraces.
            float t = 0.5;
            if (prevGap - gap > 1e-5) { t = prevGap / (prevGap - gap); }
            outv.dist = mix(prevD, d, clamp(t, 0.0, 1.0));
            outv.pos = camPos.xz + step2 * outv.dist;

            vec3 f = ridgeField(outv.pos, amp);
            outv.height = f.x - ridgeDrop(outv.dist);
            outv.normal = normalize(vec3(-f.y, 1.0, -f.z));
            outv.hit = true;
            return outv;
        }

        // Climbed clear of the tallest possible peak: nothing ahead can be hit.
        // This is what stops rays that pass over the range from paying for the
        // whole march.
        if (rayY > ceiling && slope > 0.0) { return outv; }

        prevGap = gap;
        prevD = d;
        d *= growth;
    }

    return outv;
}

/// Fraction of the sun reaching a point on the range, 0 or 1, marched along the
/// sun direction.
///
/// Four steps and a hard result. A soft edge would cost four times the samples to
/// describe a penumbra that, at twenty kilometres, is a fraction of a pixel — and
/// what this term is actually for is the large-scale read of which flank of a
/// massif is in the shade of the one in front of it.
float ridgeShadow(vec2 pos, float height, vec3 sunDir, float amp) {
    float hl = length(sunDir.xz);
    if (hl < 1e-3 || sunDir.y <= 0.0) { return 1.0; }

    vec2 step2 = sunDir.xz / hl;
    float slope = sunDir.y / hl;

    float d = 420.0;
    for (int i = 0; i < 4; i++) {
        float h = ridgeField(pos + step2 * d, amp).x;
        if (h > height + slope * d) { return 0.0; }
        d *= 2.6;
    }
    return 1.0;
}
