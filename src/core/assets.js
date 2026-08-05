/**
 * Where the binaries come from.
 *
 * Everything the demo *renders* is generated on the GPU at load; the two things
 * that cannot be are the sounds and the walker, and between them they are about
 * seven megabytes. Those live in a public Vercel Blob store rather than in
 * `public/`, which keeps the git repository and the deploy bundle to source, and
 * puts the heavy files on a CDN with a thirty-day cache instead of on the
 * function's own origin.
 *
 * One base, resolved once. Both loaders — `audio/engine.js` for the manifest and
 * `walkers/walkerAsset.js` for the model — call `asset()` with the same paths
 * they would have used relative to `public/`, so the layout on the store mirrors
 * the layout in the repository exactly and either can serve the other.
 *
 * Overridable at build time:
 *
 *   VITE_ASSET_BASE=            serve from `public/` (a clone with the files
 *                               still in it runs offline this way)
 *   VITE_ASSET_BASE=https://…   any other origin, no trailing slash needed
 *
 * The store is public and returns `access-control-allow-origin: *`, which is what
 * makes `decodeAudioData` and `createImageBitmap` legal on these bytes at all —
 * a store without it would fail at the fetch, not at the decode, and the error
 * would not mention CORS.
 */

const DEFAULT_BASE = "https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com";

/** Trailing slashes stripped, so `asset()` never emits a double slash. */
export const ASSET_BASE = String(
    import.meta.env?.VITE_ASSET_BASE ?? DEFAULT_BASE
).replace(/\/+$/, "");

/**
 * Resolve one asset path.
 *
 * @param {string} path relative to the store root, e.g. `audio/ambiance.mp3`
 * @returns {string} an absolute URL, or `path` untouched when no base is set
 */
export function asset(path) {
    const clean = path.replace(/^\/+/, "");
    return ASSET_BASE ? `${ASSET_BASE}/${clean}` : clean;
}

/**
 * Every place an asset might be, best first.
 *
 * The store is the source of truth, and this origin is the fallback — which is
 * not a redundancy so much as the answer to the gap between adding an asset and
 * uploading it. A new sound committed to `public/audio/` works immediately,
 * locally and on a deploy, and silently switches to the CDN copy the moment one
 * exists. Nothing has to be kept in step by hand and nothing 404s in between.
 *
 * @param {string} path
 * @returns {string[]}
 */
export function assetCandidates(path) {
    const clean = path.replace(/^\/+/, "");
    const primary = asset(clean);
    return primary === clean ? [clean] : [primary, clean];
}

/**
 * Fetch an asset from the first place that has it.
 * @param {string} path
 * @returns {Promise<Response>}
 */
export async function fetchAsset(path) {
    const urls = assetCandidates(path);
    let lastError = null;
    for (const url of urls) {
        try {
            const res = await fetch(url);
            if (res.ok) return res;
            lastError = new Error(`${url} — HTTP ${res.status}`);
        } catch (err) {
            lastError = err;
        }
    }
    throw lastError || new Error(`asset not found: ${path}`);
}
