/**
 * Cannon bolts.
 *
 * A fixed pool of camera-facing ribbons, drawn in one call, placed entirely from
 * a data texture — the same shape as everything else that moves in this demo.
 * The mesh is a lattice of quads whose vertices carry `(boltIndex, t, side)` and
 * nothing else; where a bolt is, how long it is and how much life it has left
 * live in two texels, and the vertex program does the rest.
 *
 * That means firing costs nothing. No mesh is created, no buffer is uploaded, no
 * material is compiled: a shot writes eight floats into a staging array that goes
 * up once a frame whether anything fired or not.
 *
 * The pool is small and wraps. A bolt lives a fifth of a second and the guns fire
 * every few seconds, so the only way to exhaust sixteen slots is a herd far
 * larger than the frame budget allows anyway — and the failure mode is the oldest
 * bolt vanishing a few frames early, which is not a failure worth code.
 *
 * Port note: the material's `viewProjection` uniform is created holding an
 * identity matrix; the owner (the herd, or the speeder) rebinds its `.value` to
 * the shared jittered `rig.camera.viewProjection` after construction. Until it
 * does, every bolt is dead and the mesh is hidden, so nothing wrong is drawn.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

/** How many bolts can be in the air at once. */
// Sized for the slowest tunable bolt: a speeder shot at low `Bolt speed` lives
// ~2s against a 0.14s fire cadence, which is ~16 in flight at once.
const POOL = 32;
/** Seconds a bolt takes to cross its flight. */
const LIFE = 0.22;
/** Metres it covers in that time — about 3 km/s, which is a bolt, not a bullet. */
const REACH = 620;
/** Metres of ribbon. */
const LENGTH = 26;
/** Half-width at the core, metres. Generous: it is seen at two hundred metres. */
const WIDTH = 0.9;

/**
 * Finding the ground.
 *
 * A march rather than an analytic solve, because the surface a bolt lands on is
 * a bicubically filtered heightfield plus a deformation buffer and there is no
 * closed form for where a line crosses it. Coarse steps to find the crossing,
 * then bisection to place it — the whole thing is a hundred height lookups and
 * runs a handful of times a second, on the frames a gun fires.
 */
const MARCH_STEP = 5;
const MARCH_REFINE = 7;

/**
 * The mark a bolt leaves.
 *
 * Deeper and wider than the Ribbon's splash, which is the closest thing in the
 * demo and is water landing rather than a cannon arriving. The one channel this
 * uses that nothing else leans on is `ice`: a bolt does not only displace snow,
 * it *fuses* it, so the crater floor comes back glazed and takes a specular
 * highlight the surrounding powder does not. That glaze is most of why the hole
 * reads as having been burned rather than dug.
 */
const CRATER_RADIUS = 2.4;
const CRATER_DEPTH = 0.72;
const CRATER_BERM = 0.55;
/** Grains thrown up. */
const IMPACT_SPRAY = 260;

export class Bolts {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {{
     *   terrain: import("../terrain/terrain.js").Terrain,
     *   spray: import("../vfx/particles.js").SprayField,
     *   look?: () => ({ r:number, g:number, b:number, width:number, reach:number,
     *                   speed?:number, velocity?:number, length?:number }),
     * }} [ctx] what a bolt hits, and what it throws up. Omitted, bolts are
     *   drawn and nothing else happens.
     *
     *   `look` is read every frame and lets one owner's bolts differ from
     *   another's. The walkers want a fat orange bolt legible at two hundred
     *   metres and scaled by the machine firing it; the speeder is five metres
     *   from the camera and wants neither. Absent, the walker's behaviour is
     *   what happens.
     */
    constructor(gfx, ctx) {
        this.gfx = gfx;
        this.ctx = ctx || null;
        this._look = ctx?.look || null;
        /**
         * Per-slot flight duration, seconds — bolts from different looks (or
         * the same look re-tuned mid-burst) each keep the life they were born
         * with, so a slider drag never time-warps shots already in the air.
         */
        this._lifeMax = new Float32Array(POOL).fill(LIFE);

        /** (originXYZ, life) then (dirXYZ, length), one column per bolt. */
        this._data = new Float32Array(POOL * 2 * 4);
        this._life = new Float32Array(POOL);
        /** Seconds until this bolt reaches the ground; negative once it has. */
        this._hitIn = new Float32Array(POOL);
        /** Where it lands, and the direction it lands travelling. */
        this._hitAt = new Float32Array(POOL * 3);
        this._hitDir = new Float32Array(POOL * 3);
        this._next = 0;

        this.texture = new THREE.DataTexture(
            this._data, POOL, 2, THREE.RGBAFormat, THREE.FloatType
        );
        this.texture.colorSpace = THREE.NoColorSpace;
        this.texture.flipY = false;
        this.texture.premultiplyAlpha = false;
        this.texture.generateMipmaps = false;
        this.texture.minFilter = THREE.NearestFilter;
        this.texture.magFilter = THREE.NearestFilter;
        this.texture.wrapS = THREE.ClampToEdgeWrapping;
        this.texture.wrapT = THREE.ClampToEdgeWrapping;
        this.texture.needsUpdate = true;

        // The body of the bolt. The shader lays a pink fringe outside this and a
        // near-white core inside it — see `bolt.fragment.glsl`.
        this._color = new THREE.Color(1.0, 0.42, 0.16);
        this._cameraPos = new THREE.Vector3();

        this.mesh = this._buildMesh();
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // The blended pass — after the opaque scene, so a bolt is correctly
        // hidden by a dune it goes behind and correctly *not* hidden by the
        // snow it flies over.
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 41);
        this.mesh.visible = false;

