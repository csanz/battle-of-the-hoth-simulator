/**
 * Where the character meets the snow.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Three writers:
 *
 *   footfall   one splat per plant, frame-accurate with the gait event. A boot
 *              is longer than it is wide and oriented with the body, so the
 *              brush is elongated and yawed rather than round.
 *   body drag  a shallow continuous scuff under a walking character, so the
 *              trail is a trail and not a row of disconnected prints.
 *   surf wake  a deep continuous groove with berms thrown to the outside of the
 *              turn. This is the centrepiece's mark on the world.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

import { S } from "../core/settings.js";

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius, so the print is
 * 20 cm across and 34 cm long — a boot plus the collapse of the snow around it,
 * which is what a print in deep snow actually measures. Narrower than this and
 * the print is only six texels wide and the rim detail has nowhere to live.
 */
const BOOT_WIDTH = 0.10;
const BOOT_ELONG = 1.7;

/** Surf groove geometry, metres. */
const SURF_WIDTH = 0.30;
const SURF_ELONG = 2.6;

export class SnowContact {
    /**
     * @param {import("./controller.js").CharacterController} character
     * @param {import("../terrain/deformation.js").DeformationField} field
     * @param {import("./figure.js").Figure} [figure] posed skeleton, if built
     * @param {import("../vfx/particles.js").SprayField} [spray]
     */
    constructor(character, field, figure, spray) {
        this.character = character;
        this.field = field || null;
        this.spray = spray || null;
        /**
         * The posed figure, when there is one.
         *
         * The controller also produces footfall events, and they are close
         * enough to be tempting. But "close enough" is exactly what a footprint
         * cannot be: the print has to be under the boot, and only the figure
         * knows where the boot actually planted, because it is the thing that
         * decided. Taking the event from the same state machine that freezes the
         * stance foot makes the two agree by construction rather than by
         * matching two sets of constants.
         */
        this.figure = figure || null;

        /** Distance travelled since the last continuous splat, metres. */
        this._sinceSplat = 0;
        this._prevX = character.position.x;
        this._prevZ = character.position.z;
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.character;
        const f = this.field;

        const dx = ch.position.x - this._prevX;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = ch.position.x;
        this._prevZ = ch.position.z;

        // Stub tolerance: without a deformation field there is nothing to mark.
        if (!f) return;

        if (ch.surf > 0.02) this._surf(dt, moved);
        if (ch.surf < 0.98) this._walk(dt, moved);

        // Footfalls fire regardless of mode; the gait suppresses them while
        // surfing because the feet are on the board.
        const fig = this.figure;
        for (let i = 0; i < 2; i++) {
            let px, pz;
            if (fig) {
                if (!fig.touchdown[i] || !ch.stepping) continue;
                px = fig.plant[i * 3];
                pz = fig.plant[i * 3 + 2];
            } else {
                if (!ch.footfall || i !== ch.footIndex) continue;
                px = ch.footPos.x;
                pz = ch.footPos.z;
            }

            // Recomputed here rather than read off the controller, so it cannot
            // be a frame stale relative to the plant it is describing.
            const impact = Math.min(1.3, 0.35 + ch.speed / 5.4);
            f.brush(
                px, pz,
                BOOT_WIDTH,
                // Depth: a boot sinks 13-27 cm into unpacked snow depending on
                // how hard it lands. Deeper than that and the character is
                // wading, which is a different animation problem.
                0.17 + 0.14 * impact,
                // The berm is the whole point. Mass pushed out of the hole has
                // to go somewhere, and seeing it pile at the rim is what makes
                // the print read as displaced snow rather than as a dark decal.
                0.10 + 0.08 * impact,
                0.9,                    // compression: trodden snow is dense
                0,                      // no ice
                ch.facing,
                BOOT_ELONG,
                1.0                     // full rim roughness — boots tear edges
            );

            const py = fig ? fig.plant[i * 3 + 1] : ch.position.y;
            this._kick(px, py, pz, impact);
        }
    }

    /**
     * Snow thrown by a boot landing.
     *
     * Fired from the same branch that stamps the print, so the grains leave the
     * ground on the exact frame the foot arrives — one event, rather than two
     * systems agreeing about when it happened.
     *
     * The kick goes up and *backward* relative to travel. A boot in deep snow
     * scoops: it enters forward, compresses, and throws the displaced snow out
     * behind the heel as the weight rolls over it.
     */
    _kick(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        if (ch.speed < 0.4) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        // Many small grains rather than a few large ones. The size at which a
        // puff stops reading as powder and starts reading as a cotton ball is
        // somewhere around five centimetres, and it is a hard threshold.
        const n = 6 + ((impact * 14) | 0);

        for (let k = 0; k < n; k++) {
            const spread = 0.9;
            const rx = (Math.random() - 0.5) * spread;
            const rz = (Math.random() - 0.5) * spread;
            const up = 0.9 + Math.random() * 1.9;
            const back = 0.5 + Math.random() * 1.6 * impact;
            // A fifth of it is heavier stuff that flies further and falls faster.
            const clod = Math.random() < 0.22 ? 1 : 0;

            sp.emit(
                x + rx * 0.09, y + 0.03 + Math.random() * 0.05, z + rz * 0.09,
                -fx * back + rx * 1.3 + ch.velocity.x * 0.25,
                up * (clod ? 1.25 : 1.0),
                -fz * back + rz * 1.3 + ch.velocity.z * 0.25,
                clod ? 0.014 + Math.random() * 0.012 : 0.020 + Math.random() * 0.030,
                clod ? 0.55 + Math.random() * 0.35 : 0.55 + Math.random() * 0.60,
                clod
            );
        }
    }

