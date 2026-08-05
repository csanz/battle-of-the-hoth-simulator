/**
 * Spell 5 — Vortex.
 *
 * A swirling column of airborne snow around the player that visibly *strips*
 * surface snow from the ground, holds it aloft, and lets it settle back.
 *
 * The stripping is the point, and it is the one thing here that no other spell
 * does: this is the only effect in the demo that takes the terrain state buffer
 * *back*. A brush with a negative depression is a perfectly ordinary brush as
 * far as the simulation is concerned — the accumulation is additive and the
 * clamp floors it at zero — so "remove snow from a ring" and "put it back" are
 * the same code path as everything else, with a sign on it.
 *
 * The airborne mass is two systems working from one description:
 *
 *   three helices   swept tubes of dense slush, wound around the player and
 *                   rotating. These give the column a readable *shape*; a vortex
 *                   made only of particles is a cloud, and a cloud does not
 *                   spiral.
 *   the grains      emitted continuously *along those same helices*, with the
 *                   helix's own tangential velocity, and short-lived enough that
 *                   they never get far from the path that launched them. That is
 *                   how the spray swirls without the particle simulation needing
 *                   to know what a vortex is — the same trick the surf plume uses
 *                   to leave the crest the mesh is actually drawing.
 */

import { PROFILE_TUBE } from "./waterBody.js";
import { clamp01, smooth01, bell, transport } from "./bending.js";

/** How many helices. Three reads as a spiral; two reads as a double helix. */
const HELICES = 3;
/** Spine samples per helix. See the note on `STRAND_COLS` — this curve is tight. */
const COLS = 64;
/** Seconds of full-strength spin, before the ease-out. */
const HOLD = 3.0;
const RAMP = 0.55;
const FADE = 1.1;
/** Height of the column, metres. */
const TOP = 4.8;
/** Turns each helix makes from the ground to the top. */
const TURNS = 1.35;

const _rgt = new Float32Array(3);

export class Vortex {
    /** @param {import("./spellSystem.js").SpellContext} ctx */
    constructor(ctx) {
        this.ctx = ctx;
        this.active = false;
        /** @type {number[]} */
        this.strands = [-1, -1, -1];

        this.t = 0;
        this.x = 0;
        this.z = 0;
        this.spin = 0;
        this._stripOwed = 0;
        this._grainOwed = 0;
        /** How far out the stripping ring has reached, metres. */
        this.ring = 0.9;
    }

    trigger() {
        const ctx = this.ctx;
        for (let i = 0; i < HELICES; i++) {
            if (this.strands[i] < 0) this.strands[i] = ctx.water.acquire();
        }
        this.t = 0;
        this.ring = 0.9;
        this._stripOwed = 0;
        this._grainOwed = 0;
        this.active = true;
    }

    /** @param {number} dt */
    update(dt) {
        if (!this.active) return;
        const ctx = this.ctx;
        this.t += dt;

        const total = RAMP + HOLD + FADE;
        if (this.t >= total) {
            this._end();
            return;
        }

        // The column follows the player. It is *their* vortex — walking out of
        // it would be the single most effect-like thing it could do.
        this.x = ctx.controller.position.x;
        this.z = ctx.controller.position.z;

        const env = smooth01(this.t / RAMP) * (1 - smooth01((this.t - RAMP - HOLD) / FADE));
        // Spins up and keeps spinning: the rotation does not ease out with the
        // envelope, so the last frame is a fading column that is still turning
        // rather than one that is winding down.
        this.spin += dt * (5.2 + 2.4 * env);

        this._helices(env);
        this._strip(dt, env);
        this._grains(dt, env);

        ctx.lights.add(
            this.x, ctx.terrain.heightAt(this.x, this.z) + 1.3, this.z,
            9.0, 0.46, 0.74, 1.0, 9.0 * env
        );
    }

