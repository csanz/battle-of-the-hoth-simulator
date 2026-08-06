/**
 * Combine Mixamo FBX downloads into a single GLB with every animation clip.
 *
 *   node tools/combineMixamo.mjs [--textures=orig.glb] <out.glb> <base.fbx|base.glb> [anim1.fbx ...]
 *
 * e.g. node tools/combineMixamo.mjs snowtrooper.glb Idle.fbx Walking.fbx Firing.fbx
 *
 * The base may also be a GLB this tool produced earlier — its mesh, skeleton,
 * materials *and existing clips* all carry through, so growing a model's clip
 * library is one command against the previous version rather than a rebuild
 * from the original FBX stack.
 *
 * `--textures=` points at the pre-Mixamo GLB of the same model. Mixamo strips
 * texture images from its FBX downloads but keeps the material names, so each
 * base material is replaced wholesale by the same-named material from that
 * GLB — textures, factors, normal maps and all.
 *
 * A clip's name defaults to its file name; append `:Name` to override when
 * the file name lies about its contents (`"Firing Rifle (1).fbx:Walking"`).
 *
 * The first FBX must be a "With Skin" download — it supplies the mesh,
 * skeleton and materials. The rest are best downloaded "Without Skin"
 * (animation only, ~10x smaller); each contributes its clip(s), retargeted
 * onto the base skeleton by bone name (Mixamo names — "mixamorig:Hips" etc —
 * are identical across every download of the same character). Clips are
 * named after their source file, so `Firing Rifle.fbx` becomes a clip called
 * "Firing Rifle" you can look up with THREE.AnimationClip.findByName.
 *
 * Each FBX is converted with FBX2glTF (the `fbx2gltf` dev dependency) into a
 * temp GLB, then the animation accessors are lifted out of the temp GLBs and
 * appended to the base GLB's buffer — only the sampler input/output data is
 * copied, so a with-skin animation download doesn't drag a second copy of the
 * mesh into the output.
 */

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { resolve, basename, join } from "node:path";
import { tmpdir } from "node:os";
import convert from "fbx2gltf";

const flags = Object.fromEntries(
    process.argv.slice(2).filter((a) => a.startsWith("--")).map((a) => a.slice(2).split("="))
);
const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (args.length < 2) {
    console.error("usage: node tools/combineMixamo.mjs [--textures=orig.glb] <out.glb> <base.fbx> [animN.fbx ...]");
    process.exit(1);
}
// "file.fbx:Clip Name" -> { path, clip override }
const splitArg = (a) => {
    const m = a.match(/^(.+\.fbx):(.+)$/i);
    return m ? { path: m[1], clip: m[2] } : { path: a, clip: null };
};
const outPath = args[0];
const baseArg = splitArg(args[1]);
const animArgs = args.slice(2).map(splitArg);

// ---------------------------------------------------------------- GLB parse
function parseGLB(path) {
    const buf = readFileSync(path);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (dv.getUint32(0, true) !== 0x46546c67) throw new Error(`${path}: not a GLB`);
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
    if (!json) throw new Error(`${path}: GLB missing JSON chunk`);
    return { json, bin: bin ?? Buffer.alloc(0) };
}

function writeGLB(path, json, bin) {
    let jsonStr = JSON.stringify(json);
    while (Buffer.byteLength(jsonStr) % 4) jsonStr += " ";
    const jsonBuf = Buffer.from(jsonStr, "utf8");
    const binPad = bin.length % 4 ? 4 - (bin.length % 4) : 0;
    const total = 12 + 8 + jsonBuf.length + 8 + bin.length + binPad;
    const out = Buffer.alloc(total);
    const dv = new DataView(out.buffer, out.byteOffset);
    dv.setUint32(0, 0x46546c67, true);     // "glTF"
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonBuf.length, true);
    dv.setUint32(16, 0x4e4f534a, true);    // "JSON"
    jsonBuf.copy(out, 20);
    dv.setUint32(20 + jsonBuf.length, bin.length + binPad, true);
    dv.setUint32(24 + jsonBuf.length, 0x004e4942, true); // "BIN"
    bin.copy(out, 28 + jsonBuf.length);
    writeFileSync(path, out);
    return total;
}

// -------------------------------------------------------------- FBX -> GLB
const tmp = mkdtempSync(join(tmpdir(), "mixamo-"));
async function fbxToGLB(fbx, i) {
    const dst = join(tmp, `${i}.glb`);
    await convert(resolve(fbx), dst, ["--binary"]);
    return parseGLB(dst);
}

