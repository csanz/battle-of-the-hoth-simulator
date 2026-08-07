/**
 * The soundscape — the one place that decides what the demo sounds like.
 *
 * The engine below it knows how to play a buffer; this knows *when*. Keeping
 * that split means no gameplay system imports the mixer: the controller does not
 * fire a carve sample, it carves, and this reads the carve. Same reasoning as
 * `SpellSystem`'s consumer list — one file answers "what does this state sound
 * like", instead of eight files each answering a bit of it.
 *
 * Three continuous voices and four triggers:
 *
 *   ambience   always up once sound is on, never above `S.ambienceVolume`
 *   music      the score, under all of it, on its own bus and its own fader
 *   slide      held for exactly as long as the slide is; rate ridden by speed
 *   turn       edge-triggered off `carve`, random of two, slide only
 *   excited    one of six, on catching air off a crest at speed
 *   spell<n>   the sound belonging to the spell that was cast, if it has one
 *   spell2Land the Ribbon's thrown water reaching the snow
 *   walkerShot a chin cannon, at the level and the delay its distance earns.
 *              Footfalls run through the same path and are silent only because
 *              the manifest has no sample for them — see the note there.
 *
 * Everything the slide owns — the loop, the turns, the air lines — is gated on
 * the slide itself, so nothing in this group can sound while the player is
 * walking.
 *
 * Allocation per frame: none.
 */

import { S } from "../core/settings.js";

/** |carve| that counts as a real edge rather than a steering correction. */
const TURN_GATE = 0.4;
/** Seconds between turn hits, on top of the manifest's own floor. */
const TURN_COOLDOWN = 0.5;
/** Below this normalised speed a turn is not loud enough to comment on. */
const TURN_SPEED = 0.3;
/** The two carve samples, picked from at random. */
const TURN_KEYS = ["turnA", "turnB"];

/**
 * Catching air.
 *
 * The controller keeps the body on the snow with a damped snap rather than a
 * ballistic arc, which means there is no `airborne` flag to read — but the snap
 * has a time constant, so when the ground drops out from under a crest the body
 * is genuinely left above the surface for a moment. That gap *is* the air: no new
 * state, and it is the same quantity the eye is judging.
 *
 * Measured over a flat-out run across the dune field, the gap sits at 14 cm for
 * the 90th percentile frame and tops out near 30 cm. The threshold sits just
 * under that 90th percentile: high enough to ignore the constant centimetre-scale
 * chatter of crossing ripples, low enough that any crest worth the name counts.
 *
 * Deliberately generous rather than tuned to only the biggest airs — at 20 cm a
 * flat-out run across the field produced two lines in forty-five seconds, which
 * reads as the feature being broken. The spacing is `EXCITED_COOLDOWN`'s job; a
 * detector that is also the rate limiter can only be wrong in both directions at
 * once.
 */
const AIR_LAG = 0.15;
/** The gap must close to this before another launch can trigger. */
const AIR_REARM = 0.07;
/** Normalised speed below which a crest is a bump, not a jump. */
const AIR_SPEED = 0.72;
/**
 * Seconds between excited lines. This, not the detector, is what decides how
 * often the character speaks — long enough that a line stays an event, short
 * enough that a good run gets answered more than once.
 */
const EXCITED_COOLDOWN = 8;
/**
 * A voice line silences the others, and ducks the score, for this long.
 *
 * With only the air lines left it can no longer be two lines talking over each
 * other — `EXCITED_COOLDOWN` is far longer than this — but it is still what the
 * music duck is keyed off, and it stays the one definition of "somebody is
 * speaking" for whatever gets added next.
 */
const VOICE_GUARD = 1.4;

/**
 * The score's entrance, seconds.
 *
 * The wind bed opens at level because a bed that swells in reads as the audio
 * arriving late. Music is the opposite case: it is a cue, not a texture, and a
 * cue that is simply *on* the instant the boot screen clears sounds like a tab
 * that was already playing. Two and a half seconds is long enough to read as an
 * entrance and short enough to be established before the player has finished
 * looking around.
 */
const MUSIC_FADE_IN = 2.5;
/**
 * How far the score steps back while a voice line is up, as a fraction.
 *
 * -5 dB, which is enough to hear a line over an orchestral swell and little
 * enough that the duck itself is not an event. Keyed off `_voiceGuard`, which is
 * already the "somebody is talking" signal — one source of truth for it, and the
 * duck cannot drift out of step with the lines it exists for.
 */
