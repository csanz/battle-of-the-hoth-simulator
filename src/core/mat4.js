/**
 * Flat-array 4x4 maths.
 *
 * The rigid-transform half is the source's `mat4.js`, byte for byte: the
 * character skeleton keeps its bone matrices, inverse binds and skinning
 * products in contiguous `Float32Array`s because the last of those is uploaded
 * to the GPU verbatim every frame.
 *
 * Layout matches Babylon's, which is also what GLSL wants: read as column-major,
 * elements 0-2 are the X axis, 4-6 the Y axis, 8-10 the Z axis and 12-14 the
 * translation, so `M * vec4(p, 1)` in a shader is the local-to-world transform.
 * `THREE.Matrix4.elements` shares this layout, so every helper here also
 * operates on `.elements` directly.
 *
 * The full-4x4 half is new to the port: this build hand-rolls the left-handed
 * view/projection matrices Babylon used to provide. All of them emit GL clip
 * space — z in [-1, +1] — NOT WebGPU's [0, 1].
 *
 * Every rigid function takes explicit array + offset. Nothing here allocates.
 */

/**
 * Write a rigid frame: three orthonormal axes and an origin.
 * @param {Float32Array} out @param {number} o element offset (16 per matrix)
 */
export function setFrame(out, o, px, py, pz, xx, xy, xz, yx, yy, yz, zx, zy, zz) {
    out[o] = xx; out[o + 1] = xy; out[o + 2] = xz; out[o + 3] = 0;
    out[o + 4] = yx; out[o + 5] = yy; out[o + 6] = yz; out[o + 7] = 0;
    out[o + 8] = zx; out[o + 9] = zy; out[o + 10] = zz; out[o + 11] = 0;
    out[o + 12] = px; out[o + 13] = py; out[o + 14] = pz; out[o + 15] = 1;
}

/**
 * Build a frame from a bone direction and a reference "front".
 *
 * `dir` becomes the local +Y axis — the convention throughout the rig is that a
 * bone's own axis runs from its joint toward its child, so a hanging arm has
 * +Y pointing at the floor. `ref` only has to be roughly perpendicular; it is
 * re-orthogonalised here, and swapped for a fallback when it is not.
 */
export function setFrameFromDir(out, o, px, py, pz, dx, dy, dz, rx, ry, rz) {
    let l = Math.hypot(dx, dy, dz) || 1;
    const yx = dx / l, yy = dy / l, yz = dz / l;

    // X = Y x ref, which is the axis both are perpendicular to.
    let ax = yy * rz - yz * ry;
    let ay = yz * rx - yx * rz;
    let az = yx * ry - yy * rx;
    l = Math.hypot(ax, ay, az);
    if (l < 1e-5) {
        // `ref` was parallel to the bone. Any perpendicular will do — cross
        // with world +X, which cannot also be parallel unless `ref` was zero.
        ax = 0 * yz - yy * 0;
        ay = yz * 1 - yx * 0;
        az = yx * 0 - yy * 1;
        l = Math.hypot(ax, ay, az) || 1;
    }
    ax /= l; ay /= l; az /= l;

    // Z = X x Y completes the basis. Babylon is left-handed with X right, Y up
    // and Z forward, and the plain cross product is exactly what produces that,
    // so this frame composes correctly with everything else in the engine.
    setFrame(
        out, o, px, py, pz,
        ax, ay, az,
        yx, yy, yz,
        ay * yz - az * yy, az * yx - ax * yz, ax * yy - ay * yx
    );
}

/** `out = a * b`, both rigid. Aliasing `out` with either input is not allowed. */
export function mul(out, oo, a, oa, b, ob) {
    for (let c = 0; c < 4; c++) {
        const bx = b[ob + c * 4], by = b[ob + c * 4 + 1], bz = b[ob + c * 4 + 2], bw = b[ob + c * 4 + 3];
        out[oo + c * 4] = a[oa] * bx + a[oa + 4] * by + a[oa + 8] * bz + a[oa + 12] * bw;
        out[oo + c * 4 + 1] = a[oa + 1] * bx + a[oa + 5] * by + a[oa + 9] * bz + a[oa + 13] * bw;
        out[oo + c * 4 + 2] = a[oa + 2] * bx + a[oa + 6] * by + a[oa + 10] * bz + a[oa + 14] * bw;
        out[oo + c * 4 + 3] = a[oa + 3] * bx + a[oa + 7] * by + a[oa + 11] * bz + a[oa + 15] * bw;
    }
}

/**
 * Inverse of a rigid transform: transpose the rotation, negate the rotated
 * translation. A general inverse would work too and would be slower and less
 * accurate; nothing in the rig ever scales.
 */
