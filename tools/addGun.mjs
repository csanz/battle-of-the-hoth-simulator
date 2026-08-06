/**
 * Add a procedural blaster rifle to the snowtrooper GLB.
 *
 *   node tools/addGun.mjs <in.glb> <out.glb>
 *
 * The rifle (a boxy vintage-Kenner-toy take on the snowtrooper blaster:
 * wedge stock, receiver, pistol grip, segmented barrel, foregrip, muzzle) is
 * generated as flat-shaded geometry and attached as a child of the
 * `*:RightHand` joint node, so it rigidly follows the hand through every
 * clip — no skinning needed.
 *
 * Placement is derived from the animations themselves: the clips are
 * animated holding an invisible rifle, so at mid-clip the right hand is on
 * the grip and the left hand on the foregrip. The gun's forward axis is
 * aimed from right hand to left hand (biased toward where the torso faces
 * for the aiming clips), and the grip is settled forward/down of the wrist
 * joint into the closed fist.
 *
 * The node's static transform comes from the walk pose. Clips whose hold
 * differs (Idle's low-ready) get their own placement injected as a
 * single-keyframe track inside that clip, so the mixer swaps holds per clip
 * and crossfades blend between them.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const [src, dst] = process.argv.slice(2);
if (!src || !dst) {
    console.error("usage: node tools/addGun.mjs <in.glb> <out.glb>");
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

const NCOMP = { SCALAR: 1, VEC3: 3, VEC4: 4 };
function accessorFloat(idx) {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const base = bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    return new Float32Array(bin.buffer, base, a.count * NCOMP[a.type]);
}

// ------------------------------------------------------------- matrix bits
function composeTRS(t, q, s) {
    const [x, y, z, w] = q;
    const [sx, sy, sz] = s;
    return [
        (1 - 2 * (y * y + z * z)) * sx, (2 * (x * y + z * w)) * sx, (2 * (x * z - y * w)) * sx, 0,
        (2 * (x * y - z * w)) * sy, (1 - 2 * (x * x + z * z)) * sy, (2 * (y * z + x * w)) * sy, 0,
        (2 * (x * z + y * w)) * sz, (2 * (y * z - x * w)) * sz, (1 - 2 * (x * x + y * y)) * sz, 0,
        t[0], t[1], t[2], 1,
    ];
}
function mul4(a, b) {
    const o = new Array(16).fill(0);
    for (let c = 0; c < 4; c++)
        for (let r = 0; r < 4; r++)
            for (let k = 0; k < 4; k++) o[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
    return o;
}
function inv4(m) {
    // Affine inverse for column-major M = T·R·S (no shear): each column of
    // the 3x3 is s_i·r_i, so inv row j = column_j / |column_j|².
    const out = new Array(16).fill(0);
    for (let j = 0; j < 3; j++) {
        const cx = m[j * 4], cy = m[j * 4 + 1], cz = m[j * 4 + 2];
        const s2 = cx * cx + cy * cy + cz * cz;
        out[0 * 4 + j] = cx / s2;
        out[1 * 4 + j] = cy / s2;
        out[2 * 4 + j] = cz / s2;
    }
    for (let j = 0; j < 3; j++) {
        out[12 + j] = -(out[j] * m[12] + out[4 + j] * m[13] + out[8 + j] * m[14]);
    }
    out[15] = 1;
    return out;
}
const sub = (a, b) => a.map((v, i) => v - b[i]);
const norm = (a) => { const l = Math.hypot(...a) || 1; return a.map((v) => v / l); };
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

// -------------------------------------------------------- pose evaluation
/** World matrices of every node with `anim` applied at `frac` of its length. */
function evalWorld(anim, frac) {
    const duration = Math.max(...anim.channels.map((ch) =>
        accessorFloat(anim.samplers[ch.sampler].input).at(-1)));
    const T = duration * frac;
    const local = json.nodes.map((n) => ({
        t: n.translation ? [...n.translation] : [0, 0, 0],
        q: n.rotation ? [...n.rotation] : [0, 0, 0, 1],
        s: n.scale ? [...n.scale] : [1, 1, 1],
        m: n.matrix ?? null,
    }));
    for (const ch of anim.channels) {
        const input = accessorFloat(anim.samplers[ch.sampler].input);
        const n = ch.target.path === "rotation" ? 4 : 3;
        const output = accessorFloat(anim.samplers[ch.sampler].output);
        let i = 0;
        while (i < input.length - 2 && input[i + 1] < T) i++;
        const t0 = input[i], t1 = input[i + 1];
        const f = t1 > t0 ? Math.min(1, Math.max(0, (T - t0) / (t1 - t0))) : 0;
        // nlerp with hemisphere check — antipodal neighbour keys must be
        // negated or the blend sweeps the long way round.
        let sign = 1;
        if (n === 4) {
            let dot = 0;
            for (let c = 0; c < 4; c++) dot += output[i * 4 + c] * output[(i + 1) * 4 + c];
            if (dot < 0) sign = -1;
        }
        const v = new Array(n);
        for (let c = 0; c < n; c++) v[c] = output[i * n + c] * (1 - f) + output[(i + 1) * n + c] * f * sign;
        if (n === 4) {
            const l = Math.hypot(...v) || 1;
            for (let c = 0; c < 4; c++) v[c] /= l;
        }
        const L = local[ch.target.node];
        if (ch.target.path === "translation") L.t = v;
        else if (ch.target.path === "rotation") L.q = v;
        else if (ch.target.path === "scale") L.s = v;
        L.m = null;
    }
    const world = new Array(json.nodes.length).fill(null);
    const walk = (idx, parent) => {
        const L = local[idx];
        const m = L.m ?? composeTRS(L.t, L.q, L.s);
        world[idx] = parent ? mul4(parent, m) : m;
        for (const c of json.nodes[idx].children ?? []) walk(c, world[idx]);
    };
    for (const r of json.scenes[json.scene ?? 0].nodes) walk(r, null);
    return world;
}