const MUSIC_DUCK = 0.56;

/**
 * How far a footfall carries, metres.
 *
 * Generous, because the thing making it is twenty-two metres tall and the field
 * is open snow with nothing in it to absorb anything. The level rolls off across
 * the whole of it rather than switching on at some radius: the point of the
 * sound is that it *arrives* — you hear the herd before you can make out which
 * way it is walking, and it grows the whole way in.
 */
const STEP_AUDIBLE = 380;
/**
 * How far a cannon carries. Further than a footfall, because it is a much louder
 * event and because hearing one fired from beyond the range you can make out the
 * machine is most of what makes the herd feel like a threat rather than scenery.
 */
const SHOT_AUDIBLE = 420;
/**
 * Metres per second. Sound is slow, and at two hundred metres the delay between
 * seeing the foot land and hearing it is a little over half a second — long
 * enough to notice, and the single cheapest cue there is that the thing you are
 * looking at is far away rather than small.
 */
const SPEED_OF_SOUND = 343;

const EXCITED_KEYS = [
    "excited1", "excited2", "excited3", "excited4", "excited5", "excited6",
];

export class Soundscape {
    /**
     * @param {import("./engine.js").AudioEngine} audio
     * @param {{
     *   controller: import("../character/controller.js").CharacterController,
     *   spells?: import("../spells/spellSystem.js").SpellSystem,
     *   walkers?: import("../walkers/walker.js").WalkerHerd,
     * }} refs
     */
    constructor(audio, refs) {
        this.audio = audio;
        this.controller = refs.controller;
        this.spells = refs.spells ?? null;
        this.walkers = refs.walkers ?? null;
        /** The AT-ST escort — same herd shape, its own counters. */
        this.atst = refs.atst ?? null;
        /** Last footfall and shot counts seen per walker, so only new ones sound. */
        this._steps = [];
        this._shots = [];
        this._atstSteps = [];
        this._atstShots = [];

        /** @type {import("./engine.js").LoopVoice|null} */
        this.ambience = null;
        /** @type {import("./engine.js").LoopVoice|null} */
        this.slideLoop = null;
        /** @type {import("./engine.js").LoopVoice|null} */
        this.music = null;
        /** @type {import("./engine.js").LoopVoice|null} */
        this.jet = null;
        this.speeder = refs.speeder ?? null;
        this._speederShots = 0;
        this._laser = 0;
        /** The entrance envelope, 0..1. See `MUSIC_FADE_IN`. */
        this._musicIn = 0;

        this.started = false;

        this._turnCooldown = 0;
        this._lastTurn = -1;
        this._castCount = this.spells ? this.spells.castCount : 0;
        this._splashCount = this.spells ? this.spells.ribbon.splashCount : 0;

        // ----------------------------------------------------------- air lines
        /** True while the current launch has already spoken; cleared on landing. */
        this._airArmed = false;
        this._excitedCooldown = 0;
        this._voiceGuard = 0;
        /** Shuffled draw order over `EXCITED_KEYS`, refilled when exhausted. */
        this._bag = EXCITED_KEYS.map((_, i) => i);
        this._bagPos = this._bag.length; // forces a shuffle on the first draw
        this._lastExcited = -1;
    }

    /**
     * Open the continuous voices. Idempotent, and called from whichever gesture
     * unlocked the engine — the boot gate or the sound button — so it must
     * tolerate being reached twice.
     */
    start() {
        if (this.started || !this.audio.unlocked) return;

        // Opened at level, not faded up. The player clicked to enter and the bed
        // should already be there when the boot screen starts to go — any fade
        // long enough to notice reads as the audio being late rather than as an
        // entrance. The only ramp is the few milliseconds of click guard on the
        // loop's first segment.
        this.ambience = this.audio.loop("ambience", { gain: 1 });
        this.ambience?.start();

        // Opened silent and brought up by the entrance envelope in `update`,
        // which also owns the voice duck — one place decides the score's level,
        // so the two cannot fight over the same gain.
        this.music = this.audio.loop("music", { gain: 0 });
        this.music?.start();
        this._musicIn = 0;

        // Opened silent and held there by `update` until an actual slide. Running
        // it continuously and riding the gain — rather than starting a source on
        // each slide — is what makes the loop seamless across a long carve: the
        // buffer never restarts, so there is no seam to hear.
        this.slideLoop = this.audio.loop("slide", { gain: 0 });
        this.slideLoop?.start();

        // The repulsorlift, open from the moment there is sound at all: a craft
        // that is hovering is making this noise whether anyone is flying it or
        // not, and fading it in on the first input would read as an engine start.
        this.jet = this.audio.loop("speederJet", { gain: 0 });
        this.jet?.start();
        if (this.speeder) this._speederShots = this.speeder.shotCount;

        // The counters may have moved during the gate; adopt them rather than
        // firing for a spell thrown before there was sound.
        if (this.spells) {
            this._castCount = this.spells.castCount;
            this._splashCount = this.spells.ribbon.splashCount;
        }
        this.started = true;
    }

