// -----------------------------------------------------------------------------
// snowWalkerSkin — the walker's vertex-side transform library.
//
// Same idea as `snowCharSkin` and deliberately the same texture layout: column =
// bone, row = matrix column, so texel (b, 3) is the translation. The beauty
// pass, all three shadow cascades and the depth prepass include this file, so
// the surface they place is the same surface by construction.
//
// One texture holds the whole herd, four rows per machine, and `row0` picks the
// block. The alternative — a texture each — would be the same bytes in as many
// uploads as there are walkers, and this way the herd's entire pose crosses to
// the GPU once per frame however many of them are out there.
//
// Two differences from the character's.
//
// Four influences, not two. The character is a procedural figure whose only hard
// joints are elbows and knees; this is an imported rig where the neck alone
// carries seventeen hundred vertices weighted to three and four bones, and
// dropping to two puts a visible crease across it.
//
// One blended matrix, then two applications of it. The character skins its point
// and its normal through separate calls because it only ever touches two bones;
// here that would be thirty-two texture loads per vertex against sixteen, for
// exactly the same result — linear blend skinning is linear, so blending the
// matrices and transforming once is identical to transforming and blending.
//
// The matrices arrive already multiplied by the walker's world transform, so
// what comes out of here is world space. There is no model matrix anywhere in
// the walker's pipeline.
// -----------------------------------------------------------------------------

/// A blended affine transform: three basis columns and a translation.
struct WalkerXform {
    vec3 c0;
    vec3 c1;
    vec3 c2;
    vec3 c3;
};

WalkerXform walkerXform(highp sampler2D tex, int row0, vec4 idx, vec4 wt) {
    WalkerXform m;
    m.c0 = vec3(0.0);
    m.c1 = vec3(0.0);
    m.c2 = vec3(0.0);
    m.c3 = vec3(0.0);

    float total = 0.0;
    for (int k = 0; k < 4; k++) {
        float w = wt[k];
        if (w <= 0.0001) { continue; }
        int b = int(idx[k]);
        m.c0 += texelFetch(tex, ivec2(b, row0), 0).xyz * w;
        m.c1 += texelFetch(tex, ivec2(b, row0 + 1), 0).xyz * w;
        m.c2 += texelFetch(tex, ivec2(b, row0 + 2), 0).xyz * w;
        m.c3 += texelFetch(tex, ivec2(b, row0 + 3), 0).xyz * w;
        total += w;
    }

    // The weights are normalised in the bake, but a blend that lost a bone to
    // the epsilon above must still come back with unit gain or that vertex
    // collapses toward the origin.
    float inv = 1.0 / max(total, 1e-4);
    m.c0 *= inv; m.c1 *= inv; m.c2 *= inv; m.c3 *= inv;
    return m;
}

vec3 walkerPoint(WalkerXform m, vec3 p) {
    return m.c0 * p.x + m.c1 * p.y + m.c2 * p.z + m.c3;
}

vec3 walkerDir(WalkerXform m, vec3 d) {
    return normalize(m.c0 * d.x + m.c1 * d.y + m.c2 * d.z);
}
