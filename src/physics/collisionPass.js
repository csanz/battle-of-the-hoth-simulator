/**
 * The collision pass — where the craft finally meet the machines.
 *
 * Everything upstream is a piece: colliders.js knows where things touch,
 * impact.js knows what a touch does to a velocity, the walkers know their own
 * capsules, the craft know how to take a shove. This module is the frame that
 * holds the pieces: once per tick it rebuilds the capsule pool from the herds
 * and the wrecks, sweeps every flying craft's sphere through it, resolves the
 * earliest contact per craft, and routes the consequences — deflection, spin,
 * scramble, stumble, snow, smoke, fire, sound — to their owners.
 *
 * Design rules, inherited from the contract the pieces were built to:
 *
 *   swept, never sampled   Craft move metres per frame; every test is against
 *                          the frame's motion, so speed cannot tunnel.
 *   earliest hit wins      One contact resolved per craft per frame. The
 *                          depenetration guarantees next frame starts clean,
 *                          so a second contact simply waits a frame.
 *   no stop on contact     Responses come from `speederImpactResponse`:
 *                          tangential velocity survives, scrapes slide.
 *   massive stays massive  A walker takes a tempo hiccup (`stumble`), never
 *                          a displacement. Wrecks take nothing at all.
 *
 * The player's damage ladder lives here rather than on the controller,
 * because it is a *game* rule, not a physics one: 'hit' steps it with a grace
 * window, 'crash' trips it, and the third rung is a field repair — explosion,
 * a twenty-second burn, and the ladder resets. No death screen.
 *
 * Everything is preallocated at construction; the frame path allocates
 * nothing. Every collaborator is null-checked so a boot without a speeder,
 * without wingmen, or without audio still runs the parts it has.
 */

import { S } from "../core/settings.js";
import { makeCapsulePool, sweptSphereVsCapsule, sweptSphereVsSphere } from "./colliders.js";
import { speederImpactResponse } from "./impact.js";
import { emitBurnTrail } from "../player/wingman.js";

/** Craft collision sphere radius, metres. Deliberately under the T-47's
 *  half-width: a sphere is a fat proxy for a flat hull, and a hit the player
 *  didn't visually earn reads as a bug — while the AT-AT's between-the-legs
 *  corridor (about 3.9 m of daylight at the default scale) must stay
 *  flyable, because that run is the whole point of a snowspeeder. */
const CRAFT_R = 1.6;
/** Wreck capsule: half-length along the hull line and radius, metres. */
const WRECK_HALF = 2.6;
const WRECK_R = 2.2;
/** Metres in one frame past which the move was a placement, not flight.
 *  Both integrators clamp their step to 1/30 s, so the fastest thing here —
 *  a boosted craft at ~57 m/s — covers under 2 m; a respawn covers 480. */
const TELEPORT = 12;
/** Seconds of degraded control a contact buys, by severity. */
const SCRAMBLE = { scrape: 0, hit: 0.9, crash: 2.0 };
/** Player camera trauma per severity — the player feels their own hits only. */
const TRAUMA = { scrape: 0.12, hit: 0.35, crash: 0.9 };
/** The field-repair burn after the ladder trips, seconds. */
const PLAYER_BURN = 20;
/** Grace after a ladder step — same idea as the wingmen's `_hitGrace`. */
const PLAYER_GRACE = 4;
/** Seconds between a craft's scrape effects — see `_contactFx`. */
const SCRAPE_GAP = 0.22;
/** Trooper squash: how close, how low, and how often per craft. */
const SQUASH_DIST = 6;
const SQUASH_ALT = 3.2;
const SQUASH_GAP = 0.4;

function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }

