/**
 * Spell 1 — Sweep.
 *
 * A crescent of slush rises out of the ground ahead of the player and runs
 * outward, ploughing a channel and throwing berms to either side.
 *
 * It is the wake's cross-section on a different spine, and that is not a
 * shortcut. A carve's wall of snow and a bent wave of slush are the same
 * object — mass thrown out of the ground and held up by its own momentum — so
 * they are drawn by the same section integral out of `lib/wake.glsl`, reached
 * through the water material's sheet profile. What differs is what the spine is:
 * the wake's is a record of where the board went, and this one is an arc that
 * grows outward from where the spell was cast.
 *
 * The channel is not a decal chased after the fact. Each frame the live crest
 * writes brushes into the terrain state buffer at the position the mesh is
 * actually drawing, so the mark and the wave cannot disagree — the same rule the
 * plume follows in the surf wake.
 */

import { PROFILE_SHEET } from "./waterBody.js";
import { clamp01, smooth01, bell } from "./bending.js";

/** Spine samples across the crescent. */
const COLS = 48;

/**
 * Curvature radius of the crescent, metres — *fixed*, and this is the whole
 * shape of the spell.
 *
 * Not the distance travelled. Using that as the radius makes the wave an arc of
 * a circle centred on the caster, and ten metres out the crescent is twenty
 * metres wide — a ridge in the terrain rather than something thrown. A wave
 * front has a curvature of its own that has nothing to do with how far it has
 * run, so the arc keeps its shape and *translates*, and only its span opens up
 * as the ends spread.
 */
const CURVE = 5.5;
/** Half-angle of the arc at cast and at full spread, radians. */
const ARC0 = 0.52;
const ARC1 = 0.96;
/** Seconds from cast to fully collapsed. */
const LIFE = 2.4;
/**
 * Peak crest height at the centre of the arc, metres.
 *
 * Taller than the character, on the same reasoning as the surf wake's 2.4 m: at
 * the distance this demo actually frames from, a crest the height of the relief
 * the terrain already has does not read as thrown mass, it reads as a dune.
 */
const PEAK = 2.15;

export class Sweep {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        this.strand = -1;

