/**
 * Bake a skinned, animated GLB into the SNWK v2 asset `walkerAsset.js` loads.
 *
 *   node tools/bakeWalker.mjs <in.glb> <outBase> [--height=8.6] [--fps=24]
 *
 * e.g. node tools/bakeWalker.mjs at-st.glb public/models/atst --height=8.6
 *
 * A recreation of the tool that baked `walker.bin` and `speeder.bin` (the
 * original was never committed); the format is reverse-engineered from
 * `src/walkers/walkerAsset.js` and the headers of the shipped bins, and
 * produces byte-compatible output:
 *
 *   magic "SNWK" · u32 header length · JSON header · payload
 *
 * where the payload sections (named in `header.layout`) are the quantised
 * vertex attributes of each LOD and one cycle of baked skinning matrices —
 * the glTF node graph, the inverse binds and the keyframe interpolation all
 * flattened offline into a flat table of model-space affines, 12 int16s per
 * bone per frame, so the runtime's whole animation system is two array reads
 * and a lerp.
 *
 * The model is normalised into the demo's frame on the way through:
 *
 *   forward   +Z. Found from the clip itself: a walk cycle animated in place
 *             slides its planted feet backwards through the body's frame, so
 *             the mean slide direction of the planted feet *is* backwards.
 *   mirror    z is negated, as `bakeDestroyer.mjs` does (glTF is right-handed).
 *   ground    posed frame-0 feet at y = 0, hull centred on x = z = 0.
 *   size      scaled so the posed hull stands `--height` metres tall.
 *   speed     measured, not made up: the mean horizontal speed of a planted
 *             foot through the body's frame, written to the header so the
 *             runtime can match ground speed to cycle rate and the feet
 *             do not skate.
 *
 * Textures: one albedo webp per material that has a base colour map, one ORM
 * webp per material with a metallic-roughness map (occlusion forced white),
 * both at `header.textureSize`, named `<outBase>_albedo_<slot>.webp` /
 * `<outBase>_orm_<slot>.webp` — the layer files `loadWalkerAsset` fetches.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, basename } from "node:path";
import sharp from "sharp";

// --------------------------------------------------------------------- args
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith("--"))
        .map((a) => a.slice(2).split("="))
);
const src = args[0];
const outBase = args[1];
if (!src || !outBase) {
    console.error("usage: node tools/bakeWalker.mjs <in.glb> <outBase> [--height=8.6] [--fps=24]");
    process.exit(1);
}
const TARGET_HEIGHT = Number(flags.height) || 0; // 0 = keep authored size
const FPS = Number(flags.fps) || 24;
const TEXTURE_SIZE = Number(flags.texsize) || 1024;

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

const COMP = {
    5120: Int8Array, 5121: Uint8Array, 5122: Int16Array,
    5123: Uint16Array, 5125: Uint32Array, 5126: Float32Array,
};
const NCOMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

/** Accessor as a tightly-packed Float32Array (integers de-normalised). */
function accessorFloat(idx) {
    const a = json.accessors[idx];
    const bv = json.bufferViews[a.bufferView];
    const n = NCOMP[a.type];
    const Ctor = COMP[a.componentType];
    const elemBytes = Ctor.BYTES_PER_ELEMENT * n;
    const stride = bv.byteStride ?? elemBytes;
    // Accessor offsets are relative to the BIN chunk, not the file.
    const base = bin.byteOffset + (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
    const out = new Float32Array(a.count * n);
    const denorm = a.normalized
        ? (Ctor === Uint8Array ? 255 : Ctor === Uint16Array ? 65535 : 1)
        : 1;
    for (let i = 0; i < a.count; i++) {
        const view = new Ctor(bin.buffer, base + i * stride, n);
        for (let c = 0; c < n; c++) out[i * n + c] = view[c] / denorm;
    }
    return out;
}

// ------------------------------------------------------------- bone table
// One global bone list across every skin, deduplicated by joint node — the
// meshes all ride one skeleton, so shared joints must share texture columns.
const boneOfJoint = new Map(); // node index -> global bone
const ibms = [];               // global bone -> Float32Array(16)
/** per-skin: local joint index -> global bone index */
const skinMaps = (json.skins ?? []).map((skin) => {
    const ibm = accessorFloat(skin.inverseBindMatrices);
    return skin.joints.map((jointNode, j) => {
        if (boneOfJoint.has(jointNode)) return boneOfJoint.get(jointNode);
        const bone = ibms.length;
        boneOfJoint.set(jointNode, bone);
        ibms.push(ibm.subarray(j * 16, j * 16 + 16));
        return bone;
    });
});
const boneCount = ibms.length;

// -------------------------------------------------------- merged geometry
const positions = [];
const normals = [];
const uvs = [];
const boneIdx = [];
const boneWt = [];
const slots = [];
const indices = [];
let vertBase = 0;

for (const node of json.nodes) {
    if (node.mesh === undefined || node.skin === undefined) continue;
    const map = skinMaps[node.skin];
    for (const prim of json.meshes[node.mesh].primitives) {
        const pos = accessorFloat(prim.attributes.POSITION);
        const nrm = accessorFloat(prim.attributes.NORMAL);
        const uv = accessorFloat(prim.attributes.TEXCOORD_0);
        const jnt = accessorFloat(prim.attributes.JOINTS_0);
        const wt = accessorFloat(prim.attributes.WEIGHTS_0);
        const n = json.accessors[prim.attributes.POSITION].count;
        for (let i = 0; i < n; i++) {
            positions.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
            normals.push(nrm[i * 3], nrm[i * 3 + 1], nrm[i * 3 + 2]);
            uvs.push(uv[i * 2], uv[i * 2 + 1]);
            for (let k = 0; k < 4; k++) {
                boneIdx.push(map[jnt[i * 4 + k] | 0]);
                boneWt.push(wt[i * 4 + k]);
            }
            slots.push(prim.material ?? 0);
        }
        const idx = accessorFloat(prim.indices);
        for (let i = 0; i < idx.length; i++) indices.push(idx[i] + vertBase);
        vertBase += n;
    }
}
const vertexCount = vertBase;
const triangleCount = indices.length / 3;
console.log(`geometry: ${vertexCount} verts, ${triangleCount} tris, ${boneCount} bones`);

// -------------------------------------------------------- animation sampling
const anim0 = json.animations?.[0];
if (!anim0) throw new Error("no animation to bake");
const channels = anim0.channels.map((ch) => ({
    node: ch.target.node,
    path: ch.target.path,
    input: accessorFloat(anim0.samplers[ch.sampler].input),
    output: accessorFloat(anim0.samplers[ch.sampler].output),
}));
const duration = Math.max(...channels.map((c) => c.input[c.input.length - 1]));
const frameCount = Math.max(2, Math.round(duration * FPS));
console.log(`clip: ${duration.toFixed(3)}s -> ${frameCount} frames @ ${FPS}fps`);

function sampleChannel(ch, time, n) {
    const input = ch.input;
    if (input.length === 1) return Array.from(ch.output.subarray(0, n));
    let i = 0;
    while (i < input.length - 2 && input[i + 1] < time) i++;
    const t0 = input[i], t1 = input[i + 1];
    const f = t1 > t0 ? Math.min(1, Math.max(0, (time - t0) / (t1 - t0))) : 0;
    const v = new Array(n);
    for (let c = 0; c < n; c++) {
        v[c] = ch.output[i * n + c] * (1 - f) + ch.output[(i + 1) * n + c] * f;
    }
    if (n === 4) { // nlerp is fine at 24 fps against 24 fps keys
        const l = Math.hypot(...v) || 1;
        for (let c = 0; c < 4; c++) v[c] /= l;
    }
    return v;
}

// column-major mat4 helpers, matching glTF conventions
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

/** All bones' skinning affines (world * IBM) at `time`, glTF space, mat4[]. */
function solveFrame(time) {
    const local = json.nodes.map((n) => ({
        t: n.translation ? [...n.translation] : [0, 0, 0],
        q: n.rotation ? [...n.rotation] : [0, 0, 0, 1],
        s: n.scale ? [...n.scale] : [1, 1, 1],
        m: n.matrix ?? null,
    }));
    for (const ch of channels) {
        const L = local[ch.node];
        if (ch.path === "translation") L.t = sampleChannel(ch, time, 3);
        else if (ch.path === "rotation") L.q = sampleChannel(ch, time, 4);
        else if (ch.path === "scale") L.s = sampleChannel(ch, time, 3);
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

    const out = new Array(boneCount);
    for (const [jointNode, bone] of boneOfJoint) {
        out[bone] = mul4(world[jointNode], Array.from(ibms[bone]));
    }
    return out;
}

const frames = [];
for (let f = 0; f < frameCount; f++) {
    frames.push(solveFrame((f / frameCount) * duration));
}

// ------------------------------------------------- orientation, scale, speed
// Feet: the bones whose skinning translation travels furthest vertically.
// Planted: the bottom 15% of that travel. The mean horizontal velocity of a
// planted foot is the gait's ground speed, and its direction is backwards.
function boneTrans(f, b) {
    const m = frames[f][b];
    return [m[12], m[13], m[14]];
}
const travel = [];
for (let b = 0; b < boneCount; b++) {
    let lo = Infinity, hi = -Infinity;
    for (let f = 0; f < frameCount; f++) {
        const y = boneTrans(f, b)[1];
        if (y < lo) lo = y;
        if (y > hi) hi = y;
    }
    travel.push({ bone: b, lo, range: hi - lo });
}
const maxRange = Math.max(...travel.map((t) => t.range));
const feet = travel
    .filter((t) => t.range > maxRange * 0.55)
    .sort((a, b) => a.lo - b.lo)
    .slice(0, 4);
console.log(`feet: bones [${feet.map((f) => f.bone)}], travel ${maxRange.toFixed(2)} glTF units`);

let slide = [0, 0];
let slideSpeed = 0;
let slideSamples = 0;
const dtF = duration / frameCount;
for (const foot of feet) {
    for (let f = 0; f < frameCount; f++) {
        const y = boneTrans(f, foot.bone)[1];
        if (y > foot.lo + foot.range * 0.15) continue;
        const a = boneTrans(f, foot.bone);
        const b = boneTrans((f + 1) % frameCount, foot.bone);
        const vx = (b[0] - a[0]) / dtF, vz = (b[2] - a[2]) / dtF;
        const v = Math.hypot(vx, vz);
        if (v < 1e-4 || v > maxRange * 20) continue; // loop-seam jump guard
        slide[0] += vx; slide[1] += vz;
        slideSpeed += v;
        slideSamples++;
    }
}
if (!slideSamples) throw new Error("no planted-foot samples; cannot derive speed");
slideSpeed /= slideSamples;
const slideLen = Math.hypot(slide[0], slide[1]) || 1;
// Forward is where the slide points *away from*.
const fwd = [-slide[0] / slideLen, -slide[1] / slideLen];
console.log(`slide: dir [${fwd[0].toFixed(2)}, ${fwd[1].toFixed(2)}], ${slideSpeed.toFixed(3)} glTF units/s`);

// Rotation about Y taking `fwd` to -Z, so the z mirror that follows lands the
// nose on +Z — the demo's forward. Rotating straight to +Z reads as correct
// right up until the mirror flips it, and the machine walks backwards.
const yaw = Math.atan2(fwd[0], fwd[1]) + Math.PI;
const cy = Math.cos(yaw), sy = Math.sin(yaw);
/** glTF-space affine (3x3 basis + translation) -> demo frame, unscaled. */
function reorient3(x, y, z) {
    const rx = cy * x - sy * z;
    const rz = sy * x + cy * z;
    return [rx, y, -rz];
}

// Posed frame-0 bounds in the reoriented (still unscaled, uncentred) frame.
const posed = { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] };
{
    const F = frames[0];
    for (let v = 0; v < vertexCount; v++) {
        let px = 0, py = 0, pz = 0;
        for (let k = 0; k < 4; k++) {
            const w = boneWt[v * 4 + k];
            if (!w) continue;
            const m = F[boneIdx[v * 4 + k]];
            const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
            px += (m[0] * x + m[4] * y + m[8] * z + m[12]) * w;
            py += (m[1] * x + m[5] * y + m[9] * z + m[13]) * w;
            pz += (m[2] * x + m[6] * y + m[10] * z + m[14]) * w;
        }
        const p = reorient3(px, py, pz);
        for (let c = 0; c < 3; c++) {
            if (p[c] < posed.min[c]) posed.min[c] = p[c];
            if (p[c] > posed.max[c]) posed.max[c] = p[c];
        }
    }
}
const rawHeight = posed.max[1] - posed.min[1];
const scale = TARGET_HEIGHT ? TARGET_HEIGHT / rawHeight : 1;
// Feet on the ground, hull centred.
const recentre = [
    -(posed.min[0] + posed.max[0]) / 2 * scale,
    -posed.min[1] * scale,
    -(posed.min[2] + posed.max[2]) / 2 * scale,
];
console.log(`posed height ${rawHeight.toFixed(2)} -> scale ${scale.toFixed(4)} (${(rawHeight * scale).toFixed(2)}m)`);

const bounds = {
    min: [0, 1, 2].map((c) => posed.min[c] * scale + recentre[c]),
    max: [0, 1, 2].map((c) => posed.max[c] * scale + recentre[c]),
};
const height = bounds.max[1];
const speed = slideSpeed * scale;
console.log(`bounds x[${bounds.min[0].toFixed(1)},${bounds.max[0].toFixed(1)}] z[${bounds.min[2].toFixed(1)},${bounds.max[2].toFixed(1)}], speed ${speed.toFixed(3)} m/s`);

// ----------------------------------------------- final matrices + quantise
// Basis stays unit (rotation-only — verified below); scale is folded into the
// bind positions and the translations instead, exactly as the shipped bins do.
const animF = new Float32Array(frameCount * boneCount * 12);
let maxBasis = 0, maxTrans = 0;
for (let f = 0; f < frameCount; f++) {
    for (let b = 0; b < boneCount; b++) {
        const m = frames[f][b];
        const o = (f * boneCount + b) * 12;
        // three basis columns through the reorient (z-mirror included)
        for (let c = 0; c < 3; c++) {
            const col = reorient3(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
            // mirror the z *input* too: p' = M''·(x,y,-z) must equal mirror(M·p)
            const sgn = c === 2 ? -1 : 1;
            animF[o + c * 3] = col[0] * sgn;
            animF[o + c * 3 + 1] = col[1] * sgn;
            animF[o + c * 3 + 2] = col[2] * sgn;
            maxBasis = Math.max(maxBasis, Math.abs(col[0]), Math.abs(col[1]), Math.abs(col[2]));
        }
        const t = reorient3(m[12], m[13], m[14]);
        animF[o + 9] = t[0] * scale + recentre[0];
        animF[o + 10] = t[1] * scale + recentre[1];
        animF[o + 11] = t[2] * scale + recentre[2];
        maxTrans = Math.max(
            maxTrans, Math.abs(animF[o + 9]), Math.abs(animF[o + 10]), Math.abs(animF[o + 11])
        );
    }
}
const basisScale = maxBasis / 32767;
const transScale = maxTrans / 32767;
const animQ = new Int16Array(frameCount * boneCount * 12);
for (let i = 0; i < animF.length; i++) {
    const s = i % 12 < 9 ? basisScale : transScale;
    animQ[i] = Math.max(-32768, Math.min(32767, Math.round(animF[i] / s)));
}
if (maxBasis > 1.2) {
    console.warn(`warning: basis max ${maxBasis.toFixed(3)} — skeleton carries scale; expected ~1`);
}

// Bind positions carry the model scale; mirror z to match the mirrored basis.
const posScaled = new Float32Array(vertexCount * 3);
for (let v = 0; v < vertexCount; v++) {
    posScaled[v * 3] = positions[v * 3] * scale;
    posScaled[v * 3 + 1] = positions[v * 3 + 1] * scale;
    posScaled[v * 3 + 2] = -positions[v * 3 + 2] * scale;
}
const posMin = [Infinity, Infinity, Infinity], posMax = [-Infinity, -Infinity, -Infinity];
for (let v = 0; v < vertexCount; v++) {
    for (let c = 0; c < 3; c++) {
        const p = posScaled[v * 3 + c];
        if (p < posMin[c]) posMin[c] = p;
        if (p > posMax[c]) posMax[c] = p;
    }
}
const posOffset = posMin;
const posScale = posMax.map((hi, c) => Math.max(hi - posMin[c], 1e-6) / 65535);

const qPos = new Int16Array(vertexCount * 3);
for (let v = 0; v < vertexCount * 3; v++) {
    const c = v % 3;
    qPos[v] = Math.round((posScaled[v] - posOffset[c]) / posScale[c]) - 32768;
}
const qNrm = new Int8Array(vertexCount * 3);
for (let v = 0; v < vertexCount; v++) {
    // normals through the same mirrored frame: (nx, ny, -nz)
    qNrm[v * 3] = Math.max(-127, Math.min(127, Math.round(normals[v * 3] * 127)));
    qNrm[v * 3 + 1] = Math.max(-127, Math.min(127, Math.round(normals[v * 3 + 1] * 127)));
    qNrm[v * 3 + 2] = Math.max(-127, Math.min(127, Math.round(-normals[v * 3 + 2] * 127)));
}
const qUV = new Uint16Array(vertexCount * 2);
for (let v = 0; v < vertexCount * 2; v++) {
    qUV[v] = Math.max(0, Math.min(65535, Math.round(uvs[v] * 65535)));
}
const qIdx = new Uint8Array(vertexCount * 4);
const qWt = new Uint8Array(vertexCount * 4);
for (let v = 0; v < vertexCount * 4; v++) {
    qIdx[v] = boneIdx[v];
    qWt[v] = Math.max(0, Math.min(255, Math.round(boneWt[v] * 255)));
}
const qSlot = new Uint8Array(slots);
const qIndices = vertexCount <= 65535 ? new Uint16Array(indices) : new Uint32Array(indices);

// --------------------------------------------------------------- materials
const materials = (json.materials ?? [{}]).map((m, i) => ({
    name: m.name ?? `mat${i}`,
    slot: i,
    roughness: m.pbrMetallicRoughness?.roughnessFactor ?? 1,
    metallic: m.pbrMetallicRoughness?.metallicFactor ?? 0,
    albedoImage: m.pbrMetallicRoughness?.baseColorTexture
        ? json.textures[m.pbrMetallicRoughness.baseColorTexture.index].source : -1,
    ormImage: m.pbrMetallicRoughness?.metallicRoughnessTexture
        ? json.textures[m.pbrMetallicRoughness.metallicRoughnessTexture.index].source : -1,
}));

function imageBytes(idx) {
    const img = json.images[idx];
    const bv = json.bufferViews[img.bufferView];
    return bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
}

// ------------------------------------------------------------------ layout
const sections = [];
let cursor = 0;
function section(name, arr) {
    cursor = (cursor + 3) & ~3;
    sections.push({ name, offset: cursor, count: arr.length, type: arr.constructor.name, arr });
    cursor += arr.byteLength;
}
section("position0", qPos);
section("normal0", qNrm);
section("texcoord0", qUV);
section("boneIdx0", qIdx);
section("boneWt0", qWt);
section("slot0", qSlot);
section("indices0", qIndices);
section("anim", animQ);

const header = {
    version: 2,
    source: basename(src),
    lods: [{ level: 0, vertexCount, triangleCount, ratio: 1 }],
    vertexCount,
    triangleCount,
    boneCount,
    frameCount,
    duration,
    speed,
    height,
    bounds,
    posOffset,
    posScale,
    basisScale,
    transScale,
    textureSize: TEXTURE_SIZE,
    materials: materials.map(({ ...m }) => m),
    layout: sections.map(({ name, offset, count, type }) => ({ name, offset, count, type })),
};

let headerJSON = JSON.stringify(header);
// Pad so the payload starts 4-aligned — the loader views typed arrays straight
// onto the fetch's ArrayBuffer, and an Int32 view on an odd offset throws.
while ((8 + Buffer.byteLength(headerJSON)) % 4) headerJSON += " ";
const headerBuf = Buffer.from(headerJSON, "utf8");

const total = 8 + headerBuf.length + cursor;
const out = Buffer.alloc(total);
out.write("SNWK", 0, "ascii");
out.writeUInt32LE(headerBuf.length, 4);
headerBuf.copy(out, 8);
for (const s of sections) {
    Buffer.from(s.arr.buffer, s.arr.byteOffset, s.arr.byteLength)
        .copy(out, 8 + headerBuf.length + s.offset);
}
writeFileSync(resolve(outBase + ".bin"), out);
console.log(`wrote ${outBase}.bin (${(total / 1024 / 1024).toFixed(2)} MB)`);

// ----------------------------------------------------------------- textures
for (const m of materials) {
    if (m.albedoImage >= 0) {
        const webp = await sharp(imageBytes(m.albedoImage))
            .resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: "fill" })
            .webp({ quality: 88 })
            .toBuffer();
        writeFileSync(resolve(`${outBase}_albedo_${m.slot}.webp`), webp);
        console.log(`wrote ${outBase}_albedo_${m.slot}.webp (${(webp.length / 1024).toFixed(0)} KB)`);
    }
    if (m.ormImage >= 0) {
        // glTF metallic-roughness: G = roughness, B = metallic. The demo wants
        // occlusion in R; the map has none, so occlusion is forced white.
        const mr = sharp(imageBytes(m.ormImage)).resize(TEXTURE_SIZE, TEXTURE_SIZE, { fit: "fill" });
        const { data, info } = await mr.raw().toBuffer({ resolveWithObject: true });
        const px = new Uint8Array(info.width * info.height * 3);
        for (let i = 0, j = 0; i < info.width * info.height; i++, j += info.channels) {
            px[i * 3] = 255;
            px[i * 3 + 1] = data[j + 1];
            px[i * 3 + 2] = data[j + 2];
        }
        const webp = await sharp(px, {
            raw: { width: info.width, height: info.height, channels: 3 },
        }).webp({ quality: 88 }).toBuffer();
        writeFileSync(resolve(`${outBase}_orm_${m.slot}.webp`), webp);
        console.log(`wrote ${outBase}_orm_${m.slot}.webp (${(webp.length / 1024).toFixed(0)} KB)`);
    }
}
console.log("done");