export class CollisionPass {
    /**
     * @param {{
     *   character?: import("../character/controller.js").CharacterController|null,
     *   speeder?: import("../player/speeder.js").Speeder|null,
     *   wingmen?: import("../player/wingman.js").Wingman[]|null,
     *   herds?: {herd: import("../walkers/walker.js").WalkerHerd, kind: string}[]|null,
     *   wrecks?: {ctl: any, active: boolean}[]|null,
     *   terrain?: import("../terrain/terrain.js").Terrain|null,
     *   explosions?: import("../vfx/explosion.js").Explosions|null,
     *   spray?: import("../vfx/particles.js").SprayField|null,
     *   smoke?: import("../vfx/smokeTrails.js").SmokeTrails|null,
     *   rig?: import("../core/camera.js").CameraRig|null,
     *   audio?: import("../audio/engine.js").AudioEngine|any|null,
     *   troopers?: import("../walkers/walker.js").WalkerHerd|null,
     *   squadImpact?: ((x:number, z:number) => void)|null,
     * }} ctx everything the pass reacts through; all optional.
     */
    constructor(ctx) {
        this.character = ctx.character ?? null;
        this.speeder = ctx.speeder ?? null;
        this.wingmen = ctx.wingmen ?? [];
        this.herds = ctx.herds ?? [];
        this.wrecks = ctx.wrecks ?? [];
        this.terrain = ctx.terrain ?? null;
        this.explosions = ctx.explosions ?? null;
        this.spray = ctx.spray ?? null;
        this.smoke = ctx.smoke ?? null;
        this.rig = ctx.rig ?? null;
        this.audio = ctx.audio ?? null;
        this.troopers = ctx.troopers ?? null;
        this.squadImpact = ctx.squadImpact ?? null;

        // ------------------------------------------------------ the capsule pool
        // Sized for the worst the sliders can ask for: six capsules per AT-AT
        // (four legs, body, head), one per AT-ST, one per wreck slot, plus
        // slack — nothing grows after this line.
        let cap = 8;
        for (const e of this.herds) {
            cap += (e.herd?._maxCount ?? 8) * (e.kind === "atst" ? 1 : 6);
        }
        cap += this.wrecks.length;
        this.pool = makeCapsulePool(cap);

        // ------------------------------------------------------- the craft slots
        // One record per craft, player first. Prev positions live here — the
        // sweep needs where the craft *was*, and neither controller keeps it.
        /** @type {{wing: import("../player/wingman.js").Wingman|null,
         *          has: boolean, prevX: number, prevY: number, prevZ: number,
         *          cx: number, cy: number, cz: number,
         *          mx: number, my: number, mz: number,
         *          active: boolean, downed: boolean, squashT: number}[]} */
        this.slots = [];
        const slot = (wing) => ({
            wing, has: false, prevX: 0, prevY: 0, prevZ: 0,
            cx: 0, cy: 0, cz: 0, mx: 0, my: 0, mz: 0,
            active: false, downed: false, squashT: 0, fxT: 0,
        });
        this.slots.push(slot(null));
        for (const w of this.wingmen) this.slots.push(slot(w));

        // ---------------------------------------------------------- scratch
        // Two hit records (candidate and best-so-far), one response, one
        // params bag — rewritten every query, never replaced.
        this._hit = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
        this._best = { t: 0, nx: 0, ny: 0, nz: 0, px: 0, py: 0, pz: 0, cap: null };
        this._res = { vx: 0, vz: 0, spin: 0, normalSpeed: 0, severity: "scrape" };
        this._axisPt = { x: 0, y: 0, z: 0 };
        this._params = {
            vx: 0, vz: 0, speed: 0, nx: 0, nz: 0, ovx: 0, ovz: 0,
            massRatio: Infinity, hitSide: 0, restitution: 0.35,
            hitAt: 7, crashAt: 17,
        };

        /** The last contact resolved, for the overlay and for tuning: what
         *  was hit, how hard it closed, and what that bought. Read-only. */
        this.lastImpact = {
            kind: "", severity: "", normalSpeed: 0, spin: 0, player: false,
        };

        // ------------------------------------------------ player damage ladder
        this._pDamage = 0;
        this._pGrace = 0;
        this._pBurnT = 0;
        this._pPuffT = 0;
    }

