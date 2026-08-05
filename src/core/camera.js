/**
 * Third-person spring-arm rig — action-MMO framing.
 *
 * The arm is deliberately *not* rigid: the pivot chases the character through a
 * critically-damped spring, so hard acceleration pulls the camera back and the
 * character drifts forward in frame. FOV widens with speed, the rig banks into
 * carves, and everything eases. Nothing here snaps.
 *
 * Open snow field, so there is no obstacle collision solve — only the ground
 * itself pushes the arm up, which buys a rig that never pops through a drift.
 *
 * Port note: there is no engine camera underneath any more. `rig.camera` is a
 * plain object — position, fov (vertical, RADIANS), aspect, near/far, and the
 * hand-built left-handed view/projection matrices — and it is the single
 * source of truth every pass renders with. The post chain jitters
 * `camera.projection` after `rig.update`; nothing else may touch these
 * matrices mid-frame.
 */

import * as THREE from "three";
import { input } from "./input.js";
import { S } from "./settings.js";
import {
    setFrame, invertRigid, mulMat4, invertMat4, perspectiveFovLH,
} from "./mat4.js";

// ------------------------------------------------------- module-scope scratch
const _pivot = new THREE.Vector3();
const _desired = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _frame = new Float32Array(16); // camera world frame, rebuilt every update

/** Height probes taken along the spring arm each frame. */
const ARM_SAMPLES = 5;

// CHASE_SWING is gone. It keyed off the per-frame mouse accumulator — so it
// never engaged on an actual A/D turn, fired as a rubbery counter-drag on
// freelook instead, and integrated a frame-rate-dependent offset into the yaw
// that never came back. The damped facing-follow below does the job it was
// after (the craft leads into the turn and presents its flank) from the real
// steer, and returns to exactly zero on the straight by construction.

const PITCH_MIN = -0.62; // looking up
const PITCH_MAX = 1.05; // looking down
const DIST_MIN = 2.6;
const DIST_MAX = 11.0;

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

export class CameraRig {
    /**
     * @param {import("./gfx.js").Gfx} gfx
     * @param {HTMLCanvasElement} canvas
     */
    constructor(gfx, canvas) {
        this.gfx = gfx;
        this.canvas = canvas;

        /**
         * The camera state — a plain object, not a THREE camera. `fov` is
         * vertical and in RADIANS (the source convention; walkers and the
         * overlay read it as such). `projection` carries the TAA jitter once
         * the post chain has run; `view` is LH with +Z forward.
         */
        this.camera = {
            position: new THREE.Vector3(0, 3, -6),
            fov: 1.02, // ~58deg vertical
            aspect: 16 / 9,
            minZ: 0.12,
            maxZ: 4200,
            view: new THREE.Matrix4(),
            projection: new THREE.Matrix4(),
            viewProjection: new THREE.Matrix4(),
            invView: new THREE.Matrix4(),
            invViewProjection: new THREE.Matrix4(),
        };

        this.yaw = 2.4;
        // Looking down on the craft rather than along the ground behind it. A
        // speeder is read from above — you fly it by watching the snow come at
        // you — and the figure's shoulder-height framing put the horizon across
        // the middle of the hull.
        this.pitch = S.speeder !== false ? 0.42 : 0.17;

        this.distance = S.speeder !== false ? 11.5 : 6.2;
        this.distanceTarget = this.distance;

        /** Smoothed pivot position (the thing the spring chases). */
        this.pivot = new THREE.Vector3(0, 0, 0);
        this.pivotVel = new THREE.Vector3(0, 0, 0);

        /** Over-the-shoulder offset, in camera space. */
        this.shoulder = S.speeder !== false ? 0.0 : 0.85;
        // The craft hovers a few metres up, so the pivot has to as well or the
        // arm sits under it and looks up through the floor.
        this.pivotHeight = S.speeder !== false ? 4.2 : 1.62;
        /** Metres of clearance the arm keeps above the snow. */
        this.groundClearanceBase = S.speeder !== false ? 3.4 : 1.35;

        this.baseFov = 1.02;
        this.fov = 1.02;

        this.roll = 0;
        this.rollTarget = 0;

        /**
         * The rig's basis, republished every frame. The spells aim with the
         * same three vectors, so there is only one place the convention for
         * "forward" is written down.
         */
        this.forward = new THREE.Vector3(0, 0, 1);
        this.right = new THREE.Vector3(1, 0, 0);
        this.up = new THREE.Vector3(0, 1, 0);

        // Trauma-based shake (Squirrel Eiserloh style): shake = trauma^2, so it
        // falls off perceptually rather than linearly.
        this.trauma = 0;
        this.shakeTime = 0;

        /**
         * Height sampler, injected once the terrain exists.
         * @type {((x:number, z:number) => number)|null}
         */
        this.groundAt = null;
        /** Metres of snow the camera must keep beneath it. */
        this.groundClearance = this.groundClearanceBase;
        /** Eased lift currently being applied to stay above the surface. */
        this.groundLift = 0;

        /**
         * Mouse-look, kept as an offset *on top of* the facing-follow while
         * flying. Null until the first flying update so it can pick up whatever
         * offset the boot sequence left between yaw and facing.
         */
        this._yawUser = null;
        /** Boost inhale 0..1 — eases the arm and FOV breathing on reheat. */
        this._breath = 0;

        this._first = true;

        // Give the matrices real values from the start — the warm-up runs the
        // shadow fit and the bakes before the first `update()`.
        this.camera.fov = this.fov;
        this._composeMatrices(this.pitch, this.yaw, this.roll);
    }