        this.t = 0;
        this.ox = 0;
        this.oz = 0;
        this.dx = 0;
        this.dz = 1;
        /** Metres the crest has travelled from the origin. */
        this.reach = 0;
        this._brushOwed = 0;
        this._sprayOwed = 0;
    }

    /** @param {number} ax @param {number} az flat aim direction */
    trigger(ax, az) {
        const ctx = this.ctx;
        const ch = ctx.controller;

        // A recast restarts rather than stacking: two crescents from the same
        // point are one crescent with a seam in it.
        if (this.strand < 0) this.strand = ctx.water.acquire();
        if (this.strand < 0) return;

        const fl = Math.hypot(ax, az) || 1;
        this.dx = ax / fl;
        this.dz = az / fl;
        // Born a little ahead of the feet, so the player is never inside it.
        this.ox = ch.position.x + this.dx * 1.1;
        this.oz = ch.position.z + this.dz * 1.1;
        this.t = 0;
        this.reach = 1.4;
        this._brushOwed = 0;
        this._sprayOwed = 0;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        const water = ctx.water;
        const terrain = ctx.terrain;
        const s = this.strand;
        if (s < 0) {
            this.active = false;
            return;
        }

        this.t += dt;
        const life01 = this.t / LIFE;
        if (life01 >= 1) {
            this._end();
            return;
        }

        // Speed decays: the wave is launched, not driven. Ten metres a second
        // down to a walking pace, which is what makes it read as something that
        // was thrown rather than something being pushed.
        const speed = 11.5 * Math.exp(-this.t * 1.15) + 1.2;
        const travelled = speed * dt;
        this.reach += travelled;

        // Rise fast, hold, fall. The fall is quadratic to exactly zero so the
        // last frame of the wave is flat rather than a step.
        const rise = smooth01(this.t / 0.26);
        const fall = 1 - clamp01((life01 - 0.55) / 0.45);
        const env = rise * fall * fall;

        // A wave spreads as it runs: the arc opens up and the crest thins, so
        // the same mass covers more ground.
        const spread = clamp01((this.reach - 1.4) / 14);
        const arc = ARC0 + (ARC1 - ARC0) * spread;
        const height = PEAK * env / (1 + spread * 0.45);

        // Circle centre, one curvature radius behind the leading point.
        const kx = this.ox + this.dx * (this.reach - CURVE);
        const kz = this.oz + this.dz * (this.reach - CURVE);
        // The crest's own right, for the arc parametrisation.
        const wx = this.dz;
        const wz = -this.dx;

        let px = 0, py = 0, pz = 0;
        for (let c = 0; c < COLS; c++) {
            const u = c / (COLS - 1);
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            // Outward radial at this angle: the direction the section faces, and
            // the direction the horn at that end of the crescent is running.
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const x = kx + rx * CURVE;
            const z = kz + rz * CURVE;
            // Sunk, so the base of the wall meets the trench floor it is cutting
            // rather than floating on the undisturbed surface.
            const y = terrain.heightAt(x, z) - 0.13;

            // Horns taper to nothing. The bell is on `u` rather than on the
            // angle so the two ends close symmetrically however wide the arc has
            // opened, and the sheet degenerates onto its own spine there instead
            // of ending on a cut edge.
            const amp = height * bell(u);

            // The crest curls harder in the middle, where the mass is. Pushed
            // most of the way to the section integral's plunging limit: at the
            // low end the sheet is a bank, and a bank lying on a dune field is
            // indistinguishable from the dune field. It has to hook over its own
            // face to read as a wave at all.
            const curl = 0.48 + 0.47 * bell(u) * (0.45 + 0.55 * rise);
            // Foam along the whole leading edge, heaviest at the centre.
            const foam = 0.30 + 0.45 * bell(u);

            water.column(
                s, c, x, y, z, amp,
                rx, 0, rz, curl,
                this.reach + u * 2.0, life01, foam, 1
            );

            if (c === (COLS >> 1)) { px = x; py = y; pz = z; }
        }

        // Slush: mostly water, with enough entrained snow to be opaque at the
        // crest. Below about 0.4 it stops reading as slush and starts reading as
        // a glass sculpture; above about 0.6 the water disappears entirely and
        // it is just a snow berm that happens to be moving.
        water.setParams(s, PROFILE_SHEET, 0.48, clamp01(env * 1.4), COLS);

        // Light rides the middle of the crest, low, so it grazes the channel it
        // is cutting rather than lighting it from above.
        ctx.lights.add(
            px, py + height * 0.55, pz,
            9.5, 0.42, 0.74, 1.0, 13.0 * env
        );

        this._plough(travelled, env);
        this._spray(travelled, env, height);
    }

    /**
     * The channel and its berms.
     *
     * Written per metre travelled rather than per second, so the trench has the
     * same depth at any speed or frame rate: a patch of ground sits under the
     * brush for (2 * radius / travelled) frames, and the depth it ends at is
     * therefore independent of both.
     */
    _plough(travelled, env) {
        if (env < 0.05) return;
        const ctx = this.ctx;
        const f = ctx.deform;

        this._brushOwed += travelled;
        // One rank of brushes every 25 cm of advance. Denser than that just
        // re-cuts the same trench; sparser leaves it scalloped.
        if (this._brushOwed < 0.25) return;
        const k = Math.min(this._brushOwed, 0.7);
        this._brushOwed = 0;

        const spread = clamp01((this.reach - 1.4) / 14);
        const arc = ARC0 + (ARC1 - ARC0) * spread;
        const N = 13;

        // Slightly behind the crest: the channel is what the wave has already
        // passed over, not what it is about to.
        const kx = this.ox + this.dx * (this.reach - 0.5 - CURVE);
        const kz = this.oz + this.dz * (this.reach - 0.5 - CURVE);
        const wx = this.dz;
        const wz = -this.dx;

        for (let i = 0; i < N; i++) {
            const u = i / (N - 1);
            const w = bell(u);
            if (w < 0.06) continue;
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const x = kx + rx * CURVE;
            const z = kz + rz * CURVE;

            // The brush's long axis runs *along* the arc, so the trench is
            // continuous rather than a row of round pits. Yaw is the tangent.
            const yaw = Math.atan2(rz, -rx);

            f.brush(
                x, z,
                0.34,
                0.95 * k * env * w,   // channel
                0.62 * k * env * w,   // berms at the rim
                0.55 * k * env * w,   // slush packs what it runs over
                0.16 * k * env * w,   // and refreezes a little of it
                yaw,
                2.2,
                0.9
            );
        }
    }

    /** Spray off the crest — thrown outward and back over the top. */
    _spray(travelled, env, height) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || env < 0.08) return;

        const perMetre = 120 * ctx.sprayScale;
        this._sprayOwed += travelled;
        let count = (this._sprayOwed * perMetre) | 0;
        if (count <= 0) return;
        this._sprayOwed -= count / perMetre;
        if (count > 150) count = 150;

        const spread = clamp01((this.reach - 1.4) / 14);
        const arc = ARC0 + (ARC1 - ARC0) * spread;
        const terrain = ctx.terrain;
        const wx = this.dz;
        const wz = -this.dx;
        const kx = this.ox + this.dx * (this.reach - CURVE);
        const kz = this.oz + this.dz * (this.reach - CURVE);

        for (let k = 0; k < count; k++) {
            const u = Math.random();
            const w = bell(u);
            if (w < 0.12) continue;
            const th = (u - 0.5) * 2 * arc;
            const cs = Math.cos(th);
            const sn = Math.sin(th);
            const rx = this.dx * cs + wx * sn;
            const rz = this.dz * cs + wz * sn;

            const amp = height * w;
            const d = CURVE + (Math.random() - 0.2) * 0.6;
            const x = kx + rx * d;
            const z = kz + rz * d;
            const y = terrain.heightAt(x, z) + amp * (0.55 + 0.6 * Math.random());

            // Thrown forward and up, off the front of the crest.
            const out = 1.4 + Math.random() * 3.2;
            const clod = Math.random() < 0.2 ? 1 : 0;
            sp.emit(
                x, y, z,
                rx * out + (Math.random() - 0.5) * 1.4,
                1.5 + Math.random() * 3.2 + amp * 1.6,
                rz * out + (Math.random() - 0.5) * 1.4,
                clod ? 0.022 + Math.random() * 0.024 : 0.050 + Math.random() * 0.075,
                clod ? 0.6 + Math.random() * 0.5 : 0.55 + Math.random() * 0.7,
                clod,
                clod ? 0.8 : 1.6 + Math.random() * 1.4
            );
        }
    }

    _end() {
        this.active = false;
        if (this.strand >= 0) {
            this.ctx.water.release(this.strand);
            this.strand = -1;
        }
    }

    cancel() {
        this._end();
    }
}