    /** @param {number} dt seconds; clamped to 1/30 like the craft integrators. */
    update(dt) {
        if (S.collisions === false) {
            // Off is off: forget the prev positions so re-enabling does not
            // sweep a teleport's worth of motion through the field.
            for (const s of this.slots) s.has = false;
            return;
        }
        const h = Math.min(dt, 1 / 30);
        this._ladderUpkeep(h);
        if (h <= 1e-6) return; // freeze-time: nothing moved, nothing can hit

        this._rebuildPool();
        this._refreshSlots();

        for (const s of this.slots) {
            if (!s.active) continue;
            s.squashT = Math.max(0, s.squashT - h);
            s.fxT = Math.max(0, s.fxT - h);
            // A craft that is already dying is the crash sequence's, not
            // ours. Its ballistic is a scripted line into the snow — the
            // whole point of it is that nothing steers it any more — and a
            // kill usually happens *against* a capsule, so sweeping it would
            // bounce the corpse off the machine that killed it, re-fire the
            // fireball every frame it stayed embedded, and move the wreck.
            if (s.downed) continue;
            this._sweepWorld(s);
        }

        // Craft on craft — every pair, both sides responding, the downed and
        // the absent excluded.
        for (let i = 0; i < this.slots.length; i++) {
            const a = this.slots[i];
            if (!a.active || a.downed) continue;
            for (let j = i + 1; j < this.slots.length; j++) {
                const b = this.slots[j];
                if (!b.active || b.downed) continue;
                this._sweepPair(a, b);
            }
        }

        this._squashTroopers();
        this._terrainSlam();

        // The corrected positions become next frame's starting line.
        for (const s of this.slots) {
            if (!s.active) continue;
            s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
        }
    }

    // ------------------------------------------------------------ frame setup

    /** Herd capsules, then wreck capsules, then a dead tail. */
    _rebuildPool() {
        const pool = this.pool;
        let k = 0;
        for (const e of this.herds) {
            if (e.herd?.collectColliders) k = e.herd.collectColliders(pool, k, e.kind);
        }
        for (const wk of this.wrecks) {
            if (!wk?.active || k >= pool.length) continue;
            const ctl = wk.ctl;
            const fx = Math.sin(ctl.facing), fz = Math.cos(ctl.facing);
            const y = (ctl.groundY ?? 0) + 1.0;
            const c = pool[k++];
            c.ax = ctl.position.x - fx * WRECK_HALF;
            c.ay = y;
            c.az = ctl.position.z - fz * WRECK_HALF;
            c.bx = ctl.position.x + fx * WRECK_HALF;
            c.by = y;
            c.bz = ctl.position.z + fz * WRECK_HALF;
            c.r = WRECK_R;
            c.kind = "wreck";
            c.walker = wk;
            c.live = true;
        }
        for (let i = k; i < pool.length; i++) pool[i].live = false;
    }

    /** Who is flying this frame, and where their sphere centre sits. */
    _refreshSlots() {
        for (const s of this.slots) {
            if (s.wing === null) {
                // The player's sphere rides the controller's XZ and the drawn
                // hull's Y — the hover ease is what the eye sees hit things.
                const c = this.character;
                const on = !!c && !!this.speeder && S.speeder === true && c.surf > 0.5;
                s.active = on;
                s.downed = false;
                if (on) {
                    s.cx = c.position.x;
                    s.cy = this.speeder.position.y;
                    s.cz = c.position.z;
                }
            } else {
                const P = s.wing.pilot;
                const on = S.showWingman !== false && !!P;
                s.active = on;
                s.downed = on && P.downed === true;
                if (on) {
                    s.cx = P.position.x; s.cy = P.position.y; s.cz = P.position.z;
                }
            }
            if (!s.active) { s.has = false; continue; }
            if (!s.has) {
                // First frame (or first after a gap): no motion to sweep, but
                // the overlap branch still depenetrates a bad spawn.
                s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
                s.has = true;
            }
            s.mx = s.cx - s.prevX; s.my = s.cy - s.prevY; s.mz = s.cz - s.prevZ;
            // A teleport is not motion. A wingman respawning jumps 480 m from
            // its crash site, the opening flyover restages the flight, and
            // the console can put the player anywhere — swept as travel, any
            // of those drags a segment across the whole battle line and
            // "hits" the first machine it crosses, which would then yank the
            // craft back to it. Nothing under power covers TELEPORT metres in
            // one clamped frame, so anything that does is a placement, and a
            // placement starts a fresh sweep from where it landed.
            if (s.mx * s.mx + s.my * s.my + s.mz * s.mz > TELEPORT * TELEPORT) {
                s.prevX = s.cx; s.prevY = s.cy; s.prevZ = s.cz;
                s.mx = 0; s.my = 0; s.mz = 0;
            }
        }
    }

    // ---------------------------------------------------------- world contacts