    /** @param {number} amount 0..1 */
    addTrauma(amount) {
        this.trauma = Math.min(1, this.trauma + amount);
    }

    /**
     * @param {number} dt seconds
     * @param {THREE.Vector3} targetPos character world position (feet)
     * @param {THREE.Vector3} targetVel character world velocity
     * @param {number} lean signed lean amount, -1..1, for banking
     * @param {number} speed01 normalised speed for FOV widening
     * @param {number|null} facing craft heading while flying; null on foot.
     *        When given, the rig owns following it — the controller no longer
     *        writes `rig.yaw` directly.
     */
    update(dt, targetPos, targetVel, lean, speed01, facing = null) {
        // ------------------------------------------------------------- look
        const flying = S.speeder !== false && facing !== null;
        if (flying) {
            // The yaw chases the craft's heading through a damped follow, with
            // the mouse kept as a separate additive offset. Same steady-state
            // framing as the old `rig.yaw += turn` weld — the follow converges
            // in about a tenth of a second — but the pan *rate* now ramps with
            // the steer instead of stepping with the keys, and a hard turn lets
            // the craft lead the frame by a few degrees and show its flank.
            if (this._yawUser === null) {
                this._yawUser = angleDelta(facing, this.yaw);
            }
            this._yawUser += input.lookX;
            // Near-welded by default; the cinematic layer relaxes the follow as
            // speed builds, so the faster the run the more the craft leads it.
            let rate = 18;
            if (S.cinematicCam) rate -= 9 * Math.min(1, speed01) * S.camYawLag;
            this.yaw = angleDamp(this.yaw, facing + this._yawUser, rate, dt);
        } else {
            this.yaw += input.lookX;
        }
        this.pitch = clamp(this.pitch + input.lookY, PITCH_MIN, PITCH_MAX);

        // ------------------------------------------------------------- zoom
        this.distanceTarget = clamp(
            this.distanceTarget + input.zoomDelta * (this.distanceTarget * 0.35),
            DIST_MIN,
            DIST_MAX
        );
        // Eased zoom — expDamp is framerate-independent.
        this.distance = expDamp(this.distance, this.distanceTarget, 9, dt);

        // ------------------------------------------------------------ pivot
        _pivot.copy(targetPos);
        _pivot.y += this.pivotHeight;

        // Lead the camera slightly into the direction of travel so fast motion
        // shows more of what's ahead.
        const lead = Math.min(1, speed01) * 1.35;
        _pivot.x += targetVel.x * lead * 0.09;
        _pivot.z += targetVel.z * lead * 0.09;

        if (this._first) {
            this.pivot.copy(_pivot);
            this._first = false;
        } else {
            // Softer spring under acceleration = the arm stretches, then recovers.
            springDamp(this.pivot, this.pivotVel, _pivot, 7.5, 1.0, dt);
        }

        // -------------------------------------------------------------- fov
        // Boost breath: while the reheat is lit the frame inhales — a little
        // extra arm and a touch more FOV, eased in over half a second and eased
        // back out on release. It rides *on top of* the composed arm length so
        // the player's own zoom (distanceTarget) is never touched.
        this._breath = expDamp(
            this._breath,
            flying && S.cinematicCam && input.sprint ? 1 : 0,
            2.5, dt
        );
        const breath = this._breath * S.camBoostBreath;
        const fovWant = this.baseFov * (1 + speed01 * 0.19) + breath * 0.04;
        this.fov = expDamp(this.fov, fovWant, 3.2, dt);

        // ------------------------------------------------------------- bank
        this.rollTarget = -lean * 0.085;
        this.roll = expDamp(this.roll, this.rollTarget, 5.0, dt);

        // ------------------------------------------------------------ shake
        this.trauma = Math.max(0, this.trauma - dt * 1.15);
        this.shakeTime += dt;
        const shake = this.trauma * this.trauma;

        // ------------------------------------------------------ compose xform
        const cp = Math.cos(this.pitch);
        _fwd.set(
            Math.sin(this.yaw) * cp,
            -Math.sin(this.pitch),
            Math.cos(this.yaw) * cp
        );
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        _up.crossVectors(_right, _fwd);
        _up.normalize();

        this.forward.copy(_fwd);
        this.right.copy(_right);
        this.up.copy(_up);

        _desired.copy(this.pivot);
        _desired.add(_tmp.copy(_fwd).multiplyScalar(-(this.distance + breath)));
        _desired.add(_tmp.copy(_right).multiplyScalar(this.shoulder));
        _desired.add(_tmp.copy(_up).multiplyScalar(0.22));

        // ---- keep the arm out of the snow --------------------------------
        // The lift rises quickly and relaxes slowly: snapping down the instant a
        // crest passes under the arm reads as a jolt, while being slow to rise
        // means a frame or two actually inside the snow.
        if (this.groundAt) {
            // Worst case over the whole arm, not just the eye: a crest between
            // the player and the camera can fill the view while the eye itself
            // is legally above the snow.
            let need = 0;
            // Predictive as well as reactive: each probe also looks ~0.12 s
            // along the rig's own travel, so an approaching crest starts the
            // lift *before* it slides under the arm. That early warning is what
            // lets the rise rate drop from a near-instant 26 to 10 — a felt
            // ease-in instead of a vertical kick — without ever clipping snow.
            const px = this.pivotVel.x * 0.12;
            const pz = this.pivotVel.z * 0.12;
            for (let i = 0; i <= ARM_SAMPLES; i++) {
                const t = i / ARM_SAMPLES;
                const x = this.pivot.x + (_desired.x - this.pivot.x) * t;
                const z = this.pivot.z + (_desired.z - this.pivot.z) * t;
                const y = this.pivot.y + (_desired.y - this.pivot.y) * t;
                const g = Math.max(this.groundAt(x, z), this.groundAt(x + px, z + pz));
                // Clearance eases in along the arm so it does not shove the
                // camera up merely for being near the player's own feet.
                const gh = g + this.groundClearance * (0.35 + 0.65 * t);
                const d = gh - y;
                if (d > need) need = d;
            }

            this.groundLift = expDamp(
                this.groundLift, need, need > this.groundLift ? 10 : 4.5, dt
            );
            _desired.y += this.groundLift;
        }

        if (shake > 0.0001) {
            const t = this.shakeTime * 26;
            _desired.x += (noise1(t) * 2 - 1) * shake * 0.16;
            _desired.y += (noise1(t + 31.7) * 2 - 1) * shake * 0.16;
            _desired.z += (noise1(t + 71.3) * 2 - 1) * shake * 0.10;
        }

        // The Babylon build wrote position + Euler angles and let the engine
        // build the view. Here the same final angles — shake included — feed
        // the hand-built LH view directly.
        const cam = this.camera;
        cam.position.copy(_desired);
        cam.fov = this.fov;
        this._composeMatrices(
            this.pitch + (shake > 0.0001 ? (noise1(this.shakeTime * 31 + 11) * 2 - 1) * shake * 0.02 : 0),
            this.yaw + (shake > 0.0001 ? (noise1(this.shakeTime * 29 + 53) * 2 - 1) * shake * 0.02 : 0),
            this.roll + (shake > 0.0001 ? (noise1(this.shakeTime * 23 + 97) * 2 - 1) * shake * 0.05 : 0)
        );
    }

