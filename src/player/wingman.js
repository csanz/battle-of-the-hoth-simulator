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
 *   APPROACH    line up on the target, throttle up;
 *   ATTACK      hold the run at hull height, guns firing through the
 *               convergence window, closing fast;
 *   BREAK       reheat, hard bank past the legs with a pull-up, bleed the
 *               turn off, and go around.
 *
 * All steering is turn-rate limited and every eased state is exponential in
 * dt, so the craft banks into arcs like a flown machine rather than homing
 * like a missile, at any frame rate. No walker is harmed: the guns crater
 * the snow around the target's feet, which is what the guns *do* here.
 *
 * What keeps the flying *smooth* (the Smoothness PRD, R1-R8):
 *
 *   path      the vertical rides a ~2 s smoothing of the ground while the
 *             craft is committed to a run, exactly as the player's cruise
 *             flattening does — no copying every dune at 29 m/s.
 *   pull-up   the break's climb never commands below what the attack was
 *             holding, so the pass peaks over the legs instead of dipping
 *             toward them for the first beat of the ramp.
 *   the lock  a pass owns its target from `_pickRunPoint` until it dies or
 *             hides; "nearest" is never re-rolled mid-run under the nose.
 *   the aim   lead pursuit against the target's own eased velocity, with
 *             the steering gain relaxing as the range closes — the run
 *             straightens out and the fire window stays open.
 *   hand-off  the carrot blends across phase entries (~0.4 s) instead of
 *             stepping; the break keeps its snap on purpose.
 *   the orbit the no-target racetrack aims a fixed arc ahead of the craft's
 *             own bearing round the circle, so it is a real orbit with a
 *             real radius rather than a chase it can never win.
 *   the bank  turn rate is budgeted by lateral acceleration, so a fast pass
 *             banks wide and a slow repositioning turn stays tight.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";
import { Speeder } from "./speeder.js";

/** Hard physical limits. Hotter than the player's craft on purpose: this is
 *  the ace of the pair, and an escort that dawdles reads as broken AI. */
const TURN_MAX = 2.6;        // rad/s ceiling, reached only at low speed
/** Lateral-acceleration budget, m/s^2 — the real cap at speed (R7). High:
 *  the craft snaps around its turns and comes straight back at the herd. */
const LAT_ACCEL = 75;
const ACCEL = 22;            // m/s^2 toward the phase's target speed
const SPEED_ATTACK = 38;
const SPEED_BREAK = 46;
const SPEED_REPO = 32;

/** The run geometry, metres. Tight — the fight stays around the walkers
 *  rather than wandering off over the horizon between passes. */
const RUN_START = 280;       // how far out a pass begins
const FIRE_FAR = 260;        // guns open
const BREAK_AT = 110;        // where the pull-off begins
/** Guns stop where the break begins — one constant, so neither can silently
 *  dead-code the other (R8). The burst runs right into the pull-off. */
const FIRE_NEAR = BREAK_AT;
const BREAK_TIME = 1.6;      // seconds of hard egress before swinging wide

/** Seconds the carrot blends across a phase hand-off (R5). */
const CARROT_BLEND = 0.4;
/** The fallback orbit: radius, and how far ahead of the craft's own bearing
 *  round the circle the carrot sits (R6). */
const ORBIT_R = 260;
const ORBIT_AHEAD = 0.55;

/** How often a pass goes after the infantry rather than the armour. */
const TROOPER_PASS_CHANCE = 0.65;
/** Run altitude against troopers, metres — low strafing, but high enough
 *  that the smoothed path never has the hull kissing a dune crest. */
const TROOPER_RUN_ALT = 3.5;

const _toT = new THREE.Vector3();

function wrapAngle(a) {
    while (a > Math.PI) a -= Math.PI * 2;
    while (a < -Math.PI) a += Math.PI * 2;
    return a;
}

