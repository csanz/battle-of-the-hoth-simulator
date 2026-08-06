/**
 * Bake a GLB capital ship into `public/models/destroyer.bin` (format "SDST").
 *
 *   node tools/bakeDestroyer.mjs <in.glb> [targetTris]
 *
 * The source rip is ~4M vertices of greebles — panel lines, turbolasers,
 * trench detail — none of which survives being three kilometres away. Mesh
 * simplifiers give up on it (it is thousands of disconnected shells whose
 * borders they refuse to collapse), so this uses the decimator that *likes*
 * shell soup: uniform-grid vertex clustering. Every vertex snaps to a grid
 * cell, cells merge, degenerate triangles drop, and the greebles collapse
 * into the hull they decorate. The grid coarsens until the ship fits the
 * triangle budget.
 *
 * Positions only — no normals (the shader derives flat facets from screen
 * derivatives, which suits a hard-edged hull), no UVs, no textures (a grey
 * hull lit by the scene's own sun/sky reads correctly at that range).
 * Output is already in the demo's left-handed frame (glTF is right-handed;
 * z is negated).
 *
 * SDST layout, little-endian:
 *   u32 magic "SDST", u32 version=1, u32 vertCount, u32 triCount,
 *   f32x3 bboxMin, f32x3 bboxMax,
 *   f32x3 * vertCount positions, u32x3 * triCount indices.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const src = process.argv[2];
const TARGET_TRIS = Number(process.argv[3]) || 55000;
if (!src) {
    console.error("usage: node tools/bakeDestroyer.mjs <in.glb> [targetTris]");
    process.exit(1);
}

// ---------------------------------------------------------------- GLB parse
const buf = readFileSync(resolve(src));
const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB");
let off = 12;
let json = null;
let bin = null;
while (off < buf.byteLength) {
    const len = dv.getUint32(off, true);
    const type = dv.getUint32(off + 4, true);
    const chunk = buf.subarray(off + 8, off + 8 + len);
    if (type === 0x4e4f534a) json = JSON.parse(chunk.toString("utf8"));
    else if (type === 0x004e4942) bin = chunk;
    off += 8 + len + (len % 4 ? 4 - (len % 4) : 0);
}
if (!json || !bin) throw new Error("GLB missing JSON or BIN chunk");

function accessorArray(idx) {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const start = (bv.byteOffset || 0) + (a.byteOffset || 0);
    const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 }[a.type];
    const Ctor = {
        5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
        5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
    }[a.componentType];
    const stride = bv.byteStride || comps * Ctor.BYTES_PER_ELEMENT;
    if (stride === comps * Ctor.BYTES_PER_ELEMENT) {
        return new Ctor(bin.buffer, bin.byteOffset + start, a.count * comps);
    }
    // Interleaved: gather.
    const out = new Ctor(a.count * comps);
    for (let i = 0; i < a.count; i++) {
        const base = bin.byteOffset + start + i * stride;
        for (let c = 0; c < comps; c++) {
            out[i * comps + c] = new Ctor(bin.buffer, base + c * Ctor.BYTES_PER_ELEMENT, 1)[0];
        }
    }
    return out;
}

// Column-major 4x4 helpers (glTF convention).
function matMul(a, b) {
    const o = new Float64Array(16);
    for (let c = 0; c < 4; c++) {
        for (let r = 0; r < 4; r++) {
            o[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1]
                + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
        }
    }
    return o;
}
const IDENT = Float64Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]);
function nodeLocal(n) {
    if (n.matrix) return Float64Array.from(n.matrix);
    const t = n.translation || [0, 0, 0];
    const q = n.rotation || [0, 0, 0, 1];
    const s = n.scale || [1, 1, 1];
    const [x, y, z, w] = q;
    const m = new Float64Array(16);
    m[0] = (1 - 2 * (y * y + z * z)) * s[0];
    m[1] = (2 * (x * y + z * w)) * s[0];
    m[2] = (2 * (x * z - y * w)) * s[0];
    m[4] = (2 * (x * y - z * w)) * s[1];
    m[5] = (1 - 2 * (x * x + z * z)) * s[1];
    m[6] = (2 * (y * z + x * w)) * s[1];
    m[8] = (2 * (x * z + y * w)) * s[2];
    m[9] = (2 * (y * z - x * w)) * s[2];
    m[10] = (1 - 2 * (x * x + y * y)) * s[2];
    m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
    return m;
}

// ------------------------------------------------- gather world-space soup
const positions = [];   // flat xyz, world space, LH (z negated)
const triangles = [];   // flat index triples
const scene = json.scenes[json.scene || 0];

function walk(nodeIdx, parent) {
    const n = json.nodes[nodeIdx];
    const world = matMul(parent, nodeLocal(n));
    if (n.mesh !== undefined) {
        const mesh = json.meshes[n.mesh];
        for (const prim of mesh.primitives) {
            if (prim.mode !== undefined && prim.mode !== 4) continue;
            const pos = accessorArray(prim.attributes.POSITION);
            const base = positions.length / 3;
            for (let i = 0; i < pos.length; i += 3) {
                const x = pos[i], y = pos[i + 1], z = pos[i + 2];
                const wx = world[0] * x + world[4] * y + world[8] * z + world[12];
                const wy = world[1] * x + world[5] * y + world[9] * z + world[13];
                const wz = world[2] * x + world[6] * y + world[10] * z + world[14];
                positions.push(wx, wy, -wz); // RH -> LH
            }
            if (prim.indices !== undefined) {
                const idx = accessorArray(prim.indices);
                for (let i = 0; i < idx.length; i++) triangles.push(base + idx[i]);
            } else {
                for (let i = 0; i < pos.length / 3; i++) triangles.push(base + i);
            }
        }
    }
    for (const c of n.children || []) walk(c, world);
}
for (const root of scene.nodes) walk(root, IDENT);

const srcVerts = positions.length / 3;
const srcTris = triangles.length / 3;

// Bounding box of the soup.
const lo = [Infinity, Infinity, Infinity];
const hi = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
        const v = positions[i + a];
        if (v < lo[a]) lo[a] = v;
        if (v > hi[a]) hi[a] = v;
    }
}
const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);

// ------------------------------------------------------- grid clustering
function decimate(cell) {
    const clusterOf = new Map(); // grid key -> cluster index
    const clusterIdx = new Int32Array(srcVerts);
    const sums = []; // per-cluster [sx, sy, sz, n]
    for (let v = 0; v < srcVerts; v++) {
        const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
        const key = `${Math.floor((x - lo[0]) / cell)},${Math.floor((y - lo[1]) / cell)},${Math.floor((z - lo[2]) / cell)}`;
        let c = clusterOf.get(key);
        if (c === undefined) {
            c = sums.length;
            clusterOf.set(key, c);
            sums.push([0, 0, 0, 0]);
        }
        clusterIdx[v] = c;
        const s = sums[c];
        s[0] += x; s[1] += y; s[2] += z; s[3]++;
    }
    const outTris = [];
    const seen = new Set();
    for (let t = 0; t < srcTris; t++) {
        const a = clusterIdx[triangles[t * 3]];
        const b = clusterIdx[triangles[t * 3 + 1]];
        const c = clusterIdx[triangles[t * 3 + 2]];
        if (a === b || b === c || a === c) continue;
        // Dedup identical collapsed triangles regardless of rotation.
        const k = a < b
            ? (b < c ? `${a},${b},${c}` : (a < c ? `${a},${c},${b}` : `${c},${a},${b}`))
            : (a < c ? `${b},${a},${c}` : (b < c ? `${b},${c},${a}` : `${c},${b},${a}`));
        if (seen.has(k)) continue;
        seen.add(k);
        outTris.push(a, b, c);
    }
    return { sums, outTris };
}

let cell = diag / 480;
let result = decimate(cell);
while (result.outTris.length / 3 > TARGET_TRIS) {
    cell *= 1.25;
    result = decimate(cell);
}

// Compact: only clusters actually referenced by surviving triangles.
const remap = new Map();
const outPos = [];
for (let i = 0; i < result.outTris.length; i++) {
    const c = result.outTris[i];
    let m = remap.get(c);
    if (m === undefined) {
        m = outPos.length / 3;
        remap.set(c, m);
        const s = result.sums[c];
        outPos.push(s[0] / s[3], s[1] / s[3], s[2] / s[3]);
    }
    result.outTris[i] = m;
}

const vertCount = outPos.length / 3;
const triCount = result.outTris.length / 3;

// ------------------------------------------------------------------ write
const HEADER = 4 * 4 + 6 * 4;
const out = Buffer.alloc(HEADER + vertCount * 12 + triCount * 12);
out.writeUInt32LE(0x54534453, 0);            // "SDST"
out.writeUInt32LE(1, 4);
out.writeUInt32LE(vertCount, 8);
out.writeUInt32LE(triCount, 12);
for (let a = 0; a < 3; a++) out.writeFloatLE(lo[a], 16 + a * 4);
for (let a = 0; a < 3; a++) out.writeFloatLE(hi[a], 28 + a * 4);
for (let i = 0; i < outPos.length; i++) out.writeFloatLE(outPos[i], HEADER + i * 4);
for (let i = 0; i < result.outTris.length; i++) {
    out.writeUInt32LE(result.outTris[i], HEADER + vertCount * 12 + i * 4);
}

const here = dirname(fileURLToPath(import.meta.url));
const dst = join(here, "..", "public", "models", "destroyer.bin");
writeFileSync(dst, out);
console.log(
    `${srcVerts.toLocaleString()} verts / ${srcTris.toLocaleString()} tris`
    + ` -> ${vertCount.toLocaleString()} verts / ${triCount.toLocaleString()} tris`
    + ` (cell ${cell.toFixed(2)} m) -> ${dst} (${(out.length / 1024).toFixed(0)} KB)`
);