    /** Sweep one craft against every live capsule; resolve the earliest. */
    _sweepWorld(s) {
        const pool = this.pool;
        const hit = this._hit, best = this._best;
        let found = false;
        for (let i = 0; i < pool.length; i++) {
            const cap = pool[i];
            if (!cap.live) continue;
            if (!sweptSphereVsCapsule(
                s.prevX, s.prevY, s.prevZ, s.mx, s.my, s.mz, cap, CRAFT_R, hit
            )) continue;
            if (!found || hit.t < best.t) {
                best.t = hit.t;
                best.nx = hit.nx; best.ny = hit.ny; best.nz = hit.nz;
                best.px = hit.px; best.py = hit.py; best.pz = hit.pz;
                best.cap = hit.cap;
                found = true;
            }
        }
        if (!found) return;

        const ctl = s.wing ? s.wing.pilot : this.character;
        const vel = ctl.velocity;

        // Both craft own their own height — the hover floor and the climb
        // ladder write y every frame and would undo anything put there — so
        // the resolution plane is XZ, and a contact has to be answered
        // *sideways* or not at all.
        //
        // Which means the 3D normal is the wrong push direction: under an
        // AT-AT's belly it points straight down, and its horizontal share is
        // a rounding error. The honest question is how far out from the
        // capsule's *axis* the craft has to stand to clear it at the height
        // it is flying, and Pythagoras answers it: with the craft dy below
        // the axis, the horizontal clearance needed is
        // sqrt(reach² − dy²) — zero once dy alone already clears, which is
        // exactly the under-belly corridor granting itself.
        const cap = best.cap;
        if (!cap) return;
        const reach = cap.r + CRAFT_R;
        const closest = this._closestOnAxis(cap, s.cx, s.cy, s.cz);
        const dy = s.cy - closest.y;
        const need2 = reach * reach - dy * dy;
        if (need2 <= 0.0001) return; // cleared vertically: the corridor holds
        const need = Math.sqrt(need2);

        // The way out is radially away from the axis, in the ground plane.
        let nx = s.cx - closest.x, nz = s.cz - closest.z;
        let nl = Math.hypot(nx, nz);
        if (nl < 1e-4) {
            // Dead on the axis: back out the way the craft came in.
            const vl = Math.hypot(vel.x, vel.z);
            if (vl > 1e-4) { nx = -vel.x / vl; nz = -vel.z / vl; }
            else { nx = 1; nz = 0; }
            nl = 0;
        } else { nx /= nl; nz /= nl; }

        if (nl < need) {
            const outX = closest.x + nx * (need + 0.05);
            const outZ = closest.z + nz * (need + 0.05);
            ctl.position.x = outX;
            ctl.position.z = outZ;
            s.cx = outX; s.cz = outZ;
        }

        // The obstacle's own ground velocity — a walker striding into you
        // closes faster than the speedometer says.
        let ovx = 0, ovz = 0;
        const wk = best.cap ? best.cap.walker : null;
        if (wk && typeof wk.stumble === "function" && wk.herd && !wk.oneshot) {
            const herd = wk.herd;
            const gs = (herd.baseSpeed ?? 0) * herd.tune.scale()
                * herd.tune.speed() * (wk.rateBias ?? 1);
            ovx = Math.sin(wk.yaw) * gs;
            ovz = Math.cos(wk.yaw) * gs;
        }

        const res = this._respond(
            ctl, vel, nx, nz, ovx, ovz, Infinity,
            best.px, best.pz, S.impactHit, S.impactCrash
        );
        const li = this.lastImpact;
        li.kind = cap.kind; li.severity = res.severity;
        li.normalSpeed = res.normalSpeed; li.spin = res.spin;
        li.player = s.wing === null;

        // The walker feels it too — as a beat, never as a shove. Nudged away
        // from the side the hit came in on.
        if (wk && typeof wk.stumble === "function") {
            const rightward = (best.px - wk.position.x) * Math.cos(wk.yaw)
                - (best.pz - wk.position.z) * Math.sin(wk.yaw);
            wk.stumble(res.normalSpeed / 25, rightward > 0 ? -1 : 1);
        }

        this._contactFx(
            res.severity, best.px, best.py, best.pz, s.wing === null, nx, nz,
            s, res.normalSpeed
        );
        if (s.wing === null) {
            if (res.severity !== "scrape") this._playerLadder(res.severity);
        } else {
            s.wing.collisionHit(res.severity, best.px, best.py, best.pz);
        }
    }

