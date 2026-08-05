/**
 * The GLSL shader registry — the port of Babylon's `ShaderStore`.
 *
 * Shared libraries resolve through `#include<...>` so the height bake and the
 * runtime snow material compile literally the same text — the terrain would
 * pull apart at the seams if they ever drifted. Whole shaders are looked up
 * under the names the Babylon build used: `<name>VertexShader` and
 * `<name>PixelShader`.
 *
 * Every `src/shaders/**?/*.glsl` file is loaded raw at build time:
 *
 *   lib/<base>.glsl          → include `snow<Base>`   (snowNoise, snowTerrain, …)
 *   <base>.vertex.glsl       → `<base>VertexShader`
 *   <base>.fragment.glsl     → `<base>PixelShader`
 *
 * Subdirectories other than `lib/` (e.g. `post/`) follow the same
 * vertex/fragment rule — the path only decides ownership, not the name.
 *
 * `registerShaders()` must run before any material is constructed; it is
 * idempotent, and `composeShader`/`getShader` self-register defensively.
 */

// Vite: eager raw imports of every shader in this tree. (`as: "raw"` is the
// pre-Vite-6 spelling; `query`/`import` is the current one.)
const RAW = import.meta.glob("./**/*.glsl", {
    query: "?raw",
    import: "default",
    eager: true,
});

/** @type {Record<string, string>} include name -> source */
const INCLUDES = Object.create(null);
/** @type {Record<string, string>} logical shader name -> source */
const SHADERS = Object.create(null);

let registered = false;

export function registerShaders() {
    if (registered) return;
    registered = true;

    for (const path in RAW) {
        const src = RAW[path];
        const file = path.slice(path.lastIndexOf("/") + 1);

        if (path.includes("/lib/")) {
            const base = file.replace(/\.glsl$/, "");
            const name = "snow" + base.charAt(0).toUpperCase() + base.slice(1);
            if (name in INCLUDES) {
                console.warn("[shaders] duplicate include name:", name, "from", path);
            }
            INCLUDES[name] = src;
            continue;
        }

        let m = /^(.+)\.vertex\.glsl$/.exec(file);
        if (m) {
            store(m[1] + "VertexShader", src, path);
            continue;
        }
        m = /^(.+)\.fragment\.glsl$/.exec(file);
        if (m) {
            store(m[1] + "PixelShader", src, path);
            continue;
        }
        console.warn("[shaders] unrecognised shader filename:", path);
    }
}

function store(name, src, path) {
    if (name in SHADERS) {
        console.warn("[shaders] duplicate shader name:", name, "from", path);
    }
    SHADERS[name] = src;
}

/**
 * Fetch a shader's raw (un-composed) source by its logical name, e.g.
 * `"snowVertexShader"` or `"deformSimPixelShader"`.
 * @param {string} name
 * @returns {string}
 */
export function getShader(name) {
    registerShaders();
    const src = SHADERS[name];
    if (src === undefined) {
        throw new Error("[shaders] unknown shader: " + name);
    }
    return src;
}

const INCLUDE_RE = /#include\s*<(\w+)>/g;

/**
 * Resolve every `#include<snowXxx>` in `source` by textual substitution,
 * recursively, before compile. Each chunk is substituted at most once per
 * compile unit (deduped by name) so shared libraries can include each other
 * without doubling definitions.
 * @param {string} source
 * @returns {string}
 */
export function composeShader(source) {
    registerShaders();
    return resolve(source, new Set());
}

/**
 * @param {string} src
 * @param {Set<string>} seen
 */
function resolve(src, seen) {
    return src.replace(INCLUDE_RE, (_full, name) => {
        if (seen.has(name)) return "";
        seen.add(name);
        const lib = INCLUDES[name];
        if (lib === undefined) {
            throw new Error("[shaders] unknown include <" + name + ">");
        }
        return resolve(lib, seen);
    });
}
