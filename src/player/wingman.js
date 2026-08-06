/**
 * The wingman: an AI T-47 flying the same fight the player joined.
 *
 * Not a second craft implementation — the same `Speeder` presentation (hull,
 * jet, bolts, shadows, prepass) driven by a `SimPilot` that publishes the
 * exact controller surface the presentation reads: position, velocity,
 * facing, lean, steerRate, speed01/speedRaw, climb/lift01/pathY, plus the
 * stick flags (driveHeld/boostHeld/fireHeld) the speeder otherwise takes
 * from the keyboard. Whatever the player's craft looks like, this one does,
 * because it is drawn by the same code with the same sliders.
 *
 * The flying is a strafing-run loop, because that is what a snowspeeder
 * versus a walker *is*:
 *
 *   REPOSITION  swing wide to a start point a few hundred metres out on a
 *               fresh bearing, low over the dunes;
 *   APPROACH    line up on the walker, throttle up;
 *   ATTACK      hold the run at hull height, guns firing through the
 *               convergence window, closing fast;
 *   BREAK       reheat, hard bank past the legs with a pull-up, bleed the
 *               turn off, and go around.
 *
 * All steering is turn-rate limited and every eased state is exponential in
 * dt, so the craft banks into arcs like a flown machine rather than homing
 * like a missile, at any frame rate. No walker is harmed: the guns crater
 * the snow around the target's feet, which is what the guns *do* here.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import { Speeder } from "./speeder.js";

/** Hard physical limits, matched to the player's craft so it reads as one. */
const TURN_MAX = 2.1;        // rad/s — just under the player's uncapped feel
const ACCEL = 13;            // m/s^2 toward the phase's target speed
const SPEED_ATTACK = 29;
const SPEED_BREAK = 36;
const SPEED_REPO = 23;

/** The run geometry, metres. */
const RUN_START = 470;       // how far out a pass begins
const FIRE_FAR = 340;        // guns open
const FIRE_NEAR = 105;       // guns stop — about to overfly
const BREAK_AT = 125;        // where the pull-off begins
const BREAK_TIME = 2.3;      // seconds of hard egress before swinging wide

const _toT = new THREE.Vector3();

function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

/** How often a pass goes after the infantry rather than the armour. */
const TROOPER_PASS_CHANCE = 0.65;
/** Run altitude against troopers, metres — man-height strafing, not hull. */
const TROOPER_RUN_ALT = 2.4;

class SimPilot {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../walkers/walker.js").WalkerHerd|null} walkers
     * @param {{x:number, z:number}} anchor the player, for the patrol fallback
     * @param {import("../walkers/walker.js").WalkerHerd|null} [troopers]
     *   the infantry the strafing runs mostly go after
     */
    constructor(terrain, walkers, anchor, troopers) {
        this.terrain = terrain;
        this.walkers = walkers;
        this.troopers = troopers ?? null;
        /** Whether the current pass hunts infantry. Rolled per pass. */
        this._hitTroopers = false;
        this.anchor = anchor;

        // ---- the controller surface Speeder reads -------------------------
        this.position = new THREE.Vector3(anchor.x - 120, 0, anchor.z - 160);
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

        // ---- the run ------------------------------------------------------
        this._phase = "reposition";
        this._phaseT = 0;
        this._speedTarget = SPEED_REPO;
        this._steer = 0;
        this._runBearing = Math.random() * Math.PI * 2;
        this._runPoint = new THREE.Vector3();
        this._breakDir = 1;
        this._climbWant = 0;
        this._pickRunPoint();
    }

    /** Nearest live machine of one herd, or null. */
    _nearestOf(herd, visible) {
        if (!herd || !herd.walkers || !visible) return null;
        const n = Math.min(herd.count, herd.walkers.length);
        let best = null;
        let bestD = Infinity;
        for (let i = 0; i < n; i++) {
            const w = herd.walkers[i];
            if (!w || !w.position) continue;
            // The dead and the flinching are not worth a pass.
            if (w.oneshot) continue;
            const d = Math.hypot(
                w.position.x - this.position.x, w.position.z - this.position.z
            );
            if (d < bestD) { bestD = d; best = w; }
        }
        return best;
    }