    /**
     * Rebuild `camera.view` (LH, +Z forward) from the given final angles and
     * the current `camera.position`, plus an UNJITTERED `camera.projection`.
     * Babylon Euler order is Y-then-X-then-Z (yaw, pitch, roll) — the basis
     * below is exactly that composition: yaw/pitch build the frame, roll spins
     * right/up about forward.
     *
     * Also refreshes viewProjection/invView/invViewProjection so early readers
     * (the warm-up shadow fit runs before the post chain exists) see coherent
     * matrices; the post chain recomputes all three after jittering.
     */
    _composeMatrices(pitch, yaw, roll) {
        const cam = this.camera;
        cam.aspect = this._aspect();

        const cp = Math.cos(pitch);
        const fx = Math.sin(yaw) * cp;
        const fy = -Math.sin(pitch);
        const fz = Math.cos(yaw) * cp;

        const rx0 = Math.cos(yaw), ry0 = 0, rz0 = -Math.sin(yaw);

        // Real up = fwd x right — (0,1,0) at identity, exactly the frame
        // Babylon's Euler-built rotation produced. (The *published* `rig.up`
        // in `update()` keeps the source's own `right x fwd` — a sign oddity
        // consumers were tuned against — but the view matrix needs the true
        // basis or the world renders upside down.)
        let ux = fy * rz0 - fz * ry0;
        let uy = fz * rx0 - fx * rz0;
        let uz = fx * ry0 - fy * rx0;
        const ul = Math.hypot(ux, uy, uz) || 1;
        ux /= ul; uy /= ul; uz /= ul;

        // Roll about forward: right' = right·cos + up·sin, up' = up·cos − right·sin.
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const rx = rx0 * cr + ux * sr;
        const ry = ry0 * cr + uy * sr;
        const rz = rz0 * cr + uz * sr;
        const ux2 = ux * cr - rx0 * sr;
        const uy2 = uy * cr - ry0 * sr;
        const uz2 = uz * cr - rz0 * sr;

        const p = cam.position;
        setFrame(
            _frame, 0, p.x, p.y, p.z,
            rx, ry, rz,
            ux2, uy2, uz2,
            fx, fy, fz
        );
        invertRigid(cam.view.elements, 0, _frame, 0);

        perspectiveFovLH(cam.projection.elements, cam.fov, cam.aspect, cam.minZ, cam.maxZ);

        mulMat4(cam.viewProjection.elements, cam.projection.elements, cam.view.elements);
        invertRigid(cam.invView.elements, 0, cam.view.elements, 0);
        invertMat4(cam.invViewProjection.elements, cam.viewProjection.elements);
    }