    /**
     * @param {number} dt seconds
     */
    update(dt) {
        if (!this.started) return;
        const c = this.controller;

        // ------------------------------------------------------------ ambience
        // The bed breathes with speed, but only ever downward from unity: standing
        // still and doing nineteen metres a second should not sound the same, and
        // `S.ambienceVolume` stays a ceiling rather than becoming a set point.
        this.ambience?.set(0.88 + 0.12 * c.speed01, 0.5);

        // ----------------------------------------------------------- the jet
        // One loop doing two jobs. At rest it idles: slowed down, and quiet
        // enough to sit under the wind. Under power it opens up — a fifth again
        // in pitch and two and a half times the level — which is the whole of
        // the throttle, because a repulsorlift has no gears to shift and nothing
        // else about it changes.
        if (this.jet) {
            const flying = S.speeder !== false;
            const sp = flying ? Math.min(1, c.speed01) : 0;
            this.jet.set(flying ? 0.34 + 0.66 * sp : 0, 0.25);
            this.jet.setRate(0.82 + 0.36 * sp);
        }

        // --------------------------------------------------------------- slide
        // Gated on the eased slide blend *and* on actually moving: the blend hits
        // one the instant space goes down, and a stationary board makes no noise.
        // `speed01` is normalised against the slide top speed, so the walking
        // range sits near zero here and the loop stays shut through it.
        if (this.slideLoop) {
            const rolling = Math.min(1, Math.max(0, (c.speed01 - 0.12) / 0.3));
            // Silent in the speeder. The controller is permanently in its slide
            // mode there — that is what gives the craft its motion — but nothing
            // is touching the snow, so the board loop has nothing to describe.
            const amt = S.speeder !== false ? 0 : c.surf * rolling;
            this.slideLoop.set(amt * (0.4 + 0.6 * c.speed01));
            // Just under an octave across the speed range. More than this and it
            // stops reading as snow and starts reading as a tape machine.
            this.slideLoop.setRate(0.84 + 0.42 * c.speed01);
        }

        // ---------------------------------------------------------- voice keeps
        if (this._excitedCooldown > 0) this._excitedCooldown -= dt;
        if (this._voiceGuard > 0) this._voiceGuard -= dt;

        // ----------------------------------------------------------- air lines
        // Daylight between the board and the snow. See `AIR_LAG`.
        const lag = c.position.y - c.groundY;
        // Silent in the speeder. The lines are a snowboarder catching air; a
        // pilot whooping every time the craft crests a dune is a different demo.
        if (S.speeder === false && c.surf > 0.5 && c.speed01 > AIR_SPEED && lag > AIR_LAG) {
            // Edge-triggered on the launch, not held: one line per air, however
            // long the air lasts.
            if (!this._airArmed) {
                this._airArmed = true;
                if (this._excitedCooldown <= 0 && this._voiceGuard <= 0) {
                    const key = EXCITED_KEYS[this._drawExcited()];
                    if (this.audio.play(key, { rate: 0.97 + Math.random() * 0.06 })) {
                        this._excitedCooldown = EXCITED_COOLDOWN;
                        this._voiceGuard = VOICE_GUARD;
                    }
                }
            }
        } else if (lag < AIR_REARM) {
            // Back on the snow — the next crest is a new launch.
            this._airArmed = false;
        }

        // --------------------------------------------------------------- music
        // Entrance envelope times the duck, and nothing else — the score does not
        // follow speed. The bed is the thing that breathes with the run; music
        // that did the same would read as a volume fault rather than as scoring.
        //
        // After the voice triggers on purpose, so a line that starts this frame
        // has already taken the guard and the score is already stepping back by
        // the time the line's first syllable is out.
        if (this.music) {
            this._musicIn = Math.min(1, this._musicIn + dt / MUSIC_FADE_IN);
            this.music.set(this._musicIn * (this._voiceGuard > 0 ? MUSIC_DUCK : 1), 0.3);
        }

        // ---------------------------------------------------------------- turn
        // `carve` is the controller's own eased lateral load, which is the same
        // signal the wake is shaped from — so the sound lands on the frames the
        // snow wall actually goes up. Slide only: a turn while walking is a turn,
        // not a carve.
        if (this._turnCooldown > 0) this._turnCooldown -= dt;
        const carve = Math.abs(c.carve);
        if (
            c.surf > 0.5 &&
            carve > TURN_GATE &&
            c.speed01 > TURN_SPEED &&
            this._turnCooldown <= 0
        ) {
            // Random of the two, but never the same one twice running — pure
            // random repeats often enough to sound like a stuck sample.
            let pick = (Math.random() * TURN_KEYS.length) | 0;
            if (pick === this._lastTurn) pick = (pick + 1) % TURN_KEYS.length;
            this._lastTurn = pick;
            this.audio.play(TURN_KEYS[pick], {
                gain: 0.45 + 0.55 * Math.min(1, carve),
                rate: 0.94 + 0.14 * c.speed01,
            });
            this._turnCooldown = TURN_COOLDOWN;
        }

        // --------------------------------------------------------------- casts
        // A counter rather than a callback: the spell system owns dispatch, and
        // polling it here keeps the audio a reader of game state everywhere. The
        // count is the edge; `lastCast` says which spell to reach for. A spell
        // with no manifest entry plays nothing — `play` no-ops on a key it does
        // not have, so this needs no table of which sounds exist.
        if (this.spells && this.spells.castCount !== this._castCount) {
            this._castCount = this.spells.castCount;
            if (S.showSpells !== false) {
                // A little detune per cast so a spell held down is not a metronome.
                this.audio.play("spell" + this.spells.lastCast, {
                    rate: 0.93 + Math.random() * 0.14,
                });
            }
        }

        // The Ribbon's thrown body hitting the snow — its own event, arriving
        // whenever the water gets there rather than on any input.
        if (this.spells && this.spells.ribbon.splashCount !== this._splashCount) {
            this._splashCount = this.spells.ribbon.splashCount;
            this.audio.play("spell2Land", { rate: 0.95 + Math.random() * 0.1 });
        }

        // ---------------------------------------------------------- the guns
        if (this.speeder && this.speeder.shotCount !== this._speederShots) {
            this._speederShots = this.speeder.shotCount;
            // A fixed cycle rather than random — random doubles a sample often
            // enough to read as a stutter at this rate of fire. Weighted three
            // to one toward the first laser: that recording is the cannon's
            // voice, and the second is the variation that stops a held trigger
            // sounding like a loop.
            this._laser = (this._laser + 1) % 4;
            this.audio.play(this._laser === 3 ? "speederLaser2" : "speederLaser1", {
                rate: 0.96 + Math.random() * 0.08,
            });
        }

        // ------------------------------------------------------------ walkers
        this._herdSteps(this.walkers, this._steps, this._shots,
            S.showWalker !== false, 1, 1, "walkerShot");
        // The scouts: lighter and quicker steps, and their own cannon sample —
        // an 8.6 m machine through the pitch and level a 22 m one was tuned at
        // reads as a herd of one size, and these are not that. The shot rides
        // the same distance falloff and speed-of-sound delay as everything
        // else, so a far scout's gun is a distant crack and a near one snaps.
        this._herdSteps(this.atst, this._atstSteps, this._atstShots,
            S.showAtst !== false, 0.5, 1.3, "atstShot");
    }

