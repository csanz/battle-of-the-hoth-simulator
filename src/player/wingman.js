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
 *   the miss  the machines are *solid*. A look-ahead down the craft's own
 *             velocity finds any hull the projected path would enter and
 *             hands the dodge the stick, plus a pull-up over the crown when
 *             there is time to fly one — see `_avoidance`. The pass's own
 *             target is given a much shorter guard than everything else,
 *             one that cannot reach past `BREAK_AT`, so the attack still
 *             closes with the guns open and only the pull-off is bent.
 *
 * And the way one dies (see the `downed` block): the fall is a *scripted*
 * two-stage crash choreographed onto `speeder-crash-2.mp3` — the craft
 * windmills down to a first ground contact at exactly 4.0 s after the
 * killing hit, skips off the snow, and comes down for good at 5.5 s.
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

/** Metres of climb per seat for the opening formation — high, level, low, so
 *  the flight has depth from the cockpit. The player opens at the E ladder's
 *  top rung (18 m), so seat 0 rides above them and seat 2 below. */
const FLYOVER_CLIMB = [25, 17, 9];
/**
 * Metres a second the opening pass is flown at.
 *
 * Not the cruise. The escorts have to OVERTAKE a player who is flying their
 * own run-in at up to 34 m/s, and at the 32 m/s cruise the closing speed is
 * two — the flight would still be behind the cockpit when the hold ended.
 * At this it closes at sixty-odd and the three ships are all through the
 * cockpit inside a couple of seconds — before the transmission square opens,
 * which is the order the opening is supposed to have. The phase machine sheds the excess in about a
 * second once the pass is over.
 */
const FLYOVER_SPEED = 84;
/** Seconds the pass keeps that speed before the phase machine takes the
 *  throttle back. Long enough for the last ship to clear the cockpit. */
const FLYOVER_HOLD = 6;

/* ------------------------------------------------------------------ avoidance
 * Nothing ever told SimPilot that the machines are solid, so it flew straight
 * through the volume they occupy — at the attack altitude (9*walkerScale, so
 * ~14 m off the deck) that is precisely leg height, and contact was routine
 * rather than accidental. These are the numbers of the fix.
 *
 * The ring is horizontal and centred on the machine. The AT-AT's leg capsules
 * plant within ~3.5*scale of the centre at r 0.75*scale, and the body capsule
 * (r 5.0*scale, axis at 17.5*scale) reaches ~13.5*scale fore and aft, so the
 * worst horizontal extent a craft can meet is a shade under 14*scale. The
 * push falls LINEARLY to zero at the ring edge, so the ring is a clearance
 * the pilot settles into flying past at, not a wall it bounces off — which
 * is why it has to be comfortably wider than the hull it protects. Swept
 * against the real capsules over 800 forty-second flights through a
 * six-machine field, 22 is the knee: 15 leaves a fifth of the contacts,
 * 25 and 28 buy nothing and start costing gun time.
 */
const AVOID_R = 22;              // metres per unit walkerScale, non-targets
/** Seconds of the craft's own flight the look-ahead covers. */
const AVOID_AHEAD = 1.6;

/* The pass's target gets its own pair, and this is the seam that keeps the
 * choreography intact. A committed run must fly AT the machine, hold the guns
 * from FIRE_FAR (260 m) down to BREAK_AT (110 m) and only then pull off. The
 * trick is the LOOK-AHEAD, not the ring: at 0.85 s the target's guard reaches
 * 0.85 * 46 + 18*1.3 ~= 63 m at the break's own speed — barely half of
 * BREAK_AT. It is therefore arithmetically incapable of touching the approach
 * or the attack, because being inside its reach at all means the break has
 * already fired. Given that, the ring itself can be generous, and is: 18
 * makes the pull-off actually clear the legs it is pulling off from. Measured
 * cost to the fire window across 800 flights: nil. */
const AVOID_R_TGT = 18;
const AVOID_AHEAD_TGT = 0.85;

/** The threat weight is shaped by a square root before it reaches the stick.
 *  Raw, it is a product of two linear falloffs and spends most of its life
 *  around 0.2 — a shrug. Rooted, a fifth of a threat is already a firm half
 *  of a correction, which is what stops the dodge stalling halfway out.
 *
 *  `AUTH` is how much of the stick the dodge takes over at a given shaped
 *  weight, `STICK` how hard it pushes once it has it. Blending authority
 *  rather than adding a heading bias matters: during an attack the carrot is
 *  pulling the nose back toward a target *beyond* the obstacle, and a bias
 *  just fights it to a draw. Authority means the pilot stops flying the
 *  target for a beat and flies the gap — which is what a pilot does. */
const AVOID_AUTH = 2.2;
const AVOID_STICK = 1.6;
/** How fast the dodge slews in and out, 1/s. Fast (~0.14 s) so it bites, but
 *  eased so the hull banks into it instead of snapping. */
