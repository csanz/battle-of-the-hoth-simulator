/**
 * The bent-water renderer — one mesh, one material, one draw, eight strands.
 *
 * Four of the five spells move a coherent body of water, and they are all the
 * same object: a swept surface along a spine, with a radius, a transported frame
 * and a foam channel. Giving each spell its own mesh would mean four pipelines,
 * four warm-ups, four sets of shadow-and-fog uniforms, and four slightly
 * different ideas about what lit water looks like. There is one of each here.
 *
 * A strand is claimed with `acquire()`, written per frame with `column()`, and
 * dropped with `release()`. Releasing zeroes the strand's rows, which is also how
 * it is switched off: a zero radius puts every vertex of that strand on one
 * point, so its triangles have no area and the rasteriser skips them. The draw
 * call and the vertex count therefore do not depend on how many spells are up.
 *
 * The frame is parallel-transported along the spine on the CPU rather than
 * rebuilt from a fixed up-vector. A ribbon drawn through the air passes through
 * vertical, and a Frenet or up-referenced frame flips there — the section spins
 * 180 degrees in one sample and the ribbon visibly folds. Transport has no such
 * degeneracy: each frame is the previous one rotated by the minimum rotation
 * taking the old tangent to the new one.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { CASCADE_COUNT } from "../render/shadows.js";

/** Must match `vec4 strandParams[8]` in `water.vertex.glsl`. */
export const STRAND_MAX = 8;

/**
 * Spine *samples* per strand — the width of the data texture, and the most
 * columns any spell may write.
 *
 * Raised from 48 for the Vortex, whose helices are the tightest curve anything
 * here draws. A cubic through samples on a circular arc carries a radial error
 * that is zero at every knot and peaks in the middle of each span — which is
 * exactly a scallop per sample, and on a 12 cm tube wound round a 2.5 m helix at
 * thirty samples a turn it was a tenth of the radius. The helices came out
 * looking like vertebrae. The error falls with the square of the sample spacing,
 * so going to sixty-four samples takes it under a percent.
 */
export const STRAND_COLS = 64;

/**
 * Spine *vertices* per strand — the width of the lattice.
 *
 * Decoupled from the sample count, and it has to be. The surface is a spline
 * through the samples, so it has real curvature between them; drawing it at
 * barely more than one vertex per sample renders that curvature as a polygon and
 * the body comes out visibly segmented — the thing that makes a swept tube look
 * like a length of pipe rather than like moving water. Nearly three vertices per
 * sample is where the segmentation stops being findable.
 *
 * It is also the sampling rate the relief field has to stay under; see the note
 * on `waterRelief`.
 */
export const LATTICE_COLS = 176;

/**
 * Vertices around the section.
 *
 * The last one coincides with the first — a tube is closed, so ring 17 sits at
 * theta = 2*PI which is theta = 0. Duplicating the seam vertex rather than
 * wrapping the index is what lets the same lattice serve the open sheet profile,
 * where ring 17 is genuinely the far edge and not the near one.
 *
 * Twenty-four rather than twelve. A twelve-sided tube seen at two metres has a
 * readable dodecagonal silhouette, and once you have noticed it you cannot stop:
 * it is the single clearest tell that the water is a mesh. It also caps how much
 * detail the relief field is allowed to put *around* the section — and detail
 * around the section, rather than along it, is exactly what stops a tube reading
 * as a string of beads.
 */
export const RING = 24;

export const PROFILE_TUBE = 0;
export const PROFILE_SHEET = 1;

/** Resolve the sky LUT handle to a bindable texture, or a black stub (G1). */
function lutTexture(sky, gfx) {
    const lut = sky && sky.lut;
    if (!lut) return gfx.blackTex;
    if (lut.isTexture) return lut;
    if (lut.texture) return lut.texture;
    return gfx.blackTex;
}

/** Resolve one cascade map, or a black stub (G1). */
function cascadeTexture(shadows, i, gfx) {
    const map = shadows && shadows.maps && shadows.maps[i];
    return map || gfx.blackTex;
}