class SimPilot {
    /**
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../walkers/walker.js").WalkerHerd|null} walkers
     * @param {{x:number, z:number}} anchor the player, for the patrol fallback
     * @param {import("../walkers/walker.js").WalkerHerd|null} [troopers]
     *   the infantry the strafing runs mostly go after
     * @param {{trooperChance?: number, seat?: number}} [opts] this pilot's
     *   character: how often a pass hunts infantry, and which slot of the
     *   flight it flies — the seat seeds the run bearing and the orbit
     *   direction, so three ships never fly the same racetrack.
     */
    constructor(terrain, walkers, anchor, troopers, opts) {
        this.terrain = terrain;
        this.walkers = walkers;
        this.troopers = troopers ?? null;
        this._trooperChance = opts?.trooperChance ?? TROOPER_PASS_CHANCE;
        this._seat = opts?.seat ?? 0;
        this._orbitDir = this._seat % 2 === 0 ? 1 : -1;
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
        // Seats fan the opening bearings a third of a turn apart, so the
        // flight's first passes cross the field on three different lines.
        this._runBearing = this._seat * (Math.PI * 2 / 3)
            + Math.random() * Math.PI * 2 / 3;
        this._runPoint = new THREE.Vector3();
        this._breakDir = 1;
        this._climbWant = 0;
        /** The break ramp's floor: whatever the attack was holding (R2). */
        this._climbFloor = 0;

        /** The pass's target, held for the whole run (R3). */
        this._lock = null;

        /** Target velocity, eased — the lead pursuit's input (R4). */
        this._tracked = null;
        this._tgtPX = 0;
        this._tgtPZ = 0;
        this._tvx = 0;
        this._tvz = 0;

        /** Carrot blending across phase hand-offs (R5). */
        this._blendT = 0;
        this._fromX = 0;
        this._fromZ = 0;
        this._wantX = this.position.x;
        this._wantZ = this.position.z + 1;

        /** Flattened cruise ground and eased flight intent (R1). */
        this._cruiseGround = NaN;
        this._lift = 0.4;

        /** Going in: the floor stops holding and the craft settles into the
         *  snow. Set by the damage ladder's third hit; `crashed` latches for
         *  one frame at ground contact, then the airframe lies as a burning
         *  wreck for `_wreckT` seconds before `respawn` refills the seat. */
        this.downed = false;
        this.crashed = false;
        this._wreckT = 0;

        this._pickRunPoint();
    }

