// -----------------------------------------------------------------------------
// charSkin — the character's shared vertex-side transform library.
//
// Everything the character needs to place a vertex comes out of one small
// RGBA32F texture, uploaded once per frame:
//
//   rows 0-3   bone skinning matrices. Column = bone index, row = matrix column,
//              so texel (b, c) is column c of bone b's `world * inverseBind`.
//   rows 4+    simulated cloth node positions, one rectangle per garment panel.
//
// A texture rather than uniform arrays, for the same reason the deformation
// brushes are a texture: it sidesteps uniform-array packing entirely, it has no
// awkward size ceiling, and it is one small upload per frame either way.
//
// The beauty pass and both shadow cascades include this file, so the surface
// they place is the same surface by construction — the mistake the terrain
// already paid for once.
// -----------------------------------------------------------------------------

/// Skin a point by one bone.
vec3 skinPoint1(sampler2D tex, int b, vec3 p) {
    vec4 c0 = texelFetch(tex, ivec2(b, 0), 0);
    vec4 c1 = texelFetch(tex, ivec2(b, 1), 0);
    vec4 c2 = texelFetch(tex, ivec2(b, 2), 0);
    vec4 c3 = texelFetch(tex, ivec2(b, 3), 0);
    return c0.xyz * p.x + c1.xyz * p.y + c2.xyz * p.z + c3.xyz;
}

/// Skin a direction by one bone (no translation).
vec3 skinDir1(sampler2D tex, int b, vec3 d) {
    vec4 c0 = texelFetch(tex, ivec2(b, 0), 0);
    vec4 c1 = texelFetch(tex, ivec2(b, 1), 0);
    vec4 c2 = texelFetch(tex, ivec2(b, 2), 0);
    return c0.xyz * d.x + c1.xyz * d.y + c2.xyz * d.z;
}

/// Two-influence linear blend skinning. Two is enough for a figure whose only
/// hard joints are elbows and knees; the garments that need more are simulated.
vec3 skinPoint(sampler2D tex, vec4 idx, vec4 wt, vec3 p) {
    vec3 r = skinPoint1(tex, int(idx.x), p) * wt.x;
    if (wt.y > 0.0001) { r += skinPoint1(tex, int(idx.y), p) * wt.y; }
    return r / max(1e-4, wt.x + wt.y);
}

vec3 skinNormal(sampler2D tex, vec4 idx, vec4 wt, vec3 n) {
    vec3 r = skinDir1(tex, int(idx.x), n) * wt.x;
    if (wt.y > 0.0001) { r += skinDir1(tex, int(idx.y), n) * wt.y; }
    return normalize(r);
}

// ------------------------------------------------------------- cloth sampling

/// One simulated node. `u` wraps — every garment is a closed tube — and `v`
/// clamps, because the top and bottom edges are real boundaries.
vec3 clothNode(sampler2D tex, int rowBase, int cols, int rows, int i, int j) {
    // WGSL's `%` truncates, so the source's `(i % cols + cols) % cols` is
    // well-defined for i = -1; GLSL ES 3.0 leaves `%` undefined for negative
    // operands, so keep every operand non-negative instead. sampleCloth only
    // ever passes i >= -1, so i + cols >= 0 and the wrap is identical.
    int ii = (i + cols) % cols;
    int jj = clamp(j, 0, rows - 1);
    return texelFetch(tex, ivec2(ii, rowBase + jj), 0).xyz;
}

/// Catmull-Rom basis and its derivative.
vec4 crBasis(float t) {
    float t2 = t * t;
    float t3 = t2 * t;
    return vec4(
        0.5 * (-t3 + 2.0 * t2 - t),
        0.5 * (3.0 * t3 - 5.0 * t2 + 2.0),
        0.5 * (-3.0 * t3 + 4.0 * t2 + t),
        0.5 * (t3 - t2)
    );
}

vec4 crDeriv(float t) {
    float t2 = t * t;
    return vec4(
        0.5 * (-3.0 * t2 + 4.0 * t - 1.0),
        0.5 * (9.0 * t2 - 10.0 * t),
        0.5 * (-9.0 * t2 + 8.0 * t + 1.0),
        0.5 * (3.0 * t2 - 2.0 * t)
    );
}

struct ClothSample {
    vec3 pos;
    vec3 nrm;
    vec3 tanU;
};

/// Reconstruct a smooth garment surface from its simulated grid.
///
/// This is the whole reason the solver can afford to be twenty by twelve: the
/// interpolant is C1, so a coarse grid renders without a single visible facet,
/// and the tangents fall out of the same sixteen taps as the position — no
/// finite differences, no second sampling pass, and normals that are exactly
/// consistent with the surface being drawn.
ClothSample sampleCloth(
    sampler2D tex,
    int rowBase, int cols, int rows,
    float u, float v
) {
    float gu = u * float(cols);
    float gv = v * float(rows - 1);
    float fu = floor(gu);
    float fv = floor(gv);
    int i0 = int(fu) - 1;
    int j0 = int(fv) - 1;

    vec4 wu = crBasis(gu - fu);
    vec4 du = crDeriv(gu - fu);
    vec4 wv = crBasis(gv - fv);
    vec4 dv = crDeriv(gv - fv);

    vec3 p = vec3(0.0);
    vec3 pu = vec3(0.0);
    vec3 pv = vec3(0.0);

    for (int j = 0; j < 4; j++) {
        vec3 rowP = vec3(0.0);
        vec3 rowD = vec3(0.0);
        for (int i = 0; i < 4; i++) {
            vec3 q = clothNode(tex, rowBase, cols, rows, i0 + i, j0 + j);
            rowP += q * wu[i];
            rowD += q * du[i];
        }
        p += rowP * wv[j];
        pu += rowD * wv[j];
        pv += rowP * dv[j];
    }

    ClothSample res;
    res.pos = p;
    // Ordered so the result points away from the body: u runs anticlockwise
    // around the tube and v runs down it.
    res.nrm = normalize(cross(pv, pu));
    res.tanU = normalize(pu);
    return res;
}