export function invertRigid(out, oo, m, om) {
    const xx = m[om], xy = m[om + 1], xz = m[om + 2];
    const yx = m[om + 4], yy = m[om + 5], yz = m[om + 6];
    const zx = m[om + 8], zy = m[om + 9], zz = m[om + 10];
    const tx = m[om + 12], ty = m[om + 13], tz = m[om + 14];

    out[oo] = xx; out[oo + 1] = yx; out[oo + 2] = zx; out[oo + 3] = 0;
    out[oo + 4] = xy; out[oo + 5] = yy; out[oo + 6] = zy; out[oo + 7] = 0;
    out[oo + 8] = xz; out[oo + 9] = yz; out[oo + 10] = zz; out[oo + 11] = 0;
    out[oo + 12] = -(xx * tx + xy * ty + xz * tz);
    out[oo + 13] = -(yx * tx + yy * ty + yz * tz);
    out[oo + 14] = -(zx * tx + zy * ty + zz * tz);
    out[oo + 15] = 1;
}

/** Transform a point. Writes three floats into `dst` at `od`. */
export function xformPoint(m, om, x, y, z, dst, od) {
    dst[od] = m[om] * x + m[om + 4] * y + m[om + 8] * z + m[om + 12];
    dst[od + 1] = m[om + 1] * x + m[om + 5] * y + m[om + 9] * z + m[om + 13];
    dst[od + 2] = m[om + 2] * x + m[om + 6] * y + m[om + 10] * z + m[om + 14];
}

/** Transform a direction (ignores translation). */
export function xformDir(m, om, x, y, z, dst, od) {
    dst[od] = m[om] * x + m[om + 4] * y + m[om + 8] * z;
    dst[od + 1] = m[om + 1] * x + m[om + 5] * y + m[om + 9] * z;
    dst[od + 2] = m[om + 2] * x + m[om + 6] * y + m[om + 10] * z;
}

// --------------------------------------------------------------- full 4x4
// New to the port. These operate on any length-16 column-major array,
// including `THREE.Matrix4.elements`. No offsets: view/projection matrices
// live one to an array.

/**
 * `out = a * b`, column-convention general 4x4 product: `(a*b)·v = a·(b·v)`.
 *
 * Babylon's row-vector `A.multiplyToRef(B, out)` is `mulMat4(out, B, A)` here
 * — so the source's `view.multiplyToRef(proj, viewProj)` becomes
 * `mulMat4(viewProj, proj, view)`. Aliasing `out` with `a` or `b` is safe.
 */
export function mulMat4(out, a, b) {
    const a0 = a[0], a1 = a[1], a2 = a[2], a3 = a[3];
    const a4 = a[4], a5 = a[5], a6 = a[6], a7 = a[7];
    const a8 = a[8], a9 = a[9], a10 = a[10], a11 = a[11];
    const a12 = a[12], a13 = a[13], a14 = a[14], a15 = a[15];
    const b0 = b[0], b1 = b[1], b2 = b[2], b3 = b[3];
    const b4 = b[4], b5 = b[5], b6 = b[6], b7 = b[7];
    const b8 = b[8], b9 = b[9], b10 = b[10], b11 = b[11];
    const b12 = b[12], b13 = b[13], b14 = b[14], b15 = b[15];

    out[0] = a0 * b0 + a4 * b1 + a8 * b2 + a12 * b3;
    out[1] = a1 * b0 + a5 * b1 + a9 * b2 + a13 * b3;
    out[2] = a2 * b0 + a6 * b1 + a10 * b2 + a14 * b3;
    out[3] = a3 * b0 + a7 * b1 + a11 * b2 + a15 * b3;
    out[4] = a0 * b4 + a4 * b5 + a8 * b6 + a12 * b7;
    out[5] = a1 * b4 + a5 * b5 + a9 * b6 + a13 * b7;
    out[6] = a2 * b4 + a6 * b5 + a10 * b6 + a14 * b7;
    out[7] = a3 * b4 + a7 * b5 + a11 * b6 + a15 * b7;
    out[8] = a0 * b8 + a4 * b9 + a8 * b10 + a12 * b11;
    out[9] = a1 * b8 + a5 * b9 + a9 * b10 + a13 * b11;
    out[10] = a2 * b8 + a6 * b9 + a10 * b10 + a14 * b11;
    out[11] = a3 * b8 + a7 * b9 + a11 * b10 + a15 * b11;
    out[12] = a0 * b12 + a4 * b13 + a8 * b14 + a12 * b15;
    out[13] = a1 * b12 + a5 * b13 + a9 * b14 + a13 * b15;
    out[14] = a2 * b12 + a6 * b13 + a10 * b14 + a14 * b15;
    out[15] = a3 * b12 + a7 * b13 + a11 * b14 + a15 * b15;
    return out;
}