    /**
     * A foot landing, per walker, at the level and the delay its distance earns.
     *
     * Polled off a counter the herd increments when the cycle crosses a footfall
     * phase — the same shape as the spell system's cast count, and for the same
     * reason: the walkers do not know sound exists.
     *
     * Two numbers do all the work. The level rolls off over the whole audible
     * range as a squared falloff, which is what "it comes up as it gets closer"
     * actually is; and the playback is *delayed* by the distance over the speed
     * of sound, so the thud of a foot two hundred metres away arrives six tenths
     * of a second after you watch it land. That second one is nearly free — the
     * engine's `play` already takes a delay — and it is the cue that sells the
     * scale of the thing better than the level ever does.
     *
     * Generalised over the herd: the AT-ATs and the AT-ST escort run the same
     * counters with their own memory arrays, and the multipliers are what make
     * a scout's footfall lighter and faster-pitched than a walker's.
     *
     * @param {import("../walkers/walker.js").WalkerHerd|null} herd
     * @param {(number|undefined)[]} steps per-walker footfall counts last seen
     * @param {(number|undefined)[]} shots per-walker shot counts last seen
     * @param {boolean} on the herd's own visibility toggle
     * @param {number} gainMul level multiplier on both samples
     * @param {number} rateMul pitch multiplier on both samples
     * @param {string} shotKey manifest key for this herd's cannon
     */
    _herdSteps(herd, steps, shots, on, gainMul, rateMul, shotKey) {
        if (!herd || !on) return;

        const me = this.controller.position;
        for (let i = 0; i < herd.count; i++) {
            const w = herd.walkers[i];
            const seen = steps[i];
            // First sight of this walker: adopt its count rather than firing a
            // step for every one it has taken since it was built. Written back
            // before the early-out, or the adoption never sticks and the counter
            // is permanently "unchanged".
            if (seen === undefined) {
                steps[i] = w.stepCount;
                continue;
            }
            if (w.stepCount === seen) continue;
            steps[i] = w.stepCount;

            const d = Math.hypot(w.position.x - me.x, w.position.z - me.z);
            if (d > STEP_AUDIBLE) continue;

            const near = 1 - d / STEP_AUDIBLE;
            // A little detune per step, weighted by which foot it was, so a
            // four-legged gait does not tick like a metronome.
            const rate = (0.93 + (i % 2) * 0.05 + Math.random() * 0.09) * rateMul;
            this.audio.play("walkerStep", {
                gain: near * near * gainMul,
                rate,
                delay: Math.min(1.6, d / SPEED_OF_SOUND),
            });
        }

        // ---- the guns ------------------------------------------------------
        for (let i = 0; i < herd.count; i++) {
            const w = herd.walkers[i];
            const seen = shots[i];
            if (seen === undefined) { shots[i] = w.shotCount; continue; }
            if (w.shotCount === seen) continue;
            shots[i] = w.shotCount;

            const d = Math.hypot(w.position.x - me.x, w.position.z - me.z);
            if (d > SHOT_AUDIBLE) continue;
            const near = 1 - d / SHOT_AUDIBLE;
            // No `gainMul`/`rateMul` here: those exist to make the *shared*
            // step sample read as a smaller machine, and each herd's cannon is
            // its own recording with its own manifest level. Distance is the
            // only thing that scales a shot — all the way to zero, and
            // *cubed*. Squared was not enough: a machine only fires once the
            // player is inside its ~340 m gun range, so every shot the player
            // ever hears lives in the top of the curve, and a shallow top is
            // exactly "loud at every distance". The cube keeps a near shot a
            // crack and makes two hundred metres genuinely far.
            this.audio.play(shotKey, {
                gain: near * near * near,
                rate: 0.94 + Math.random() * 0.1,
                delay: Math.min(1.6, d / SPEED_OF_SOUND),
            });
        }
        // Adopt the counts of any walker that appeared since the last frame, so
        // a herd grown by the slider does not fire a burst of backdated steps.
        for (let i = herd.count; i < steps.length; i++) {
            steps[i] = undefined;
            shots[i] = undefined;
        }
    }

