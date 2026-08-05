/**
 * Spell 2 — Ribbon.
 *
 * A held, continuous stream of water tracking the hand and the camera aim,
 * describing arcs and figure-eights in the air, and scoring thin curved lines in
 * the snow it passes over.
 *
 * The whole character of this spell is in one decision: the ribbon is a *record
 * of where its tip has been*, not a shape recomputed each frame from the current
 * aim. That is what gives it momentum. Swing the camera and the water does not
 * swing with it — the tip goes, and the body follows a fraction of a second
 * later, trailing through the arc the tip drew. It is also why letting go does
 * not despawn anything: the tip stops being driven, the tail keeps retiring, and
 * the ribbon eats itself from behind over about three quarters of a second.
 *
 * The figure-eight is not decoration either. Bent water reads as bent when it
 * doubles back on itself, and a tip driven only by the aim draws a straight
 * line. A slow Lissajous in the camera's own right/up plane means the pattern
 * is always broadside to the viewer however the player is standing.
 */

import { PROFILE_TUBE, STRAND_COLS } from "./waterBody.js";
import { clamp01, clampRange, smooth01, expDamp, transport } from "./bending.js";

/** Live spine samples. Capped by the strand table's width. */
const SAMPLES = 46;
/** Metres of tip travel between committed samples. */
const STEP = 0.20;
/** Seconds a sample survives once the body has been thrown. */
const TAIL_LIFE = 1.25;
/**
 * Speed the thrown head builds to, m/s.
 *
 * Tuned down from 30 for a reason that is entirely about the camera and not
 * about the physics: the throw goes *away from the viewer*, so a body flying
 * flat out foreshortens to a dot within half a second — a nine metre ribbon
 * seen end-on is nine metres of nothing. Twenty-one metres a second is still
 * plainly fast and stays broadside long enough to be watched.
 */
const THROW_SPEED = 21;
/**
 * How fast the head turns onto the aim after release, 1/s.
 *
 * Deliberately unhurried. Snapping the velocity onto the aim makes the body a
 * straight line immediately, and a straight line pointing at the horizon is the
 * least legible thing this spell could do. At 5.5 the head takes about a fifth
 * of a second to come round, so it leaves on a curve and the tail carries the
 * swing it was in on its way out.
 */
const THROW_STEER = 5.5;
/** Tube radius at the fat part of the body, metres. */
const RADIUS = 0.205;

/**
 * How much wider the section is than it is thick.
 *
 * A body of bent water is not a hose. It is a *ribbon* — flattened, twisting as
 * it goes, catching the light on the broad face and vanishing to an edge when
 * it turns side-on. A circular section cannot do any of that: it presents the
 * same silhouette from every direction, which is what makes it read as a
 * cylinder.
 *
 * The ellipse rolls with the section twist, so the broad face turns over as it
 * travels down the body. That twist is what a stream of water under lateral
 * acceleration actually does, and it is most of the difference between "a tube"
 * and "water being bent".
 */
const SECTION_ASPECT = 1.55;

// ------------------------------------------------------- module-scope scratch
const _tan = new Float32Array(3);
const _rgt = new Float32Array(3);

export class Ribbon {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.held = false;
        this.strand = -1;

        // Ring buffer of tip positions, newest at `_head`.
        this._x = new Float32Array(SAMPLES);
        this._y = new Float32Array(SAMPLES);
        this._z = new Float32Array(SAMPLES);
        /**
         * How fast the tip was moving when each sample was laid.
         *
         * This is what gives the body its thickness variation, and it is the one
         * source of it that is neither periodic nor random. A stream of water
         * conserves mass: where it was moving fast it is stretched thin, and
         * where it slowed at the end of a swing it bunches up. Recording the
         * speed at commit time and reading it back as a radius means the ribbon
         * is thick and thin in the places the *motion* put it, so no two passes
         * through the same figure-eight look the same and none of it repeats.
         */
        this._spd = new Float32Array(SAMPLES);
        this._head = 0;
        this._count = 0;

        /** Transported reference frame, three floats per sample. */
        this._right = new Float32Array(SAMPLES * 3);

