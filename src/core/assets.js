/**
 * Where the binaries come from.
 *
 * Everything the demo *renders* is generated on the GPU at load; the things
 * that cannot be are the sounds and the baked machines. They ship in `public/`
 * and are served from this site's own origin — same host as the page, one
 * connection already open, no DNS and no second TLS handshake.
 *
 * It used to default to a public Vercel Blob store, on the reasoning that a
 * CDN with a long cache beats the deploy's own origin. That store is gone (it
 * answers 403 to everything), and the fallback in `fetchAsset` below meant the
 * cost was invisible but real: every sound and every model paid a failed
 * cross-origin round-trip *before* falling back to the copy that was sitting
 * in `public/` all along. Forty-odd assets, forty-odd wasted requests, on
 * every cold load. The origin is the default now; the fallback chain is kept
 * because it is still the right answer for the gap between adding an asset and
 * uploading it anywhere.
 *
 * One base, resolved once. Both loaders — `audio/engine.js` for the manifest and
 * `walkers/walkerAsset.js` for the model — call `asset()` with the same paths
 * they would have used relative to `public/`, so the layout on any store
 * mirrors the layout in the repository exactly and either can serve the other.
 *
 * Overridable at build time:
 *
 *   VITE_ASSET_BASE=https://…   serve the heavy files from a CDN instead
 *   VITE_ASSET_BASE=            (or unset) this site's own origin
 *
 * A remote store must return `access-control-allow-origin: *`, which is what
 * makes `decodeAudioData` and `createImageBitmap` legal on those bytes at all —
 * a store without it fails at the fetch, not at the decode, and the error does
 * not mention CORS. Same-origin has no such problem, which is one more reason
 * it is the default.
 */

const DEFAULT_BASE = "";

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
