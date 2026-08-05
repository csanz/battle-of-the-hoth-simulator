/**
 * Cascaded shadow maps, hand-rolled.
 *
 * Three's shadow machinery is not used here for a specific reason: the terrain
 * has no CPU-side geometry. Its vertices are grid indices, and where they
 * actually land is decided by the clipmap vertex shader from the camera
 * position. Any generic depth pass would render the undisplaced lattice — a
 * flat sheet at y=0 — and the terrain would shadow against a surface that does
 * not exist. The depth pass has to run the same displacement code, which means
 * owning the pass.
 *
 * Owning it also buys the filtering: depth goes into plain R32F colour targets
 * (the casters write `gl_FragCoord.z`), so PCSS can run a real blocker search.
 * A hardware comparison sampler only ever returns a pre-thresholded result,
 * which a blocker search cannot use.
 *
 * Three cascades, not four. The fourth would cover 320 m and beyond, where the
 * aerial perspective has already compressed contrast to the point that no
 * shadow in it is legible — it would be four milliseconds of shadow map nobody
 * can see.
 */

import * as THREE from "three";
import { lookAtLH, orthoOffCenterLH, mulMat4, invertMat4 } from "../core/mat4.js";

export const CASCADE_COUNT = 3;
const RESOLUTION = 2048;

/** Far distance of each cascade, metres. */
const SPLITS = [26, 95, 330];

// ------------------------------------------------------- module-scope scratch
const _corners = [];
for (let i = 0; i < 8; i++) _corners.push(new THREE.Vector3());
const _center = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);
const _right = new THREE.Vector3();
const _lup = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _vp = new Float32Array(16);
const _invViewProj = new Float32Array(16);
const _lightView = new Float32Array(16);
const _lightProj = new Float32Array(16);

/** Clear color: the far plane — anything unwritten occludes nothing. */
const CLEAR_FAR = [1, 1, 1, 1];

// NDC cube corners. This build rasterises through GL clip space, so the depth
// range of the unprojection cube is [-1, 1] — not the source's WebGPU [0, 1].
const NDC = [
    [-1, -1, -1], [1, -1, -1], [1, 1, -1], [-1, 1, -1],
    [-1, -1, 1], [1, -1, 1], [1, 1, 1], [-1, 1, 1],
];

/** TransformCoordinates: full 4x4 with the w divide, into `out`. */
function xformCoord(m, x, y, z, out) {
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1;
    const iw = 1 / w;
    out.set(
        (m[0] * x + m[4] * y + m[8] * z + m[12]) * iw,
        (m[1] * x + m[5] * y + m[9] * z + m[13]) * iw,
        (m[2] * x + m[6] * y + m[10] * z + m[14]) * iw
    );
}

export class ShadowSystem {
    /** @param {import("../core/gfx.js").Gfx} gfx */
    constructor(gfx) {
        this.gfx = gfx;

        /** @type {THREE.WebGLRenderTarget[]} the R32F cascade targets */
        this._rts = [];
        /** @type {THREE.Texture[]} bound as `cascade0/1/2` samplers. */
        this.maps = [];
        /** @type {THREE.Material[]} every per-cascade caster material. */
        this.materials = [];

        /**
         * Per-cascade light view-projections. Each `Matrix4.elements` is an
         * aliased subarray view of `matrixData`, so flattening is free and
         * consumers can bind either form zero-copy.
         * @type {THREE.Matrix4[]}
         */
        this.matrices = [];
        /** Flat array of 16*CASCADE_COUNT floats for uniform upload. */
        this.matrixData = new Float32Array(16 * CASCADE_COUNT);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            const m = new THREE.Matrix4();
            m.elements = this.matrixData.subarray(i * 16, i * 16 + 16);
            m.identity();
            this.matrices.push(m);
        }
        /** The §7.2 binding idiom — the same aliased Matrix4 instances. */
        this.matrixValues = this.matrices;

        this.splits = new Float32Array(4);
        for (let i = 0; i < CASCADE_COUNT; i++) this.splits[i] = SPLITS[i];
        this.splits[3] = SPLITS[CASCADE_COUNT - 1];
        /** The same four numbers as a shared Vector4 (`cascadeSplits`). */
        this.splitsVec4 = new THREE.Vector4(
            this.splits[0], this.splits[1], this.splits[2], this.splits[3]
        );