        this.live = 0;
        /** Set by `update`; init so a warm-up call before any update is safe. */
        this._lastDt = 0;
    }

    _buildMesh() {
        const positions = new Float32Array(POOL * 4 * 3);
        const indices = new Uint16Array(POOL * 6);
        for (let b = 0; b < POOL; b++) {
            const v = b * 4;
            // (bolt, t, side) — two rungs, two sides.
            const corners = [[0, -1], [0, 1], [1, -1], [1, 1]];
            for (let c = 0; c < 4; c++) {
                positions[(v + c) * 3] = b;
                positions[(v + c) * 3 + 1] = corners[c][0];
                positions[(v + c) * 3 + 2] = corners[c][1];
            }
            const o = b * 6;
            indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
            indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2;
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

        const mesh = new THREE.Mesh(geometry);
        mesh.name = "walkerBolts";
        mesh.metadata = { triangles: POOL * 2, vertices: POOL * 4 };
        return mesh;
    }

    _makeMaterial() {
        return makeMaterial({
            name: "bolt",
            vertex: getShader("boltVertexShader"),
            fragment: getShader("boltPixelShader"),
            uniforms: {
                // Rebound by the owner to the shared jittered matrix (§7.1).
                viewProjection: { value: new THREE.Matrix4() },
                cameraPos: { value: this._cameraPos },
                boltWidth: { value: WIDTH },
                boltReach: { value: REACH },
                boltColor: { value: this._color },
                boltTex: { value: this.texture },
            },
            // Additive, and no depth write: a bolt is light. It still
            // depth-*tests*, so terrain in front of it occludes it, but two
            // bolts crossing add rather than one winning.
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
    }

    /**
     * The owner's look this frame, defaults filled in. The walker's ember bolt
     * scaled by the machine is what an absent look means; `speed` is a velocity
     * multiplier — the same reach covered in `LIFE / speed` seconds — and is
     * guarded here so a look wired to a settings key that does not exist yet
     * degrades to 1 rather than NaN.
     * @returns {{r:number,g:number,b:number,width:number,reach:number,speed:number}}
     */
    _lookNow() {
        if (this._look) {
            const k = this._look();
            const length =
                Number.isFinite(k.length) && k.length > 0 ? k.length : LENGTH;
            let reach = k.reach;
            let lifeSec;
            if (Number.isFinite(k.velocity) && k.velocity > 0) {
                // The look speaks in metres per second. Life follows from the
                // range — capped so a slow bolt fades in flight rather than
                // outliving the pool, with the reach shortened to match so the
                // velocity the slider asked for is always the velocity flown.
                lifeSec = reach / k.velocity;
                if (lifeSec > 2.0) {
                    lifeSec = 2.0;
                    reach = k.velocity * lifeSec;
                }
            } else {
                // The look speaks in multiples of the walker's own bolt: same
                // reach, covered in LIFE / speed seconds.
                const speed =
                    Number.isFinite(k.speed) && k.speed > 0 ? k.speed : 1;
                lifeSec = LIFE / speed;
            }
            return { r: k.r, g: k.g, b: k.b, width: k.width, reach, length, lifeSec };
        }
        const s = Math.max(0.4, S.walkerScale);
        return {
            r: 1.0, g: 0.42, b: 0.16,
            width: WIDTH * s, reach: REACH * s, length: LENGTH, lifeSec: LIFE,
        };
    }

    /**
     * Fire one.
     * @param {THREE.Vector3} origin world muzzle position
     * @param {THREE.Vector3} dir unit, world
     */
    spawn(origin, dir) {
        const i = this._next;
        this._next = (this._next + 1) % POOL;

        const k = this._lookNow();
        this._life[i] = k.lifeSec;
        this._lifeMax[i] = k.lifeSec;
        this._hitIn[i] = -1;

        const a = i * 4;
        this._data[a] = origin.x;
        this._data[a + 1] = origin.y;
        this._data[a + 2] = origin.z;
        this._data[a + 3] = 1;

        const b = (POOL + i) * 4;
        this._data[b] = dir.x;
        this._data[b + 1] = dir.y;
        this._data[b + 2] = dir.z;
        this._data[b + 3] = k.length;

        // Where it lands is solved now, on the frame it is fired, and merely
        // *waited for* below. Marching the terrain once per shot is far cheaper
        // than testing a moving point against it every frame, and it means the
        // impact lands at exactly the right moment rather than one frame late.
        this._hitIn[i] = this._solveImpact(origin, dir, i, k);
    }

    /**
     * March the terrain for the first crossing, then bisect onto it.
     * @param {{reach:number, speed:number}} k this owner's look, from `_lookNow`
     * @returns {number} seconds until the bolt gets there, or -1 if it never does
     */
    _solveImpact(origin, dir, slot, k) {
        if (!this.ctx || !this.ctx.terrain || !this.ctx.terrain.heightAt) return -1;
        const terrain = this.ctx.terrain;
        // Upward shots never land. Cheap to check and it is most of the misses.
        if (dir.y > 0.02) return -1;

        let prevT = 0;
        let prevGap = origin.y - terrain.heightAt(origin.x, origin.z);
        // Already underground — the muzzle is inside a dune. Nothing to draw.
        if (prevGap <= 0) return -1;

        // March only as far as this owner's bolt actually flies — past its
        // reach it fades out mid-air and there is no impact to time.
        for (let t = MARCH_STEP; t <= k.reach; t += MARCH_STEP) {
            const x = origin.x + dir.x * t;
            const y = origin.y + dir.y * t;
            const z = origin.z + dir.z * t;
            const gap = y - terrain.heightAt(x, z);
            if (gap > 0) { prevT = t; prevGap = gap; continue; }

            // Crossed. Bisect between the last airborne sample and this one.
            let lo = prevT, hi = t;
            for (let k = 0; k < MARCH_REFINE; k++) {
                const mid = (lo + hi) * 0.5;
                const my = origin.y + dir.y * mid;
                const mg = my - terrain.heightAt(
                    origin.x + dir.x * mid, origin.z + dir.z * mid
                );
                if (mg > 0) lo = mid; else hi = mid;
            }
            const hit = (lo + hi) * 0.5;
            const o = slot * 3;
            this._hitAt[o] = origin.x + dir.x * hit;
            this._hitAt[o + 1] = origin.y + dir.y * hit;
            this._hitAt[o + 2] = origin.z + dir.z * hit;
            this._hitDir[o] = dir.x;
            this._hitDir[o + 1] = dir.y;
            this._hitDir[o + 2] = dir.z;
            // Time of flight at the speed the ribbon is drawn travelling, so
            // the snow goes up exactly as the bolt gets there. That speed is
            // the owner's reach over its own flight life — the old constant
            // REACH/LIFE was only right for an unscaled walker.
            return hit / (Math.max(1e-3, k.reach) / k.lifeSec);
        }
        void prevGap;
        return -1;
    }

    /**
     * Snow, thrown. The crater is one wide brush plus a ragged ring, because a
     * single disc reads as a stamp; the grains come off in a cone biased down
     * the bolt's own line, so a shallow shot sprays forward and a steep one goes
     * straight up.
     */
    _impact(slot) {
        const ctx = this.ctx;
        if (!ctx) return;
        const o = slot * 3;
        const x = this._hitAt[o], y = this._hitAt[o + 1], z = this._hitAt[o + 2];
        const dx = this._hitDir[o], dy = this._hitDir[o + 1], dz = this._hitDir[o + 2];
        // Crater scale follows the bolt that made it. At the walker's default
        // look, width / WIDTH *is* `walkerScale`, so this reproduces the old
        // `max(0.5, S.walkerScale)` exactly — and a speeder's slimmer bolt digs
        // a proportionally smaller (floored) hole with the same character.
        const scale = Math.max(0.5, this._lookNow().width / WIDTH);
        const steep = Math.min(1, Math.abs(dy));

        const spray = ctx.spray;
        if (spray) {
            const total = (IMPACT_SPRAY * S.spellSpray) | 0;
            for (let k = 0; k < total; k++) {
                const a = Math.random() * Math.PI * 2;
                const ca = Math.cos(a), sa = Math.sin(a);
                const out = (2.4 + Math.random() * 7.5) * (0.5 + 0.9 * (1 - steep));
                // Most of it goes up: this is an explosion, not a splash.
                const up = (5.5 + Math.random() * 12.0) * (0.55 + 0.7 * steep);
                const clod = Math.random() < 0.42 ? 1 : 0;
                spray.emit(
                    x + ca * 0.2, y + 0.06 + Math.random() * 0.3, z + sa * 0.2,
                    ca * out + dx * 5.5, up, sa * out + dz * 5.5,
                    clod ? 0.03 + Math.random() * 0.06 : 0.07 + Math.random() * 0.13,
                    0.7 + Math.random() * 1.4,
                    clod,
                    clod ? 0.7 : 2.4
                );
            }
        }

        const yaw = Math.atan2(dz, dx);
        const deform = ctx.terrain && ctx.terrain.deform;
        if (!deform) return;
        // Compression and ice both at full: the floor of the hole is packed and
        // glazed, which is what makes it read as burned rather than dug.
        deform.brush(
            x, z, CRATER_RADIUS * scale,
            CRATER_DEPTH, CRATER_BERM, 1.0, 0.95,
            yaw, 1.2, 1.0
        );
        for (let i = 0; i < 4; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = (1.5 + Math.random() * 1.5) * scale;
            deform.brush(
                x + Math.cos(a) * d, z + Math.sin(a) * d,
                (0.7 + Math.random() * 0.8) * scale,
                0.22, 0.4, 0.7, 0.35,
                a, 1.0, 1.0
            );
        }
    }

    /** @param {number} dt @param {THREE.Vector3} cameraPos */
    update(dt, cameraPos) {
        this._lastDt = dt || 0;
        if (cameraPos) this._cameraPos.copy(cameraPos);

        const k = this._lookNow();

        let live = 0;
        for (let i = 0; i < POOL; i++) {
            if (this._life[i] <= 0) continue;
            // Real seconds — each bolt's velocity is baked into the `_lifeMax`
            // it was born with, and the impact clock was timed the same way.
            this._life[i] -= dt;

            // The ground, if this one was ever going to reach it.
            if (this._hitIn[i] > 0) {
                this._hitIn[i] -= dt;
                if (this._hitIn[i] <= 0) {
                    this._impact(i);
                    // The bolt ends where it landed rather than flying on
                    // through the dune it just cratered.
                    this._life[i] = Math.min(this._life[i], 0.04);
                }
            }

            const t = Math.max(0, this._life[i] / Math.max(1e-6, this._lifeMax[i]));
            this._data[i * 4 + 3] = t;
            if (t > 0) live++;
        }
        this.live = live;
        this.texture.needsUpdate = true;

        const u = this.material.uniforms;
        this._color.setRGB(k.r, k.g, k.b);
        u.boltWidth.value = k.width;
        u.boltReach.value = k.reach;
        this.mesh.visible = live > 0;
    }

    async warmUp() {
        // A bolt has to be alive for the pipeline to have anything to compile
        // against, so one is faked into existence and then killed. It needs a
        // real direction as well as a life: the shader substitutes for a zero
        // vector, but compiling against the substitution is not compiling
        // against the thing that will actually be drawn.
        this._data[3] = 1;
        this._data[POOL * 4 + 2] = 1;
        this._data[POOL * 4 + 3] = LENGTH;
        this.texture.needsUpdate = true;
        this.mesh.visible = true;
        await whenReady(this.gfx, this.material, "bolt material");
        this._data[3] = 0;
        this._data[POOL * 4 + 2] = 0;
        this._data[POOL * 4 + 3] = 0;
        this.texture.needsUpdate = true;
        this.mesh.visible = false;
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}

export { REACH as BOLT_REACH };