    /** Lay the three helices. */
    _helices(env) {
        const ctx = this.ctx;
        const water = ctx.water;
        const groundY = ctx.terrain.heightAt(this.x, this.z);

        for (let hIdx = 0; hIdx < HELICES; hIdx++) {
            const s = this.strands[hIdx];
            if (s < 0) continue;
            const phase = (hIdx / HELICES) * Math.PI * 2;

            let px = 0, py = 0, pz = 0;
            let rx = 1, ry = 0, rz = 0;
            let t0x = 1, t0y = 0, t0z = 0;
            let dist = 0;

            for (let c = 0; c < COLS; c++) {
                const u = c / (COLS - 1);
                // Column 0 is the top of the helix — the leading edge of the
                // lift — so `u` runs downward, matching every other strand.
                const h = 1 - u;
                const ang = phase + this.spin + h * TURNS * Math.PI * 2;
                // Wide at the bottom where it is picking snow up, narrower and
                // faster at the top. Not a cone: the waist is what makes it read
                // as a vortex rather than as a party hat.
                const r = (2.55 - 1.15 * h) * (0.78 + 0.34 * bell(clamp01(h * 1.2)));

                const x = this.x + Math.cos(ang) * r;
                const z = this.z + Math.sin(ang) * r;
                const y = groundY + TOP * h * env + 0.05;

                if (c > 0) {
                    let t1x = x - px, t1y = y - py, t1z = z - pz;
                    const l = Math.hypot(t1x, t1y, t1z) || 1e-4;
                    t1x /= l; t1y /= l; t1z /= l;
                    dist += l;
                    transport(_rgt, 0, rx, ry, rz, t0x, t0y, t0z, t1x, t1y, t1z);
                    rx = _rgt[0]; ry = _rgt[1]; rz = _rgt[2];
                    t0x = t1x; t0y = t1y; t0z = t1z;
                } else {
                    rx = 0; ry = 1; rz = 0;
                }

                // Both ends taper to nothing: the top because the snow is
                // dispersing, the bottom because it is still on the ground.
                //
                // Thin. The helices are here to give the column a readable
                // *shape*, not to be the column: the mass of it is the grains,
                // and a fat ribbon takes the reading away from them and turns
                // the spell into three solid loops with some snow near it.
                // Monotonic in `u`, with one slow modulation and nothing else.
                // Several terms keyed to world distance reach the sample Nyquist
                // and pinch the tube shut wherever their zeros line up, which
                // reads as vertebrae. Anything finer than the samples can carry
                // has to live in the relief field, which is band-limited on
                // purpose; see `waterRelief`.
                const taper = bell(u * 0.92 + 0.04);
                const rad = 0.125 * taper * env
                          * (0.78 + 0.34 * Math.sin(u * 3.4 + ctx.time * 2.2 + hIdx));

                // The section roll carries *no* distance term.
                //
                // A roll that advances along the spine spirals everything keyed
                // to the section angle — including the relief field — so the
                // surface comes out cut with a screw thread, which on a thin
                // tube reads as vertebrae. The ribbon wants that
                // spiral, because it has an elliptical section and the twist is
                // the point; a round section gains nothing from it but the
                // artefact.
                water.column(
                    s, c, x, y, z, rad,
                    rx, ry, rz, ctx.time * 0.7 + hIdx * 2.1,
                    dist, u, 0.22 + 0.3 * (1 - h), 1
                );

                px = x; py = y; pz = z;
            }

            // Almost entirely opaque: this is lifted snow, not water. The small
            // amount of transparency left is what lets the far side of the
            // column show through the near side, which is most of what makes it
            // read as a rotating volume.
            water.setParams(s, PROFILE_TUBE, 0.88, clamp01(env * 1.3), COLS);
        }
    }