        this.texelSize = 1 / RESOLUTION;
        this.resolution = RESOLUTION;

        /**
         * Per cascade, as vec4s for the shader: (depth range m, ortho width m,
         * 0, 0). PCSS needs both to work in metres rather than in NDC.
         * @type {THREE.Vector4[]}
         */
        this.params = [];
        for (let i = 0; i < CASCADE_COUNT; i++) this.params.push(new THREE.Vector4(1, 1, 0, 0));
        /** Flat mirror of `params` for the uniform upload (`cascadeParams`). */
        this.paramData = new Float32Array(4 * CASCADE_COUNT);

        const filter = gfx.caps.floatLinear ? THREE.LinearFilter : THREE.NearestFilter;
        for (let i = 0; i < CASCADE_COUNT; i++) {
            const rt = gfx.makeRenderTarget("cascade" + i, RESOLUTION, RESOLUTION, {
                type: THREE.FloatType,
                format: THREE.RedFormat,
                filter,
                depth: true,
            });
            this._rts.push(rt);
            this.maps.push(rt.texture);
        }

        /** Direction the light *travels* (= −sunDir). */
        this.lightDir = new THREE.Vector3(0, -1, 0);

        /**
         * World height range the casters occupy. Feeds the light volume's depth
         * solve in `_fitCascade`; conservative defaults until the heightfield is
         * baked and `setHeightBounds` narrows them.
         */
        this.minHeight = -60;
        this.maxHeight = 60;
        /** Slack on the cascade's Y extent, covering the texel snap. */
        this.texelWorldPad = 2;

