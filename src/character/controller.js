/**
 * Character locomotion + snow-surf physics.
 *
 * This owns motion only — the visual rig, cloth and fur read the state this
 * produces. Two modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: momentum-carrying. Thrust along facing, steering from mouse yaw,
 *    strong lateral grip that bleeds into a drift as you push the carve, and
 *    slope-driven acceleration so dropping down a dune face feels like a gain.
 *
 * Blending between them is eased in both directions; there is no snap.
 */

import * as THREE from "three";
import { input } from "../core/input.js";
import { S } from "../core/settings.js";
import { expDamp } from "../core/camera.js";

const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _tmp = new THREE.Vector3();
const _n = new THREE.Vector3();

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

const WALK_SPEED = 2.5;
const RUN_SPEED = 5.4;
const WALK_ACCEL = 26;
const WALK_DECEL = 30;

const SURF_MAX = 19.5;
/**
 * The E ladder's mid rung, as a fraction of `speederClimbMax` — rung 3 is the
 * full ceiling. Also where the lift saturates: at and above this height the
 * craft is clean of every ground effect.
 */
const CLIMB_MID = 0.45;
const SURF_THRUST = 11.0;
/**
 * Throttle scheme only: the open throttle cruises this much beyond the
 * board's terminal speed — the craft is a fighter, not a sled — with the E
 * reheat multiplying on top. The spool stays the same eased ramp.
 */
const FLY_CRUISE = 1.5;
/**
 * What shift is worth in the slide.
 *
 * On foot it picks run over walk; sliding, there was nothing for it to do —
 * which in the speeder means the one key everybody reaches for did nothing at
 * all. Half again on the top speed and the thrust together, so the craft both
 * accelerates harder and runs out further rather than just getting there sooner.
 */
const BOOST = 1.95;
const SURF_DRAG = 0.42;
const SURF_TURN = 2.35; // rad/s at full steer
const SURF_GRIP = 7.5;