    /**
     * The point on a capsule's axis nearest a world point — the reference
     * every planar clearance question is asked against. Written into one
     * reused record.
     */
    _closestOnAxis(cap, x, y, z) {
        const ex = cap.bx - cap.ax, ey = cap.by - cap.ay, ez = cap.bz - cap.az;
        const len2 = ex * ex + ey * ey + ez * ez;
        let t = 0;
        if (len2 > 1e-8) {
            t = clamp(
                ((x - cap.ax) * ex + (y - cap.ay) * ey + (z - cap.az) * ez) / len2,
                0, 1
            );
        }
        const out = this._axisPt;
        out.x = cap.ax + ex * t;
        out.y = cap.ay + ey * t;
        out.z = cap.az + ez * t;
        return out;
    }

    // ------------------------------------------------------------ craft pairs

    /** Sphere-sphere sweep between two craft; both sides respond. */
    _sweepPair(a, b) {
        const hit = this._hit;
        if (!sweptSphereVsSphere(
            a.prevX, a.prevY, a.prevZ,
            a.mx - b.mx, a.my - b.my, a.mz - b.mz,
            b.prevX, b.prevY, b.prevZ, CRAFT_R, CRAFT_R, hit
        )) return;

        const ctlA = a.wing ? a.wing.pilot : this.character;
        const ctlB = b.wing ? b.wing.pilot : this.character;

        // Horizontal normal away from B toward A.
        let nx = hit.nx, nz = hit.nz;
        const nl = Math.hypot(nx, nz);
        if (nl < 1e-4) { nx = 1; nz = 0; } else { nx /= nl; nz /= nl; }

        // Overlapping already: shoulder them apart evenly, planar only.
        if (hit.t === 0) {
            const dx = a.cx - b.cx, dz = a.cz - b.cz;
            const d = Math.hypot(dx, dz);
            const need = (CRAFT_R * 2 - d) * 0.5 + 0.05;
            if (need > 0) {
                ctlA.position.x += nx * need; ctlA.position.z += nz * need;
                ctlB.position.x -= nx * need; ctlB.position.z -= nz * need;
                a.cx = ctlA.position.x; a.cz = ctlA.position.z;
                b.cx = ctlB.position.x; b.cz = ctlB.position.z;
            }
        }

        // Equal mass, both sides: each craft runs its own response with the
        // other's velocity as the obstacle's, and thresholds a fifth kinder —
        // two hulls glancing off each other is drama, not a wall.
        const hitAt = S.impactHit * 1.2, crashAt = S.impactCrash * 1.2;
        const avx = ctlA.velocity.x, avz = ctlA.velocity.z;
        const bvx = ctlB.velocity.x, bvz = ctlB.velocity.z;
        const resA = this._respond(
            ctlA, ctlA.velocity, nx, nz, bvx, bvz, 1, hit.px, hit.pz, hitAt, crashAt
        );
        const sev = resA.severity;
        this._respond(
            ctlB, ctlB.velocity, -nx, -nz, avx, avz, 1, hit.px, hit.pz, hitAt, crashAt
        );

        this._contactFx(
            sev, hit.px, hit.py, hit.pz,
            a.wing === null || b.wing === null, nx, nz,
            a.wing === null ? a : b, resA.normalSpeed
        );
        if (a.wing === null || b.wing === null) {
            if (sev !== "scrape") this._playerLadder(sev);
        }
        if (a.wing) a.wing.collisionHit(sev, hit.px, hit.py, hit.pz);
        if (b.wing) b.wing.collisionHit(sev, hit.px, hit.py, hit.pz);
    }

    // ------------------------------------------------------- shared machinery