    /** What this pass is attacking, or null when there is nothing to fight. */
    _target() {
        if (this._hitTroopers) {
            const t = this._nearestOf(this.troopers, S.showAtst !== false);
            if (t) return t;
        }
        return this._nearestOf(this.walkers, S.showWalker !== false);
    }

    /** A fresh start point for the next pass: wide, low, new axis. */
    _pickRunPoint() {
        // Roll what the pass goes after: mostly the infantry — that is where
        // the drama is — falling back to armour when no squad is standing.
        this._hitTroopers = Math.random() < TROOPER_PASS_CHANCE;
        const t = this._target();
        const cx = t ? t.position.x : this.anchor.x;
        const cz = t ? t.position.z : this.anchor.z;
        // Swing the axis 70-120 degrees each pass so consecutive runs cross
        // the walker on different lines — the same lap twice is a carousel.
        this._runBearing += (0.45 + Math.random() * 0.45) * Math.PI
            * (Math.random() < 0.5 ? 1 : -1);
        this._runPoint.set(
            cx + Math.sin(this._runBearing) * RUN_START,
            0,
            cz + Math.cos(this._runBearing) * RUN_START
        );
    }

    /** @param {number} rawDt */
    update(rawDt) {
        const dt = Math.min(rawDt || 0, 1 / 30);
        if (dt <= 0) return;
        this._phaseT += dt;

        const target = this._target();
        const tx = target ? target.position.x : this.anchor.x;
        const tz = target ? target.position.z : this.anchor.z;
        const distT = Math.hypot(tx - this.position.x, tz - this.position.z);
        const scale = Math.max(0.4, S.walkerScale);

        // ---- phase logic ---------------------------------------------------
        let wantX, wantZ;   // where the nose should point
        this.fireHeld = false;
        this.boostHeld = false;

        if (!target) {
            // No walkers to fight: a lazy racetrack around the player, so the
            // craft stays part of the scene instead of vanishing over a dune.
            this._phase = "reposition";
            const orbit = this._phaseT * 0.22;
            wantX = this.anchor.x + Math.sin(orbit) * 260;
            wantZ = this.anchor.z + Math.cos(orbit) * 260;
            this._speedTarget = SPEED_REPO;
            this._climbWant = 4;
        } else if (this._phase === "reposition") {
            wantX = this._runPoint.x;
            wantZ = this._runPoint.z;
            this._speedTarget = SPEED_REPO;
            this._climbWant = 3;
            const dRun = Math.hypot(
                this._runPoint.x - this.position.x, this._runPoint.z - this.position.z
            );
            if (dRun < 70 || this._phaseT > 11) {
                this._phase = "approach";
                this._phaseT = 0;
            }
        } else if (this._phase === "approach") {
            wantX = tx; wantZ = tz;
            this._speedTarget = SPEED_ATTACK;
            // Rise to hull height on the way in: the guns fire flat, so the
            // run's altitude *is* the aim — man-height against a squad.
            this._climbWant = target.herd === this.troopers
                ? TROOPER_RUN_ALT : 9 * scale;
            const err = Math.abs(wrapAngle(
                Math.atan2(tx - this.position.x, tz - this.position.z) - this.facing
            ));
            if ((err < 0.22 && distT < RUN_START + 60) || this._phaseT > 9) {
                this._phase = "attack";
                this._phaseT = 0;
            }
        } else if (this._phase === "attack") {
            wantX = tx; wantZ = tz;
            this._speedTarget = SPEED_ATTACK;
            this._climbWant = target.herd === this.troopers
                ? TROOPER_RUN_ALT : 9 * scale;
            const err = Math.abs(wrapAngle(
                Math.atan2(tx - this.position.x, tz - this.position.z) - this.facing
            ));
            this.fireHeld = err < 0.05 && distT < FIRE_FAR && distT > FIRE_NEAR;
            if (distT < BREAK_AT) {
                this._phase = "break";
                this._phaseT = 0;
                this._breakDir = Math.random() < 0.5 ? 1 : -1;
            }
        } else { // break
            // Hard egress: a heading well off the run axis, reheat lit, a
            // pull-up over the legs that settles as the turn bleeds off.
            const away = this.facing + this._breakDir * 1.9;
            wantX = this.position.x + Math.sin(away) * 200;
            wantZ = this.position.z + Math.cos(away) * 200;
            this._speedTarget = SPEED_BREAK;
            this.boostHeld = true;
            this._climbWant = 15 * scale * Math.min(1, this._phaseT / 0.7);
            if (this._phaseT > BREAK_TIME) {
                this._phase = "reposition";
                this._phaseT = 0;
                this._pickRunPoint();
            }
        }

        // ---- steering: turn-rate limited, slewed like the player's stick ---
        const wantHeading = Math.atan2(wantX - this.position.x, wantZ - this.position.z);
        const err = wrapAngle(wantHeading - this.facing);
        const steerRaw = Math.max(-1, Math.min(1, err * 2.2));
        const prevSteer = this._steer;
        this._steer = expDamp(this._steer, steerRaw, 12, dt);
        this.steerRate = (this._steer - prevSteer) / dt;
        const turn = this._steer * TURN_MAX;
        this.facing = wrapAngle(this.facing + turn * dt);

        // ---- speed along the nose ------------------------------------------
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        const want = this._speedTarget;
        const next = speed + Math.max(-ACCEL * dt, Math.min(ACCEL * dt, want - speed));
        const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
        const prevVx = this.velocity.x, prevVz = this.velocity.z;
        // Mostly on rails with a touch of drift: velocity chases the nose fast
        // but not instantly, which is where the visible slip in a hard bank
        // comes from.
        const grip = 1 - Math.exp(-9 * dt);
        this.velocity.x += (fx * next - this.velocity.x) * grip;
        this.velocity.z += (fz * next - this.velocity.z) * grip;
        this.position.x += this.velocity.x * dt;
        this.position.z += this.velocity.z * dt;

        // ---- the fields the presentation banks and bobs off ----------------
        const sNow = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Math.min(1, sNow / 19.5);
        this.speedRaw = sNow / 19.5;
        const ax = (this.velocity.x - prevVx) / dt;
        const az = (this.velocity.z - prevVz) / dt;
        const latAcc = ax * Math.cos(this.facing) - az * Math.sin(this.facing);
        this.lean = expDamp(this.lean, Math.max(-1, Math.min(1, latAcc / 26)), 6.5, dt);

        // ---- altitude ------------------------------------------------------
        this.groundY = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
        this.pathY = this.groundY;
        this.climb = expDamp(this.climb, this._climbWant, 2.4, dt);
        this.lift01 = Math.min(1, this.climb / 20);
        this.position.y = this.groundY + 2.6 + this.climb;
    }
}