    /** A fresh airframe for this seat, brought in from deep on a new bearing. */
    respawn() {
        this.downed = false;
        this.crashed = false;
        this._hitTroopers = Math.random() < this._trooperChance;
        this._lock = this._pickTarget();
        const cx = this._lock ? this._lock.position.x : this.anchor.x;
        const cz = this._lock ? this._lock.position.z : this.anchor.z;
        const b = Math.random() * Math.PI * 2;
        this.position.set(cx + Math.sin(b) * 480, 0, cz + Math.cos(b) * 480);
        this.facing = Math.atan2(cx - this.position.x, cz - this.position.z);
        this.velocity.set(
            Math.sin(this.facing) * SPEED_REPO, 0, Math.cos(this.facing) * SPEED_REPO
        );
        this.groundY = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
        this._cruiseGround = this.groundY;
        this.climb = 12;
        this._climbWant = 12;
        this._lift = 1;
        this.position.y = this.groundY + 2.6 + this.climb;
        this._phase = "reposition";
        this._phaseT = 0;
        this._blendT = 0;
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

    /** Fresh pick: what the next pass should attack, or null. */
    _pickTarget() {
        if (this._hitTroopers) {
            const t = this._nearestOf(this.troopers, S.showAtst !== false);
            if (t) return t;
        }
        return this._nearestOf(this.walkers, S.showWalker !== false);
    }

    /** Is this held target still worth flying at? */
    _lockAlive(w) {
        if (!w || w.oneshot) return false;
        const herd = w.herd;
        if (!herd || w.index >= herd.count) return false;
        return herd === this.walkers
            ? S.showWalker !== false
            : S.showAtst !== false;
    }

    /**
     * The target this pass is flying, held from `_pickRunPoint` until it dies
     * or disappears — "nearest" re-rolled mid-run is a nose that whips
     * sideways under the player's eye (R3). A dead lock re-picks immediately,
     * and the carrot blend covers the hand-off.
     */
    _target() {
        if (this._lockAlive(this._lock)) return this._lock;
        const next = this._pickTarget();
        if (next !== this._lock) this._startBlend();
        this._lock = next;
        return next;
    }

    /** Begin easing the carrot from wherever it currently is (R5). */
    _startBlend() {
        this._fromX = this._wantX;
        this._fromZ = this._wantZ;
        this._blendT = CARROT_BLEND;
    }

    /** A fresh start point for the next pass: wide, low, new axis. */
    _pickRunPoint() {
        // Roll what the pass goes after — each pilot has its own appetite for
        // infantry; the specialist's chance is 1 and it never leaves the
        // squads alone. Falls back to armour when no squad is standing.
        this._hitTroopers = Math.random() < this._trooperChance;
        this._lock = this._pickTarget();
        const t = this._lock;
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

    /**
     * The opening: start the flight behind the player, already at altitude
     * and speed, aimed at the battle — so frame one has the escorts sweeping
     * low overhead toward the walkers, in echelon, each on its own lane.
     *
     * @param {{x:number, z:number}} player where the camera is
     * @param {number} bx battle centre x
     * @param {number} bz battle centre z
     */
    flyover(player, bx, bz) {
        const dx = bx - player.x, dz = bz - player.z;
        const l = Math.hypot(dx, dz) || 1;
        const nx = dx / l, nz = dz / l;
        // Echelon: seat 0 dead over the camera, the others offset to either
        // side and staggered back, so the formation reads in one glance.
        const lane = (this._seat === 0 ? 0 : this._seat === 1 ? -1 : 1) * 26;
        const back = 90 + this._seat * 35;
        this.position.set(
            player.x - nx * back - nz * lane, 0,
            player.z - nz * back + nx * lane
        );
        this.facing = Math.atan2(dx, dz);
        this.velocity.set(nx * SPEED_REPO, 0, nz * SPEED_REPO);
        this.climb = 13;
        this._climbWant = 12;
        this._lift = 1;
        this.groundY = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
        this._cruiseGround = this.groundY;
        this.position.y = this.groundY + 2.6 + this.climb;
        // Straight into an approach on the battle: the run point is the
        // battle centre, so the first pass is the flyover continuing on.
        this._runPoint.set(bx, 0, bz);
        this._runBearing = Math.atan2(this.position.x - bx, this.position.z - bz);
        this._phase = "reposition";
        this._phaseT = 0;
        this._wantX = bx;
        this._wantZ = bz;
        this._blendT = 0;
    }

    /** @param {number} rawDt */
    update(rawDt) {
        const dt = Math.min(rawDt || 0, 1 / 30);
        if (dt <= 0) return;

        // The wreck: down in the snow, sliding to a stop, burning. The hull
        // is drawn from terrain + hover + climb, so a negative climb is what
        // actually grounds it. When the timer runs out the seat refills.
        if (this._wreckT > 0) {
            this._wreckT -= dt;
            const skid = Math.max(0, 1 - dt * 2.2);
            this.velocity.x *= skid;
            this.velocity.z *= skid;
            this.position.x += this.velocity.x * dt;
            this.position.z += this.velocity.z * dt;
            this.groundY = this.terrain && this.terrain.heightAt
                ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
            this.pathY = this.groundY;
            this.lift01 = 0;
            this.climb = expDamp(this.climb, -1.9, 3, dt);
            this.position.y = this.groundY + 2.6 + this.climb;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            this.speed01 = Math.min(1, s / 19.5);
            this.speedRaw = this.speed01;
            this.driveHeld = false;
            this.boostHeld = false;
            this.fireHeld = false;
            // Settled on one skid, slightly over: a wreck lies at an angle.
            this.lean = expDamp(this.lean, 0.35, 2.0, dt);
            this.steerRate = 0;
            if (this._wreckT <= 0) this.respawn();
            return;
        }

        this._phaseT += dt;

        const target = this._target();
        const tx = target ? target.position.x : this.anchor.x;
        const tz = target ? target.position.z : this.anchor.z;
        const distT = Math.hypot(tx - this.position.x, tz - this.position.z);
        const scale = Math.max(0.4, S.walkerScale);
        const speedNow = Math.hypot(this.velocity.x, this.velocity.z);

        // ---- target velocity, eased — what the lead pursuit aims off (R4) --
        if (target) {
            if (this._tracked !== target) {
                this._tracked = target;
                this._tvx = 0;
                this._tvz = 0;
            } else {
                this._tvx = expDamp(this._tvx, (target.position.x - this._tgtPX) / dt, 6, dt);
                this._tvz = expDamp(this._tvz, (target.position.z - this._tgtPZ) / dt, 6, dt);
            }
            this._tgtPX = target.position.x;
            this._tgtPZ = target.position.z;
        } else {
            this._tracked = null;
        }
        // Nose at where the target will be when the craft gets there, not
        // where it is — pure pursuit against a moving machine is a constant
        // tail-chase curve, and the curve is what flickered the fire window.
        const tof = distT / Math.max(10, speedNow);
        const aimX = tx + this._tvx * tof;
        const aimZ = tz + this._tvz * tof;

        // ---- phase logic ---------------------------------------------------
        let wantX, wantZ;   // where the nose should point
        // Proportional steering gain; relaxed with proximity during the run
        // so a small lateral offset near the target stays a small correction.
        let gain = 2.2;
        this.fireHeld = false;
        this.boostHeld = false;

        if (!target) {
            // No one to fight: a real racetrack around the player. The carrot
            // sits a fixed arc ahead of the craft's own bearing round the
            // circle — a point it can actually reach — rather than a clock
            // hand it could never catch (R6).
            this._phase = "reposition";
            const b = Math.atan2(
                this.position.x - this.anchor.x, this.position.z - this.anchor.z
            );
            wantX = this.anchor.x + Math.sin(b + ORBIT_AHEAD * this._orbitDir) * ORBIT_R;
            wantZ = this.anchor.z + Math.cos(b + ORBIT_AHEAD * this._orbitDir) * ORBIT_R;
            this._speedTarget = SPEED_REPO;
            this._climbWant = 12;
        } else if (this._phase === "reposition") {
            wantX = this._runPoint.x;
            wantZ = this._runPoint.z;
            this._speedTarget = SPEED_REPO;
            // High between passes: the swing-around is flown up out of the
            // dunes, and the attack is a *descent* onto the line.
            this._climbWant = 12;
            const dRun = Math.hypot(
                this._runPoint.x - this.position.x, this._runPoint.z - this.position.z
            );
            if (dRun < 60 || this._phaseT > 7) {
                this._phase = "approach";
                this._phaseT = 0;
                // Soften the run-point -> target hand-off; the break keeps
                // its snap because the break is meant to be violent (R5).
                this._startBlend();
            }
        } else if (this._phase === "approach") {
            wantX = aimX; wantZ = aimZ;
            gain = 1.2 + Math.min(1, distT / 200);
            this._speedTarget = SPEED_ATTACK;
            // Rise to hull height on the way in: the guns fire flat, so the
            // run's altitude *is* the aim — man-height against a squad.
            this._climbWant = target.herd === this.troopers
                ? TROOPER_RUN_ALT : 9 * scale;
            const err = Math.abs(wrapAngle(
                Math.atan2(tx - this.position.x, tz - this.position.z) - this.facing
            ));
            if ((err < 0.22 && distT < RUN_START + 60) || this._phaseT > 6) {
                this._phase = "attack";
                this._phaseT = 0;
            }
        } else if (this._phase === "attack") {
            wantX = aimX; wantZ = aimZ;
            gain = 1.2 + Math.min(1, distT / 200);
            this._speedTarget = SPEED_ATTACK;
            this._climbWant = target.herd === this.troopers
                ? TROOPER_RUN_ALT : 9 * scale;
            const err = Math.abs(wrapAngle(
                Math.atan2(aimX - this.position.x, aimZ - this.position.z) - this.facing
            ));
            this.fireHeld = err < 0.05 && distT < FIRE_FAR && distT > FIRE_NEAR;
            if (distT < BREAK_AT) {
                this._phase = "break";
                this._phaseT = 0;
                this._breakDir = Math.random() < 0.5 ? 1 : -1;
                // The pull-up ramps from what the attack was holding, never
                // below it — a break that first commands a dive is the craft
                // sagging toward the legs at its closest point (R2).
                this._climbFloor = this._climbWant;
            }
        } else { // break
            // Hard egress: a heading well off the run axis, reheat lit, a
            // pull-up over the legs that settles as the turn bleeds off.
            const away = this.facing + this._breakDir * 1.9;
            wantX = this.position.x + Math.sin(away) * 200;
            wantZ = this.position.z + Math.cos(away) * 200;
            this._speedTarget = SPEED_BREAK;
            this.boostHeld = true;
            this._climbWant = Math.max(
                this._climbFloor,
                15 * scale * Math.min(1, this._phaseT / 0.7)
            );
            if (this._phaseT > BREAK_TIME) {
                this._phase = "reposition";
                this._phaseT = 0;
                this._pickRunPoint();
                this._startBlend();
            }
        }

        // ---- carrot blend across hand-offs (R5) ----------------------------
        // The path was always continuous; this keeps the *steer input* from
        // saturating in one frame, which is what a whip-pan looks like on the
        // banking hull. Skipped through the break — that snap is the drama.
        if (this._blendT > 0 && this._phase !== "break") {
            this._blendT -= dt;
            const k = 1 - Math.max(0, this._blendT) / CARROT_BLEND;
            const s = k * k * (3 - 2 * k);
            wantX = this._fromX + (wantX - this._fromX) * s;
            wantZ = this._fromZ + (wantZ - this._fromZ) * s;
        } else {
            this._blendT = 0;
        }
        this._wantX = wantX;
        this._wantZ = wantZ;

        // ---- steering: turn-rate limited, slewed like the player's stick ---
        const wantHeading = Math.atan2(wantX - this.position.x, wantZ - this.position.z);
        const err = wrapAngle(wantHeading - this.facing);
        const steerRaw = Math.max(-1, Math.min(1, err * gain));
        const prevSteer = this._steer;
        this._steer = expDamp(this._steer, steerRaw, 12, dt);
        this.steerRate = (this._steer - prevSteer) / dt;
        // The turn budget is lateral acceleration, not angle: omega = a / v,
        // so a fast pass banks wide and a slow turn stays tight (R7). The
        // old constant survives as the low-speed ceiling.
        const turnMax = Math.min(TURN_MAX, LAT_ACCEL / Math.max(8, speedNow));
        const turn = this._steer * turnMax;
        this.facing = wrapAngle(this.facing + turn * dt);

        // ---- speed along the nose ------------------------------------------
        const want = this._speedTarget;
        const fx = Math.sin(this.facing), fz = Math.cos(this.facing);
        const prevVx = this.velocity.x, prevVz = this.velocity.z;
        // Mostly on rails with a touch of drift: velocity chases the nose fast
        // but not instantly, which is where the visible slip in a hard bank
        // comes from. The chase aims at the phase's *full* want-speed — aiming
        // it one ACCEL*dt step ahead instead was the old hidden handbrake:
        // the ease only ever took a seventh of a one-frame increment, so the
        // craft accelerated at ~2 m/s^2 whatever ACCEL said.
        const grip = 1 - Math.exp(-9 * dt);
        this.velocity.x += (fx * want - this.velocity.x) * grip;
        this.velocity.z += (fz * want - this.velocity.z) * grip;
        // The throttle's authority over the magnitude: speed builds at ACCEL
        // and sheds half again faster, whatever the directional ease just did.
        const sAfter = Math.hypot(this.velocity.x, this.velocity.z);
        const sClamped = Math.max(
            speedNow - ACCEL * 1.5 * dt,
            Math.min(speedNow + ACCEL * dt, sAfter)
        );
        if (sAfter > 1e-4 && sClamped !== sAfter) {
            const k = sClamped / sAfter;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
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
        // The player's cruise flattening, given to the pilot (R1): a ~2 s
        // smoothing of the ground, blended in by an eased flight *intent* —
        // committed to a run the craft rides the levelled line over the dunes
        // instead of copying every one of them at 29 m/s. `lift01` publishes
        // the intent, so the presentation's own probes flatten in step.
        this.groundY = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
        if (!Number.isFinite(this._cruiseGround)) this._cruiseGround = this.groundY;
        this._cruiseGround = expDamp(this._cruiseGround, this.groundY, 0.4, dt);
        // Always fully flown: the AI never traces the deck the way the player
        // can choose to, so the hull rides the levelled line in every phase —
        // the up-and-down of the dune field belongs to the player's low
        // flying, not to an escort holding formation at altitude.
        this._lift = expDamp(this._lift, 1, 1.6, dt);
        this.lift01 = this._lift;
        const base = this.groundY + (this._cruiseGround - this.groundY) * this._lift;
        this.pathY = base;
        if (this.downed) {
            // Power dying: the climb bleeds below the deck, the clearance
            // floor stops holding, and ground contact latches the crash and
            // starts the wreck clock — the airframe stays down, burning,
            // before this seat's replacement flies in from deep.
            this._speedTarget = Math.min(this._speedTarget, 24);
            this.climb = expDamp(this.climb, -4, 0.9, dt);
            this.position.y = Math.max(
                base + 2.6 + this.climb, this.groundY + 0.3
            );
            if (this.position.y - this.groundY < 1.1) {
                this.crashed = true;
                this.downed = false;
                this._wreckT = 13;
            }
            return;
        }
        this.climb = expDamp(this.climb, this._climbWant, 2.4, dt);
        // Floored against the raw ground so a man-height run over a dune the
        // smoothed line cut through still clears the crest.
        this.position.y = Math.max(
            base + 2.6 + this.climb, this.groundY + 2.2
        );
    }
}

export class Wingman {
    /**
     * Same signature spirit as the player's craft: everything the Speeder
     * presentation needs, plus the herds it is fighting and the player it
     * falls back to orbiting. `opts` is the pilot's character — see SimPilot.
     */
    constructor(gfx, terrain, sky, shadows, asset, walkers, spray, player, troopers, opts) {
        this.terrain = terrain;
        this.pilot = new SimPilot(terrain, walkers, player.position, troopers, opts);
        this.craft = new Speeder(gfx, terrain, sky, shadows, asset, this.pilot, spray);
        this.craft.setVisible(true);

        /**
         * The damage ladder: 0 clean, 1 black smoke, 2 fire, 3 going in.
         * `effects` is wired by main — the smoke pool, the enemy bolt pools
         * that can hit this craft, and the crash handler.
         * @type {{ smoke: import("../vfx/smokeTrails.js").SmokeTrails,
         *          enemy: (import("../walkers/bolts.js").Bolts|null)[],
         *          onCrash?: (x:number,y:number,z:number) => void } | null}
         */
        this.effects = null;
        this.damage = 0;
        this._hitGrace = 0;
        this._puffT = 0;
        /** The attrition clock — see `_updateDamage`. */
        this._fateT = 9 + Math.random() * 9;
        this._wasWreck = false;
    }

    /** One hit lands: step the ladder, buy the grace, flash the flame. */
    _takeHit() {
        const fx = this.effects;
        const P = this.pilot;
        this.damage++;
        this._hitGrace = 4.5 + Math.random() * 3;
        this._fateT = 8 + Math.random() * 10;
        for (let k = 0; k < 5; k++) {
            fx.smoke.emit(
                P.position.x, P.position.y + 0.2, P.position.z,
                (Math.random() - 0.5) * 6, 1 + Math.random() * 3,
                (Math.random() - 0.5) * 6,
                0.5, 1.2, 0.25 + Math.random() * 0.2,
                2.8, 1.0, 0.28, 0.6, false
            );
        }
        if (this.damage >= 3) P.downed = true;
    }

    /**
     * The ladder itself. A hit is a live enemy bolt passing within hull
     * distance; each one steps the damage and buys a grace window, so the
     * stages play out — smoke, then fire, then the third hit puts it in.
     * @param {number} dt
     */
    _updateDamage(dt) {
        const fx = this.effects;
        if (!fx) return;
        const P = this.pilot;
        if (this._hitGrace > 0) this._hitGrace -= dt;

        const flying = !P.downed && P._wreckT <= 0;
        if (this.damage < 3 && this._hitGrace <= 0 && flying) {
            // A literal bolt through hull space always counts...
            let hit = false;
            for (const pool of fx.enemy) {
                if (pool && pool.hitTest(P.position.x, P.position.y, P.position.z, 3.4)) {
                    hit = true;
                    break;
                }
            }
            // ...but the field's fire is aimed at the *player*, so literal
            // intersections are rare. The attrition clock is what actually
            // wears a craft down: seconds spent committed to runs through
            // the guns, and eventually one connects. This is why the ships
            // visibly smoke, burn and go in rather than flying charmed lives.
            const inTheFire = P._phase === "approach"
                || P._phase === "attack" || P._phase === "break";
            if (!hit && inTheFire) {
                this._fateT -= dt;
                if (this._fateT <= 0) hit = true;
            }
            if (hit) this._takeHit();
        }

        // The trail: dark smoke from the first hit, fire licking with it
        // from the second, both shed just behind the hull and left hanging
        // in the air the craft has already flown out of.
        if (this.damage > 0) {
            this._puffT -= dt;
            if (this._puffT <= 0) {
                this._puffT = 0.05;
                const v = P.velocity;
                // Shed at the engine block — the hull's tail, level with the
                // canopy, so the trail streams *off* the craft rather than
                // hanging under it.
                const bx = P.position.x - Math.sin(P.facing) * 2.4;
                const by = P.position.y + 0.95;
                const bz = P.position.z - Math.cos(P.facing) * 2.4;
                const shade = this.damage >= 2 ? 0.045 : 0.09;
                fx.smoke.emit(
                    bx, by, bz,
                    v.x * 0.22 + (Math.random() - 0.5) * 0.8,
                    1.1 + Math.random() * 0.6,
                    v.z * 0.22 + (Math.random() - 0.5) * 0.8,
                    0.5 + Math.random() * 0.25, 1.7,
                    1.5 + Math.random() * 0.7,
                    shade, shade, shade, 0.55, true
                );
                if (this.damage >= 2) {
                    // The fire: a fat tongue of flame off the tail, riding
                    // most of the craft's own speed so it licks backward
                    // along the hull — unmissable, which is the point of the
                    // second stage existing.
                    fx.smoke.emit(
                        bx, by - 0.25, bz,
                        v.x * 0.72 + (Math.random() - 0.5) * 1.2,
                        0.9 + Math.random() * 0.8,
                        v.z * 0.72 + (Math.random() - 0.5) * 1.2,
                        0.62 + Math.random() * 0.25, 1.4,
                        0.42 + Math.random() * 0.2,
                        3.2, 1.05, 0.26, 0.8, false
                    );
                }
            }
        }

        // Ground contact: the burst, the crater, the sound — and then the
        // airframe *stays*, a wreck in the snow shedding smoke and fire
        // (damage holds at 2 so the trail keeps burning) until the pilot's
        // wreck clock runs out and the seat's replacement flies in.
        if (P.crashed) {
            P.crashed = false;
            fx.onCrash?.(P.position.x, P.position.y, P.position.z);
            this.damage = 2;
        }
        if (this._wasWreck && P._wreckT <= 0) {
            this.damage = 0;
            this._hitGrace = 6;
            this._fateT = 9 + Math.random() * 9;
        }
        this._wasWreck = P._wreckT > 0;
    }

    /** Start this ship on the opening flyover — see SimPilot.flyover. */
    flyover(player, bx, bz) {
        this.pilot.flyover(player, bx, bz);
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
        this._updateDamage(dt);
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