    /** Fill the params bag, run the impact math, apply it to the craft. */
    _respond(ctl, vel, nx, nz, ovx, ovz, massRatio, px, pz, hitAt, crashAt) {
        const p = this._params;
        p.vx = vel.x; p.vz = vel.z;
        p.speed = Math.hypot(vel.x, vel.z);
        p.nx = nx; p.nz = nz;
        p.ovx = ovx; p.ovz = ovz;
        p.massRatio = massRatio;
        // The lever arm: the contact's lateral offset in the craft's frame,
        // over the sphere radius — starboard positive, port negative.
        const f = ctl.facing ?? 0;
        p.hitSide = clamp(
            ((px - ctl.position.x) * Math.cos(f)
                - (pz - ctl.position.z) * Math.sin(f)) / CRAFT_R,
            -1, 1
        );
        p.restitution = /** @type {number} */ (S.impactBounce);
        p.hitAt = hitAt;
        p.crashAt = crashAt;
        const res = speederImpactResponse(this._res, p);
        ctl.applyImpact(
            res.vx, res.vz,
            res.spin * /** @type {number} */ (S.impactSpin),
            SCRAMBLE[res.severity]
        );
        return res;
    }

    /**
     * The look and the sound of a contact, by severity. Trauma is the
     * player's alone — the camera is their body, not the wingmen's.
     *
     * A contact is not an event so much as a state: hold the stick into a
     * leg and the resolver re-contacts every second or third frame for as
     * long as you lean on it. Left alone that pays trauma several times a
     * second against a 1.15/s decay, so a *scrape* — a deflection and some
     * snow, by definition the mildest thing here — would shake the camera
     * harder than a crash and stream particles the whole time. So the
     * gentle end is rate-limited per craft and its trauma scales with the
     * closing speed that earned it; a real hit or crash always speaks,
     * because those separate the hulls and cannot repeat.
     */
    _contactFx(sev, px, py, pz, isPlayer, nx, nz, slot, closing) {
        if (sev === "scrape") {
            if (slot && slot.fxT > 0) return;
            if (slot) slot.fxT = SCRAPE_GAP;
        }
        if (isPlayer) {
            const t = sev === "scrape"
                ? TRAUMA.scrape * clamp((closing ?? 0) / S.impactHit, 0.15, 1)
                : TRAUMA[sev];
            this.rig?.addTrauma(t);
        }
        // A kick of snow and sparks off the contact, thrown along the normal.
        if (this.spray) {
            const n = sev === "crash" ? 10 : sev === "hit" ? 6 : 4;
            for (let i = 0; i < n; i++) {
                const a = Math.random() * Math.PI * 2;
                const out = 2 + Math.random() * 5;
                this.spray.emit(
                    px + (Math.random() - 0.5) * 0.6,
                    py + (Math.random() - 0.5) * 0.6,
                    pz + (Math.random() - 0.5) * 0.6,
                    nx * out + Math.cos(a) * 1.6,
                    1.5 + Math.random() * 3.5,
                    nz * out + Math.sin(a) * 1.6,
                    0.06 + Math.random() * 0.09, 0.5 + Math.random() * 0.6,
                    Math.random() < 0.5 ? 1 : 0, 1.4
                );
            }
        }
        if (sev === "hit") {
            this._bang(px, pz, 0.25, 1.1);
            if (this.smoke) {
                for (let i = 0; i < 3; i++) {
                    this.smoke.emit(
                        px, py + 0.2, pz,
                        (Math.random() - 0.5) * 4, 1 + Math.random() * 2,
                        (Math.random() - 0.5) * 4,
                        0.45, 1.2, 0.6 + Math.random() * 0.3,
                        0.09, 0.09, 0.09, 0.5, true
                    );
                }
            }
        } else if (sev === "crash") {
            this.explosions?.impact(px, py - 2.4, pz, true, true);
            this._bang(px, pz, 1.0, 1.0);
        }
    }

    /** The crash report, at the level and delay its distance earns. */
    _bang(px, pz, gain, rate) {
        if (!this.audio || !this.character) return;
        const d = Math.hypot(
            px - this.character.position.x, pz - this.character.position.z
        );
        const near = Math.max(0, 1 - d / 420);
        this.audio.play("speederCrash", {
            gain: gain * near * near * near,
            rate,
            delay: Math.min(1.6, d / 343),
        });
    }

    // ---------------------------------------------------------- trooper squash