/** Gait: metres of travel per full stride cycle, scaled by speed. */
const STRIDE_BASE = 1.55;

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:THREE.Vector3):THREE.Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new THREE.Vector3(0, 0, 0);
        this.velocity = new THREE.Vector3(0, 0, 0);
        this.prevVelocity = new THREE.Vector3(0, 0, 0);
        this.acceleration = new THREE.Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind
        this.speedRaw = 0;

        /** 0 = walking, 1 = fully surfing. Eased. */
        this.surf = 0;
        this.surfActive = false;

        /**
         * 0 = not casting, 1 = fully in the bending stance. Written by the spell
         * system, read by the figure.
         *
         * It lives here rather than on the spell system because the figure
         * already reads the controller for everything else it poses from, and a
         * second source of "what is this character doing" is how the arms and the
         * legs end up disagreeing about which frame it is.
         */
        this.cast = 0;
        this.castAimX = 0;
        this.castAimY = 0;
        this.castAimZ = 1;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        /**
         * 0..1, how hard the screen-space speed streaks should read. Deadbanded
         * well above walking pace: streaks at a jog make the demo feel cheap.
         */
        this.streak01 = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = true;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new THREE.Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new THREE.Vector3(0, 1, 0);

        this._prevSpeed = 0;

        // ---------------------------------------------------- eased key states
        // The keyboard is a bank of switches and the craft is not. These three
        // carry the switch positions through short exponential ramps so nothing
        // downstream — thrust, brake, top speed, turn rate, the camera pan that
        // follows the turn — ever steps in a single frame. The *equilibria* are
        // untouched: hold a key and within a tenth of a second or so every one
        // of these sits exactly where the raw key state used to put it.
        /** Slewed throttle, -1..1. W and S spool (~110 ms) rather than switch. */
        this._drive = 0;
        /**
         * Eased boost factor, 1..BOOST. Spools up in about a third of a second
         * (the reheat lighting) and bleeds down over about one (the reheat
         * dying) — which is what turns the old one-frame halving of velocity on
         * shift-release into a strong, readable deceleration.
         */
        this._boost = 1;
        /**
         * Metres of altitude held above the terrain-following path while E is
         * held (flying only). Eased both ways and asymptotic to
         * `S.speederClimbMax`, so "higher but not too high" is the shape of the
         * curve rather than a ceiling it bangs into.
         */
        // The game opens at the ladder's top rung (see `input.riseLevel`):
        // seeded here so the craft *starts* at altitude rather than spending
        // its first seconds climbing off the deck.
        this._climb = S.speeder !== false ? Math.max(0, S.speederClimbMax || 0) : 0;
        /** Throttle scheme: where the vertical keys have flown the craft to. */
        this._climbWant = 0;
        /** The vertical keys, slewed (~80 ms) so the climb engages as a ramp. */
        this._vertEase = 0;
        /** Vertical rate of the eased climb, m/s — the hull pitches on this. */
        this.climbRate = 0;
        this._wasThrottle = false;
        /** Slow-smoothed ground level the cruise path flattens toward. */
        this._cruiseGround = NaN;
        /** Flattened base path (terrain-hugging at 0 climb, level at cruise). */
        this.pathY = 0;
        /**
         * 0..1, how far up the climb the craft is — published so the ground
         * effects (the trench, the downwash) can pull away with altitude.
         */
        this.lift01 = 0;
        /**
         * Slewed steer, -1..1 — published because the presentation leans on its
         * derivative. An ~80 ms ramp: imperceptible as latency, but it converts
         * every step the keys (and the input disc-clamp) put on the steer into
         * a slope, which is the difference between a craft banking into a turn
         * and a craft being switched into one.
         */
        this.steer = 0;
        /** d(steer)/dt of the slewed steer, for the bank lead. */
        this.steerRate = 0;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        const h = Math.min(dt, 1 / 30);

        this.prevVelocity.copy(this.velocity);
        this.surfActive = input.surf;

        // Ease the surf blend — entering and exiting are transitions, not switches.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        if (this.surf > 0.5) this._surfStep(h, rig);
        else this._walkStep(h);

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

        // ---- climb (flying) -------------------------------------------------
        // Two schemes share this block and the eased `_climb` under them.
        //
        // Classic (default): hold nothing — E is a latch. The climb is an
        // exponential approach to `speederClimbMax`, so it can never overshoot
        // the configured ceiling and release settles it back the same way.
        //
        // Throttle (`S.flightThrottle`): free flight on the vertical. The held
        // key — slewed like the steer, so it engages as a ramp — walks a target
        // height between the deck and `speederCeiling` at `speederClimbSpeed`
        // m/s, and letting go *holds the altitude* rather than settling.
        const flyingNow = S.speeder !== false && this.surf > 0.5;
        const throttleMode = flyingNow && S.flightThrottle === true;
        if (throttleMode !== this._wasThrottle) {
            // Mid-flight scheme change: adopt the current height as the flown
            // target so nothing jumps, and clear the classic latch.
            this._wasThrottle = throttleMode;
            this._climbWant = this._climb;
            input.riseLevel = 1;
        }
        const climbRate = Math.max(0.1, S.speederClimbRate || 2.2);
        const prevClimb = this._climb;
        let liftDenom;
        if (throttleMode) {
            const ceiling = Math.max(0, S.speederCeiling || 0);
            this._vertEase = expDamp(this._vertEase, input.vert, 12, h);
            this._climbWant = clamp(
                this._climbWant + this._vertEase * (S.speederClimbSpeed || 9) * h,
                0, ceiling
            );
            this._climb = expDamp(
                this._climb, this._climbWant,
                this._climbWant > this._climb ? climbRate * 2 : climbRate, h
            );
            liftDenom = ceiling;
        } else {
            const climbMax = Math.max(0, S.speederClimbMax || 0);
            // Three rungs on the E ladder: the deck ride, a mid cruise, and
            // the top. Each is genuinely higher than the last; E steps up and
            // wraps (see input.riseLevel).
            const level = Math.max(1, Math.min(3, input.riseLevel | 0));
            const wantUp = flyingNow
                ? [0, 0, CLIMB_MID, 1][level] * climbMax : 0;
            this._climb = expDamp(
                this._climb, wantUp,
                wantUp > this._climb ? climbRate : climbRate * 0.6, h
            );
            this._climbWant = this._climb;
            this._vertEase = 0;
            // Lift saturates at the mid rung: the deck keeps its trench,
            // downwash and spray, and rungs 2 and 3 both fly fully clean of
            // the snow rather than trailing a faded version of it.
            liftDenom = climbMax * CLIMB_MID;
        }
        this.climbRate = h > 1e-6 ? (this._climb - prevClimb) / h : 0;
        this.lift01 = liftDenom > 1e-6 ? Math.min(1, this._climb / liftDenom) : 0;
        /** Published metres of climb — the speeder adds it to its hover height. */
        this.climb = this._climb;

        // Cruise flattening: up at altitude the craft stops tracing every dune
        // and rides a level path that only drifts with the large-scale terrain
        // (a ~2 s smoothing of the ground). Blended in by how far up the climb
        // it is, with a floor so a hill taller than the cruise path still
        // pushes the craft over it rather than through it. On the deck (and on
        // the board) lift01 is 0 and this is exactly the old ground snap.
        if (!Number.isFinite(this._cruiseGround)) this._cruiseGround = this.groundY;
        this._cruiseGround = expDamp(this._cruiseGround, this.groundY, 0.5, h);
        /** The flattened base path the hull rides — published for the speeder. */
        this.pathY = this.groundY
            + (this._cruiseGround - this.groundY) * this.lift01;
        const targetY = Math.max(
            this.pathY + this._climb, this.groundY + 0.8 * this.lift01
        );
        // Snap with a little softness so micro-ripples don't jitter the rig.
        this.position.y = expDamp(this.position.y, targetY, 26, h);

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        // Normalised against the *unboosted* top, so the FOV, the wind and the
        // jet all keep opening up past 1 while the boost is held rather than
        // pinning the instant it engages.
        this.speed01 = clamp(this.speed / SURF_MAX, 0, 1);
        /** Unclamped, for anything that wants to know about the boost. */
        this.speedRaw = this.speed / SURF_MAX;

        // Same guard as steerRate: freeze-time runs the whole loop at dt = 0,
        // and 0/0 here is a NaN that rides lean → carve → rig roll and never
        // comes back.
        if (h > 1e-6) {
            this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
            this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;
        } else {
            this.acceleration.x = 0;
            this.acceleration.z = 0;
        }

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        this.streak01 = this.surf * clamp((this.speed - 7) / 11, 0, 1);

        this._gait(h);
    }

    _walkStep(h) {
        const maxSpeed = input.sprint ? RUN_SPEED : WALK_SPEED;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const a = WALK_ACCEL * h;
            this.velocity.x += clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += clamp(_wish.z - this.velocity.z, -a, a);

            // Face the direction of travel, eased.
            const want = Math.atan2(_wish.x, _wish.z);
            this.facing = angleDamp(this.facing, want, 11, h);
        } else {
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    _surfStep(h, rig) {
        // Steer from the mouse (camera yaw drift) plus explicit A/D.
        //
        // On a board those two terms are a servo: A/D pushes the facing and the
        // camera-relative term pulls it back toward where you are looking, which
        // is what makes a carve feel like leaning rather than like driving. It
        // also *caps* the turn — at equilibrium the two cancel, which on this
        // board is about forty degrees off the camera and is the whole point.
        //
        // In the speeder that cap is a bug. A craft you cannot turn around is not
        // flying, it is on rails, so A/D steers outright and the camera is
        // dragged along with it below.
        const flying = S.speeder !== false;
        const steerRaw = flying
            ? clamp(input.moveX, -1, 1)
            : clamp(
                input.moveX * 0.85 + angleDelta(this.facing, rig.yaw) * 1.25, -1, 1
            );
        // Slew, don't sample: the keys step the steer 0 → 1 in one frame, and
        // used raw that steps the yaw *rate* of the entire view. The ramp is
        // ~80 ms — under any human's perception of latency, and it also eats
        // the 1.0 → 0.707 step the input disc-clamp puts on moveX every time
        // the throttle key changes while turning.
        const prevSteer = this.steer;
        this.steer = expDamp(this.steer, steerRaw, 12, h);
        this.steerRate = h > 1e-6 ? (this.steer - prevSteer) / h : 0;
        const steer = this.steer;
        const turn = steer * SURF_TURN * h;
        this.facing += turn;
        // The chase camera still follows the craft round — but the rig now
        // chases `facing` itself through a damped follow (see CameraRig.update)
        // instead of having `turn` added straight into `rig.yaw` here, so the
        // view's pan rate eases with the steer rather than stepping with it.

        // Camera shake, and only from the one thing that earns it: an edge
        // loaded up at speed. Added as a rate rather than as an impulse, so it
        // reaches an equilibrium against the rig's own decay — hard carve at top
        // speed settles around 0.4 trauma, which is a couple of centimetres of
        // rig movement. Anything you can consciously see here is too much.
        const load = Math.abs(steer) * (this.speed / SURF_MAX);
        if (load > 0.25) rig.addTrauma((load - 0.25) * 1.35 * h);

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Slope: heading downhill adds speed, uphill scrubs it.
        this.terrain.normalAt(this.position.x, this.position.z, _n);
        const slopeAssist = -(_n.x * fx + _n.z * fz) * 26;

        // Eased, not switched: shift moves the *target* of the boost factor and
        // the factor chases it — quick on (the reheat lights), slow off (it
        // dies). The hard speed cap below still exists, but its ceiling now
        // glides down over about a second instead of halving the velocity in
        // one frame on shift-release.
        const throttleMode = flying && S.flightThrottle === true;
        const boostHeld = throttleMode ? input.boost : input.sprint;
        this._boost = expDamp(this._boost, boostHeld ? BOOST : 1, boostHeld ? 3.0 : 1.4, h);
        const boost = this._boost * (throttleMode ? FLY_CRUISE : 1);
        let thrust = SURF_THRUST * boost + slopeAssist;

        // The throttle spools the same way (~110 ms), so the key engages thrust
        // as a ramp the jet's own eased flame actually matches, instead of the
        // hull lurching a frame before the flame answers. Under the throttle
        // scheme that key is shift — W/S belong to the vertical — and there is
        // no reverse gear: a craft that can dive out of a run doesn't back up.
        this._drive = expDamp(
            this._drive,
            throttleMode ? (input.thrust ? 1 : 0) : input.moveZ,
            9, h
        );

        // Published for the presentation, which prefers these over its raw
        // keyboard fallbacks (the wingman's pilot publishes the same pair) —
        // so the jet plume answers the throttle, whichever key that is.
        this.driveHeld = throttleMode ? input.thrust : input.moving;
        this.boostHeld = boostHeld;

        // A board under a rider is always being pushed — that is what a slide is,
        // and letting go means stopping pushing. A craft holding station is not
        // being pushed at all, so flying, the thrust is gated on the throttle
        // actually being open: W drives, S is reverse thrust — it sheds speed
        // hard and, held, backs the craft up — and nothing at all leaves it
        // hovering where you left it instead of wandering off across the field.
        if (flying) {
            const fwd = this._drive;
            // One continuous curve through zero: forward thrust scaled by the
            // spooled throttle, astern geared to 0.9 of it. Both directions ride
            // the eased `_drive`, so brake engagement ramps instead of stepping,
            // and the top-speed clamp below caps reverse exactly as it caps
            // forward.
            thrust *= fwd > 0 ? fwd : 0;
            if (fwd < 0) thrust = SURF_THRUST * 0.9 * fwd;
        } else if (input.moveZ < 0) {
            // Board only.
            thrust -= 14; // pull back to scrub speed
        }

        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip: kill sideways velocity, but not entirely — the residual
        // is what reads as a drift when you overcook the turn.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        // Exact exponential rather than the Euler fraction `SURF_GRIP * h`: the
        // fraction removed more sideways velocity per frame at low frame rates
        // than at high ones, so the drift character stiffened whenever the frame
        // rate dipped. Same constant; at 60 fps the two differ by under 1%.
        const grip = 1 - Math.exp(-SURF_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // Quadratic drag → a natural terminal speed.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            const drag = SURF_DRAG * s * s * 0.02 + 0.9;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        const top = SURF_MAX * boost;
        if (s > top) {
            const k = top / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing — and for the run-out afterwards.
        //
        // The surf blend eases to zero in a fifth of a second, but the momentum
        // takes two thirds of one to bleed off, and in between the character is
        // travelling at nineteen metres a second. The gait is distance-driven, so
        // it answered that with a twelve-hertz cadence and the legs blurred. A
        // sprint is the fastest thing anyone walks at; above it, glide.
        this.stepping = this.surf <= 0.5 && this.speed <= RUN_SPEED * 1.2;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_BASE * (0.72 + 0.28 * Math.min(1, this.speed / RUN_SPEED));
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