const AVOID_SLEW = 7;

/* The pull-up. This one is counter-intuitive and the geometry decides it: the
 * body capsule's floor sits at 12.5*scale (16.3 m at the default), so a pilot
 * cruising at 14 m is already UNDER the hull, threading four thin leg struts.
 * Climbing halfway does not lift it over the machine, it lifts it INTO the
 * 6.5 m-radius body — measurably worse than not climbing at all (a partial
 * climb bias cost 3400 contact-frames against 1950 for pure turning).
 *
 * So the climb is all-or-nothing: it is commanded only when there is enough
 * warning to actually top the crown before arrival, and when it is commanded
 * it goes for full clearance. Below that gate the craft holds its run
 * altitude and lets the turn do the work. The result is the pull-up the eye
 * wants — the craft really does go over the top, ~34 m against a 29 m
 * machine — on the ~7 % of frames where it can be flown honestly. */
const AVOID_CLIMB_T = 1.2;       // seconds of warning a pull-up needs
const AVOID_CLEAR = 6;           // metres of daylight over the crown
/** Slower than the turn: a pull-up is a pull-up, not a flinch. */
const AVOID_CLIMB_SLEW = 4;
/** Seconds a committed pull-up is held past the machine's arrival — the
 *  climb is a decision, not a proximity readout. See `_avoidance`. */
const AVOID_CLIMB_HOLD = 0.9;
/** Already this far above the hull's crown? Then there is nothing to avoid. */
const AVOID_OVER = 4;

/* ---------------------------------------------------------------- the crash
 * The fall is choreographed, not simulated, because it has to land on the
 * beats of `speeder-crash-2.mp3`: that sample is fired ONCE at the killing
 * hit and its own timeline carries the next seven and a half seconds — a
 * first ground impact at 4.0 s, the final crash at 5.5 s, debris after. The
 * old descent (an exponential ease toward climb -4) reached the snow in
 * ~3.4 s from climb 12 and drifted with the altitude the craft happened to
 * be carrying, which is exactly the thing a fixed soundtrack cannot forgive.
 *
 * So both stages are *normalised* profiles in `_downT`: stage one maps
 * whatever climb the hit interrupted onto `DOWN_CONTACT` at u = 1, and u = 1
 * is 4.0 s by definition, from any starting height. See the `downed` block. */
const DOWN_FALL_T = 4.0;         // killing hit -> first ground contact, s
const DOWN_SKIP_T = 1.5;         // first contact -> final crash, s
/**
 * The climb at which the existing contact test (`position.y - groundY < 1.1`)
 * trips: the downed block places the hull at `groundY + 2.6 + climb`, so
 * contact is climb < -1.5. Both profiles are aimed at exactly this value at
 * the end of their normalised time, and are deliberately left UNCLAMPED past
 * it — the first frame beyond the mark dips below and fires, so the event
 * lands within one dt of the beat instead of hovering one frame short of it.
 */
const DOWN_CONTACT = -1.5;
/** Metres of climb the skip regains at the top of its arc. */
const DOWN_HOP = 3.5;
/** Horizontal speed kept through the skip — a third of it goes into the snow. */
const DOWN_SKIP_KEEP = 0.65;

const _toT = new THREE.Vector3();

/** Scratch for `_avoidance`'s worst-threat reduction — module-level so the
 *  per-frame search allocates nothing. Written and read inside one call. */
const _av = { w: 0, side: 0, top: 0, h: 0, tHit: 0 };

/**
 * One tick of a burning craft's trail: a dark smoke puff, and — when the
 * burn has reached the fire stage — a tongue of flame riding the craft's
 * own speed backward along the hull. Shared by the wingmen's damage ladder
 * and the overlay's burn-preview on the player craft, and positioned by the
 * `S.burnBackZ` / `S.burnY` sliders so the shed point can be dialled by eye.
 *
 * @param {import("../vfx/smokeTrails.js").SmokeTrails} smoke
 * @param {{x:number,y:number,z:number}} pos hull position
 * @param {number} facing yaw, radians
 * @param {{x:number,z:number}} vel world velocity
 * @param {boolean} withFire stage two — flame with the smoke
 */