export class WaterBody {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./spellLights.js").SpellLights} lights
     * @param {import("../core/camera.js").CameraRig} rig
     */
    constructor(gfx, sky, shadows, lights, rig) {
        this.gfx = gfx;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;
        this.rig = rig;

        // Three rows per strand: (pos, radius) / (right, twist) / (dist, age, foam, flatten)
        this._texData = new Float32Array(STRAND_COLS * STRAND_MAX * 3 * 4);
        this.dataTex = new THREE.DataTexture(
            this._texData, STRAND_COLS, STRAND_MAX * 3,
            THREE.RGBAFormat, THREE.FloatType
        );
        this.dataTex.colorSpace = THREE.NoColorSpace;
        this.dataTex.flipY = false;
        this.dataTex.premultiplyAlpha = false;
        this.dataTex.generateMipmaps = false;
        this.dataTex.minFilter = THREE.NearestFilter;
        this.dataTex.magFilter = THREE.NearestFilter;
        this.dataTex.wrapS = THREE.ClampToEdgeWrapping;
        this.dataTex.wrapT = THREE.ClampToEdgeWrapping;
        this.dataTex.needsUpdate = true;

        /** (profile, milkiness, alpha, column count) per strand. */
        this._params = new Float32Array(STRAND_MAX * 4);
        /** @type {boolean[]} */
        this._used = new Array(STRAND_MAX).fill(false);

        this._camPos = new THREE.Vector3();
        this._t = 0;
        this._live = 0;

        this.mesh = buildLattice();
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the spray, after the opaque pass (LAYER.BLEND, renderOrder 30).
        // Water first: mist hanging in front of a body of water is much commoner
        // than the reverse, and neither writes depth.
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 30);
        this.mesh.visible = false;
    }

    _makeMaterial() {
        const gfx = this.gfx;
        const sky = this.sky;
        const sh = this.shadows;

        // Stub-tolerant shared-object bindings (G1): if a peer is absent, a
        // local placeholder keeps the pipeline valid — the material still only
        // ever binds by the §7 names, so a live peer drops straight in.
        const uniforms = {
            viewProjection: {
                value: this.rig && this.rig.camera
                    ? this.rig.camera.viewProjection
                    : new THREE.Matrix4(),
            },
            cameraPos: { value: this._camPos },
            waterCols: { value: LATTICE_COLS },
            waterRings: { value: RING },
            waterTime: { value: 0 },
            strandParams: { value: this._params },

            sunDir: { value: sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0) },
            sunRadiance: {
                value: sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(1, 1, 1),
            },
            shR: { value: sky && sky.sh ? sky.sh : new Float32Array(36) },

            cascadeMatrices: {
                value: sh && sh.matrixValues ? sh.matrixValues
                    : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
            },
            cascadeSplits: {
                value: sh && sh.splitsVec4 ? sh.splitsVec4
                    : new THREE.Vector4(26, 95, 330, 330),
            },
            cascadeParams: { value: sh && sh.paramData ? sh.paramData : new Float32Array(12) },
            shadowTexel: { value: sh && sh.texelSize ? sh.texelSize : 1 / 2048 },
            shadowSoftness: { value: 1.4 },
            shadowBias: { value: 0.03 },

            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity },
            sssStrength: { value: S.sssStrength },
            glintIntensity: { value: S.glintIntensity },
            glintGrazing: { value: S.glintGrazing },
            waterDepthTint: { value: S.waterDepthTint },

            // SPELL_LIGHT_UNIFORMS — bound zero-copy to the pool's flat arrays.
            spellLightPos: { value: this.lights.pos },
            spellLightCol: { value: this.lights.col },
            spellLightCount: { value: 0 },

            waterTex: { value: this.dataTex },
            skyLUT: { value: lutTexture(sky, gfx) },
            cascade0: { value: cascadeTexture(this.shadows, 0, gfx) },
            cascade1: { value: cascadeTexture(this.shadows, 1, gfx) },
            cascade2: { value: cascadeTexture(this.shadows, 2, gfx) },
        };

        // A transparent body seen from both sides — looking through the near wall
        // at the far one is most of what makes it read as a volume.
        return makeMaterial({
            name: "spellWater",
            vertex: getShader("waterVertexShader"),
            fragment: getShader("waterPixelShader"),
            uniforms,
            transparent: true,
            blending: THREE.NormalBlending,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
    }

    // ------------------------------------------------------------ strand pool

    /** @returns {number} strand index, or -1 when the pool is exhausted. */
    acquire() {
        for (let i = 0; i < STRAND_MAX; i++) {
            if (!this._used[i]) {
                this._used[i] = true;
                this.clear(i);
                return i;
            }
        }
        return -1;
    }

    /** @param {number} s */
    release(s) {
        if (s < 0 || s >= STRAND_MAX) return;
        this._used[s] = false;
        this.clear(s);
    }

    /** Zero a strand's rows and parameters. */
    clear(s) {
        const d = this._texData;
        const base = s * 3 * STRAND_COLS * 4;
        d.fill(0, base, base + STRAND_COLS * 3 * 4);
        const p = s * 4;
        this._params[p] = 0;
        this._params[p + 1] = 0;
        this._params[p + 2] = 0;
        this._params[p + 3] = 0;
    }

    /**
     * Per-strand constants for this frame.
     * @param {number} s
     * @param {number} profile PROFILE_TUBE or PROFILE_SHEET
     * @param {number} milkiness 0 clear water, 1 opaque slush
     * @param {number} alpha global fade, 0 hides the strand
     * @param {number} count live columns, 2..STRAND_COLS
     */
    setParams(s, profile, milkiness, alpha, count) {
        const p = s * 4;
        this._params[p] = profile;
        this._params[p + 1] = milkiness;
        this._params[p + 2] = alpha;
        this._params[p + 3] = count < 2 ? 0 : Math.min(count, STRAND_COLS);
    }

    /**
     * Write one spine sample.
     *
     * `rx/ry/rz` is the reference right vector; it does not have to be exactly
     * perpendicular to the tangent, since the shader re-orthogonalises. It does
     * have to be *transported* — see the note at the top of the file.
     *
     * @param {number} s strand
     * @param {number} c column, 0 = head
     * @param {number} x @param {number} y @param {number} z world position
     * @param {number} radius metres. Must taper to ~0 at both ends.
     * @param {number} rx @param {number} ry @param {number} rz reference right
     * @param {number} twist section roll (tube) or curl (sheet)
     * @param {number} dist metres along the spine, drives the relief field
     * @param {number} age 0..1
     * @param {number} foam 0..1
     * @param {number} flatten vertical squash of the section, 1 = round
     */
    column(s, c, x, y, z, radius, rx, ry, rz, twist, dist, age, foam, flatten) {
        if (c < 0 || c >= STRAND_COLS) return;
        const d = this._texData;
        const row = s * 3;
        const w = STRAND_COLS * 4;
        let o = row * w + c * 4;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = radius;
        o += w;
        d[o] = rx; d[o + 1] = ry; d[o + 2] = rz; d[o + 3] = twist;
        o += w;
        d[o] = dist; d[o + 1] = age; d[o + 2] = foam; d[o + 3] = flatten;
    }

    // ---------------------------------------------------------------- frame

    /**
     * Upload and push uniforms. Called after every spell has written its strands.
     * @param {number} dt
     * @param {THREE.Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._t += dt;
        this._camPos.copy(cameraPos);

        let live = 0;
        for (let i = 0; i < STRAND_MAX; i++) {
            if (this._params[i * 4 + 2] > 0.003 && this._params[i * 4 + 3] >= 2) live++;
        }
        this._live = live;

        this.mesh.visible = live > 0 && S.showSpells !== false;
        if (!this.mesh.visible) return;

        this.dataTex.needsUpdate = true;
        this._pushUniforms();
    }

    _pushUniforms() {
        const u = this.material.uniforms;
        const sky = this.sky;
        const sh = this.shadows;

        // cameraPos/viewProjection are shared objects mutated in place; the
        // scalars and the peer-owned shared arrays are re-pointed here so a peer
        // that appeared after construction still lands (G1).
        u.waterTime.value = this._t;
        u.strandParams.value = this._params;

        if (sky && sky.sunDir) u.sunDir.value = sky.sunDir;
        if (sky && sky.sunRadiance) u.sunRadiance.value = sky.sunRadiance;
        if (sky && sky.sh) u.shR.value = sky.sh;

        if (sh && sh.matrixValues) u.cascadeMatrices.value = sh.matrixValues;
        if (sh && sh.splitsVec4) u.cascadeSplits.value = sh.splitsVec4;
        if (sh && sh.paramData) u.cascadeParams.value = sh.paramData;
        if (sh && sh.texelSize) u.shadowTexel.value = sh.texelSize;
        u.shadowSoftness.value = 1.4;
        u.shadowBias.value = 0.03;
        for (let i = 0; i < CASCADE_COUNT; i++) {
            u["cascade" + i].value = cascadeTexture(sh, i, this.gfx);
        }
        u.skyLUT.value = lutTexture(sky, this.gfx);

        u.fogDensity.value = S.fogDensity;
        u.fogHeightFalloff.value = S.fogHeightFalloff;
        u.fogStart.value = S.fogStart;
        u.aerialStrength.value = S.aerialStrength;
        u.ambientIntensity.value = S.ambientIntensity;
        u.sssStrength.value = S.sssStrength;
        u.glintIntensity.value = S.glintIntensity;
        u.glintGrazing.value = S.glintGrazing;
        u.waterDepthTint.value = S.waterDepthTint;

        this.lights.apply(this.material);
    }

    /** Live strand count, for the overlay. */
    get liveStrands() {
        return this._live;
    }

    get triangles() {
        return this.mesh.visible
            ? (this._live / STRAND_MAX) * this.mesh.metadata.triangles
            : 0;
    }

    /**
     * Compile behind the loading screen.
     *
     * Two synthetic strands are laid and **left standing**, so the warm-up frames
     * in `main` actually rasterise water. `finishWarmUp` takes them down
     * afterwards.
     *
     * Leaving them up is the whole point. `compileAsync` compiles the GLSL
     * program; WebGL still finalises state lazily on the first real draw with
     * this blend/depth/target combination, and that only happens when the mesh
     * is actually drawn. Hide the mesh here and the warm-up frames draw nothing,
     * so the cost lands on the first frame of the first cast instead — a hitch
     * behind a warm-up that looks complete.
     */
    async warmUp(x, y, z) {
        for (let c = 0; c < 24; c++) {
            const t = c / 23;
            this.column(
                0, c, x + t * 3, y + 1.2 + Math.sin(t * 3) * 0.5, z,
                0.22 * Math.sin(t * Math.PI),
                0, 0, 1, 0, t * 3, t, t < 0.2 ? 1 : 0, 1
            );
        }
        this.setParams(0, PROFILE_TUBE, 0.2, 1, 24);
        // And a sheet, because the two profiles are different code paths through
        // the same vertex shader and only one of them being exercised is exactly
        // how a warm-up quietly stops covering half of what it claims to.
        for (let c = 0; c < 24; c++) {
            const t = c / 23;
            this.column(
                1, c, x + t * 4 - 2, y, z + 2,
                0.5 * Math.sin(t * Math.PI),
                0, 0, 1, 0.6, t * 4, t, 0.4, 1
            );
        }
        this.setParams(1, PROFILE_SHEET, 0.6, 1, 24);

        this.dataTex.needsUpdate = true;
        this.mesh.visible = true;
        this._pushUniforms();
        await whenReady(this.gfx, this.material, "water material");
    }

    /** Take the synthetic strands down, after the warm-up frames have drawn. */
    finishWarmUp() {
        this.clear(0);
        this.clear(1);
        this.dataTex.needsUpdate = true;
        this.mesh.visible = false;
    }

    dispose() {
        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.dataTex.dispose();
    }
}