    /**
     * Draw the next excited line: a shuffled bag rather than a raw random pick.
     *
     * Six independent random draws repeat a line about one time in six, and a
     * voice line you have just heard coming straight back is the thing that makes
     * a small set sound smaller than it is. A bag gives random order *and*
     * guarantees all six are used before any repeats — and the refill checks its
     * own first entry against the last line played, so the seam between two bags
     * cannot repeat either.
     *
     * @returns {number} index into `EXCITED_KEYS`
     */
    _drawExcited() {
        const bag = this._bag;
        if (this._bagPos >= bag.length) {
            for (let i = bag.length - 1; i > 0; i--) {
                const j = (Math.random() * (i + 1)) | 0;
                const t = bag[i];
                bag[i] = bag[j];
                bag[j] = t;
            }
            if (bag.length > 1 && bag[0] === this._lastExcited) {
                const t = bag[0];
                bag[0] = bag[1];
                bag[1] = t;
            }
            this._bagPos = 0;
        }
        this._lastExcited = bag[this._bagPos++];
        return this._lastExcited;
    }

    /** Close the continuous voices. Not used by the demo; here for the console. */
    stop() {
        this.ambience?.stop(0.8);
        this.music?.stop(1.2);
        this.jet?.stop(0.4);
        this.slideLoop?.stop(0.2);
        this.ambience = null;
        this.music = null;
        this.slideLoop = null;
        this.started = false;
    }
}