export function emitBurnTrail(smoke, pos, facing, vel, withFire) {
    const back = /** @type {number} */ (S.burnBackZ ?? 2.4);
    const lift = /** @type {number} */ (S.burnY ?? 0.95);
    const bx = pos.x - Math.sin(facing) * back;
    const by = pos.y + lift;
    const bz = pos.z - Math.cos(facing) * back;
    const shade = withFire ? 0.045 : 0.09;
    smoke.emit(
        bx, by, bz,
        vel.x * 0.22 + (Math.random() - 0.5) * 0.8,
        1.1 + Math.random() * 0.6,
        vel.z * 0.22 + (Math.random() - 0.5) * 0.8,
        0.5 + Math.random() * 0.25, 1.7,
        1.5 + Math.random() * 0.7,
        shade, shade, shade, 0.55, true
    );
    if (withFire) {
        smoke.emit(
            bx, by - 0.25, bz,
            vel.x * 0.72 + (Math.random() - 0.5) * 1.2,
            0.9 + Math.random() * 0.8,
            vel.z * 0.72 + (Math.random() - 0.5) * 1.2,
            0.62 + Math.random() * 0.25, 1.4,
            0.42 + Math.random() * 0.2,
            3.2, 1.05, 0.26, 0.8, false
        );
    }
}

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

        /** Extra herds the avoidance sweeps beyond `walkers` — see
         *  `Wingman.setAvoidHerds`. Empty unless somebody wires it. */
        this._avoidHerds = null;
        /** The avoidance's eased stick command (signed, -1..1), how much of
         *  the stick it currently owns (0..1), and the metres of pull-up it
         *  is adding to the phase's climb. See `_avoidance`. */
        this._avoidCmd = 0;
        this._avoidAuth = 0;
        this._avoidClimb = 0;
        this._avoidClimbHold = 0;
        /** Seconds of opening-pass throttle left. See `FLYOVER_SPEED`. */
        this._flyoverT = 0;

        /** Going in: the floor stops holding and the craft settles into the
         *  snow. Set by the damage ladder's third hit through `goDown`.
         *
         *  Two latches come back out of the fall, each true for exactly one
         *  frame and cleared by whoever consumes it (the `Wingman` wrapper):
         *  `bounced` at the first ground contact (4.0 s — the craft skips and
         *  keeps going) and `crashed` at the final one (5.5 s — the wreck
         *  pool takes the hull and this seat respawns from deep). */
        this.downed = false;
        this.crashed = false;
        this.bounced = false;
        /** 0 = the long fall, 1 = past the skip and on the way to the end. */
        this._downStage = 0;
        /** Seconds since the killing hit, and the climb it interrupted. */
        this._downT = 0;
        this._downClimb0 = 0;

        /** Collision aftermath: a yaw kick ringing down into the heading,
         *  and a beat of blunted steering while the pilot recovers the line.
         *  Fed by `applyImpact`; the downed ballistic ignores both. */
        this._impactSpin = 0;
        this._scramble = 0;

        this._pickRunPoint();
    }

    /** A fresh airframe for this seat, brought in from deep on a new bearing. */
    respawn() {
        this._flyoverT = 0;
        this.downed = false;
        this.crashed = false;
        this.bounced = false;
        this._downStage = 0;
        this._downT = 0;
        this._impactSpin = 0;
        this._scramble = 0;
        this._avoidCmd = 0;
        this._avoidAuth = 0;
        this._avoidClimb = 0;
        this._avoidClimbHold = 0;
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
        // The pass is flown FAST — much faster than the escorts' cruise, and
        // deliberately so. The opening used to work because the player sat
        // still for it: three ships at 32 m/s crossed a stationary cockpit at
        // 2.8, 3.9 and 5.0 s, and the hold was cut to fit. Then the player's
        // own run-in arrived and carried them forward at up to 34 — within
        // two metres a second of the escorts — and a formation that closes at
        // walking pace never arrives at all. Closing speed is what makes a
        // flyover a flyover, so this is set against the run-in rather than
        // against the cruise, and the original timings come back out.
        this.velocity.set(nx * FLYOVER_SPEED, 0, nz * FLYOVER_SPEED);
        this._flyoverT = FLYOVER_HOLD;
        // Stacked as well as spread. One ship rides high, one level, one low,
        // so the flight has depth from the cockpit instead of being three
        // shapes pasted at one altitude — and whichever way the player is
        // looking, somebody crosses it.
        this.climb = FLYOVER_CLIMB[this._seat] ?? 13;
        this._climbWant = this.climb;
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
        this._avoidCmd = 0;
        this._avoidAuth = 0;
        this._avoidClimb = 0;
        this._avoidClimbHold = 0;
    }

    /**
     * Going in. One door into the downed pipeline, so every entry path — the
     * damage ladder's third bolt and the collision pass's 'crash' verdict —
     * arms the crash choreography identically and nothing can be left over
     * from a previous fall.
     *
     * `_downClimb0` is the whole trick behind the 4.0 s mark: the descent is
     * a normalised profile from *this* climb to the deck, so wherever the
     * killing hit caught the craft (the run holds 9*scale, the break peaks at
     * 15*scale, the orbit sits at 12) it still touches the snow on the beat.
     *
     * @param {number} [spinDir] which way it rolls in; random if omitted
     */
    goDown(spinDir) {
        this.downed = true;
        this.crashed = false;
        this.bounced = false;
        this._downT = 0;
        this._downStage = 0;
        // Floored a clear metre above the contact climb: the stage-one
        // profile interpolates from here DOWN to DOWN_CONTACT, and a craft
        // somehow caught at or below the deck would otherwise be handed a
        // profile that rises into it.
        this._downClimb0 = Math.max(DOWN_CONTACT + 1, this.climb);
        this._rollRate = 0.6;
        this._spinDir = spinDir || (Math.random() < 0.5 ? -1 : 1);
        this._impactSpin = 0;
        this._scramble = 0;
        this._avoidCmd = 0;
        this._avoidAuth = 0;
        this._avoidClimb = 0;
        this._avoidClimbHold = 0;
    }

    /**
     * A collision's verdict, applied by the physics pass: the deflected
     * velocity replaces the pilot's, a signed yaw kick rings down into the
     * heading over the next second or so, and a scramble timer blunts the
     * steering while the pilot fights the craft back onto its line. The
     * downed ballistic ignores all of it — once the craft is going in,
     * momentum owns the trajectory, not the pass.
     * @param {number} vx new world velocity x, m/s
     * @param {number} vz new world velocity z, m/s
     * @param {number} spin signed yaw-rate kick, rad/s
     * @param {number} scrambleSec seconds of degraded steering authority
     */
    applyImpact(vx, vz, spin, scrambleSec) {
        this.velocity.x = vx;
        this.velocity.z = vz;
        this._impactSpin = Math.max(-3.5, Math.min(3.5,
            (this._impactSpin || 0) + spin
        ));
        this._scramble = Math.max(this._scramble || 0, scrambleSec || 0);
    }

    /**
     * One herd's worth of the look-ahead sweep. Folds the single most urgent
     * threat into the module-level `_av` scratch — the *worst*, not the sum,
     * because two machines on opposite sides of the nose summing to zero is
     * how a pilot flies into the one it decided to split the difference with.
     *
     * The test is a horizontal ring around each machine, sampled against the
     * craft's own velocity vector: `along` is how far down the flight path
     * the machine sits, `lat` how far off it. A machine behind the craft, or
     * beyond the look-ahead, or further off the line than the ring, or
     * already comfortably below the hull, is not a threat and costs one
     * branch. Everything else contributes
     *
     *     weight = (1 - along/reach) * (1 - |lat|/R)
     *
     * — urgency times how squarely the path is aimed at it. Both terms fall
     * linearly to zero at the edges, so this is a clearance controller, not a
     * wall: the craft settles into flying *past* at R metres rather than
     * bouncing off an invisible bubble.
     *
     * @param {import("../walkers/walker.js").WalkerHerd|null} herd
     * @param {any} target the machine this pass owns, exempted into its own
     *   much tighter guard so the strafing run survives
     * @param {number} px @param {number} pz @param {number} py hull position
     * @param {number} ux @param {number} uz unit flight path, XZ
     * @param {number} rx @param {number} rz its right-hand normal — positive
     *   steer turns toward this, so a machine at +lat is escaped by -1
     * @param {number} speedNow m/s
     */
    _sweepHerd(herd, target, px, pz, py, ux, uz, rx, rz, speedNow) {
        if (!herd || !herd.walkers) return;
        if (herd.tune && herd.tune.visible && !herd.tune.visible()) return;
        const hScale = herd.tune && herd.tune.scale ? herd.tune.scale() : 1;
        const top = (herd.height || 0) * hScale;
        const n = Math.min(herd.count, herd.walkers.length);
        const v = Math.max(12, speedNow);
        for (let i = 0; i < n; i++) {
            const w = herd.walkers[i];
            if (!w || !w.position || w.oneshot) continue;
            const isTgt = w === target;
            const R = (isTgt ? AVOID_R_TGT : AVOID_R) * hScale;
            const reach = (isTgt ? AVOID_AHEAD_TGT : AVOID_AHEAD) * v + R;
            const dx = w.position.x - px;
            const dz = w.position.z - pz;
            const along = dx * ux + dz * uz;
            // Only what is still AHEAD. A machine level with the cockpit or
            // behind it cannot be flown into — the craft is leaving it — and
            // scoring those was making the dodge strongest against the one
            // threat that had already been survived, then reversing the stick
            // at full authority the moment it dropped out of range.
            if (along < 0 || along > reach) continue;
            const lat = dx * rx + dz * rz;
            const off = Math.abs(lat);
            if (off > R) continue;
            // Over the crown with daylight to spare: nothing to dodge.
            if (py > w.position.y + top + AVOID_OVER) continue;
            const wgt = (1 - along / reach) * (1 - off / R);
            if (wgt > _av.w) {
                _av.w = wgt;
                _av.side = lat >= 0 ? -1 : 1;
                _av.top = w.position.y + top;
                _av.h = top;
                _av.tHit = Math.max(0, along) / v;
            }
        }
    }

    /**
     * Walker avoidance. The headline of the flying: the machines are solid,
     * and until now nothing in the steering knew it — SimPilot held its line
     * through the exact volume a 29 m AT-AT occupies while cruising at 9-15 m,
     * which is leg height, so contact was routine instead of accidental.
     *
     * Two things happen, and they are not symmetric. The turn is the fix: the
     * dodge takes over the stick in proportion to the threat, so for a beat
     * the pilot stops flying the target and flies the gap. The pull-up is the
     * *read* — and, per `AVOID_CLIMB_T`, it is only commanded when it can
     * honestly top the machine, because a half-climb off a 14 m run lifts the
     * craft out of the leg struts and into the solid belly.
     *
     * What it must not do is stop the pilot attacking, so the pass's own
     * target is swept with `AVOID_R_TGT`/`AVOID_AHEAD_TGT` instead — a guard
     * whose reach is under 65 m, half of BREAK_AT, so being inside it at all
     * means the break has already fired. The whole approach, the whole attack
     * and the entire fire window (FIRE_FAR 260 -> FIRE_NEAR 110) are
     * untouchable by construction; only the pull-off is ever bent, and that
     * is the collision the user is watching.
     *
     * Off entirely while `downed` — the ballistic owns the craft — which is
     * free here, since the downed block returns long before this is reached.
     *
     * @param {number} dt
     * @param {any} target the pass's locked machine, or null
     * @param {number} speedNow m/s
     */
    _avoidance(dt, target, speedNow) {
        _av.w = 0;
        _av.side = 0;
        _av.top = 0;
        _av.h = 0;
        _av.tHit = 0;
        if (S.wingAvoid !== false) {
            const sp = Math.hypot(this.velocity.x, this.velocity.z);
            // Look down the velocity, not the nose: in a hard bank the two
            // differ by the slip angle, and it is the velocity that arrives.
            let ux, uz;
            if (sp > 1) { ux = this.velocity.x / sp; uz = this.velocity.z / sp; }
            else { ux = Math.sin(this.facing); uz = Math.cos(this.facing); }
            const rx = uz, rz = -ux;
            const px = this.position.x, pz = this.position.z, py = this.position.y;
            this._sweepHerd(this.walkers, target, px, pz, py, ux, uz, rx, rz, speedNow);
            // The troopers are deliberately absent: they are man-sized, they
            // are what the low runs exist to strafe, and a scale-derived ring
            // around each of thirty of them would wall the squads off.
            if (this._avoidHerds) {
                for (let i = 0; i < this._avoidHerds.length; i++) {
                    const h = this._avoidHerds[i];
                    if (h && h !== this.walkers) {
                        this._sweepHerd(h, target, px, pz, py, ux, uz, rx, rz, speedNow);
                    }
                }
            }
        }

        // The stick command and how much of the stick it owns, both eased so
        // the hull banks into the dodge rather than snapping into it.
        const shaped = _av.w > 0 ? Math.sqrt(_av.w) : 0;
        this._avoidCmd = expDamp(
            this._avoidCmd, _av.side * shaped, AVOID_SLEW, dt
        );
        this._avoidAuth = expDamp(
            this._avoidAuth, Math.min(1, shaped * AVOID_AUTH), AVOID_SLEW, dt
        );
        if (this._avoidAuth < 1e-3) { this._avoidAuth = 0; this._avoidCmd = 0; }

        // The pull-up, all or nothing — and, once started, *committed*.
        //
        // `tHit` is how many seconds of flight still separate the craft from
        // the machine, so it counts down to zero as the machine arrives. A
        // bare `tHit > AVOID_CLIMB_T` test therefore opens the gate far out
        // and shuts it exactly 1.2 s before the encounter — commanding the
        // climb only while it is unnecessary and releasing it just in time to
        // sink back into the leg struts. So the decision to go over the top
        // is made once, at the range where it can still be flown honestly,
        // and then *held* until the machine is genuinely behind: a climb is a
        // manoeuvre a pilot commits to, not a proximity readout.
        let bias = 0;
        if (_av.w > 0) {
            const clear = _av.top + AVOID_CLEAR - this.groundY - 2.6;
            // Cap: no dodge ever needs more climb than the machine is tall
            // plus its clearance. Derived from the threat's own height rather
            // than a constant, so it stays honest at every walker scale, and
            // it only ever binds when the craft and the machine are standing
            // on wildly different ground.
            const want = Math.min(
                _av.h + AVOID_CLEAR, Math.max(0, clear - this._climbWant)
            );
            if (_av.tHit > AVOID_CLIMB_T) {
                // Far enough out to commit: take the climb, and book the hold
                // through the arrival plus a beat on the far side.
                this._avoidClimbHold = Math.max(
                    this._avoidClimbHold, _av.tHit + AVOID_CLIMB_HOLD
                );
                bias = want;
            } else if (this._avoidClimbHold > 0) {
                // Already committed and now close: hold the climb in. This is
                // the window the machine is actually crossed in.
                bias = want;
            }
        }
        this._avoidClimbHold = Math.max(0, this._avoidClimbHold - dt);
        this._avoidClimb = expDamp(this._avoidClimb, bias, AVOID_CLIMB_SLEW, dt);
        if (this._avoidClimb < 0.05) this._avoidClimb = 0;
        this._climbWant += this._avoidClimb;
    }

    /** @param {number} rawDt */
    update(rawDt) {
        const dt = Math.min(rawDt || 0, 1 / 30);
        if (dt <= 0) return;

        // Holding formation for the opening: attitude, altitude and the hover
        // all live, so the craft reads as a flying machine station-keeping
        // rather than a prop — it simply covers no ground.

        // Going down: the machine *rolls* — continuously, around its own long
        // axis, the way a crippled aircraft rolls over and over on the way
        // in — while its momentum carries it toward wherever it is going to
        // die (a clear spot near the walker line, chosen at the killing hit).
        // Owns the whole update.
        if (this.downed) {
            // Collision residue has no business here: whatever spin or
            // scramble the impact left behind, the ballistic keeps its own
            // slow roll and its own line, and the ground-contact check
            // below stays honest — a spun-up craft still lands on time.
            this._impactSpin = 0;
            this._scramble = 0;
            // The crash clock runs on RAW time, alone in this file. Everything
            // else here is clamped to 1/30 so a stalled frame cannot teleport
            // a craft — but this choreography is cut to a recording that is
            // already playing on the audio clock, and a sim second that is
            // shorter than a real one slides the bounce and the crash off
            // their beats. The frame's own motion still integrates on the
            // clamped step; only the beats are told the truth.
            this._downT = (this._downT ?? 0) + Math.min(rawDt || 0, 0.25);
            const dir = this._spinDir || 1;
            // The roll accelerates as control bleeds away: a slow wing-over
            // becoming a full rotation every couple of seconds. `lean` maps
            // to roll through the presentation's bank gain, so a steadily
            // growing lean *is* a continuous roll.
            this._rollRate = Math.min(2.4, (this._rollRate || 0.6) + dt * 0.45);
            this.lean += dir * (this._rollRate / 0.62) * dt;
            // The heading barely moves — it is rolling, not turning.
            this.facing = wrapAngle(this.facing + dir * 0.12 * dt);
            this.steerRate = 0;
            // No steering, no target, no correction of any kind: the machine
            // keeps exactly the trajectory it had when the hit landed, speed
            // bleeding gently to drag, and rides that line into the ground.
            const drag = Math.max(0, 1 - dt * 0.06);
            this.velocity.x *= drag;
            this.velocity.z *= drag;
            this.position.x += this.velocity.x * dt;
            this.position.z += this.velocity.z * dt;
            const sp = Math.hypot(this.velocity.x, this.velocity.z);
            this.speed01 = Math.min(1, sp / 19.5);
            this.speedRaw = sp / 19.5;
            this.driveHeld = false;
            this.boostHeld = false;
            this.fireHeld = false;
            this.groundY = this.terrain && this.terrain.heightAt
                ? this.terrain.heightAt(this.position.x, this.position.z) : 0;
            this.pathY = this.groundY;
            this.lift01 = 0;

            // ---- the scripted descent, on the sound's beats ----------------
            // Stage one: a normalised profile from the climb the hit
            // interrupted down to DOWN_CONTACT, reached at u = 1 — which is
            // DOWN_FALL_T seconds, by construction, from ANY starting height.
            // The shape is s = 0.6u^2 + 0.4u^3: s'(0) = 0, so the craft holds
            // its altitude for the first beat and only then drops its nose,
            // and s'(1) = 2.4, so it arrives steepening rather than settling.
            // A ship caught high at the top of a break falls faster than one
            // caught in the weeds, and both touch the snow at 4.0 s.
            //
            // Stage two: the skip. A half-sine arc, skewed early by the 0.7
            // exponent so it peaks about 0.55 s after the bounce and is back
            // on the deck at v = 1 — DOWN_SKIP_T later, i.e. 5.5 s.
            //
            // Both are left unclamped past their end so the first frame
            // beyond the mark dips under the contact threshold and fires.
            if (this._downStage === 0) {
                const u = Math.max(0, this._downT / DOWN_FALL_T);
                const s = u * u * (0.6 + 0.4 * u);
                this.climb = this._downClimb0
                    + (DOWN_CONTACT - this._downClimb0) * s;
            } else {
                const v = Math.max(0, (this._downT - DOWN_FALL_T) / DOWN_SKIP_T);
                this.climb = DOWN_CONTACT
                    + DOWN_HOP * Math.sin(Math.PI * Math.pow(v, 0.7));
            }
            this.position.y = Math.max(
                this.groundY + 2.6 + this.climb, this.groundY + 0.3
            );
            if (this.position.y - this.groundY < 1.1) {
                if (this._downStage === 0) {
                    // t = 4.0 s. The craft strikes the snow and *skips* — it
                    // is not over, it is the first of two. Momentum stays,
                    // minus a third of it into the drift; the roll picks up
                    // the energy of the hit; and `bounced` latches for the
                    // frame so the effects layer can throw up the snow and
                    // dig the first scar. `crashed` is NOT set: the wreck
                    // pipeline belongs to the second contact alone.
                    this._downStage = 1;
                    this.bounced = true;
                    this.velocity.x *= DOWN_SKIP_KEEP;
                    this.velocity.z *= DOWN_SKIP_KEEP;
                    this._rollRate = Math.min(2.4, (this._rollRate || 0.6) + 0.5);
                } else {
                    // t = 5.5 s. Ground contact for good. The wreck pool takes
                    // the hull from here — this pilot's seat refills from deep.
                    this.crashed = true;
                    this.downed = false;
                }
            }
            return;
        }

        this._phaseT += dt;
        if (this._flyoverT > 0) this._flyoverT = Math.max(0, this._flyoverT - dt);

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

        // ---- walker avoidance ----------------------------------------------
        // After the phase has said where it wants to go and what altitude it
        // wants to hold, and before any of it reaches the stick: the pilot
        // looks down its own flight path, and if a machine is standing in it,
        // turns off and climbs over. `_climbWant` is still just a target here
        // — the ease at the bottom of the update turns it into a pull-up.
        this._avoidance(dt, target, speedNow);

        // ---- collision aftermath -------------------------------------------
        // The impact's yaw kick rings down into the heading, and while the
        // scramble runs the pilot's corrections are blunt — the craft
        // staggers visibly off the hit before the line comes back.
        if (this._scramble > 0) {
            this._scramble = Math.max(0, this._scramble - dt);
            gain *= 0.4;
        }
        if (this._impactSpin) {
            this.facing = wrapAngle(this.facing + this._impactSpin * dt);
            this._impactSpin = expDamp(this._impactSpin, 0, 1.4, dt);
            if (Math.abs(this._impactSpin) < 1e-3) this._impactSpin = 0;
        }

        // ---- steering: turn-rate limited, slewed like the player's stick ---
        const wantHeading = Math.atan2(wantX - this.position.x, wantZ - this.position.z);
        const err = wrapAngle(wantHeading - this.facing);
        let steerRaw = Math.max(-1, Math.min(1, err * gain));
        // The dodge takes the stick, it does not argue with it. Biasing the
        // wanted heading instead was tried and fails for a reason worth
        // recording: on an attack run the carrot is pulling the nose toward a
        // target BEYOND the obstacle, so a bias and the attraction fight to a
        // draw and the craft creeps past at whatever clearance the stalemate
        // happens to give. Blending authority means the pilot lets go of the
        // target for a beat. Everything downstream is untouched — the slew,
        // the lateral-acceleration turn budget, the bank that falls out of
        // the resulting lateral acceleration — so a dodge still reads as a
        // flown turn and not as a nudge on the transform.
        if (this._avoidAuth > 0) {
            const dodge = Math.max(-1, Math.min(1, this._avoidCmd * AVOID_STICK));
            steerRaw += (dodge - steerRaw) * Math.min(1, this._avoidAuth);
        }
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
        // The opening pass overrides the phase's own target for as long as
        // it lasts: the reposition phase wants the cruise, and letting it
        // have its way the instant the flight is staged is exactly what
        // stopped the escorts ever overtaking the player's run-in.
        const want = this._flyoverT > 0
            ? Math.max(this._speedTarget, FLYOVER_SPEED)
            : this._speedTarget;
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
        // While the scramble runs, the residual impact spin leaks into the
        // bank target — the hull rocks off the hit, fading as control comes
        // back, instead of holding a serene coordinated turn through it.
        const rock = this._scramble > 0
            ? this._impactSpin * 0.45 * Math.min(1, this._scramble)
            : 0;
        this.lean = expDamp(
            this.lean, Math.max(-1, Math.min(1, latAcc / 26)) + rock, 6.5, dt
        );

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
         * `onBounce` is the first of the crash's two ground contacts — the
         * 4.0 s skip. It fires once, the craft is still airborne and still
         * rolling when it does, and no crash sound belongs on it: the single
         * `speeder-crash-2.mp3` fired at `onKillHit` already contains that
         * impact. Snow and a scar, nothing more.
         *
         * @type {{ smoke: import("../vfx/smokeTrails.js").SmokeTrails,
         *          enemy: (import("../walkers/bolts.js").Bolts|null)[],
         *          onKillHit?: (x:number,y:number,z:number) => void,
         *          onBounce?: (x:number,y:number,z:number,facing:number) => void,
         *          onCrash?: (x:number,y:number,z:number,facing:number) => void
         *        } | null}
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
        if (this.damage >= 3) {
            P.goDown();
            // The killing hit bursts on the airframe itself — the explosion
            // the craft then flies out of, rolling, on its unchanged line.
            fx.onKillHit?.(P.position.x, P.position.y, P.position.z);
        }
    }

    /**
     * The collision pass's verdict lands here, after the deflection has
     * already gone through `applyImpact`. A 'crash' is a kill only when
     * this seat holds the raid's fate token — one ship at a time, always.
     * Without the token (or for a plain 'hit') it is one ladder step,
     * respecting the same grace a bolt would, and the ladder is never
     * allowed to reach three this way: it clamps at burning instead, so
     * the token stays the only door into the downed pipeline. 'scrape'
     * is paint — the bounce was the whole event.
     * @param {'scrape'|'hit'|'crash'} severity
     * @param {number} x contact x
     * @param {number} y contact y
     * @param {number} z contact z
     */
    collisionHit(severity, x, y, z) {
        if (severity === "scrape") return;
        const P = this.pilot;
        if (P.downed) return;
        const myTurn = this.effects?.raid
            ? this.effects.raid.turn === (P._seat ?? 0)
            : true;
        if (severity === "crash" && myTurn && this.damage < 3) {
            // The walker won. Same downed pipeline as the third bolt — the
            // craft rolls out of the burst on its unchanged line, and the
            // impact's own spin picks which way it rolls in.
            this.damage = 3;
            P.goDown(P._impactSpin ? Math.sign(P._impactSpin) : 0);
            this.effects?.onKillHit?.(x, y, z);
            return;
        }
        if (this._hitGrace > 0) return;
        if (!myTurn && this.damage >= 2) {
            // The step that would put it in, without the token: hold the
            // ladder at fire and just buy the grace — the deflection and
            // the burning trail already tell the story.
            this._hitGrace = 4.5 + Math.random() * 3;
            return;
        }
        if (this.effects) this._takeHit();
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

        // One ship at a time: the raid shares a fate token, and only the
        // seat holding it can be hit at all. It passes on after the crash —
        // the field never has two escorts falling out of the sky at once.
        const myTurn = !fx.raid || fx.raid.turn === (this.pilot._seat ?? 0);
        const flying = !P.downed;
        if (this.damage < 3 && this._hitGrace <= 0 && flying && myTurn) {
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
                // Off the DRAWN hull, exactly as the player's own burn is —
                // never the pilot. `craft` is a full Speeder presentation, so
                // its position is the controller's plus hover, plus the speed
                // lift, plus the climb, all eased a beat behind; the pilot's
                // own position is a flight-model number that the eye never
                // sees. Trailing fire off the latter hangs it visibly off the
                // machine it is supposed to be burning.
                const hull = this.craft ? this.craft.position : P.position;
                const yaw = this.craft ? this.craft.yaw : P.facing;
                emitBurnTrail(
                    fx.smoke, hull, yaw, P.velocity, this.damage >= 2
                );
            }
        }

        // The skip, 4.0 s after the killing hit. SimPilot has no line to the
        // effects — the wrapper owns those — so it raises a one-frame latch
        // exactly the way it raises `crashed`, and the wrapper consumes it
        // here and forwards it on. The craft is still flying when this fires:
        // no wreck, no respawn, no ladder reset, and above all no sound.
        if (P.bounced) {
            P.bounced = false;
            fx.onBounce?.(P.position.x, P.position.y, P.position.z, P.facing);
        }

        // Ground contact: the burst, the crater, the sound. The wreck pool
        // takes over the hull on the ground (and the pilot thrown beside it);
        // this seat's craft respawns from deep, and the fate token passes to
        // the next ship in the raid.
        if (P.crashed) {
            P.crashed = false;
            fx.onCrash?.(P.position.x, P.position.y, P.position.z, P.facing);
            this.damage = 0;
            this._hitGrace = 6;
            this._fateT = 9 + Math.random() * 9;
            if (fx.raid) fx.raid.turn = (fx.raid.turn + 1) % (fx.raid.size || 3);
            P.respawn();
        }
    }

    /** Start this ship on the opening flyover — see SimPilot.flyover. */
    flyover(player, bx, bz) {
        this.pilot.flyover(player, bx, bz);
    }

    /**
     * Widen the avoidance sweep beyond the herd this pilot targets.
     *
     * OPTIONAL, and nothing depends on it: the pilot already dodges the AT-AT
     * herd it was handed for targeting, which is where the collisions the
     * user is complaining about come from. But the field carries a *second*
     * AT-AT line and a rank of AT-STs that the wingman constructor never sees,
     * and the craft will still fly through those. Anyone holding the full herd
     * list — the collision pass has exactly it — can close that gap with one
     * call. Herds already swept are skipped, so passing the whole list is
     * safe. Man-sized herds must NOT be passed: the ring is sized off the
     * herd's own scale but a squad of infantry has no business deflecting a
     * strafing run aimed at it.
     *
     * @param {import("../walkers/walker.js").WalkerHerd[]|null} herds
     */
    setAvoidHerds(herds) {
        this.pilot._avoidHerds = herds && herds.length ? herds : null;
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