try {
    console.log(`base: ${basename(baseArg.path)}`);
    const baseIsGLB = /\.glb$/i.test(baseArg.path);
    const base = baseIsGLB
        ? parseGLB(resolve(baseArg.path))
        : await fbxToGLB(baseArg.path, "base");
    const baseNodeByName = new Map(
        base.json.nodes.map((n, i) => [n.name, i])
    );
    base.json.animations = base.json.animations ?? [];
    // The base's own clip (if it was downloaded with an animation) keeps a
    // useful name too, instead of Mixamo's default "mixamo.com". A GLB base's
    // clips were named when they were combined — renaming them all after the
    // base file would flatten "Walking"/"Idle"/... into one name.
    const clipName = ({ path, clip }) => clip ?? basename(path).replace(/\.(fbx|glb)$/i, "");
    if (!baseIsGLB) {
        for (const a of base.json.animations) a.name = clipName(baseArg);
    }

    let bin = Buffer.from(base.bin);
    const binParts = [bin];
    let binLength = bin.length;

    for (const animArg of animArgs) {
        const animPath = animArg.path;
        const doc = await fbxToGLB(animPath, base.json.animations.length);
        const { json: aj, bin: abin } = doc;
        if (!aj.animations?.length) {
            console.warn(`  ${basename(animPath)}: no animations — skipped`);
            continue;
        }
        for (const anim of aj.animations) {
            const samplers = [];
            const channels = [];
            const accessorMap = new Map(); // source accessor idx -> base accessor idx
            const liftAccessor = (idx) => {
                if (accessorMap.has(idx)) return accessorMap.get(idx);
                const src = aj.accessors[idx];
                const bv = aj.bufferViews[src.bufferView];
                const start = (bv.byteOffset ?? 0) + (src.byteOffset ?? 0);
                // Sampler accessors are tightly packed floats; copy just the
                // bytes this accessor covers.
                const COMP_BYTES = { 5126: 4 };
                const NCOMP = { SCALAR: 1, VEC3: 3, VEC4: 4 };
                const bytes = src.count * NCOMP[src.type] * COMP_BYTES[src.componentType];
                if (!bytes) throw new Error(`${basename(animPath)}: non-float sampler accessor`);
                const aligned = (binLength + 3) & ~3;
                const pad = aligned - binLength;
                if (pad) { binParts.push(Buffer.alloc(pad)); binLength += pad; }
                binParts.push(abin.subarray(start, start + bytes));
                base.json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bytes });
                binLength += bytes;
                base.json.accessors.push({
                    bufferView: base.json.bufferViews.length - 1,
                    componentType: src.componentType,
                    count: src.count,
                    type: src.type,
                    min: src.min,
                    max: src.max,
                });
                accessorMap.set(idx, base.json.accessors.length - 1);
                return base.json.accessors.length - 1;
            };
            for (const ch of anim.channels) {
                const srcNode = aj.nodes[ch.target.node];
                const dstNode = baseNodeByName.get(srcNode.name);
                if (dstNode === undefined) {
                    console.warn(`  ${basename(animPath)}: no base bone named "${srcNode.name}" — channel dropped`);
                    continue;
                }
                const s = anim.samplers[ch.sampler];
                samplers.push({
                    input: liftAccessor(s.input),
                    output: liftAccessor(s.output),
                    interpolation: s.interpolation ?? "LINEAR",
                });
                channels.push({
                    sampler: samplers.length - 1,
                    target: { node: dstNode, path: ch.target.path },
                });
            }
            const name = aj.animations.length > 1
                ? `${clipName(animArg)}_${aj.animations.indexOf(anim)}`
                : clipName(animArg);
            base.json.animations.push({ name, samplers, channels });
            console.log(`  ${basename(animPath)}: clip "${name}", ${channels.length} channels`);
        }
    }

    // ------------------------------------------------------- texture merge
    if (flags.textures) {
        const tex = parseGLB(resolve(flags.textures));
        const tj = tex.json;
        base.json.textures = base.json.textures ?? [];
        base.json.images = base.json.images ?? [];
        base.json.samplers = base.json.samplers ?? [];
        const textureMap = new Map(); // source texture idx -> base texture idx
        const liftTexture = (idx) => {
            if (textureMap.has(idx)) return textureMap.get(idx);
            const t = tj.textures[idx];
            const img = tj.images[t.source];
            if (img.bufferView === undefined) throw new Error("texture GLB uses external image URIs");
            const bv = tj.bufferViews[img.bufferView];
            const aligned = (binLength + 3) & ~3;
            const pad = aligned - binLength;
            if (pad) { binParts.push(Buffer.alloc(pad)); binLength += pad; }
            binParts.push(tex.bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength));
            base.json.bufferViews.push({ buffer: 0, byteOffset: binLength, byteLength: bv.byteLength });
            binLength += bv.byteLength;
            base.json.images.push({ mimeType: img.mimeType, bufferView: base.json.bufferViews.length - 1 });
            let sampler;
            if (t.sampler !== undefined) {
                base.json.samplers.push({ ...tj.samplers[t.sampler] });
                sampler = base.json.samplers.length - 1;
            }
            base.json.textures.push({ source: base.json.images.length - 1, ...(sampler !== undefined && { sampler }) });
            textureMap.set(idx, base.json.textures.length - 1);
            return base.json.textures.length - 1;
        };
        const srcMatByName = new Map(tj.materials.map((m) => [m.name, m]));
        for (let i = 0; i < base.json.materials.length; i++) {
            const src = srcMatByName.get(base.json.materials[i].name);
            if (!src) {
                console.warn(`  textures: no material "${base.json.materials[i].name}" in ${basename(flags.textures)} — kept untextured`);
                continue;
            }
            // Deep copy, remapping every texture reference on the way through.
            const mat = JSON.parse(JSON.stringify(src));
            for (const ref of [
                mat.pbrMetallicRoughness?.baseColorTexture,
                mat.pbrMetallicRoughness?.metallicRoughnessTexture,
                mat.normalTexture, mat.occlusionTexture, mat.emissiveTexture,
            ]) {
                if (ref) ref.index = liftTexture(ref.index);
            }
            base.json.materials[i] = mat;
            console.log(`  textures: "${mat.name}" remapped from ${basename(flags.textures)}`);
        }
    }

    base.json.buffers = [{ byteLength: binLength }];
    const merged = Buffer.concat(binParts, binLength);
    const total = writeGLB(resolve(outPath), base.json, merged);
    console.log(`wrote ${outPath} (${(total / 1024 / 1024).toFixed(2)} MB, ${base.json.animations.length} clips: ${base.json.animations.map((a) => `"${a.name}"`).join(", ")})`);
} finally {
    rmSync(tmp, { recursive: true, force: true });
}
