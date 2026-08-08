/**
 * Every sound the demo owns, in one table.
 *
 * This is the loader's work list *and* the mixer's per-asset defaults: the boot
 * sequence fetches and decodes exactly these entries before the gate opens, so
 * nothing in the demo ever hits the network again once it is running. A sound
 * that is not here does not exist.
 *
 * Fields:
 *   url       store-relative path, resolved through `core/assets.js` — the
 *             layout under the asset base mirrors `public/audio/` exactly
 *   bus       "ambience" | "music" | "sfx" | "voice", each with its own fader
 *   gain      unity gain for this asset, so call sites pass 0..1 intent rather
 *             than per-file trim
 *   rate      base playback rate, same reasoning
 *   loop      declared here rather than at the call site; see `AudioEngine.loop`
 *   trim      seconds shaved off both ends. MP3 decoding leaves encoder padding
 *             at the head and tail, and a native loop over the raw buffer plays
 *             that padding as a click every cycle
 *   crossfade seconds of overlap for a looped asset. Non-zero switches the loop
 *             to the overlap scheduler, which does not need the file's ends to
 *             match — see `LoopVoice`
 *   needs     a settings key this asset belongs to. Falsy at load and the entry
 *             is skipped entirely — not fetched, not decoded, not counted. For
 *             sounds that belong to a feature which may not be built at all
 *   minGap    minimum seconds between two starts of this one-shot. The carve
 *             sounds are driven by a continuous signal, and without a floor a
 *             held edge machine-guns them
 *   exclusive one voice at a time: starting this again releases the copy already
 *             playing instead of layering onto it. For sounds that belong to a
 *             thing which can restart — a re-cast spell — rather than to an event
 */

/**
 * @typedef {{
 *   url: string,
 *   bus?: "ambience"|"music"|"sfx"|"voice",
 *   gain?: number,
 *   rate?: number,
 *   needs?: string,
 *   loop?: boolean,
 *   trim?: number,
 *   crossfade?: number,
 *   minGap?: number,
 *   exclusive?: boolean|string,
 * }} AudioAsset
 */

