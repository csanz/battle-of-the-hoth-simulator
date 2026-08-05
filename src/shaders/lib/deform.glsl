// -----------------------------------------------------------------------------
// snowDeform — the read side of the terrain state buffer.
//
// Three consumers sample this: the snow vertex shader (displacement), the shadow
// depth vertex shader (so carved snow casts its own shadow), and the snow
// fragment shader (normals and surface state). They must agree exactly — if the
// depth pass placed a vertex a centimetre off the beauty pass, the trail would
// acne against its own floor. Hence one include rather than three copies.
//
// Addressing is toroidal. The buffer is never scrolled or copied; the window
// simply re-interprets which world position each texel stands for, so the UV is
// just the world position wrapped into one window.
// -----------------------------------------------------------------------------

/// World XZ → deformation-buffer UV. The sampler must be in wrap mode.
vec2 deformUV(vec2 worldXZ, float size) {
    return fract(worldXZ / size);
}

/// How much of the buffer's authority applies here, 0..1.
///
/// Faded rather than cut: the window edge is a straight line ~32 m from the
/// player, and a hard cutoff there would drag a visible seam across the field
/// every time the player moved. The fade completes before the toroidal seam, so
/// the wrapped-around content is never visible at any weight.
float deformFalloff(vec2 worldXZ, vec2 centre, float size) {
    vec2 d = abs(worldXZ - centre) / (size * 0.5);
    return 1.0 - smoothstep(0.80, 0.96, max(d.x, d.y));
}

/// Net height offset in metres: piled mass minus depression, band-limited to
/// what a lattice of `spacing` metres can actually carry.
///
/// The filter is not optional polish — without it the surf groove tears itself
/// into a row of triangular peaks. The clipmap rings are centred on the *camera*,
/// so orbiting or zooming slides a ring boundary across a stationary trail: the
/// same patch of snow gets re-sampled from 0.085 m spacing to 0.34 m, and a
/// 0.6 m-wide groove with a narrower berm crest ends up with less than one vertex
/// across its ridge. Each triangle then spans the whole berm and the ridge
/// collapses into facets that swim as the camera moves. Fading the displacement
/// out with distance hides it but also deletes the trail; filtering fixes it.
///
/// A separable 3x3 binomial with taps one `spacing` apart puts the filter's first
/// zero exactly at the lattice Nyquist (wavelength 2 x spacing), so content the
/// vertices cannot represent is removed rather than aliased, while a broad trench
/// at 8 x spacing still passes at 85%. Because `spacing` is continuous through
/// the CDLOD morph, so is the filter — two rings meeting at a shared vertex
/// compute the same width and the same height, and the mesh stays crack-free.
///
/// Cost is close to free in practice: the whole clipmap is 870 m across and the
/// deformation window is 80 m, so the falloff test rejects the overwhelming
/// majority of vertices before a single fetch.
float deformHeight(
    sampler2D tex,
    vec2 worldXZ, vec2 centre, float size, float scale, float spacing
) {
    float w = deformFalloff(worldXZ, centre, size);
    if (w <= 0.0) { return 0.0; }

    vec2 base = deformUV(worldXZ, size);
    float r = spacing / size; // tap offset, in UV

    float acc = 0.0;
    for (int j = -1; j <= 1; j++) {
        for (int i = -1; i <= 1; i++) {
            // Binomial [1,2,1] x [1,2,1] / 16.
            float wt = float((2 - abs(i)) * (2 - abs(j))) * (1.0 / 16.0);
            vec2 uv = base + vec2(float(i), float(j)) * r;
            vec4 s = textureLod(tex, uv, 0.0);
            acc += (s.g - s.r) * wt;
        }
    }
    return acc * scale * w;
}
