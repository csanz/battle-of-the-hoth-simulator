/**
 * The snow-surf wake — the centrepiece.
 *
 * Three things come out of this module and they are deliberately one system:
 *
 *   the wave    a swept mesh built from the path the board has taken, shaped as
 *               a breaking wave that rises just behind the bow, curls over, and
 *               collapses into powder about nine tenths of a second later.
 *   the plume   spray thrown off the lip of that wave, emitted from the crest
 *               position the mesh is actually drawing rather than from the
 *               player's feet.
 *   the crest   the bow. The two walls converge just ahead of the boots, so the
 *               pair reads as snow splitting around something moving through it.
 *
 * They are one system because they share one spine. A plume emitted from an
 * independent guess at where the wave is will drift out of register with it the
 * moment the player turns, and the failure is not subtle — the spray comes off
 * the wrong side of a carve.
 *
 * The spine is a ring of samples laid every 30 cm of travel. Nothing is rebuilt:
 * the mesh is a static lattice of (column, row, side) and the vertex shader
 * places every vertex from a 96 x 3 data texture, exactly as the spray billboards
 * are placed. So a 19-metre wake and a 2-metre one cost the same buffer and the
 * same upload.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { getShader } from "../shaders/registry.js";
import { makeMaterial, whenReady } from "../core/gpuUtil.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/** Spine capacity. At 30 cm a sample this is 28.5 m, comfortably past `LIFE`. */
const SPINE_MAX = 96;
/** Metres of travel between committed samples. */
const SPINE_STEP = 0.30;

/**
 * Seconds a thrown wall of snow stays up.
 *
 * This is the number that sets how long the wake is, because length is just
 * `LIFE * speed` — 16 m at the controller's top speed, four metres at a jog.
 * Tying it to time rather than to distance is what makes a slow carve leave a
 * short wave and a fast one leave a long one, without a second constant.
 */
const LIFE = 0.88;

/** How far ahead of the player the bow sits, metres. */
const BOW_LEAD = 0.55;

/**
 * Peak wall height at a full-speed hard carve, metres.
 *
 * Taller than the character, deliberately. A physically plausible 1.45 m — what
 * a real snowboard carve throws — reads as a ripple at this framing, nine metres
 * back and slightly above, beside the 0.9 m of relief the trench and its berms
 * already have.
 */
const MAX_HEIGHT = 2.4;

// Mesh lattice. Columns are along the spine, rows across the wave section.
const COLS = 128;
const ROWS = 18;

/** How many cascades the wake casts into. Same reasoning as the character. */
const WAKE_CASCADES = 2;