/**
 * General 4x4 inverse (adjugate over determinant). Aliasing `out` with `m` is
 * safe. A singular matrix leaves `out` untouched.
 */
export function invertMat4(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3];
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7];
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11];
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15];

    const b00 = a00 * a11 - a01 * a10;
    const b01 = a00 * a12 - a02 * a10;
    const b02 = a00 * a13 - a03 * a10;
    const b03 = a01 * a12 - a02 * a11;
    const b04 = a01 * a13 - a03 * a11;
    const b05 = a02 * a13 - a03 * a12;
    const b06 = a20 * a31 - a21 * a30;
    const b07 = a20 * a32 - a22 * a30;
    const b08 = a20 * a33 - a23 * a30;
    const b09 = a21 * a32 - a22 * a31;
    const b10 = a21 * a33 - a23 * a31;
    const b11 = a22 * a33 - a23 * a32;

    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06;
    if (!det) return out;
    det = 1.0 / det;

    out[0] = (a11 * b11 - a12 * b10 + a13 * b09) * det;
    out[1] = (a02 * b10 - a01 * b11 - a03 * b09) * det;
    out[2] = (a31 * b05 - a32 * b04 + a33 * b03) * det;
    out[3] = (a22 * b04 - a21 * b05 - a23 * b03) * det;
    out[4] = (a12 * b08 - a10 * b11 - a13 * b07) * det;
    out[5] = (a00 * b11 - a02 * b08 + a03 * b07) * det;
    out[6] = (a32 * b02 - a30 * b05 - a33 * b01) * det;
    out[7] = (a20 * b05 - a22 * b02 + a23 * b01) * det;
    out[8] = (a10 * b10 - a11 * b08 + a13 * b06) * det;
    out[9] = (a01 * b08 - a00 * b10 - a03 * b06) * det;
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det;
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det;
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det;
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det;
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det;
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det;
    return out;
}

/**
 * Left-handed look-at view matrix (Babylon `Matrix.LookAtLHToRef` semantics):
 * +Z forward toward the target, X right, Y up. Rows of the rotation are the
 * camera axes; translation is the negated, rotated eye.
 */
export function lookAtLH(out, eyeX, eyeY, eyeZ, tX, tY, tZ, upX, upY, upZ) {
    // Forward: eye -> target, normalised.
    let zx = tX - eyeX, zy = tY - eyeY, zz = tZ - eyeZ;
    let l = Math.hypot(zx, zy, zz) || 1;
    zx /= l; zy /= l; zz /= l;

    // Right = up x forward (LH).
    let xx = upY * zz - upZ * zy;
    let xy = upZ * zx - upX * zz;
    let xz = upX * zy - upY * zx;
    l = Math.hypot(xx, xy, xz) || 1;
    xx /= l; xy /= l; xz /= l;

    // Up = forward x right (already unit).
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;

    out[0] = xx; out[1] = yx; out[2] = zx; out[3] = 0;
    out[4] = xy; out[5] = yy; out[6] = zy; out[7] = 0;
    out[8] = xz; out[9] = yz; out[10] = zz; out[11] = 0;
    out[12] = -(xx * eyeX + xy * eyeY + xz * eyeZ);
    out[13] = -(yx * eyeX + yy * eyeY + yz * eyeZ);
    out[14] = -(zx * eyeX + zy * eyeY + zz * eyeZ);
    out[15] = 1;
    return out;
}

/**
 * Left-handed perspective projection, GL clip z in [-1, +1].
 *
 * `clip.w = +viewZ` — positive metres in front of the camera — which is the
 * invariant the prepass (`vViewZ = clip.w`) and every screen-space
 * reconstruction in the post chain rely on.
 * @param {number} fovY vertical field of view, radians
 */
export function perspectiveFovLH(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY * 0.5);
    const rangeInv = 1 / (far - near);

    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = (far + near) * rangeInv; out[11] = 1;
    out[12] = 0; out[13] = 0; out[14] = -2 * far * near * rangeInv; out[15] = 0;
    return out;
}

/**
 * Left-handed off-centre orthographic projection, GL clip z in [-1, +1].
 * Used by the shadow cascades.
 */
export function orthoOffCenterLH(out, l, r, b, t, near, far) {
    const rlInv = 1 / (r - l);
    const tbInv = 1 / (t - b);
    const fnInv = 1 / (far - near);

    out[0] = 2 * rlInv; out[1] = 0; out[2] = 0; out[3] = 0;
    out[4] = 0; out[5] = 2 * tbInv; out[6] = 0; out[7] = 0;
    out[8] = 0; out[9] = 0; out[10] = 2 * fnInv; out[11] = 0;
    out[12] = -(r + l) * rlInv;
    out[13] = -(t + b) * tbInv;
    out[14] = -(far + near) * fnInv;
    out[15] = 1;
    return out;
}