        /** @type {{mesh: THREE.Object3D, material: THREE.Material}[][]} */
        this._casters = [];
        for (let i = 0; i < CASCADE_COUNT; i++) this._casters.push([]);
    }

    /**
     * Tell the cascade fitter how tall the world actually is.
     * @param {number} min @param {number} max metres
     */
    setHeightBounds(min, max) {
        this.minHeight = min;
        this.maxHeight = max;
    }

    /**
     * Register a mesh as a shadow caster, rendered with the material
     * `makeMaterial(cascade)` returns — which must declare a
     * `lightViewProjection` uniform.
     *
     * One material instance per cascade, so each can hold its own matrix without
     * any mid-frame uniform juggling.
     *
     * `cascades` limits how far out a caster is drawn. The terrain needs all
     * three; a two-metre character does not — cascade 2 covers 330 m at 32 cm
     * per texel, where the whole figure is two texels wide.
     *
     * @param {THREE.Object3D} mesh
     * @param {(cascade:number) => THREE.Material} makeMaterial
     * @param {number} [cascades] how many cascades to cast into, from the near end
     */
    registerCaster(mesh, makeMaterial, cascades) {
        if (!mesh || !makeMaterial) return;
        const n = Math.min(cascades === undefined ? CASCADE_COUNT : cascades, CASCADE_COUNT);
        for (let i = 0; i < n; i++) {
            const mat = makeMaterial(i);
            if (!mat) continue;
            this._casters[i].push({ mesh, material: mat });
            this.materials.push(mat);
        }
    }

    /**
     * Refit every cascade to the current camera frustum and sun direction.
     * @param {{view: THREE.Matrix4, projection: THREE.Matrix4, minZ: number,
     *          maxZ: number}} camera the rig camera (plain object)
     * @param {THREE.Vector3} sunDir unit vector pointing *toward* the sun
     */
    update(camera, sunDir) {
        this.lightDir.copy(sunDir).multiplyScalar(-1).normalize();

        // Babylon `view.multiplyToRef(proj)` == column-convention proj * view.
        mulMat4(_vp, camera.projection.elements, camera.view.elements);
        invertMat4(_invViewProj, _vp);

        const near = camera.minZ;
        // The camera's *far plane*, not the last cascade split: `_fitCascade`
        // re-parameterises the frustum's corner edges, which run minZ..maxZ, so
        // that is the span each cut must be normalised against.
        const farPlane = camera.maxZ;

        let sliceNear = near;
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const sliceFar = SPLITS[c];
            this._fitCascade(c, sliceNear, sliceFar, near, farPlane);
            // Overlap slices slightly so the cross-fade band has real data in
            // both cascades.
            sliceNear = sliceFar * 0.88;
        }

        // Flatten for the uniform upload. The matrices already alias
        // `matrixData`; only the params need copying.
        for (let c = 0; c < CASCADE_COUNT; c++) {
            const p = this.params[c];
            this.paramData[c * 4] = p.x;
            this.paramData[c * 4 + 1] = p.y;
            this.paramData[c * 4 + 2] = p.z;
            this.paramData[c * 4 + 3] = p.w;
        }
    }

    _fitCascade(c, sliceNear, sliceFar, camNear, camFar) {
        // Frustum slice corners, by unprojecting the NDC cube and re-cutting it
        // at the slice distances along each edge.
        for (let i = 0; i < 8; i++) {
            const n = NDC[i];
            xformCoord(_invViewProj, n[0], n[1], n[2], _corners[i]);
        }
        for (let i = 0; i < 4; i++) {
            const nearC = _corners[i];
            const farC = _corners[i + 4];
            _tmp.copy(farC).sub(nearC);
            const len = _tmp.length();
            _tmp.multiplyScalar(1 / len);
            // The unprojected corners span camNear..camFar; re-parameterise.
            const t0 = (sliceNear - camNear) / (camFar - camNear);
            const t1 = (sliceFar - camNear) / (camFar - camNear);
            farC.copy(nearC).addScaledVector(_tmp, len * t1);
            nearC.addScaledVector(_tmp, len * t0);
        }

        // Bounding *sphere*, not box. A sphere is rotation-invariant, so the
        // fitted extent does not change as the camera turns — which is what
        // stops the shadow edges crawling when you look around.
        _center.set(0, 0, 0);
        for (let i = 0; i < 8; i++) _center.add(_corners[i]);
        _center.multiplyScalar(1 / 8);

        let radius = 0;
        for (let i = 0; i < 8; i++) {
            const d = _center.distanceTo(_corners[i]);
            if (d > radius) radius = d;
        }

        // Quantise the radius *relatively*, not to a fixed fraction of a metre.
        // The radius depends only on the FOV, the aspect and the two splits, but
        // it is measured by unprojecting the NDC cube through an inverted
        // view-projection, so it carries a few ULPs of round-trip noise. An
        // absolute quantum lets that noise cross a step, and a radius change
        // rescales the whole map and defeats the snapping below. ~0.4% of the
        // radius sits well above the noise floor at every cascade size and still
        // tracks a real FOV change (the rig widens the FOV with speed).
        radius = Math.max(radius, 0.5);
        const q = Math.pow(2, Math.ceil(Math.log2(radius)) - 8);
        radius = Math.ceil(radius / q) * q;

        // Degenerate up-vector guard for a sun near the zenith.
        if (Math.abs(this.lightDir.y) > 0.995) _up.set(0, 0, 1);
        else _up.set(0, 1, 0);

        // ---- how deep the light volume actually has to be ------------------
        //
        // Solved rather than budgeted. At a grazing sun the ground lies almost
        // *along* the light: it gains cot(elevation) metres of light-space depth
        // per metre travelled across the light's view, which at 13 degrees is
        // 4.33. Across cascade 2 that is thousands of metres of depth, so any
        // fixed budget clips most of the terrain out of the depth map — and
        // because `radius` is fitted to the camera frustum, the clipping planes
        // then move whenever the camera turns.
        //
        // `_right` is horizontal by construction (up x forward, with up = +Y),
        // so a point's height depends only on its light-space Y and depth:
        //
        //     p.y - c.y = yRel * up.y + depth * fwd.y
        //
        // Rearranged for depth and evaluated at the four combinations of the
        // box's Y extent and the terrain's height extent, that gives the exact
        // range of light-space depth the snow can occupy inside this cascade.
        _right.crossVectors(_up, this.lightDir);
        _right.normalize();
        _lup.crossVectors(this.lightDir, _right);

        // ---- texel snapping ---------------------------------------------
        // Quantise the cascade centre onto the shadow map's own texel lattice,
        // in world space, along the light's two lateral axes. Without it the map
        // resamples every frame and every shadow edge crawls — which TAA smears
        // rather than fixes.
        //
        // This has to happen here, in world space, *before* the light view matrix
        // is built. Snapping afterwards by projecting `_center` through the matrix
        // that was built to look at it is self-referential: that maps it to
        // light-space (0, 0, backoff) by construction, so both quantised
        // coordinates are identically zero and the snap does nothing. `_right`
        // and `_lup` are the same orthonormal pair `lookAtLH` rebuilds below.
        const texelWorld = (radius * 2) / RESOLUTION;
        const cr = Math.floor(_center.dot(_right) / texelWorld) * texelWorld;
        const cu = Math.floor(_center.dot(_lup) / texelWorld) * texelWorld;
        const cf = _center.dot(this.lightDir);
        _center.set(
            _right.x * cr + _lup.x * cu + this.lightDir.x * cf,
            _right.y * cr + _lup.y * cu + this.lightDir.y * cf,
            _right.z * cr + _lup.z * cu + this.lightDir.z * cf
        );

        // Grazing enough and this runs away — cot(0.5 deg) is 114. Clamped to
        // 2 degrees, past which the sun carries no useful energy anyway and the
        // whole field is in shadow regardless.
        const fy = Math.min(this.lightDir.y, -0.0349);
        const relief = radius + this.texelWorldPad;

        let gMin = Infinity;
        let gMax = -Infinity;
        for (let i = 0; i < 4; i++) {
            const yRel = i < 2 ? -relief : relief;
            const py = i % 2 === 0 ? this.minHeight : this.maxHeight;
            const g = (py - _center.y - yRel * _lup.y) / fy;
            if (g < gMin) gMin = g;
            if (g > gMax) gMax = g;
        }

        // Margin absorbs carved berms, the character and anything else standing
        // proud of the baked heightfield.
        const MARGIN = 12;
        const backoff = MARGIN - gMin;
        _eye.copy(this.lightDir).multiplyScalar(-backoff).add(_center);

        lookAtLH(
            _lightView,
            _eye.x, _eye.y, _eye.z,
            _center.x, _center.y, _center.z,
            _up.x, _up.y, _up.z
        );

        // Both ends now come from the solve above, so the whole terrain inside
        // this cascade is inside the volume — at any sun elevation.
        const near = MARGIN * 0.5;
        const far = backoff + gMax + MARGIN;

        // GL ortho: NDC z in [-1, 1]. The source's `halfZRange` flag mapped
        // WebGPU's [0, 1]; here the caster fragments write `gl_FragCoord.z`
        // (window depth 0..1 over the same near..far), and the shadow lookup
        // remaps `ndc.z * 0.5 + 0.5` before comparing — the three conventions
        // move together.
        //
        // Centred on light-space zero, which is where `_lightView` puts the
        // (already snapped) cascade centre.
        orthoOffCenterLH(
            _lightProj,
            -radius, radius,
            -radius, radius,
            near, far
        );

        // Babylon `_lightView.multiplyToRef(_lightProj, out)` == out = proj * view.
        mulMat4(this.matrices[c].elements, _lightProj, _lightView);

        // World-space extents, so the shader's penumbra estimate is in metres.
        this.params[c].set(far - near, radius * 2, 0, 0);

        const list = this._casters[c];
        for (let i = 0; i < list.length; i++) {
            const u = list[i].material.uniforms;
            if (u && u.lightViewProjection) u.lightViewProjection.value = this.matrices[c];
        }
    }

    /**
     * Render the three cascades (§4.3 step 2): clear each to the far plane and
     * draw every registered caster with its per-cascade material.
     * @param {import("../core/gfx.js").Gfx} gfx
     */
    render(gfx) {
        for (let c = 0; c < CASCADE_COUNT; c++) {
            gfx.runPass({
                target: this._rts[c],
                clearColor: CLEAR_FAR,
                clearDepth: true,
                casters: this._casters[c],
            });
        }
    }

    dispose() {
        for (const rt of this._rts) rt.dispose();
        for (const m of this.materials) m.dispose();
        this._rts.length = 0;
        this.maps.length = 0;
        this.materials.length = 0;
        for (const list of this._casters) list.length = 0;
    }
}