    /**
     * Infantry under a hull: any craft low enough and close enough triggers
     * the squad's existing shellburst reaction at its own position — dives,
     * deaths, flinches, all already choreographed by `squadImpact`. Throttled
     * per craft so a hover doesn't machine-gun the squad with reactions.
     */
    _squashTroopers() {
        const troopers = this.troopers;
        if (!troopers || !this.squadImpact || !this.terrain) return;
        const n = Math.min(troopers.count, troopers.walkers.length);
        if (n <= 0) return;
        for (const s of this.slots) {
            if (!s.active || s.squashT > 0) continue;
            const gy = this.terrain.heightAt(s.cx, s.cz);
            if (s.cy >= gy + SQUASH_ALT) continue;
            for (let i = 0; i < n; i++) {
                const w = troopers.walkers[i];
                const d = Math.hypot(w.position.x - s.cx, w.position.z - s.cz);
                if (d > SQUASH_DIST) continue;
                this.squadImpact(s.cx, s.cz);
                s.squashT = SQUASH_GAP;
                break;
            }
        }
    }

    // ------------------------------------------------------------ terrain slam

    /**
     * The controller publishes one frame of {closing, nx, nz} when the hover
     * floor absorbed a hard vertical closure — flying into a rising face.
     * There is no capsule and no reflection (the floor already ate the
     * motion); what is left to do is the *consequence*: severity from the
     * closing speed, the same fx path as any contact, and a crash joins the
     * player's ladder like any other crash.
     */
    _terrainSlam() {
        const c = this.character;
        const slam = c?.terrainSlam;
        if (!slam || !this.speeder || S.speeder !== true) return;
        const sev = slam.closing > S.impactCrash ? "crash"
            : slam.closing >= S.impactHit ? "hit" : "scrape";
        const hull = this.speeder.position;
        this._contactFx(
            sev, hull.x, hull.y - 1.2, hull.z, true, slam.nx, slam.nz,
            this.slots[0], slam.closing
        );
        if (sev !== "scrape") {
            c.applyImpact(c.velocity.x, c.velocity.z, 0, SCRAMBLE[sev]);
        }
        if (sev === "crash") this._playerLadder("crash");
        c.terrainSlam = null;
    }

    // ---------------------------------------------------- player damage ladder

    /**
     * 'hit' steps the ladder inside a grace window; 'crash' trips it
     * outright. Tripping is once — while the twenty-second burn runs, further
     * crashes are already part of the fire.
     */
    _playerLadder(sev) {
        if (this._pBurnT > 0) return;
        if (sev === "crash") { this._trip(); return; }
        if (this._pGrace > 0) return;
        this._pGrace = PLAYER_GRACE;
        this._pDamage = Math.min(3, this._pDamage + 1);
        if (this._pDamage >= 3) this._trip();
    }

    /** The third rung: the burst on the hull, and the long burn home. */
    _trip() {
        const c = this.character;
        this._pDamage = 3;
        this._pBurnT = PLAYER_BURN;
        this._pGrace = PLAYER_GRACE;
        // The burst volume centres LIFT above the point it is given, so the
        // y is walked down to land it at hull height — same as `onKillHit`.
        const hull = this.speeder ? this.speeder.position : c?.position;
        if (hull) this.explosions?.impact(hull.x, hull.y - 2.4, hull.z, true, true);
        if (hull) this._bang(hull.x, hull.z, 1.0, 1.0);
        this.rig?.addTrauma(1);
        if (c) {
            c.applyImpact(
                c.velocity.x * 0.3, c.velocity.z * 0.3,
                (Math.random() < 0.5 ? -1 : 1) * 2.8
                    * /** @type {number} */ (S.impactSpin),
                2.5
            );
        }
    }

    /** Grace and burn timers, and the burning trail off the drawn hull. */
    _ladderUpkeep(h) {
        if (this._pGrace > 0) this._pGrace = Math.max(0, this._pGrace - h);
        if (this._pBurnT > 0) {
            this._pBurnT -= h;
            if (this._pBurnT <= 0) {
                // Field repair: the fire dies and the ladder starts over.
                this._pBurnT = 0;
                this._pDamage = 0;
            }
        }
        if (this._pDamage >= 1 && this.smoke && this.speeder && this.character) {
            this._pPuffT -= h;
            if (this._pPuffT <= 0) {
                this._pPuffT = 0.05;
                emitBurnTrail(
                    this.smoke, this.speeder.position, this.character.facing,
                    this.character.velocity, this._pDamage >= 2
                );
            }
        }
    }
}