// Mixamo bone names keep the uploaded character's prefix ("<char>:RightHand"),
// so match on the suffix after the colon.
const nodeIdx = (name) => {
    const i = json.nodes.findIndex((n) => (n.name ?? "").split(":").pop() === name);
    if (i < 0) throw new Error(`no node "*:${name}"`);
    return i;
};
const rHand = nodeIdx("RightHand");
const lHand = nodeIdx("LeftHand");
const hipsIdx = nodeIdx("Hips");

// ------------------------------------------------------------- placement
/**
 * Gun local TRS under the right hand for one posed frame.
 * bias  — how much the aim leans from the hand axis toward the torso facing
 * fwdOff/downOff — metres from the wrist joint to the fist's grip point
 */
function placement(world, { bias, fwdOff, downOff, k }) {
    const rPos = world[rHand].slice(12, 15);
    const lPos = world[lHand].slice(12, 15);
    const handAxis = norm(sub(lPos, rPos));
    const hips = world[hipsIdx];
    let hipsFwd = norm([hips[8], 0, hips[10]]);
    if (hipsFwd[0] * handAxis[0] + hipsFwd[2] * handAxis[2] < 0) hipsFwd = hipsFwd.map((v) => -v);
    const fwd = norm([
        handAxis[0] * (1 - bias) + hipsFwd[0] * bias,
        handAxis[1] * (1 - bias),
        handAxis[2] * (1 - bias) + hipsFwd[2] * bias,
    ]);
    // Right-handed basis: x̂×ŷ = ẑ, i.e. right×up = fwd.
    const right = norm(cross([0, 1, 0], fwd));
    const up = norm(cross(fwd, right));
    const gPos = rPos.map((v, i) => v + fwd[i] * fwdOff * k - up[i] * downOff * k);
    const gunWorld = [
        right[0], right[1], right[2], 0,
        up[0], up[1], up[2], 0,
        fwd[0], fwd[1], fwd[2], 0,
        gPos[0], gPos[1], gPos[2], 1,
    ];
    const localM = mul4(inv4(world[rHand]), gunWorld);
    const sx = Math.hypot(localM[0], localM[1], localM[2]);
    const sy = Math.hypot(localM[4], localM[5], localM[6]);
    const sz = Math.hypot(localM[8], localM[9], localM[10]);
    const R = [
        localM[0] / sx, localM[1] / sx, localM[2] / sx,
        localM[4] / sy, localM[5] / sy, localM[6] / sy,
        localM[8] / sz, localM[9] / sz, localM[10] / sz,
    ];
    const tr = R[0] + R[4] + R[8];
    let q;
    if (tr > 0) {
        const s = Math.sqrt(tr + 1) * 2;
        q = [(R[5] - R[7]) / s, (R[6] - R[2]) / s, (R[1] - R[3]) / s, s / 4];
    } else if (R[0] > R[4] && R[0] > R[8]) {
        const s = Math.sqrt(1 + R[0] - R[4] - R[8]) * 2;
        q = [s / 4, (R[3] + R[1]) / s, (R[6] + R[2]) / s, (R[5] - R[7]) / s];
    } else if (R[4] > R[8]) {
        const s = Math.sqrt(1 + R[4] - R[0] - R[8]) * 2;
        q = [(R[3] + R[1]) / s, s / 4, (R[7] + R[5]) / s, (R[6] - R[2]) / s];
    } else {
        const s = Math.sqrt(1 + R[8] - R[0] - R[4]) * 2;
        q = [(R[6] + R[2]) / s, (R[7] + R[5]) / s, s / 4, (R[1] - R[3]) / s];
    }
    return { t: localM.slice(12, 15), q, s: [sx, sy, sz] };
}