export class SurfWake {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("./particles.js").SprayField} spray
     * @param {{heightAt(x:number,z:number):number}} terrain
     */
    constructor(gfx, sky, shadows, controller, spray, terrain) {
        this.gfx = gfx;
        this.sky = sky || null;
        this.shadows = shadows || null;
        this.controller = controller || null;
        this.spray = spray || null;
        this.terrain = terrain || null;

        // ---- spine ring ---------------------------------------------------
        this._x = new Float32Array(SPINE_MAX);
        this._y = new Float32Array(SPINE_MAX);
        this._z = new Float32Array(SPINE_MAX);
        this._rx = new Float32Array(SPINE_MAX);
        this._rz = new Float32Array(SPINE_MAX);
        /** Odometer reading when the sample was laid, metres. */
        this._travel = new Float32Array(SPINE_MAX);
        /** Clock reading when the sample was laid, seconds. */
        this._laid = new Float32Array(SPINE_MAX);
        /** Wave strength captured at lay time, 0..1. */
        this._strength = new Float32Array(SPINE_MAX);
        /** Signed carve captured at lay time. */
        this._carve = new Float32Array(SPINE_MAX);

        /** Newest sample. While the player is surfing it is rewritten each frame. */
        this._head = 0;
        this._count = 0;
        this._odo = 0;
        this._clock = 0;
        this._active = false;
        this._plumeOwed = 0;
        this._driftOwed = 0;

        // Per-column resolved amplitude, so the plume can be emitted from the
        // crest the mesh is actually drawing rather than from a second estimate.
        this._ampL = new Float32Array(SPINE_MAX);
        this._ampR = new Float32Array(SPINE_MAX);
        this._dist = new Float32Array(SPINE_MAX);
        /** Ring index of each column, newest first. */
        this._col = new Int32Array(SPINE_MAX);

        // ---- GPU ----------------------------------------------------------
        this._texData = new Float32Array(SPINE_MAX * 3 * 4);
        this.dataTex = new THREE.DataTexture(
            this._texData, SPINE_MAX, 3, THREE.RGBAFormat, THREE.FloatType
        );
        this.dataTex.magFilter = THREE.NearestFilter;
        this.dataTex.minFilter = THREE.NearestFilter;
        this.dataTex.wrapS = THREE.ClampToEdgeWrapping;
        this.dataTex.wrapT = THREE.ClampToEdgeWrapping;
        this.dataTex.generateMipmaps = false;
        this.dataTex.colorSpace = THREE.NoColorSpace;
        this.dataTex.flipY = false;
        this.dataTex.premultiplyAlpha = false;
        this.dataTex.needsUpdate = true;

        // The jittered view-projection, refreshed at draw time. Shared by the
        // beauty and prepass materials — one matrix, one moment (see the
        // onBeforeRender hook below).
        this._vp = new THREE.Matrix4();
        this._camPos = new THREE.Vector3();

        this.mesh = buildLattice();
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // Opaque scene, with the terrain (CONTRACTS §4.4).
        gfx.addMesh(this.mesh, gfx.LAYER.OPAQUE, 10);
        this.mesh.visible = false;

        // The token camera carries this frame's jittered matrices from the top
        // of `renderFrame` on — so reading it at draw time gives the same
        // values as `rig.camera.viewProjection`, for a module that never sees
        // the rig.
        const vp = this._vp;
        this.mesh.onBeforeRender = (renderer, scene, camera) => {
            vp.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
        };

        /** @type {THREE.RawShaderMaterial[]} */
        this._depthMats = [];
        if (this.shadows && this.shadows.registerCaster) {
            this.shadows.registerCaster(
                this.mesh, (c) => this._makeDepthMaterial(c), WAKE_CASCADES
            );
        }

        this.prepassMat = null;
        this._enabled = true;

        /**
         * Per-term diagnostic, settable from the console as
         * `SNOWFLOW.wake.debug = n`. See the switch at the bottom of
         * `wake.fragment.glsl` for the modes.
         */
        this.debug = 0;
    }

    _makeMaterial() {
        const gfx = this.gfx;
        const sky = this.sky;
        const sh = this.shadows;

        const uniforms = {
            viewProjection: { value: this._vp },
            cameraPos: { value: this._camPos },
            wakeCount: { value: 0 },
            wakeCols: { value: COLS },
            wakeRows: { value: ROWS },
            wakeTime: { value: 0 },
            wakeDebug: { value: 0 },

            sunDir: { value: sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0) },
            sunRadiance: { value: sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(0, 0, 0) },
            shR: { value: sky && sky.sh ? sky.sh : new Float32Array(36) },

            cascadeMatrices: {
                value: sh && sh.matrixValues
                    ? sh.matrixValues
                    : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
            },
            cascadeSplits: {
                value: sh && sh.splitsVec4 ? sh.splitsVec4 : new THREE.Vector4(26, 95, 330, 330),
            },
            cascadeParams: { value: sh && sh.paramData ? sh.paramData : new Float32Array(12) },
            shadowTexel: { value: sh && sh.texelSize ? sh.texelSize : 1 / 2048 },
            shadowSoftness: { value: 1.5 },
            shadowBias: { value: 0.018 },

            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity },
            sssStrength: { value: S.sssStrength },
            glintIntensity: { value: S.glintIntensity },
            glintGrazing: { value: S.glintGrazing },

            wakeTex: { value: this.dataTex },
            skyLUT: { value: sky && sky.lut ? sky.lut : gfx.blackTex },
        };
        for (let i = 0; i < CASCADE_COUNT; i++) {
            uniforms["cascade" + i] = {
                value: sh && sh.maps && sh.maps[i] ? sh.maps[i] : gfx.whiteTex,
            };
        }
        uniforms[SPELL_LIGHT_UNIFORMS[0]] = { value: new Float32Array(16) };
        uniforms[SPELL_LIGHT_UNIFORMS[1]] = { value: new Float32Array(16) };
        uniforms[SPELL_LIGHT_UNIFORMS[2]] = { value: 0 };

        // An open curled sheet: both faces are seen, often in the same frame
        // through the holes torn in the lip.
        return makeMaterial({
            name: "surfWake",
            vertex: getShader("wakeVertexShader"),
            fragment: getShader("wakePixelShader"),
            uniforms,
            side: THREE.DoubleSide,
        });
    }

    _makeDepthMaterial(cascade) {
        // One material *per cascade*, each holding its own bound
        // `lightViewProjection` (CONTRACTS §4.5) — the ShadowSystem writes it
        // every frame.
        const mat = makeMaterial({
            name: "wakeDepth" + cascade,
            vertex: getShader("wakeDepthVertexShader"),
            fragment: getShader("wakeDepthPixelShader"),
            uniforms: {
                lightViewProjection: { value: new THREE.Matrix4() },
                wakeCount: { value: 0 },
                wakeCols: { value: COLS },
                wakeRows: { value: ROWS },
                wakeTime: { value: 0 },
                wakeTex: { value: this.dataTex },
            },
            side: THREE.DoubleSide,
        });
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * The camera-space depth prepass material.
     *
     * The wake belongs in the prepass for two separate reasons: it is the largest
     * moving object in the frame, so the temporal resolve needs its depth to
     * reproject anything in front of it, and a two-metre wall of snow standing on
     * the field ought to occlude the trench beside it.
     *
     * It does not *receive* occlusion: a broad, gentle darkening of a wall of
     * white powder does not read as shading, it reads as brown snow beside white
     * snow. The wall's own analytic barrel term is the only occlusion it is
     * allowed, and it is confined to the inside of the curl.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = makeMaterial({
            name: "wakePrepass",
            vertex: getShader("wakePrepassVertexShader"),
            fragment: getShader("wakePrepassPixelShader"),
            uniforms: {
                // The same shared matrix the beauty pass reads — TAA-jittered,
                // refreshed by the mesh's onBeforeRender hook.
                viewProjection: { value: this._vp },
                wakeCount: { value: 0 },
                wakeCols: { value: COLS },
                wakeRows: { value: ROWS },
                wakeTime: { value: 0 },
                wakeTex: { value: this.dataTex },
            },
            side: THREE.DoubleSide,
        });
        this.prepassMat = mat;
        if (depth && depth.registerCaster) depth.registerCaster(this.mesh, mat);
    }

    setEnabled(v) {
        this._enabled = !!v;
        if (!this._enabled) this.mesh.visible = false;
    }

    /**
     * Advance the spine, resolve the wave, upload.
     *
     * Called after the controller has integrated and before the scene renders,
     * so the bow is at the position the character is actually drawn at.
     *
     * @param {number} dt
     * @param {THREE.Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._camPos.copy(cameraPos);
        this._clock += dt;

        const ch = this.controller;
        if (!ch) return;
        const moved = Math.hypot(ch.velocity.x, ch.velocity.z) * dt;
        this._odo += moved;

        // Below a walking pace there is nothing being displaced, and laying
        // samples anyway leaves a knot of overlapping wall wherever the player
        // coasted to a stop. Up at altitude there is nothing being displaced
        // either — the craft has left the snow, so the trench goes with the
        // downwash (`lift01` is the same signal snowContact fades on).
        const air = 1 - Math.min(1, Math.max(0, ch.lift01 || 0));
        // A crashing craft pins `surf` open to hold the hull's flying pose,
        // but it is falling, not displacing snow — no trench, no rooster tail.
        const active = ch.surf > 0.06 && ch.speed > 1.6 && air > 0.02
            && !ch.crashing;

        if (active) {
            if (!this._active) this._maybeRestart();
            this._writeHead();
            this._active = true;
        } else {
            this._active = false;
        }

        this._retire();
        const maxAmp = this._resolve();

        this.mesh.visible = this._enabled && this._count >= 2 && maxAmp > 0.01;
        if (this.mesh.visible) {
            this.dataTex.needsUpdate = true;
            this._pushUniforms();
        }

        if (this.spray) this._plume(dt);
    }

    /**
     * A new run starts a new spine rather than continuing the last one.
     *
     * Reconnecting would sweep a wall of snow across whatever ground lies between
     * where the player stopped and where they started again — which, if they
     * turned around, is a wave running backwards through the field.
     */
    _maybeRestart() {
        if (this._count === 0) return;
        const age = this._clock - this._laid[this._head];
        if (age > 0.25) this._count = 0;
    }

    /** Write (or rewrite) the live bow sample, and commit it once it has moved. */
    _writeHead() {
        const ch = this.controller;
        const i = this._head;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        const bx = ch.position.x + fx * BOW_LEAD;
        const bz = ch.position.z + fz * BOW_LEAD;

        this._x[i] = bx;
        this._y[i] = this.terrain ? this.terrain.heightAt(bx, bz) : 0;
        this._z[i] = bz;
        this._rx[i] = Math.cos(ch.facing);
        this._rz[i] = -Math.sin(ch.facing);
        this._travel[i] = this._odo;
        this._laid[i] = this._clock;
        // Speed sets how much snow there is to throw; the surf blend eases the
        // whole thing in and out so entering and leaving are never a switch —
        // and the lift fades it the same way on the way up, so the last
        // samples laid before the craft leaves the deck taper instead of
        // ending in a full-strength cliff.
        this._strength[i] = ch.surf * clamp01((ch.speed - 2.2) / 9.0)
            * (1 - Math.min(1, Math.max(0, ch.lift01 || 0)));
        this._carve[i] = ch.carve;

        if (this._count === 0) {
            this._count = 1;
            return;
        }

        // Commit once the bow has travelled a full step from the last fixed
        // sample. The head then freezes exactly where it was and a fresh live
        // sample takes over, so the spine is a record of the path rather than a
        // resampling of it.
        const p = (i - 1 + SPINE_MAX) % SPINE_MAX;
        const dx = this._x[i] - this._x[p];
        const dz = this._z[i] - this._z[p];
        if (this._count === 1 || dx * dx + dz * dz >= SPINE_STEP * SPINE_STEP) {
            this._head = (i + 1) % SPINE_MAX;
            if (this._count < SPINE_MAX) this._count++;
            // Seed the new live sample from the one it follows, so a frame in
            // which the head has not been written yet is still a valid spine.
            const n = this._head;
            this._x[n] = this._x[i]; this._y[n] = this._y[i]; this._z[n] = this._z[i];
            this._rx[n] = this._rx[i]; this._rz[n] = this._rz[i];
            this._travel[n] = this._travel[i]; this._laid[n] = this._laid[i];
            this._strength[n] = this._strength[i]; this._carve[n] = this._carve[i];
        }
    }

    /** Drop samples that have finished collapsing. */
    _retire() {
        while (this._count > 0) {
            const tail = (this._head - this._count + 1 + SPINE_MAX) % SPINE_MAX;
            if (this._clock - this._laid[tail] <= LIFE) break;
            this._count--;
        }
    }

    /**
     * Resolve every column's amplitude and curl and write the data texture.
     *
     * Which side of the board is the *outside* of the turn is the one thing both
     * sides need to agree on, and it is a fact about the carve rather than about
     * geometry — so it is decided once, here, and shipped to the shader as a
     * pair of resolved amplitudes rather than as a carve the vertex shader would
     * have to re-interpret.
     *
     * @returns {number} the largest amplitude anywhere on the wave, metres
     */
    _resolve() {
        const d = this._texData;
        const n = this._count;
        const heightScale = MAX_HEIGHT * S.wakeHeight;
        let maxAmp = 0;

        for (let j = 0; j < n; j++) {
            const i = (this._head - j + SPINE_MAX) % SPINE_MAX;
            this._col[j] = i;

            const dist = this._odo - this._travel[i] + BOW_LEAD;
            const a01 = clamp01((this._clock - this._laid[i]) / LIFE);

            // Rise: the wall is small at the bow and full by a metre and a half
            // behind it. Fall: quadratic to exactly zero at the end of life, so
            // the tail column always degenerates onto its own spine instead of
            // ending in a cut edge.
            const shape = 0.34 + 0.66 * smoothstep01((dist - 0.3) / 1.3);
            const env = (1 - a01) * (1 - a01);
            const base = heightScale * this._strength[i] * shape * env;

            // Outside of the turn takes the snow. `carve` is positive turning
            // right, and the outside of a right turn is the left-hand side.
            const c = this._carve[i];
            const biasL = c < -1 ? -1 : c > 1 ? 1 : c;
            const biasR = -biasL;

            // Straight running throws a modest wall each side; a hard carve puts
            // nearly all of it outboard and almost nothing inboard. The spread
            // between those two is the whole reason to steer.
            const ampL = base * clampRange(0.45 + 0.55 * biasL, 0.05, 1.0);
            const ampR = base * clampRange(0.45 + 0.55 * biasR, 0.05, 1.0);
            // A wall that is barely there does not curl; a hard carve throws snow
            // far enough over that the lip hangs back across its own face.
            const curlL = clampRange(0.42 + 0.58 * biasL, 0.26, 1.0);
            const curlR = clampRange(0.42 + 0.58 * biasR, 0.26, 1.0);

            if (ampL > maxAmp) maxAmp = ampL;
            if (ampR > maxAmp) maxAmp = ampR;
            this._ampL[j] = ampL;
            this._ampR[j] = ampR;
            this._dist[j] = dist;

            const o0 = j * 4;
            const o1 = (SPINE_MAX + j) * 4;
            const o2 = (SPINE_MAX * 2 + j) * 4;
            d[o0] = this._x[i]; d[o0 + 1] = this._y[i]; d[o0 + 2] = this._z[i]; d[o0 + 3] = dist;
            d[o1] = this._rx[i]; d[o1 + 1] = this._rz[i]; d[o1 + 2] = ampL; d[o1 + 3] = ampR;
            d[o2] = curlL; d[o2 + 1] = curlR; d[o2 + 2] = a01; d[o2 + 3] = 0;
        }

        return maxAmp;
    }

    /**
     * Spray off the lip.
     *
     * Emitted from the crest position the mesh is drawing — same spine, same
     * amplitude, same side weighting — so the plume leaves the wave rather than
     * appearing near it. Rate is per metre travelled, not per second, so it does
     * not thin out at a higher frame rate.
     */
    _plume(dt) {
        const ch = this.controller;
        const sp = this.spray;
        const n = this._count;
        if (n < 3 || ch.surf < 0.15 || ch.speed < 3.0 || ch.crashing) {
            this._plumeOwed = 0;
            return;
        }

        const travelled = ch.speed * dt;
        this._plumeOwed += travelled;
        this._driftOwed += travelled;

        // Two populations, because spray off a carve is two things and trying to
        // get both out of one emitter gets neither.
        //
        //   curtain   a dense, slow, short-lived sheet hugging the crest. This
        //             is the mass of it, and it is what makes the wave look like
        //             it is disintegrating rather than sliding.
        //   throw     ballistic grains flung clear, which give the plume its
        //             reach and its silhouette against the sky.
        //
        // Sizing is set by the curtain: at ten metres a six-centimetre puff is
        // six pixels, and a thousand six-pixel dots at low opacity spread over
        // twenty metres of trail is a faint haze rather than a plume.
        const perMetre = 88 * S.wakeSpray;
        let count = (this._plumeOwed * perMetre) | 0;
        if (count > 0) {
            this._plumeOwed -= count / perMetre;
            if (count > 150) count = 150;

            // Sample the live part of the wave — roughly the first four metres,
            // which is where a breaking crest is actually shedding. From column
            // zero, so the plume is attached to the board: starting a metre back
            // leaves a bare gap exactly where the eye is looking.
            //
            // Fractionally, which matters more than any of the sizing above.
            // Picking a whole column puts every grain on one of fifteen points
            // 30 cm apart and the plume comes out as fifteen clumps of dots in a
            // row. Interpolating along the spine spreads the same count over a
            // continuous line.
            const span = Math.min(n - 1, 15);

            for (let k = 0; k < count; k++) {
                const jf = Math.random() * span;
                const j = jf | 0;
                const j2 = j + 1 < n ? j + 1 : j;
                const t = jf - j;

                const aL = this._ampL[j] + (this._ampL[j2] - this._ampL[j]) * t;
                const aR = this._ampR[j] + (this._ampR[j2] - this._ampR[j]) * t;
                const total = aL + aR;
                if (total < 0.12) continue;

                const side = Math.random() * total < aL ? -1 : 1;
                const amp = side < 0 ? aL : aR;
                if (amp < 0.10) continue;

                const i = this._col[j];
                const i2 = this._col[j2];
                const rx = this._rx[i] + (this._rx[i2] - this._rx[i]) * t;
                const rz = this._rz[i] + (this._rz[i2] - this._rz[i]) * t;
                // Forward, from the same basis the shader builds.
                const fx = -rz;
                const fz = rx;

                const sx = this._x[i] + (this._x[i2] - this._x[i]) * t;
                const sy = this._y[i] + (this._y[i2] - this._y[i]) * t;
                const sz = this._z[i] + (this._z[i2] - this._z[i]) * t;
                const dist = this._dist[j] + (this._dist[j2] - this._dist[j]) * t;

                // Just outboard of the crest's lateral maximum, at its height.
                // Mirrors `wakePoint`'s base offset, so the plume leaves the lip
                // the mesh is drawing rather than a second guess at where it is.
                const l0 = 0.24 + 0.44 * smoothstep01((dist - 0.3) / 2.3);
                // The section's lateral maximum sits at about 0.65 of the
                // amplitude once the squash is applied, and the lip hooks back
                // inside that — so the shed grains leave from a band straddling
                // it rather than from a single line.
                const lat = l0 + (0.35 + Math.random() * 0.55) * amp;
                const px = sx + rx * side * lat;
                const pz = sz + rz * side * lat;
                // Spread down the face, but weighted toward the lip: a sqrt on a
                // uniform biases the draw upward, so most grains leave from the
                // crest — which is where the wall is actually coming apart — while
                // enough sheet down the face to avoid a horizontal rope of dots.
                const py = sy + (0.30 + 0.82 * Math.sqrt(Math.random())) * amp;

                // ---- curtain ------------------------------------------------
                // Big, slow, short-lived, high drag. A puff of blown snow is a
                // cloud rather than a crystal, and at the distance this is framed
                // from it has to be twenty to forty centimetres across to be a
                // shape at all. It dies before it can drift far enough for the
                // size to look wrong.
                if (Math.random() < 0.72) {
                    sp.emit(
                        px, py, pz,
                        rx * side * (0.4 + Math.random() * 1.1) + ch.velocity.x * 0.16,
                        0.9 + Math.random() * 1.8,
                        rz * side * (0.4 + Math.random() * 1.1) + ch.velocity.z * 0.16,
                        0.055 + Math.random() * 0.085,
                        0.34 + Math.random() * 0.40,
                        0,
                        4.5
                    );
                    continue;
                }

                // ---- throw --------------------------------------------------
                const out = 1.2 + Math.random() * 2.6;
                const back = 0.4 + Math.random() * 2.2;
                const clod = Math.random() < 0.18 ? 1 : 0;

                sp.emit(
                    px, py, pz,
                    rx * side * out - fx * back + ch.velocity.x * 0.30,
                    1.6 + Math.random() * 3.4 + amp * 1.5,
                    rz * side * out - fz * back + ch.velocity.z * 0.30,
                    clod ? 0.020 + Math.random() * 0.022 : 0.045 + Math.random() * 0.055,
                    clod ? 0.7 + Math.random() * 0.5 : 0.9 + Math.random() * 1.3,
                    clod,
                    // Ballistic. This is a mass of snow leaving a wave, and it
                    // has to actually clear the wave — see `drag` in particles.js.
                    clod ? 0.7 : 1.0 + Math.random() * 0.8
                );
            }
        }

        // A separate, slower stream of fine powder hanging low over the trench.
        // The lip spray is all ballistic and gone in a second; this is the part
        // that leaves the trail looking like it is still smoking.
        const driftPerMetre = 7 * S.wakeSpray;
        let drift = (this._driftOwed * driftPerMetre) | 0;
        if (drift > 0) {
            this._driftOwed -= drift / driftPerMetre;
            if (drift > 14) drift = 14;
            const dspan = Math.min(n - 3, 22);
            for (let k = 0; k < drift; k++) {
                const jf = 2 + Math.random() * dspan;
                const j = jf | 0;
                const j2 = j + 1 < n ? j + 1 : j;
                const t = jf - j;
                const i = this._col[j];
                const i2 = this._col[j2];
                const rx = this._rx[i] + (this._rx[i2] - this._rx[i]) * t;
                const rz = this._rz[i] + (this._rz[i2] - this._rz[i]) * t;
                const lat = (Math.random() - 0.5) * 1.6;
                sp.emit(
                    this._x[i] + (this._x[i2] - this._x[i]) * t + rx * lat,
                    this._y[i] + (this._y[i2] - this._y[i]) * t + 0.08 + Math.random() * 0.35,
                    this._z[i] + (this._z[i2] - this._z[i]) * t + rz * lat,
                    (Math.random() - 0.5) * 1.1,
                    0.25 + Math.random() * 0.9,
                    (Math.random() - 0.5) * 1.1,
                    0.026 + Math.random() * 0.036,
                    1.5 + Math.random() * 1.6,
                    0,
                    // High drag: this stream is meant to hang over the trench
                    // and drift, not to fly.
                    4.5
                );
            }
        }
    }

    _pushUniforms() {
        const u = this.material.uniforms;

        // Shared objects (sunDir, sunRadiance, shR, the cascade block, the
        // view-projection) are bound by reference and mutated by their owners;
        // only plain numbers move here.
        u.wakeCount.value = this._count;
        u.wakeTime.value = this._clock;
        u.wakeDebug.value = this.debug;

        u.shadowSoftness.value = 1.5;
        u.shadowBias.value = 0.018;

        u.fogDensity.value = S.fogDensity;
        u.fogHeightFalloff.value = S.fogHeightFalloff;
        u.fogStart.value = S.fogStart;
        u.aerialStrength.value = S.aerialStrength;
        u.ambientIntensity.value = S.ambientIntensity;
        u.sssStrength.value = S.sssStrength;
        u.glintIntensity.value = S.glintIntensity;
        u.glintGrazing.value = S.glintGrazing;

        // One clock, all four materials — the erosion must bite the same texels
        // in the beauty, shadow and prepass stages this frame.
        for (let i = 0; i < this._depthMats.length; i++) {
            this._depthMats[i].uniforms.wakeCount.value = this._count;
            this._depthMats[i].uniforms.wakeTime.value = this._clock;
        }
        if (this.prepassMat) {
            this.prepassMat.uniforms.wakeCount.value = this._count;
            this.prepassMat.uniforms.wakeTime.value = this._clock;
        }
    }

    /**
     * Compile all the pipelines behind the loading screen.
     *
     * A synthetic straight spine is laid first so the warm-up frames in `main`
     * actually rasterise the wake rather than compiling a pipeline that has
     * never had a triangle through it. The first real `update` overwrites it.
     */
    async warmUp() {
        this._syntheticSpine();
        this.dataTex.needsUpdate = true;
        this.mesh.visible = true;
        this._pushUniforms();

        await whenReady(this.gfx, this.material, "wake material");
        for (let i = 0; i < this._depthMats.length; i++) {
            await whenReady(this.gfx, this._depthMats[i], this._depthMats[i].name);
        }
        if (this.prepassMat) {
            await whenReady(this.gfx, this.prepassMat, "wake prepass");
        }
    }

    /** A short straight run under the player, for warm-up only. */
    _syntheticSpine() {
        const ch = this.controller;
        const d = this._texData;
        const n = 24;
        this._count = n;
        const px = ch ? ch.position.x : 0;
        const pz = ch ? ch.position.z : 0;
        for (let j = 0; j < n; j++) {
            const dist = j * SPINE_STEP + BOW_LEAD;
            const x = px;
            const z = pz - dist;
            const a01 = j / n;
            const amp = 0.8 * (1 - a01) * (1 - a01);
            const o0 = j * 4;
            const o1 = (SPINE_MAX + j) * 4;
            const o2 = (SPINE_MAX * 2 + j) * 4;
            d[o0] = x;
            d[o0 + 1] = this.terrain ? this.terrain.heightAt(x, z) : 0;
            d[o0 + 2] = z;
            d[o0 + 3] = dist;
            d[o1] = 1; d[o1 + 1] = 0; d[o1 + 2] = amp; d[o1 + 3] = amp;
            d[o2] = 0.7; d[o2 + 1] = 0.7; d[o2 + 2] = a01; d[o2 + 3] = 0;
        }
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
        if (this.prepassMat) this.prepassMat.dispose();
        this.dataTex.dispose();
    }
}