export class Wingman {
    /**
     * Same signature spirit as the player's craft: everything the Speeder
     * presentation needs, plus the herd it is fighting and the player it
     * falls back to orbiting.
     */
    constructor(gfx, terrain, sky, shadows, asset, walkers, spray, player, troopers) {
        this.terrain = terrain;
        this.pilot = new SimPilot(terrain, walkers, player.position, troopers);
        this.craft = new Speeder(gfx, terrain, sky, shadows, asset, this.pilot, spray);
        this.craft.setVisible(true);
    }

    get triangles() { return this.craft.triangles; }
    get shotCount() { return this.craft.shotCount; }

    registerPrepass(depth) { this.craft.registerPrepass(depth); }

    setVisible(v) { this.craft.setVisible(v); }

    tick(dt) { this.craft.tick(dt); }

    update(dt) {
        const on = S.showWingman !== false;
        this.craft.setVisible(on);
        if (!on) return;
        this.pilot.update(dt);
        this.craft.update(dt);
    }

    sync(cameraPos) {
        if (S.showWingman === false) return;
        this.craft.sync(cameraPos);
    }

    async warmUp() {
        this.pilot.update(1 / 60);
        this.craft.update(0);
        this.craft.sync(_toT.set(0, 0, 0));
        await this.craft.warmUp();
    }
}
