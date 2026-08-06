/**
 * Loading the baked walker.
 *
 * The file is what `tools/bakeWalker.mjs` produced: a magic word, a JSON header,
 * then one contiguous payload of quantised attributes and one cycle of baked
 * skinning matrices. There is no parsing to speak of — every section is a typed
 * view onto the ArrayBuffer the fetch already produced, and the only work done
 * here is widening the quantised attributes into the Float32Arrays the vertex
 * buffers want.
 *
 * That widening is deliberate rather than lazy. WebGPU has no three-component
 * 16-bit vertex format, so a packed layout would have to be padded to vec4 and
 * would save nothing in VRAM; the quantisation is there to make the *download*
 * small, and 75k vertices expand in about a millisecond. What crosses the wire
 * is 2.8 MB where the source glTF was 15.5, and it comes from wherever
 * `core/assets.js` points — by default a public Vercel Blob store, not this
 * origin.
 *
 * Textures arrive as three WebP images per set and are assembled into one
 * four-layer array, so the whole machine draws in a single pass with a single
 * sampler. The fourth layer has no image behind it — the interior material is a
 * flat colour — and is generated white so the per-slot factors decide it.
 */

import { fetchAsset } from "../core/assets.js";

const MAGIC = "SNWK";

/**
 * @typedef {object} WalkerLOD
 * @property {Float32Array} positions
 * @property {Float32Array} normals
 * @property {Float32Array} uvs
 * @property {Float32Array} aux       (material slot, spare) per vertex
 * @property {Float32Array} boneIdx
 * @property {Float32Array} boneWt
 * @property {Uint16Array|Uint32Array} indices
 * @property {number} triangleCount
 * @property {number} vertexCount
 */

/**
 * @typedef {object} WalkerAsset
 * @property {any} header
 * @property {WalkerLOD[]} lods       finest first
 * @property {Int16Array}   anim      frame-major, 12 quantised floats per bone
 * @property {Uint8Array}   albedo    layer-major RGBA
 * @property {Uint8Array}   orm       layer-major RGBA
 */

/**
 * Layers in the texture arrays. Material slots index straight into them, so the
 * count follows the model — the walker has four materials and the speeder five,
 * and a fixed four silently dropped the fifth.
 */
const MIN_LAYERS = 4;
const layersFor = (materials) => Math.max(MIN_LAYERS, materials.length);

/**
 * sRGB byte -> linear float, as a 256-entry table.
 *
 * Built once and only used when asked for. A colour map authored for a renderer
 * that decodes sRGB, uploaded as raw bytes into a texture array that does not,
 * is read as though its mid-tones were already linear — which lands every one of
 * them in the wrong place and reads, on a dark hull, as black.
 */
const SRGB_TO_LINEAR = (() => {
    const t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) {
        const c = i / 255;
        const lin = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
        t[i] = Math.round(lin * 255);
    }
    return t;
})();

/**
 * @param {string} base path prefix, without extension
 * @param {{ srgbAlbedo?: boolean }} [opts]
 *   `srgbAlbedo` decodes the colour maps on the way into the array. Off by
 *   default, deliberately: the walker's maps have been looked at and tuned as
 *   they are, and silently re-gamma-ing them would change a model nobody asked
 *   to change.
 * @returns {Promise<WalkerAsset>}
 */