/**
 * The static lattice: (column, ring, strand), no geometry at all.
 *
 * Strands are separate index ranges in one buffer rather than separate meshes,
 * so the whole system is a single draw however many spells are up.
 */
function buildLattice() {
    const perStrand = LATTICE_COLS * RING;
    const pos = new Float32Array(perStrand * STRAND_MAX * 3);
    const idx = new Uint32Array((LATTICE_COLS - 1) * (RING - 1) * 6 * STRAND_MAX);

    let vi = 0;
    let ii = 0;
    for (let s = 0; s < STRAND_MAX; s++) {
        const base = s * perStrand;
        for (let c = 0; c < LATTICE_COLS; c++) {
            for (let r = 0; r < RING; r++) {
                pos[vi++] = c;
                pos[vi++] = r;
                pos[vi++] = s;
            }
        }
        for (let c = 0; c < LATTICE_COLS - 1; c++) {
            for (let r = 0; r < RING - 1; r++) {
                const a = base + c * RING + r;
                const b = a + RING;
                idx[ii++] = a; idx[ii++] = b; idx[ii++] = b + 1;
                idx[ii++] = a; idx[ii++] = b + 1; idx[ii++] = a + 1;
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));

    const mesh = new THREE.Mesh(geometry);
    mesh.name = "spellWater";
    mesh.metadata = { triangles: idx.length / 3, vertices: perStrand * STRAND_MAX };
    return mesh;
}
