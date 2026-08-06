/**
 * The flight recorder, and the ghost that flies the tape.
 *
 * The AI wingman's runs are competent and legible — and therefore boring.
 * The fix is not more AI: it is the player. Flip "Record flight" on, fly the
 * way only a person flies — the hesitation before a run, the too-late break,
 * the show-off low pass — flip it off, and the wingman can fly *that*,
 * forever, through the same Speeder presentation the player's craft uses.
 *
 * What is recorded, at 20 Hz into a rolling ~3 minute window:
 *
 *   x, z        where the craft was
 *   facing      unwrapped, so interpolation never spins the long way round
 *   climb       the E-latch altitude above the terrain-following path —
 *               recorded instead of absolute height so the tape replays
 *               sensibly over any terrain state
 *   boost/fire  the reheat and the trigger, so the flame and the guns play
 *               back exactly where they were used
 *
 * Playback interpolates between samples, derives velocity/lean/steer from
 * the tape's own motion, and loops with a blended seam. The tape persists in
 * localStorage, so the wingman remembers across reloads.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";

const HZ = 20;
const STRIDE = 6;                 // x, z, facing, climb, boost, fire
const MAX_SECONDS = 180;
const MAX_SAMPLES = MAX_SECONDS * HZ;
const STORE_KEY = "snowflow.flightTape.v1";
/** Seconds of the loop's tail blended back onto its head. */
const SEAM = 1.6;

export class FlightRecorder {
    constructor() {
        /** @type {Float32Array} ring buffer of samples */
        this._buf = new Float32Array(MAX_SAMPLES * STRIDE);
        this._count = 0;
        this._head = 0;
        this._accum = 0;
        this._facingCont = 0;
        this._facingPrev = 0;
        this._primed = false;
        this.recording = false;
    }

    /** Begin a fresh tape. */
    start() {
        this._count = 0;
        this._head = 0;
        this._accum = 0;
        this._primed = false;
        this.recording = true;
        console.log("[tape] recording");
    }

    /** Stop, persist, report. @returns {boolean} whether a usable tape exists */
    stop() {
        this.recording = false;
        if (this._count < HZ * 5) {
            console.log("[tape] too short to keep (fly at least ~5s)");
            return false;
        }
        this.save();
        console.log(`[tape] saved ${(this._count / HZ).toFixed(1)}s of flight`);
        return true;
    }

    /**
     * One simulation step while recording.
     * @param {import("../character/controller.js").CharacterController} c
     * @param {{sprint:boolean, fire:boolean}} input
     * @param {number} dt
     */
    sample(c, input, dt) {
        if (!this.recording) return;
        // Unwrap facing before deciding whether to store this frame, so fast
        // spins between samples still accumulate correctly.
        if (!this._primed) {
            this._facingPrev = c.facing;
            this._facingCont = c.facing;
            this._primed = true;
        }
        let d = c.facing - this._facingPrev;
        while (d > Math.PI) d -= Math.PI * 2;
        while (d < -Math.PI) d += Math.PI * 2;
        this._facingCont += d;
        this._facingPrev = c.facing;

        this._accum += dt;
        if (this._accum < 1 / HZ) return;
        // Cap the debt: a long hitch must not queue a burst of near-duplicate
        // samples that replays as a slow-motion crawl at this point of every
        // future loop.
        this._accum = Math.min(this._accum - 1 / HZ, 1 / HZ);

        const o = this._head * STRIDE;
        this._buf[o] = c.position.x;
        this._buf[o + 1] = c.position.z;
        this._buf[o + 2] = this._facingCont;
        this._buf[o + 3] = c.climb || 0;
        this._buf[o + 4] = input.sprint ? 1 : 0;
        this._buf[o + 5] = input.fire ? 1 : 0;
        this._head = (this._head + 1) % MAX_SAMPLES;
        if (this._count < MAX_SAMPLES) this._count++;
    }

    /** The tape in chronological order, or null if too short. */
    tape() {
        if (this._count < HZ * 5) return null;
        const out = new Float32Array(this._count * STRIDE);
        const start = (this._head - this._count + MAX_SAMPLES) % MAX_SAMPLES;
        for (let i = 0; i < this._count; i++) {
            const src = ((start + i) % MAX_SAMPLES) * STRIDE;
            out.set(this._buf.subarray(src, src + STRIDE), i * STRIDE);
        }
        return out;
    }

    save() {
        const t = this.tape();
        if (!t) return;
        try {
            // Rounded to centimetres/milliradians — a fraction of the size,
            // none of the difference.
            localStorage.setItem(STORE_KEY, JSON.stringify(
                Array.from(t, (v) => Math.round(v * 100) / 100)
            ));
        } catch (err) {
            console.warn("[tape] could not persist:", err);
        }
    }

    /** @returns {Float32Array|null} the persisted tape, if any */
    static load() {
        try {
            const raw = localStorage.getItem(STORE_KEY);
            if (!raw) return null;
            const arr = JSON.parse(raw);
            if (!Array.isArray(arr) || arr.length < HZ * 5 * STRIDE) return null;
            // A tampered/corrupt tape must not become NaN positions: the shape
            // has to be whole samples and every element a real number.
            if (arr.length % STRIDE !== 0) return null;
            if (!arr.every(Number.isFinite)) return null;
            return Float32Array.from(arr);
        } catch {
            return null;
        }
    }
}

/**
 * Flies a tape. Publishes the same controller surface `SimPilot` does, so the
 * `Speeder` presentation cannot tell a ghost from a machine — or a player.
 */