/** @type {Record<string, AudioAsset>} */
export const AUDIO_MANIFEST = {
    // The wind bed. Seventeen seconds of it, overlapped by two and a half, so
    // the bed never lands on a seam the ear can time.
    //
    // Unity here, deliberately. How loud the bed actually sits is one number,
    // `S.ambienceVolume`, and it lives in the settings so the overlay's Ambience
    // fader is the real control rather than a trim on top of a hidden one. A trim
    // here as well would mean two places to look and a slider whose number means
    // nothing on its own.
    //
    // The soundscape still rides this voice with speed, but only ever *downward*
    // from unity — so `S.ambienceVolume` is a ceiling the bed never exceeds.
    ambience: {
        url: "audio/ambiance.mp3",
        bus: "ambience",
        loop: true,
        gain: 1.0,
        trim: 0.2,
        crossfade: 2.5,
    },

    // The score, under everything, on its own bus and its own fader.
    //
    // The gain is not a taste value — it is a measured loudness match to the wind
    // bed, which is what "at the same level as the ambience" has to mean if it is
    // to mean anything. EBU R 128 integrated loudness: the bed sits at
    // -16.8 LUFS and this file at -19.5, so the file comes up 2.7 dB, and the
    // soundscape then holds the bed at 0.88 of unity while the player is standing
    // still — so the match is 10^(2.7/20) * 0.88 = 1.20 rather than 1.36.
    //
    // Matched at rest on purpose. That is the state the player is in for the first
    // few seconds after the gate, which is when the two get compared; once they
    // are moving the bed rises to unity and ends up a decibel over the music,
    // which is the wind coming up rather than the music going quiet.
    //
    // With both files levelled to each other, `S.musicVolume` can default to
    // exactly `S.ambienceVolume` and equal fader positions mean equal loudness.
    //
    // Headroom is not a concern despite the boost: the file's true peak is
    // -1.7 dBFS, so the source node reaches +1.0, and nothing downstream of it
    // runs at unity — the music bus sits at 0.34 and the master at 0.8, which
    // lands the peak near -8 dBFS well before the limiter has an opinion.
    //
    // Overlapped rather than natively looped, and by four seconds rather than the
    // bed's two and a half. The track ends loud and begins quiet, so the join is
    // a real musical event rather than a seam in a texture, and it needs the long
    // window to pass as a decay.
    music: {
        url: "audio/imperial.mp3",
        bus: "music",
        loop: true,
        gain: 1.20,
        trim: 0.08,
        crossfade: 4.0,
    },

    // The board on snow, held for as long as the slide is. Natively looped
    // rather than overlapped: its rate is modulated by speed every frame, which
    // an overlap schedule cannot follow.
    slide: {
        url: "audio/slide-continue.mp3",
        bus: "sfx",
        loop: true,
        gain: 0.85,
        trim: 0.04,
    },

    // Two carve samples, picked at random per turn with no immediate repeat.
    turnA: { url: "audio/slide-turn-1.mp3", bus: "sfx", gain: 0.7, minGap: 0.42 },
    turnB: { url: "audio/slide-turn-2.mp3", bus: "sfx", gain: 0.7, minGap: 0.42 },

    // The opening line: Luke, once, as the boot screen fades. Fired from main
    // right after the unlock gesture, so it is the first thing heard.
    lukeIntro: { url: "audio/luke-voice-1.mp3", bus: "voice", gain: 1.0 },

    // Catching air off a crest at speed. Six takes, drawn from a shuffled bag so
    // the order is random but no line comes back before the other five have had a
    // turn. Each carries its own long floor as a backstop under the soundscape's
    // cooldown — a voice line repeating inside a few seconds is the fastest way to
    // make a character sound like a soundboard.
    excited1: { url: "audio/excited-1.mp3", bus: "voice", gain: 0.95, minGap: 20 },
    excited2: { url: "audio/excited-2.mp3", bus: "voice", gain: 0.95, minGap: 20 },
    excited3: { url: "audio/excited-3.mp3", bus: "voice", gain: 0.95, minGap: 20 },
    excited4: { url: "audio/excited-4.mp3", bus: "voice", gain: 0.95, minGap: 20 },
    excited5: { url: "audio/excited-5.mp3", bus: "voice", gain: 0.95, minGap: 20 },
    excited6: { url: "audio/excited-6.mp3", bus: "voice", gain: 0.95, minGap: 20 },

    // One entry per spell, keyed `spell<n>` so the soundscape can look a cast up
    // by the number the player pressed. A spell with no entry is simply silent —
    // `play` no-ops on a key it does not hold — so this table is the whole of
    // which spells have a voice.
    //
    // All of them are `exclusive`, which is load-bearing rather than tidy: nothing
    // rate-limits how fast a spell can be re-cast — the spell itself just restarts
    // — so the sound has to restart with it. `effect1` runs five seconds against a
    // 2.4-second sweep, and without this a player leaning on the key stacks voices
    // faster than they expire.
    spell1: { url: "audio/effect1.mp3", bus: "sfx", gain: 0.55, minGap: 0.1, exclusive: true },
    spell2: { url: "audio/effect2.mp3", bus: "sfx", gain: 0.55, minGap: 0.1, exclusive: true },
    spell3: { url: "audio/effect3.mp3", bus: "sfx", gain: 0.55, minGap: 0.1, exclusive: true },
    spell4: { url: "audio/effect4.mp3", bus: "sfx", gain: 0.55, minGap: 0.1, exclusive: true },
    spell5: { url: "audio/effect5.mp3", bus: "sfx", gain: 0.55, minGap: 0.1, exclusive: true },

    // A walker's chin cannon.
    //
    // No `exclusive`: two machines firing a second apart are two events, and a
    // near shot cutting a far one short is exactly what would give the distance
    // away as fake. The floor is short because the guns are paired and the second
    // barrel follows the first by a tenth of a second.
    //
    // Hot on its own — the file measures -11 LUFS against the spells' -20s — so
    // the trim here is doing real work rather than expressing a preference.
    //
    // There is no footfall entry. The gait *is* detected (see `deriveFootfalls`
    // in `walkers/walker.js`) and the soundscape already asks for `walkerStep` on
    // every one, so dropping a sample in here and naming it is the whole of
    // turning footsteps on. It is deliberately not a synthesised stand-in: a
    // twenty-two metre machine's footfall is a recording or it is a thud.
    walkerShot: {
        url: "audio/at-walker-canon.mp3",
        bus: "sfx",
        gain: 0.36,
        minGap: 0.05,
    },

    // The AT-ST's chin gun — the escort's own voice, snappier and lighter than
    // the walker cannon above. Same no-`exclusive` reasoning: two scouts firing
    // are two events, and the soundscape scales the level with distance.
    atstShot: {
        url: "audio/at-st-cannon.mp3",
        bus: "sfx",
        gain: 0.32,
        minGap: 0.05,
    },

    // The speeder's cannons, alternating. Two samples rather than one detuned,
    // because the pair are audibly different weapons firing and a single sample
    // pitched about is the fastest way to make a rate-of-fire sound like a loop.
    speederLaser1: {
        url: "audio/airspeeder-laser-1.mp3", bus: "sfx", gain: 0.42, minGap: 0.04,
        needs: "speeder",
    },
    speederLaser2: {
        url: "audio/airspeeder-laser-2.mp3", bus: "sfx", gain: 0.42, minGap: 0.04,
        needs: "speeder",
    },

    // The repulsorlift. One loop, held for as long as the craft exists, with its
    // rate and its level ridden by speed — idling low and slow, opening up under
    // power. Natively looped rather than overlapped for exactly the reason the
    // board is: an overlap schedule is laid out in real seconds and cannot follow
    // a playback rate that changes every frame.
    // A craft hitting something — a wingman going in, or the collision
    // pass's own hits and crashes, player included. Fired at the level and
    // delay its distance earns, same physics as the cannon. Gated on the
    // speeder rather than the wingmen now that the player's craft can crash.
    speederCrash: {
        url: "audio/speeder-explosion.mp3",
        bus: "sfx",
        gain: 0.9,
        minGap: 0.5,
        needs: "speeder",
    },

    speederJet: {
        url: "audio/delta-jet.mp3",
        needs: "speeder",
        bus: "sfx",
        loop: true,
        gain: 0.62,
        trim: 0.06,
    },

    // The Ribbon landing. Spell 2 is the only one with two sounds, because it is
    // the only one that is two events: `spell2` is the water leaving the hand on
    // the press, this is the thrown body hitting the snow some time later — and
    // how much later is up to the player, since the ribbon is a held cast.
    //
    // Not exclusive: one impact is one event, and there is only ever one ribbon.
    spell2Land: { url: "audio/effect2-landing.mp3", bus: "sfx", gain: 0.7, minGap: 0.12 },
};