    /**
     * Walking scuff. Very shallow, and only while actually moving — a standing
     * character should not slowly bore a hole.
     */
    _walk(dt, moved) {
        const ch = this.character;
        if (ch.speed < 0.25) return;

        const w = 1 - ch.surf;
        // Scaled by distance travelled, not by dt, so the groove has the same
        // depth per metre at any speed or frame rate. A given patch of ground
        // sits under the brush for (2 * radius / moved) frames, so the depth it
        // ends up at is roughly rate * 2 * radius * profile — independent of
        // both speed and frame rate, which is the point.
        const k = Math.min(moved, 0.35);
        // Compression stays deliberately below saturation here. If the scuff
        // packed the whole path to 1.0, the boot prints stamped on top would
        // have nothing left to darken and the trail would read as one flat
        // ribbon instead of as a line of prints in a churned path.
        // Shallower and narrower than the boot prints it links, on purpose. It
        // was originally deep enough to dominate them, which turned a line of
        // footprints into one continuous ski track — fine while the feet were
        // hidden under a floor-length robe, wrong now that they are not.
        this.field.brush(
            ch.position.x, ch.position.z,
            0.22,
            0.20 * k * w,
            0.22 * k * w,
            0.8 * k * w,
            0,
            ch.facing,
            1.5,
            0.85
        );
    }

    /**
     * The surf wake.
     *
     * Three brushes: the groove the board cuts, and one berm on each side
     * weighted by the carve, so the outside of a turn throws a much heavier wall
     * of snow than the inside. That asymmetry is what makes a carve read as a
     * carve rather than as a straight furrow.
     */
    _surf(dt, moved) {
        const ch = this.character;
        const f = this.field;
        const s = ch.surf;

        // Below a walking pace there is no wake to speak of; splatting anyway
        // would just dig a pit wherever the player coasted to a stop.
        const speedK = Math.min(1, ch.speed / 6);
        if (speedK < 0.05) return;

        // A climbing craft pulls its downwash off the field: the trench and the
        // thrown berms fade quadratically with the climb, and are gone well
        // before the ceiling — snow that high is not being touched.
        const near = 1 - Math.min(1, Math.max(0, ch.lift01 || 0));
        const k = Math.min(moved, 0.6) * s * speedK * near * near;
        if (k <= 0.001) return;

        // Past the point where the trench stops deepening, extra speed still
        // means extra snow moved — it goes into width and into the walls, which
        // is what makes a fast run's scar read as bigger rather than just longer.
        const fast = Math.min(1, Math.max(0, ch.speed - 6) / 12);

        const yaw = ch.facing;
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);

        // --- the groove ------------------------------------------------------
        // The board rides the inside edge in a turn, so the trench offsets
        // slightly toward the lean.
        const lean = ch.carve;
        const gx = ch.position.x + rx * lean * 0.12;
        const gz = ch.position.z + rz * lean * 0.12;

        f.brush(
            gx, gz,
            SURF_WIDTH * S.surfWidth * (1 + 0.35 * fast),
            1.20 * k,   // deep — a run should be visible from across the field
            0.30 * k,
            4.0 * k,    // the board packs the trench floor hard
            0,
            yaw,
            SURF_ELONG,
            0.55        // the board's edge is cleaner than a boot's
        );

        // --- thrown mass -----------------------------------------------------
        // The outside of the turn takes most of it, and the outside of a *right*
        // turn is the left-hand side — the board resists the turn and throws snow
        // away from its centre, the same way a carving snowboard's spray arcs out
        // of the turn rather than into it. `carve` is positive turning right, so
        // the weights run against it.
        //
        // The wake mesh in `src/vfx/surfWake.js` resolves its sides from the same
        // sign, so the airborne wave and the mark it leaves agree.
        const outside = Math.min(1, Math.abs(lean));
        const sideL = 0.5 + lean * 0.5; // weight on the left berm
        const sideR = 0.5 - lean * 0.5;

        const off = SURF_WIDTH * (1.5 + 0.5 * fast);
        const throwK = 0.75 * k * (0.55 + 0.9 * outside) * (1 + 0.5 * fast);

        f.brush(
            ch.position.x - rx * off, ch.position.z - rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideL * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
        f.brush(
            ch.position.x + rx * off, ch.position.z + rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideR * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
    }
}