export class ReplayPilot {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {Float32Array} tape
     */
    constructor(terrain, tape) {
        this.terrain = terrain;
        this.setTape(tape);

        this.position = new THREE.Vector3();
        this.velocity = new THREE.Vector3();
        this.facing = 0;
        this.lean = 0;
        this.steerRate = 0;
        this.speed01 = 0;
        this.speedRaw = 0;
        this.climb = 0;
        this.lift01 = 0;
        this.pathY = 0;
        this.groundY = 0;
        this.driveHeld = true;
        this.boostHeld = false;
        this.fireHeld = false;

        this._t = 0;
        this._steerPrev = 0;
        this._steerSlew = 0;
    }

    /** Swap tapes mid-session (a fresh recording just finished). */
    setTape(tape) {
        this._tape = tape;
        this._samples = tape ? tape.length / STRIDE : 0;
        this._dur = Math.max(0.001, (this._samples - 1) / HZ);
        this._t = 0;
    }

    /** Raw tape read at time v (seconds), interpolated. */
    _raw(v, out) {
        const idx = Math.max(0, v) * HZ;
        const i0 = Math.min(this._samples - 2, Math.floor(idx));
        const f = Math.min(1, idx - i0);
        const a = i0 * STRIDE;
        const b = (i0 + 1) * STRIDE;
        const T = this._tape;
        out.x = T[a] + (T[b] - T[a]) * f;
        out.z = T[a + 1] + (T[b + 1] - T[a + 1]) * f;
        out.facing = T[a + 2] + (T[b + 2] - T[a + 2]) * f;
        out.climb = T[a + 3] + (T[b + 3] - T[a + 3]) * f;
        out.boost = T[a + 4] > 0.5 || T[b + 4] > 0.5;
        out.fire = T[a + 5] > 0.5 || T[b + 5] > 0.5;
    }

    /**
     * Sample the tape at time t (seconds), with the seam blended.
     *
     * The crossfade sits at the loop *start*: the loop plays only the first
     * `dur - SEAM` seconds, and for the first SEAM seconds after each wrap
     * the output fades from the truncated tail — `tape(loops + u)` — into the
     * head. At u = 0 that IS the pre-wrap frame, so both boundaries are
     * continuous (an earlier tail-side blend converged on tape(SEAM) and then
     * wrapped to tape(0): a teleport, and a one-frame velocity spike the hull
     * convulsed on every loop).
     */
    _at(t, out) {
        const trunc = this._dur - SEAM > 1;
        const loops = trunc ? this._dur - SEAM : this._dur;
        const u = t % loops;
        this._raw(u, out);

        if (trunc && u < SEAM) {
            const k = u / SEAM;
            const s = 1 - k * k * (3 - 2 * k); // 1 -> 0 across the seam
            const tail = ReplayPilot._seam;
            this._raw(loops + u, tail);
            out.x += (tail.x - out.x) * s;
            out.z += (tail.z - out.z) * s;
            // Facing blends by shortest path — the tape's unwrapped values may
            // be many turns apart between head and tail.
            let df = tail.facing - out.facing;
            df = ((df % (Math.PI * 2)) + Math.PI * 3) % (Math.PI * 2) - Math.PI;
            out.facing += df * s;
            out.climb += (tail.climb - out.climb) * s;
        }
    }

    /** @param {number} rawDt */
    update(rawDt) {
        const dt = Math.min(rawDt || 0, 1 / 30);
        if (dt <= 0 || !this._tape) return;
        const prevX = this.position.x, prevZ = this.position.z;
        const prevFacing = this.facing;

        this._t += dt;
        const s = ReplayPilot._scratch;
        this._at(this._t, s);

        this.position.x = s.x;
        this.position.z = s.z;
        this.facing = Math.atan2(Math.sin(s.facing), Math.cos(s.facing));
        this.boostHeld = s.boost;
        this.fireHeld = s.fire;
        this.climb = s.climb;
        this.lift01 = Math.min(1, this.climb / 20);

        // Everything the presentation banks off, derived from the tape's own
        // motion — the ghost leans because the recorded flight actually turned.
        if (this._t > dt * 2) {
            const vx = (this.position.x - prevX) / dt;
            const vz = (this.position.z - prevZ) / dt;
            this.velocity.x = expDamp(this.velocity.x, vx, 14, dt);
            this.velocity.z = expDamp(this.velocity.z, vz, 14, dt);
            let dFace = this.facing - prevFacing;
            while (dFace > Math.PI) dFace -= Math.PI * 2;
            while (dFace < -Math.PI) dFace += Math.PI * 2;
            const steer = Math.max(-1, Math.min(1, (dFace / dt) / 2.35));
            const slewPrev = this._steerSlew;
            this._steerSlew = expDamp(this._steerSlew, steer, 12, dt);
            this.steerRate = (this._steerSlew - slewPrev) / dt;
            const sNow = Math.hypot(this.velocity.x, this.velocity.z);
            this.speed01 = Math.min(1, sNow / 19.5);
            this.speedRaw = sNow / 19.5;
            const latAcc = (dFace / dt) * sNow; // curvature * speed
            this.lean = expDamp(
                this.lean, Math.max(-1, Math.min(1, latAcc / 26)), 6.5, dt
            );
        }
        this.driveHeld = this.speed01 > 0.04;

        this.groundY = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
        this.pathY = this.groundY;
        this.position.y = this.groundY + 2.6 + this.climb;
    }
}

ReplayPilot._scratch = { x: 0, z: 0, facing: 0, climb: 0, boost: false, fire: false };
ReplayPilot._seam = { x: 0, z: 0, facing: 0, climb: 0, boost: false, fire: false };