// The walk clip calibrates the geometry scale: hands ~0.35 m apart on a rifle.
const anims = json.animations;
const walkAnim = anims.find((a) => /walk|firing/i.test(a.name)) ?? anims[0];
const walkWorld = evalWorld(walkAnim, 0.5);
const handDist = Math.hypot(...sub(walkWorld[lHand].slice(12, 15), walkWorld[rHand].slice(12, 15)));
const k = handDist / 0.35;
console.log(`"${walkAnim.name}": hands ${handDist.toFixed(3)} units apart -> scale ${k.toFixed(3)}`);

const aimHold = placement(walkWorld, { bias: 0.35, fwdOff: 0.06, downOff: 0.045, k });

// ------------------------------------------------------------ gun geometry
// Authored in metres: +Z is the barrel direction, origin at the pistol grip
// (where the right hand is), receiver above it, stock behind, muzzle ahead.
const positions = [];
const normals = [];
const indices = [];

/** Quad-faced prism from 8 explicit corners (flat shaded). */
function prism(c) {
    // c: [rear-bottom-left, rear-bottom-right, rear-top-right, rear-top-left,
    //     front-bottom-left, front-bottom-right, front-top-right, front-top-left]
    const faces = [
        [0, 1, 2, 3], [5, 4, 7, 6], // rear, front
        [4, 5, 1, 0], [3, 2, 6, 7], // bottom, top
        [4, 0, 3, 7], [1, 5, 6, 2], // left, right
    ];
    for (const f of faces) {
        const base = positions.length / 3;
        const [p0, p1, p2] = [c[f[0]], c[f[1]], c[f[2]]];
        const n = norm(cross(sub(p1, p0), sub(p2, p0)));
        for (const vi of f) { positions.push(...c[vi]); normals.push(...n); }
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
}
/** Axis-aligned box. */
function box(x0, x1, y0, y1, z0, z1) {
    prism([
        [x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0],
        [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1],
    ]);
}
/** 8-sided cylinder along Z, centred on (0, cy). */
function barrelSeg(cy, r, z0, z1) {
    const N = 8;
    for (let i = 0; i < N; i++) {
        const a0 = (i / N) * Math.PI * 2, a1 = ((i + 1) / N) * Math.PI * 2;
        const p0 = [Math.cos(a0) * r, cy + Math.sin(a0) * r];
        const p1 = [Math.cos(a1) * r, cy + Math.sin(a1) * r];
        const base = positions.length / 3;
        const mid = (a0 + a1) / 2;
        const n = [Math.cos(mid), Math.sin(mid), 0];
        positions.push(p0[0], p0[1], z0, p1[0], p1[1], z0, p1[0], p1[1], z1, p0[0], p0[1], z1);
        normals.push(...n, ...n, ...n, ...n);
        indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
    for (const [z, dir] of [[z0, -1], [z1, 1]]) {
        const base = positions.length / 3;
        for (let i = 0; i < N; i++) {
            const a = (i / N) * Math.PI * 2;
            positions.push(Math.cos(a) * r, cy + Math.sin(a) * r, z);
            normals.push(0, 0, dir);
        }
        for (let i = 1; i < N - 1; i++) {
            if (dir > 0) indices.push(base, base + i, base + i + 1);
            else indices.push(base, base + i + 1, base + i);
        }
    }
}

// stock: wedge, deep at the back, meeting the receiver's underside
prism([
    [-0.022, -0.070, -0.25], [0.022, -0.070, -0.25], [0.022, 0.095, -0.25], [-0.022, 0.095, -0.25],
    [-0.022, 0.020, -0.09], [0.022, 0.020, -0.09], [0.022, 0.095, -0.09], [-0.022, 0.095, -0.09],
]);
// receiver
box(-0.023, 0.023, 0.030, 0.100, -0.12, 0.20);
// pistol grip (leaning back slightly), right hand wraps this at the origin
prism([
    [-0.014, -0.055, -0.045], [0.014, -0.055, -0.045], [0.014, 0.030, -0.020], [-0.014, 0.030, -0.020],
    [-0.014, -0.055, -0.010], [0.014, -0.055, -0.010], [0.014, 0.030, 0.030], [-0.014, 0.030, 0.030],
]);
// grip ribs
for (let i = 0; i < 4; i++) {
    const z = -0.043 + i * 0.013;
    box(-0.016, 0.016, -0.050 + i * 0.006, -0.030 + i * 0.006, z, z + 0.007);
}
// scope block + eyepiece
box(-0.012, 0.012, 0.100, 0.132, -0.05, 0.10);
box(-0.009, 0.009, 0.104, 0.128, -0.08, -0.05);
// front sight
box(-0.006, 0.006, 0.100, 0.126, 0.14, 0.17);
// barrel with rings
barrelSeg(0.068, 0.016, 0.20, 0.62);
for (const z of [0.28, 0.36, 0.44, 0.52]) barrelSeg(0.068, 0.022, z, z + 0.022);
// foregrip under the barrel where the left hand rides (z = 0.35 = handDist)
prism([
    [-0.012, -0.030, 0.325], [0.012, -0.030, 0.325], [0.012, 0.052, 0.335], [-0.012, 0.052, 0.335],
    [-0.012, -0.030, 0.360], [0.012, -0.030, 0.360], [0.012, 0.052, 0.380], [-0.012, 0.052, 0.380],
]);
// muzzle: thin tip + flare
barrelSeg(0.068, 0.009, 0.62, 0.70);
barrelSeg(0.068, 0.018, 0.68, 0.70);

// scale metres -> model units
for (let i = 0; i < positions.length; i++) positions[i] *= k;
console.log(`gun: ${positions.length / 3} verts, ${indices.length / 3} tris`);

// ------------------------------------------------------------- GLB append
const posArr = new Float32Array(positions);
const nrmArr = new Float32Array(normals);
const idxArr = new Uint16Array(indices);

let binLength = bin.length;
const parts = [bin];
function append(arr) {
    const aligned = (binLength + 3) & ~3;
    if (aligned > binLength) { parts.push(Buffer.alloc(aligned - binLength)); binLength = aligned; }
    parts.push(Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
    json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: arr.byteLength });
    binLength += arr.byteLength;
    return json.bufferViews.length - 1;
}
const mins = [Infinity, Infinity, Infinity], maxs = [-Infinity, -Infinity, -Infinity];
for (let i = 0; i < posArr.length; i += 3)
    for (let c = 0; c < 3; c++) {
        if (posArr[i + c] < mins[c]) mins[c] = posArr[i + c];
        if (posArr[i + c] > maxs[c]) maxs[c] = posArr[i + c];
    }
json.accessors.push({ bufferView: append(posArr), componentType: 5126, count: posArr.length / 3, type: "VEC3", min: mins, max: maxs });
const posAcc = json.accessors.length - 1;
json.accessors.push({ bufferView: append(nrmArr), componentType: 5126, count: nrmArr.length / 3, type: "VEC3" });
const nrmAcc = json.accessors.length - 1;
json.accessors.push({ bufferView: append(idxArr), componentType: 5123, count: idxArr.length, type: "SCALAR" });
const idxAcc = json.accessors.length - 1;

json.materials.push({
    name: "BlasterMaterial",
    pbrMetallicRoughness: {
        baseColorFactor: [0.035, 0.055, 0.095, 1],
        metallicFactor: 0.1,
        roughnessFactor: 0.75,
    },
});
json.meshes.push({
    name: "BlasterRifle",
    primitives: [{
        attributes: { POSITION: posAcc, NORMAL: nrmAcc },
        indices: idxAcc,
        material: json.materials.length - 1,
    }],
});
json.nodes.push({
    name: "BlasterRifle",
    mesh: json.meshes.length - 1,
    translation: aimHold.t,
    rotation: aimHold.q,
    scale: aimHold.s,
});
const gunNode = json.nodes.length - 1;
(json.nodes[rHand].children ??= []).push(gunNode);

// ------------------------------------------- per-clip holds (Idle low-ready)
// Clips whose grip differs from the walk's aim get their own placement as a
// single-key track on the gun node inside that clip; the mixer applies it
// only while the clip plays and crossfades handle the transitions.
for (const anim of anims) {
    if (!/idle/i.test(anim.name)) continue;
    const hold = placement(evalWorld(anim, 0.5), { bias: 0, fwdOff: 0.05, downOff: 0.04, k });
    const timeAcc = () => {
        json.accessors.push({
            bufferView: append(new Float32Array([0])),
            componentType: 5126, count: 1, type: "SCALAR", min: [0], max: [0],
        });
        return json.accessors.length - 1;
    };
    const valAcc = (v, type) => {
        json.accessors.push({
            bufferView: append(new Float32Array(v)),
            componentType: 5126, count: 1, type,
        });
        return json.accessors.length - 1;
    };
    for (const [path, value, type] of [
        ["translation", hold.t, "VEC3"],
        ["rotation", hold.q, "VEC4"],
        ["scale", hold.s, "VEC3"],
    ]) {
        anim.samplers.push({ input: timeAcc(), output: valAcc(value, type), interpolation: "LINEAR" });
        anim.channels.push({ sampler: anim.samplers.length - 1, target: { node: gunNode, path } });
    }
    console.log(`"${anim.name}": own hold injected`);
}

json.buffers = [{ byteLength: binLength }];
let jsonStr = JSON.stringify(json);
while (Buffer.byteLength(jsonStr) % 4) jsonStr += " ";
const jsonBuf = Buffer.from(jsonStr, "utf8");
const binPad = binLength % 4 ? 4 - (binLength % 4) : 0;
const total = 12 + 8 + jsonBuf.length + 8 + binLength + binPad;
const out = Buffer.alloc(total);
const odv = new DataView(out.buffer, out.byteOffset);
odv.setUint32(0, 0x46546c67, true);
odv.setUint32(4, 2, true);
odv.setUint32(8, total, true);
odv.setUint32(12, jsonBuf.length, true);
odv.setUint32(16, 0x4e4f534a, true);
jsonBuf.copy(out, 20);
odv.setUint32(20 + jsonBuf.length, binLength + binPad, true);
odv.setUint32(24 + jsonBuf.length, 0x004e4942, true);
Buffer.concat(parts, binLength).copy(out, 28 + jsonBuf.length);
writeFileSync(resolve(dst), out);
console.log(`wrote ${dst} (${(total / 1024 / 1024).toFixed(2)} MB)`);