export async function loadWalkerAsset(base, opts) {
    // The store first, this origin second — so a model that has been baked but
    // not yet uploaded loads anyway. See `core/assets.js`.
    const res = await fetchAsset(base + ".bin");
    const buffer = await res.arrayBuffer();

    const magic = String.fromCharCode(...new Uint8Array(buffer, 0, 4));
    if (magic !== MAGIC) throw new Error(`walker: bad magic "${magic}"`);
    const headerBytes = new DataView(buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, headerBytes)));
    if (header.version !== 2) throw new Error(`walker: unsupported version ${header.version}`);

    const payload = 8 + headerBytes;
    /** @type {Record<string, {offset:number,count:number,type:string}>} */
    const sections = {};
    for (const s of header.layout) sections[s.name] = s;
    const TYPES = { Int8Array, Uint8Array, Int16Array, Uint16Array, Uint32Array, Float32Array };
    const view = (name) => {
        const s = sections[name];
        if (!s) throw new Error(`walker: section "${name}" missing`);
        return new TYPES[s.type](buffer, payload + s.offset, s.count);
    };

    const [ox, oy, oz] = header.posOffset;
    const [sx, sy, sz] = header.posScale;

    /** Widen one level's quantised attributes into the vertex buffers. */
    const readLOD = (level) => {
        const qPos = view(`position${level}`);
        const qNrm = view(`normal${level}`);
        const qUV = view(`texcoord${level}`);
        const qIdx = view(`boneIdx${level}`);
        const qWt = view(`boneWt${level}`);
        const qSlot = view(`slot${level}`);
        const n = qSlot.length;

        const positions = new Float32Array(n * 3);
        const normals = new Float32Array(n * 3);
        const uvs = new Float32Array(n * 2);
        const aux = new Float32Array(n * 2);
        const boneIdx = new Float32Array(n * 4);
        const boneWt = new Float32Array(n * 4);

        for (let i = 0; i < n; i++) {
            const p = i * 3;
            positions[p] = (qPos[p] + 32768) * sx + ox;
            positions[p + 1] = (qPos[p + 1] + 32768) * sy + oy;
            positions[p + 2] = (qPos[p + 2] + 32768) * sz + oz;
            normals[p] = qNrm[p] / 127;
            normals[p + 1] = qNrm[p + 1] / 127;
            normals[p + 2] = qNrm[p + 2] / 127;

            uvs[i * 2] = qUV[i * 2] / 65535;
            uvs[i * 2 + 1] = qUV[i * 2 + 1] / 65535;
            aux[i * 2] = qSlot[i];

            const b = i * 4;
            for (let k = 0; k < 4; k++) {
                boneIdx[b + k] = qIdx[b + k];
                boneWt[b + k] = qWt[b + k] / 255;
            }
        }

        const indices = view(`indices${level}`);
        return {
            positions, normals, uvs, aux, boneIdx, boneWt, indices,
            vertexCount: n,
            triangleCount: indices.length / 3,
        };
    };

    // Named `out` rather than `asset`: `asset()` is the URL resolver the assets
    // module exports, and a `const asset` anywhere in this function would put it
    // in the temporal dead zone for the whole body — including the fetch on
    // line one.
    const out = {
        header,
        lods: header.lods.map((l) => readLOD(l.level)),
        anim: view("anim"),
        albedo: null,
        orm: null,
    };

    // Extra clips, if the bake carried any (hit reactions, deaths). Each is a
    // view into the same anim table; the runtime's cycle stays clip 0, which
    // `header.frameCount`/`duration` still describe, so a model without these
    // loads exactly as before.
    out.clips = null;
    if (header.clips) {
        out.clips = {};
        const stride = header.boneCount * 12;
        for (const c of header.clips) {
            out.clips[c.name] = {
                anim: out.anim.subarray(c.frame0 * stride, (c.frame0 + c.frameCount) * stride),
                frameCount: c.frameCount,
                duration: c.duration,
            };
        }
    }

    const size = header.textureSize;
    out.layers = layersFor(header.materials);

    // Both arrays stay at the model's own texture size, including the ORM of a
    // model that has no ORM maps and gets a plain white one. Shrinking that to a
    // single texel is obviously free VRAM and was tried; it is also a mipmapped,
    // anisotropically-filtered 1x1 array texture, which is enough of an edge case
    // that "obviously equivalent" stopped being something worth asserting without
    // a frame to look at. The white array costs memory and nothing else.
    out.albedoSize = size;
    out.ormSize = size;

    const [albedo, orm] = await Promise.all([
        loadLayers(base, "albedo", header.materials, size, out.layers, !!opts?.srgbAlbedo),
        // Never the ORM: occlusion, roughness and metalness are data, not colour,
        // and are authored linear already.
        loadLayers(base, "orm", header.materials, out.ormSize, out.layers, false),
    ]);
    out.albedo = albedo;
    out.orm = orm;
    return out;
}

/**
 * Decode one image per material into a single layer-major RGBA buffer.
 *
 * Materials with no map of this kind get a white layer, which the per-slot
 * factor uniforms then scale — so the shader never has to branch on whether a
 * slot is textured.
 */
async function loadLayers(base, kind, materials, size, layers, srgb) {
    const stride = size * size * 4;
    const out = new Uint8Array(stride * layers);
    out.fill(255);

    const canvas = new OffscreenCanvas(size, size);
    const ctx = canvas.getContext("2d", { willReadFrequently: true });

    await Promise.all(materials.map(async (m) => {
        const key = kind === "albedo" ? "albedoImage" : "ormImage";
        if (m[key] < 0 || m.slot >= layers) return;
        const res = await fetchAsset(`${base}_${kind}_${m.slot}.webp`);
        const bitmap = await createImageBitmap(await res.blob());
        // Drawn rather than copied: it costs nothing and it means a texture that
        // came out of the bake at some other size still lands in the array.
        ctx.clearRect(0, 0, size, size);
        ctx.drawImage(bitmap, 0, 0, size, size);
        bitmap.close();
        const px = new Uint8Array(ctx.getImageData(0, 0, size, size).data.buffer);
        if (srgb) {
            // RGB through the curve; alpha is coverage, not colour.
            for (let i = 0; i < px.length; i += 4) {
                px[i] = SRGB_TO_LINEAR[px[i]];
                px[i + 1] = SRGB_TO_LINEAR[px[i + 1]];
                px[i + 2] = SRGB_TO_LINEAR[px[i + 2]];
            }
        }
        out.set(px, m.slot * stride);
    }));

    return out;
}

export { layersFor as walkerTextureLayers };