        /** The live tip, and the velocity that gives it its lag. */
        this.tipX = 0; this.tipY = 0; this.tipZ = 0;
        this._vx = 0; this._vy = 0; this._vz = 0;
        this._phase = 0;
        /** Eased 0..1: how much ribbon there is. Never a switch. */
        this.blend = 0;
        this._sprayOwed = 0;
        this._scoreOwed = 0;
        this._seeded = false;

        /** True from the frame the key comes up until the body has drained. */
        this.thrown = false;
        /** True once a thrown body has hit the ground. */
        this._splashed = false;
        /**
         * Monotonic count of impacts. Published for the same reason the spell
         * system publishes `castCount`: the soundscape needs the *moment* the
         * water lands, and polling a number is cheaper to reason about than the
         * spell handing out callbacks. `_splashed` is a state, not an edge — it
         * stays true for the third of a second the body takes to drain — so it
         * cannot be used for this.
         */
        this.splashCount = 0;
        this._throwT = 0;
        this._tx = 0; this._ty = 0; this._tz = 1;
    }

    /** Called on the frame the key goes down. */
    trigger() {
        if (this.strand < 0) this.strand = this.ctx.water.acquire();
        this.held = true;
        this.active = true;
        if (!this._seeded) this._seed();
    }

    /**
     * Called on the frame the key comes up: the body is *thrown*, not dropped.
     *
     * The throw is not a translation of the mesh. The head keeps being a moving
     * point with a velocity, and the spine keeps recording where it has been —
     * the same machinery that draws the ribbon while it is held. All that changes
     * is what drives the head: instead of a spring chasing a figure-eight, it
     * steers onto the aim direction and accelerates.
     *
     * That is the difference between throwing the ribbon and the ribbon being
     * thrown. Translating the body rigidly moves a shape; steering the head and
     * letting the body follow means the water *arcs onto* the target — it leaves
     * the swing it was in, turns over about a fifth of a second, straightens, and
     * goes. The bend it had when you let go is still in the tail on its way out,
     * because the tail is literally the path the head took.
     */
    release() {
        if (!this.held) return;
        this.held = false;
        this.thrown = true;
        this._splashed = false;
        this._throwT = 0;

        const f = this.ctx.rig.forward;
        // Slightly above the aim: a thrown body has to arc, and starting it dead
        // flat means it only ever falls.
        this._tx = f.x;
        this._ty = f.y + 0.18;
        this._tz = f.z;
        const l = Math.hypot(this._tx, this._ty, this._tz) || 1;
        this._tx /= l; this._ty /= l; this._tz /= l;

        this._burst();
    }

    /** A shear of droplets off the whole body at the moment of release. */
    _burst() {
        const ctx = this.ctx;
        const sp = ctx.spray;
        const n = this._count;
        if (!sp || n < 3) return;
        const total = (70 * ctx.sprayScale) | 0;
        for (let k = 0; k < total; k++) {
            const j = 1 + ((Math.random() * (n - 2)) | 0);
            const i = (this._head - j + SAMPLES * 2) % SAMPLES;
            sp.emit(
                this._x[i] + (Math.random() - 0.5) * 0.3,
                this._y[i] + (Math.random() - 0.5) * 0.3,
                this._z[i] + (Math.random() - 0.5) * 0.3,
                this._tx * (4 + Math.random() * 9) + (Math.random() - 0.5) * 2.4,
                this._ty * (4 + Math.random() * 9) + 0.8 + Math.random() * 2.0,
                this._tz * (4 + Math.random() * 9) + (Math.random() - 0.5) * 2.4,
                0.020 + Math.random() * 0.040,
                0.6 + Math.random() * 0.9,
                1,
                0.7
            );
        }
    }

    _seed() {
        const ctx = this.ctx;
        ctx.handPosition(1, _tan, 0);
        this.tipX = _tan[0];
        this.tipY = _tan[1];
        this.tipZ = _tan[2];
        this._vx = 0; this._vy = 0; this._vz = 0;
        this._head = 0;
        this._count = 0;
        this._phase = 0;
        this._seeded = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const s = this.strand;
        if (s < 0) {
            this.active = false;
            return;
        }

        // A thrown body does not thin out while it is still flying — it is all
        // still there, travelling. It only gives out once it has spent itself.
        const want = this.held
            ? 1
            : this.thrown
                ? clamp01(1 - (this._throwT - 1.5) / 1.0)
                : 0;
        this.blend = expDamp(this.blend, want, this.held ? 5.5 : 3.4, dt);

        if (this.held) this._driveTip(dt);
        else this._retire(dt);

        if (!this.held && (this._count < 3 || this.blend < 0.02)) {
            this._end();
            return;
        }

        this._writeStrand();
        this._score(dt);
        this._shed(dt);
    }

    /**
     * Move the tip.
     *
     * A critically-damped spring toward a target that is itself moving on a slow
     * figure-eight. The spring is what makes the water heavy: at these rates the
     * tip overshoots a fast camera swing and comes back, which is exactly the
     * behaviour a mass on the end of an arc has and exactly what a direct
     * assignment would throw away.
     */
    _driveTip(dt) {
        const ctx = this.ctx;
        const rig = ctx.rig;
        const h = Math.min(dt, 1 / 60);

        ctx.handPosition(1, _tan, 0);
        const hx = _tan[0], hy = _tan[1], hz = _tan[2];

        this._phase += dt * 2.55;
        // Lissajous with a 2:1 ratio — the classic figure-eight — in the plane
        // the camera is looking through, so it always reads as a figure-eight
        // rather than as a shape seen edge-on.
        //
        // The pattern sits high enough that the bottom lobe only *occasionally*
        // reaches the snow rather than dragging through it every cycle. Scoring
        // on every pass turns a trace into a ploughed furrow, and a ribbon
        // permanently in contact with the surface stops reading as something
        // held in the air.
        //
        // Two extra harmonics, both incommensurate with the fundamental and with
        // each other. A pure 2:1 Lissajous closes on itself every cycle, so the
        // tip retraces the identical path forever and the ribbon lies on top of
        // its own previous pass, which reads as a flat repeating sign. The
        // harmonics make the pattern precess: recognisably a figure-eight, never
        // twice the same one.
        const a = Math.sin(this._phase) * 1.70
                + Math.sin(this._phase * 0.41 + 1.7) * 0.44;
        const b = Math.sin(this._phase * 2 + 0.4) * 0.92
                + Math.sin(this._phase * 0.73 + 0.2) * 0.26;

        const f = rig.forward;
        const r = rig.right;
        const u = rig.up;

        // Reach out along the aim, then swing.
        const reach = 2.5;
        const tx = hx + f.x * reach + r.x * a + u.x * b;
        const ty = hy + f.y * reach + r.y * a + u.y * b + 0.34;
        const tz = hz + f.z * reach + r.z * a + u.z * b;

        // Stiff and close to critical. Slacker than this and the tip lags its
        // target far enough to spend each cycle catching up in a straight line
        // and then turning hard at the ends, which squares off the loops.
        // Momentum should round the path, not corner it: track the smooth
        // Lissajous closely and let the spine's own length carry the lag.
        const k = 210;         // spring
        const c = 2 * Math.sqrt(k) * 0.92;
        this._vx += (k * (tx - this.tipX) - c * this._vx) * h;
        this._vy += (k * (ty - this.tipY) - c * this._vy) * h;
        this._vz += (k * (tz - this.tipZ) - c * this._vz) * h;
        this.tipX += this._vx * h;
        this.tipY += this._vy * h;
        this.tipZ += this._vz * h;

        // Never let the tip bore into the ground; it skims it instead, which is
        // where the scoring comes from.
        const g = ctx.terrain.heightAt(this.tipX, this.tipZ) + 0.10;
        if (this.tipY < g) {
            this.tipY = g;
            if (this._vy < 0) this._vy *= -0.25;
        }

        this._commit();
    }

    /** Append the tip to the spine once it has moved a full step. */
    _commit() {
        if (this._count === 0) {
            this._push(this.tipX, this.tipY, this.tipZ);
            return;
        }
        const i = this._head;
        const dx = this.tipX - this._x[i];
        const dy = this.tipY - this._y[i];
        const dz = this.tipZ - this._z[i];
        if (dx * dx + dy * dy + dz * dz >= STEP * STEP) {
            this._push(this.tipX, this.tipY, this.tipZ);
        }
    }

    _push(x, y, z) {
        this._head = (this._head + 1) % SAMPLES;
        if (this._count < SAMPLES) this._count++;
        this._x[this._head] = x;
        this._y[this._head] = y;
        this._z[this._head] = z;
        this._spd[this._head] = Math.hypot(this._vx, this._vy, this._vz);
    }

    /**
     * After release: fly the head, and drain the tail behind it.
     *
     * The head is integrated exactly as it was while held — it is the same
     * point with the same velocity, so the moment of release is continuous in
     * both position *and* velocity and there is nothing to ease. What changes is
     * the force on it.
     */
    _retire(dt) {
        if (this.thrown && this._count > 0) {
            this._throwT += dt;
            const h = Math.min(dt, 1 / 60);

            // ---- steer onto the aim ---------------------------------------
            // The velocity direction turns toward the aim rather than being
            // replaced by it, so the head *curves* out of whatever part of the
            // figure-eight it was in. Frame-rate-independent, and fast enough to
            // be committed inside a fifth of a second.
            const k = 1 - Math.exp(-THROW_STEER * h);
            const sp = Math.hypot(this._vx, this._vy, this._vz);
            this._vx += (this._tx * sp - this._vx) * k;
            this._vy += (this._ty * sp - this._vy) * k;
            this._vz += (this._tz * sp - this._vz) * k;

            // ---- accelerate ------------------------------------------------
            // Thrust along the aim for the first third of a second, then
            // quadratic drag takes over and it coasts. Accelerating rather than
            // starting at speed is what makes it read as being *sent* — the eye
            // catches the head building pace and follows it out.
            const thrust = 62 * Math.exp(-this._throwT * 3.0);
            this._vx += this._tx * thrust * h;
            this._vy += this._ty * thrust * h;
            this._vz += this._tz * thrust * h;
            this._vy -= 9.81 * h;

            const s2 = Math.hypot(this._vx, this._vy, this._vz);
            if (s2 > 0.001) {
                const drag = Math.min(1, (0.55 + s2 * s2 * 0.0016) * h);
                this._vx -= this._vx * drag;
                this._vy -= this._vy * drag;
                this._vz -= this._vz * drag;
            }
            if (s2 > THROW_SPEED) {
                const c = THROW_SPEED / s2;
                this._vx *= c; this._vy *= c; this._vz *= c;
            }

            this.tipX += this._vx * h;
            this.tipY += this._vy * h;
            this.tipZ += this._vz * h;

            // ---- impact ----------------------------------------------------
            // A thrown body of water that meets the ground does not keep going.
            // The first version clamped the head to the surface and let it carry
            // on, which made a released ribbon slither across the snow like a
            // snake — the one reading it must not have. It bursts instead: the
            // head stops dead where it hit, and the rest of the body pours into
            // that point over the next third of a second while the spray does
            // the work.
            const g = this.ctx.terrain.heightAt(this.tipX, this.tipZ) + 0.05;
            if (!this._splashed && this.tipY < g) {
                this.tipY = g;
                this._splash();
            }

            if (this._splashed) {
                // The head is pinned. Nothing else needs to happen — the tail
                // retire below runs at the splash rate and drains the body into
                // the impact, which is what a stream hitting a surface does.
                this._vx = 0; this._vy = 0; this._vz = 0;
            } else {
                // Same commit path as the held ribbon: the body is the record of
                // where the head has been, before and after release alike.
                this._commit();
            }
        }

        // The tail drains from behind. While the head is still flying and
        // committing samples this only holds the body to a fixed length; once
        // the head slows, the drain outruns it and eats the ribbon.
        //
        // The rate climbs with time so the spell always terminates: a head that
        // coasted for ever would keep feeding the spine for ever.
        this._retireOwed = (this._retireOwed || 0) + dt;
        const rate = this._splashed ? 7.0 : 1 + this._throwT * 0.9;
        const per = TAIL_LIFE / SAMPLES / rate;
        while (this._retireOwed >= per && this._count > 0) {
            this._retireOwed -= per;
            this._count--;
        }
    }

    /**
     * The body meets the ground.
     *
     * Three things at once, and they are all the same event: a fan of droplets
     * thrown outward and up from the point of contact, a mark in the snow, and
     * a hard acceleration of the tail drain so the remaining body visibly pours
     * into the impact rather than hanging in the air above it.
     *
     * The droplet fan is deliberately *wide and low*. A vertical burst reads as
     * an explosion; water hitting a surface at a shallow angle mostly goes
     * sideways, and the ring of it skating outward across the snow is the thing
     * that says "liquid" rather than "impact effect".
     */
    _splash() {
        const ctx = this.ctx;
        this._splashed = true;
        this.splashCount++;

        const x = this.tipX;
        const y = this.tipY;
        const z = this.tipZ;

        // Carry the incoming direction into the fan, so a shallow throw sprays
        // forward and a steep one sprays evenly. `_vx/_vz` are still the impact
        // velocity at this point — `_retire` zeroes them after this returns.
        const sp = Math.hypot(this._vx, this._vy, this._vz) || 1;
        const ix = this._vx / sp;
        const iz = this._vz / sp;
        const steep = Math.min(1, Math.abs(this._vy) / sp);

        const spray = ctx.spray;
        if (spray) {
            const total = ((280 + 190 * (1 - steep)) * ctx.sprayScale) | 0;
            for (let k = 0; k < total; k++) {
                const a = Math.random() * Math.PI * 2;
                const ca = Math.cos(a);
                const sa = Math.sin(a);
                // Biased downrange: the water keeps most of its momentum.
                const out = (1.8 + Math.random() * 5.5) * (0.45 + 0.85 * (1 - steep));
                const vx = ca * out + ix * sp * 0.32;
                const vz = sa * out + iz * sp * 0.32;
                // Low. The tall part of a splash is the minority of it.
                const vy = (1.2 + Math.random() * 4.6) * (0.4 + 0.8 * steep);
                const drop = Math.random() < 0.55 ? 1 : 0;
                spray.emit(
                    x + ca * 0.12, y + 0.04 + Math.random() * 0.12, z + sa * 0.12,
                    vx, vy, vz,
                    drop ? 0.020 + Math.random() * 0.034 : 0.055 + Math.random() * 0.095,
                    0.6 + Math.random() * 1.1,
                    drop,
                    drop ? 0.6 : 2.2
                );
            }
        }

        // The mark. Shallower than a Bloom crater and much wetter: this is water
        // landing, so it packs and glazes far more than it displaces.
        ctx.deform.brush(
            x, z, 0.62,
            0.16, 0.13, 1.0, 0.85,
            Math.atan2(iz, ix), 1.35, 1.0
        );
        for (let i = 0; i < 3; i++) {
            const a = Math.random() * Math.PI * 2;
            const d = 0.55 + Math.random() * 0.65;
            ctx.deform.brush(
                x + Math.cos(a) * d, z + Math.sin(a) * d,
                0.30 + Math.random() * 0.22,
                0.05, 0.07, 0.6, 0.5, a, 1.3, 1.0
            );
        }

        ctx.rig.addTrauma(0.09);
    }

    /**
     * Resolve the spine into the strand table.
     *
     * Column 0 is the **live tip**, not the newest committed sample, and that
     * distinction was worth a rewrite. Samples are committed every 20 cm of head
     * travel, so a spine drawn only from committed samples has a head that
     * advances in 20 cm jumps — three or four frames of the tip standing still
     * followed by one frame of it teleporting forward. At a walking swing that is
     * a visible stutter at the leading edge, which is the part of the ribbon the
     * eye is locked onto. Writing the live tip as column 0 and the committed
     * samples behind it gives a head that moves every frame and a body that is
     * still a record of where it has been.
     *
     * `u` therefore means "distance behind the tip", which is what the radius
     * profile, the foam and the relief field all key off.
     */
    _writeStrand() {
        const ctx = this.ctx;
        const water = ctx.water;
        const s = this.strand;
        const n = Math.min(this._count + 1, STRAND_COLS);
        if (n < 3) {
            water.setParams(s, PROFILE_TUBE, 0.12, 0, 0);
            return;
        }

        // Seed the frame at the tip with something perpendicular to the first
        // tangent, then transport it down the spine.
        let px = this.tipX;
        let py = this.tipY;
        let pz = this.tipZ;
        let t0x = px - this._x[this._head];
        let t0y = py - this._y[this._head];
        let t0z = pz - this._z[this._head];
        let tl = Math.hypot(t0x, t0y, t0z);
        if (tl < 1e-5) {
            const i1 = (this._head - 1 + SAMPLES) % SAMPLES;
            t0x = px - this._x[i1]; t0y = py - this._y[i1]; t0z = pz - this._z[i1];
            tl = Math.hypot(t0x, t0y, t0z) || 1;
        }
        t0x /= tl; t0y /= tl; t0z /= tl;

        // Any perpendicular will do for the seed; the transport takes it from
        // there and the section is round anyway.
        let rx = -t0z, ry = 0, rz = t0x;
        let rl = Math.hypot(rx, ry, rz);
        if (rl < 1e-4) { rx = 1; ry = 0; rz = 0; rl = 1; }
        rx /= rl; ry /= rl; rz /= rl;

        let dist = 0;
        const twist = ctx.time * 2.4;

        for (let j = 0; j < n; j++) {
            // j = 0 is the live tip; j >= 1 walks the committed ring backwards.
            const i = (this._head - (j - 1) + SAMPLES * 2) % SAMPLES;
            const x = j === 0 ? this.tipX : this._x[i];
            const y = j === 0 ? this.tipY : this._y[i];
            const z = j === 0 ? this.tipZ : this._z[i];

            if (j > 0) {
                const ddx = px - x, ddy = py - y, ddz = pz - z;
                const dl = Math.hypot(ddx, ddy, ddz);
                // The tip can sit arbitrarily close to the sample behind it —
                // right after a commit it sits exactly on it — so a degenerate
                // segment here is normal and must not produce a NaN tangent.
                if (dl > 1e-5) {
                    dist += dl;
                    const t1x = -ddx / dl, t1y = -ddy / dl, t1z = -ddz / dl;
                    transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                    rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                    t0x = t1x; t0y = t1y; t0z = t1z;
                }
            }

            const u = j / (n - 1);
            // A pointed head, a shoulder just behind it, and a continuous taper
            // all the way to nothing. Both ends have to close on a point or the
            // tube shows its open section as a disc of backface.
            //
            // **No plateau.** A constant radius over any part of the body is
            // the definition of a cylinder; a stream tapers everywhere and the
            // only question is how fast. The exponent decides how much of the
            // spine you actually see — above about 1.2 the tail is gone by two
            // thirds of the way back and the arc reads short, so the taper is
            // close to linear and the body carries almost the whole nine metres.
            const profile = smooth01(u / 0.10) * Math.pow(1 - u, 1.05);

            // Thickness from the speed the tip had when this sample was laid —
            // slow means bunched, fast means stretched thin. Conservation of
            // mass, near enough, and it is the reason the body varies without
            // anything periodic in it.
            const stretch = clampRange(1.35 - this._spd[i] * 0.055, 0.55, 1.35);
            const rad = RADIUS * profile * stretch * this.blend;

            // Section aspect. Flattened where it is skimming the snow, on top of
            // the ribbon's own ellipse: water running over a surface spreads
            // across it rather than staying round.
            const clear = y - ctx.terrain.heightAt(x, z);
            const ground = 1 - clamp01((clear - 0.06) / 0.35);
            const flat = SECTION_ASPECT * (1 - 0.72 * ground);

            // Foam at the head, where it is tearing through the air; again
            // wherever it is dragging on the ground; and again wherever the body
            // is stretched thin, because that is where a stream tears.
            const foam = clamp01(
                (1 - smooth01(u / 0.16)) * 0.55 +
                ground * 0.5 +
                (1 - stretch) * 0.45
            );

            // The section rolls as it goes. With an elliptical section that
            // turns the broad face over along the body, which is what makes it
            // read as a ribbon of water rather than as an extruded shape.
            water.column(
                s, j, x, y, z, rad,
                rx, ry, rz, twist + dist * 1.35,
                dist, u, foam, flat
            );

            px = x; py = y; pz = z;
        }

        water.setParams(s, PROFILE_TUBE, 0.14, clamp01(this.blend * 1.3), n);
    }

    // No light, unlike the other four spells. Those are all *events* — a wave
    // breaking, a charge detonating, ice crystallising, a column of snow torn
    // off the ground — and light coming out of them reads as the energy doing
    // the work. Bent water is just water being moved; a blue glow under it says
    // the water is luminous, which nothing about it suggests. The cost is the
    // through-scatter demonstration on this spell; the gain is that the ribbon
    // is lit by the same sun as everything else.

    /**
     * Thin curved lines scored in the snow.
     *
     * Only where the body is actually low enough to touch, and shallow — a
     * score, not a trench, so the trace of a figure-eight is still legible on
     * the ground a minute later. A little ice with it, because water on snow at
     * this temperature does one thing.
     */
    _score(dt) {
        const ctx = this.ctx;
        const f = ctx.deform;
        const n = Math.min(this._count, STRAND_COLS);
        if (n < 2 || this.blend < 0.15) return;

        this._scoreOwed += dt;
        if (this._scoreOwed < 1 / 60) return;
        const k = Math.min(this._scoreOwed, 0.05);
        this._scoreOwed = 0;

        // Walk the head end only. The tail has already scored whatever it was
        // going to score, and re-cutting it every frame is how a light trace
        // turns into a gouge.
        const span = Math.min(n - 1, 10);
        for (let j = 0; j <= span; j += 2) {
            const i = (this._head - j + SAMPLES * 2) % SAMPLES;
            const x = this._x[i];
            const y = this._y[i];
            const z = this._z[i];
            const clear = y - ctx.terrain.heightAt(x, z);
            if (clear > 0.34) continue;

            const w = 1 - clamp01(clear / 0.34);
            f.brush(
                x, z,
                0.13,
                1.15 * k * w * this.blend,   // shallow
                0.55 * k * w * this.blend,   // a small lip of pushed snow
                2.6 * k * w * this.blend,    // packed hard by running water
                1.9 * k * w * this.blend,    // and glazed
                0, 1, 0.65
            );
        }
    }

    /**
     * Droplets shed from the trailing edge.
     *
     * Off the *body*, not off the tip: a stream under this much lateral
     * acceleration loses water all the way along its outside, and emitting only
     * at the head puts a comet trail behind a shape that is not a comet.
     */
    _shed(dt) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        const n = this._count;
        if (!sp || n < 4 || this.blend < 0.2) return;

        const rate = 130 * ctx.sprayScale * this.blend;
        this._sprayOwed += dt * rate;
        let count = this._sprayOwed | 0;
        if (count <= 0) return;
        this._sprayOwed -= count;
        if (count > 30) count = 30;

        for (let k = 0; k < count; k++) {
            const j = 1 + ((Math.random() * (n - 2)) | 0);
            const i = (this._head - j + SAMPLES * 2) % SAMPLES;
            const ip = (i + 1) % SAMPLES;
            // Local velocity of the body, from the spine's own spacing.
            const vx = (this._x[i] - this._x[ip]) * 12;
            const vy = (this._y[i] - this._y[ip]) * 12;
            const vz = (this._z[i] - this._z[ip]) * 12;

            sp.emit(
                this._x[i] + (Math.random() - 0.5) * 0.2,
                this._y[i] + (Math.random() - 0.5) * 0.2,
                this._z[i] + (Math.random() - 0.5) * 0.2,
                vx * 0.5 + (Math.random() - 0.5) * 1.6,
                vy * 0.5 + 0.4 + Math.random() * 1.2,
                vz * 0.5 + (Math.random() - 0.5) * 1.6,
                0.022 + Math.random() * 0.034,
                0.55 + Math.random() * 0.75,
                // Droplets, not powder: hard-edged and ballistic.
                1,
                0.55
            );
        }
    }

    _end() {
        this.active = false;
        this._seeded = false;
        this.thrown = false;
        this._splashed = false;
        this._throwT = 0;
        this.blend = 0;
        if (this.strand >= 0) {
            this.ctx.water.release(this.strand);
            this.strand = -1;
        }
    }

    cancel() {
        // Not `release()`: cancelling is the settings toggle or a lost pointer
        // lock, and neither of those is the player throwing anything.
        this.held = false;
        this._end();
    }
}