    /** Render-size aspect; the ratio is scale-invariant. */
    _aspect() {
        const gfx = this.gfx;
        if (gfx && gfx.renderer) {
            const h = gfx.renderHeight;
            if (h > 0) return gfx.renderWidth / h;
        }
        const canvas = this.canvas;
        if (canvas && canvas.clientHeight > 0) {
            return canvas.clientWidth / canvas.clientHeight;
        }
        return 16 / 9;
    }

    /** Flat camera-space forward on the XZ plane, for movement. Writes to `out`. */
    getFlatForward(out) {
        out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        return out;
    }

    getFlatRight(out) {
        out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        return out;
    }
}

// ------------------------------------------------------------------ helpers

/** Framerate-independent exponential approach. */
export function expDamp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

// Local copies of the controller's angle helpers. Duplicated on purpose:
// controller.js imports expDamp from here, and a camera → controller import
// would close a module cycle for the sake of six lines.

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}

/**
 * Semi-implicit damped spring toward `target`, mutating `pos` and `vel`.
 * @param {THREE.Vector3} pos @param {THREE.Vector3} vel @param {THREE.Vector3} target
 * @param {number} freq natural frequency (rad/s-ish)
 * @param {number} damping 1 = critical
 */
function springDamp(pos, vel, target, freq, damping, dt) {
    const k = freq * freq;
    const c = 2 * damping * freq;
    // Substep rather than truncate. The old clamp to 1/45 kept the integrator
    // stable but silently integrated *less* than the elapsed time below 45 fps,
    // so the arm lagged more on a slow machine and rubber-banded after every
    // hitch. Splitting the real dt into sub-1/90 steps is stable at any frame
    // rate and always advances the spring by exactly the time that passed.
    // (dt arrives capped at 0.1 s by the main loop, so n tops out at 9.)
    const n = Math.max(1, Math.ceil(dt * 90));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
        vel.x += (k * (target.x - pos.x) - c * vel.x) * h;
        vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
        vel.z += (k * (target.z - pos.z) - c * vel.z) * h;
        pos.x += vel.x * h;
        pos.y += vel.y * h;
        pos.z += vel.z * h;
    }
}

/** Cheap smooth 1D value noise for shake. Deterministic, no allocation. */
function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

function hash1(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
}