    /**
     * Strip the ground, then give it back.
     *
     * The ring grows outward while the spell holds and retreats while it fades,
     * so the snow comes back from the outside in — which is what settling snow
     * does, since the outermost material was lifted the least far.
     */
    _strip(dt, env) {
        const ctx = this.ctx;
        const f = ctx.deform;

        const holding = this.t < RAMP + HOLD;
        this.ring = holding
            ? Math.min(3.1, this.ring + dt * 0.85)
            : Math.max(0.9, this.ring - dt * 2.2);

        this._stripOwed += dt;
        if (this._stripOwed < 1 / 45) return;
        const k = Math.min(this._stripOwed, 0.05);
        this._stripOwed = 0;

        const N = 9;
        // Holding: take snow away — depression up, no berm, because the mass is
        // in the air rather than piled at the rim. Fading: put it back, as
        // negative depression plus a little loose berm, because what lands is
        // broken snow sitting proud of what it fell on.
        const give = holding ? -1 : 1;

        for (let i = 0; i < N; i++) {
            // Rotating with the column, so the ring is scoured rather than
            // stamped: a fixed set of angles leaves nine radial scars.
            const a = (i / N) * Math.PI * 2 + this.spin * 0.6;
            const r = this.ring * (0.82 + Math.random() * 0.3);
            f.brush(
                this.x + Math.cos(a) * r,
                this.z + Math.sin(a) * r,
                0.55,
                give < 0 ? 0.95 * k * env : -1.7 * k,
                give < 0 ? 0.05 * k * env : 0.85 * k,
                give < 0 ? 0.30 * k * env : -0.6 * k,
                0,
                a + Math.PI * 0.5, 1.9, 1.0
            );
        }
    }

    /**
     * The airborne grains.
     *
     * Emitted at a point on one of the helices with that helix's own tangential
     * velocity, and given a life short enough (a third of a second) that a
     * straight-line integration never visibly departs from the curve it was
     * launched along. Nothing in the particle system knows this is a vortex; the
     * swirl is entirely in where and how the grains are born.
     */
    _grains(dt, env) {
        const ctx = this.ctx;
        const sp = ctx.spray;
        if (!sp || env < 0.05) return;

        const rate = 2600 * ctx.sprayScale * env;
        this._grainOwed += dt * rate;
        let count = this._grainOwed | 0;
        if (count <= 0) return;
        this._grainOwed -= count;
        if (count > 260) count = 260;

        const groundY = ctx.terrain.heightAt(this.x, this.z);

        for (let k = 0; k < count; k++) {
            // Weighted toward the bottom, where the snow is being picked up.
            const h = Math.random() * Math.random();
            const hIdx = (Math.random() * HELICES) | 0;
            const phase = (hIdx / HELICES) * Math.PI * 2;
            const ang = phase + this.spin + h * TURNS * Math.PI * 2
                      + (Math.random() - 0.5) * 0.9;
            const r = (2.55 - 1.15 * h) * (0.78 + 0.34 * bell(clamp01(h * 1.2)))
                    * (0.85 + Math.random() * 0.35);

            const cs = Math.cos(ang);
            const sn = Math.sin(ang);
            // Tangential: perpendicular to the radius, in the direction of spin.
            const speed = 7.5 - 2.6 * h;
            const vx = -sn * speed;
            const vz = cs * speed;

            sp.emit(
                this.x + cs * r,
                groundY + TOP * h * env + 0.06 + Math.random() * 0.2,
                this.z + sn * r,
                vx + cs * (Math.random() - 0.6) * 1.2,
                1.4 + Math.random() * 3.4 + (1 - h) * 2.5,
                vz + sn * (Math.random() - 0.6) * 1.2,
                0.028 + Math.random() * 0.062,
                0.30 + Math.random() * 0.26,
                0,
                // Low drag, short life: it holds the launch velocity for the
                // whole of its life, which is what keeps it on the spiral.
                0.9
            );
        }
    }

    _end() {
        this.active = false;
        for (let i = 0; i < HELICES; i++) {
            if (this.strands[i] >= 0) {
                this.ctx.water.release(this.strands[i]);
                this.strands[i] = -1;
            }
        }
    }

    cancel() {
        this._end();
    }
}