// -----------------------------------------------------------------------------

/**
 * The static lattice. `position` is (column, row, side) and carries no geometry
 * at all — see `wake.vertex.glsl`.
 */
function buildLattice() {
    const perSide = COLS * ROWS;
    const pos = new Float32Array(perSide * 2 * 3);
    const idx = new Uint32Array((COLS - 1) * (ROWS - 1) * 2 * 6);

    let vi = 0;
    let ii = 0;
    for (let s = 0; s < 2; s++) {
        const side = s === 0 ? -1 : 1;
        const base = s * perSide;
        for (let c = 0; c < COLS; c++) {
            for (let r = 0; r < ROWS; r++) {
                pos[vi++] = c;
                pos[vi++] = r;
                pos[vi++] = side;
            }
        }
        for (let c = 0; c < COLS - 1; c++) {
            for (let r = 0; r < ROWS - 1; r++) {
                const a = base + c * ROWS + r;
                const b = a + ROWS;
                idx[ii++] = a; idx[ii++] = b; idx[ii++] = b + 1;
                idx[ii++] = a; idx[ii++] = b + 1; idx[ii++] = a + 1;
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));

// Placed entirely by the vertex shader, so the CPU-side bounds are a
    // fiction — pin them rather than letting three derive nonsense (or a
    // NaN radius) from the lattice indices.
    geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    const mesh = new THREE.Mesh(geometry);
    mesh.name = "surfWake";
    mesh.metadata = { triangles: idx.length / 3, vertices: perSide * 2 };
    return mesh;
}

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clampRange(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Hermite smoothstep on an already-normalised parameter. */
function smoothstep01(t) {
    const x = clamp01(t);
    return x * x * (3 - 2 * x);
}

export { COLS as WAKE_COLS, ROWS as WAKE_ROWS };
