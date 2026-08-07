/**
 * Central tuning + toggle store.
 *
 * `S` is a flat plain object read directly by systems every frame — no getters,
 * no proxies, no allocation. `SCHEMA` is metadata the settings overlay builds
 * its widgets from, and `onChange` lets systems react to edits that need work
 * (rebuilding a render target, re-freezing a material) rather than just being
 * sampled next frame.
 */

/** @type {Record<string, number|boolean|string>} */
export const S = {
    // ---------------------------------------------------------------- quality
    preset: "ultra",
    resolutionScale: 1.0,

    // ------------------------------------------------------------------- sun
    sunAzimuth: 118, // degrees, compass bearing of the sun
    // Low enough for long raking shadows, high enough that the beam still
    // carries real energy — below ~10 degrees the air mass eats so much of it
    // that the scene goes flat and sky-lit.
    sunElevation: 13.0,
    sunIntensity: 4.2,
    sunTempWarm: 1.0, // 0 = neutral white, 1 = full warm low-sun tint
    ambientIntensity: 1.0,
    ambientBlue: 1.0, // strength of the cool shadow shift

    // ------------------------------------------------------------- atmosphere
    fogDensity: 0.0072,
    fogHeightFalloff: 0.045,
    fogStart: 24,
    aerialStrength: 1.0,
    // Degrees. Drives sastrugi shear and dune orientation. Held 70-80 degrees
    // away from `sunAzimuth`: sastrugi ridges run along the wind, so when the
    // two align the sun rakes down every ridge, lights both flanks identically
    // and the fine structure reads as flat ground.
    windDirection: 42,
    windStrength: 1.0,
    /** Far-field mountain range on the skybox. */
    showMountains: true,
    /** Peak height of that range, metres. */
    mountainHeight: 2150,
    /** Strength of the volumetric shafts spilling past dune crests. */
    shaftStrength: 0.30,

    // ------------------------------------------------------------------- snow
    glintIntensity: 0.55,
    glintGrazing: 0.72, // how hard the grazing-angle gate bites
    sssStrength: 1.0,
    sssRadius: 1.0,
    detailNormalStrength: 1.0,
    macroHeightScale: 1.0,
    sastrugiStrength: 1.0,

    // ----------------------------------------------------------- deformation
    deformDepth: 1.0,
    deformBerm: 1.0,
    refillRate: 1.0,
    deformResolution: 2048,

    // ------------------------------------------------------------- snow-surf
    /** Height of the breaking wall thrown by a carve, as a multiple of 1.45 m. */
    wakeHeight: 1.0,
    /** Density of the plume shed off the wake's lip. */
    wakeSpray: 1.0,
    /** Screen-space speed streaks while surfing. */
    windStreaks: true,
    streakStrength: 1.0,

    // --------------------------------------------------------------- speeder
    /**
     * Fly rather than walk.
     *
     * On, the figure is hidden and an airspeeder hovers in its place: WASD flies,
     * space fires. The character controller underneath is unchanged — it still
     * owns the position, the facing and the physics, and the craft is a different
     * way of *drawing* the same player rather than a second one.
     *
     * On now, and the herd is the reason it is worth it: a T-47 at ten metres
     * flying at four AT-ATs on the horizon is the shot this demo has been
     * walking toward, and neither half reads as well alone.
     *
     * It was held off for a long time and the objection has only half gone. The
     * exhaust still does not refract, and the trench under the craft is still
     * the snowboard's contact brush widened by `surfWidth` rather than anything
     * that knows how wide a hull is. What has changed is that the craft no
     * longer renders as a black cut-out — its albedo array was being sampled
     * from a mip chain that came back empty, which is also why `speeder.js`
     * builds that one texture without mips.
     *
     * Flying puts the whole snowboarding half away: the figure is hidden, and
     * the spells and the surf wake go with it, because one is cast by a body
     * that is not there and the other is thrown by a board. Read once at boot —
     * off, nothing is built at all, which is why this is a reload and not a
     * toggle.
     */
    speeder: true,
    /**
     * Open the settings overlay as soon as the scene is up.
     *
     * For pages whose whole purpose is tuning. The toggle is F1 or backtick, and
     * F1 is a screen-brightness key on a Mac unless the function-key preference
     * is flipped — which is a poor thing for a panel's discoverability to rest
     * on when the page cannot be used without it.
     */
    overlayOpen: false,

    /**
     * How much of the field's bounce the craft is allowed to see, as a multiple
     * of the scene ambient.
     *
     * A number rather than a constant because the craft needs far more of it
     * than anything standing on the ground does, and because the right value is
     * a thing to be looked at rather than derived. Two reasons it is owed some:
     * it hovers *above* an 85%-albedo field and is surrounded by it, where the
     * walker stands on one and sees a half-space; and it is the only opaque
     * object in the scene close enough to the camera to fall inside `fogStart`,
     * so it receives none of the aerial inscatter that is quietly carrying
     * everything else.
     *
     * It matters more than it would on a smooth hull. The model is 1814
     * triangles and hard-edged, so every facet takes a single flat lighting
     * value; with the ambient too low the ones turned away from a 13-degree sun
     * have nothing left to sit on and the craft reads as a black cut-out with a
     * few sunlit panels, rather than as a light grey aircraft.
     */
    speederAmbient: 0.0,
    /**
     * Albedo multiplier on the craft's maps.
     *
     * The maps are the game rip's own and three of the five are genuinely very
     * dark — the cannons, the canopy and the dispersion vanes sit at a tenth of
     * the hull's value. This lifts them toward the light grey a T-47 is meant to
     * be. A tint rather than a repaint, and honestly a tint: the alternative is
     * editing someone else's textures.
     */
    speederTint: 0.9,
    /**
     * Roughness of the craft's hull, overriding the source material's own.
     *
     * The glTF declares 0.5 on all five materials and carries no roughness map,
     * so 0.5 is what every panel gets. That is close to a lacquered finish, and
     * on a hull this dark it reads as black glass: the diffuse term has almost
     * nothing to return, so what the eye picks up is a broad specular sheen of
     * reflected sky, which at dawn is warm and lands as tan panels that look
     * painted on. A snowspeeder is matte military paint. The walker's own maps
     * sit at 0.9 for the same reason.
     *
     * Worth knowing when tuning this against `speederAmbient`: ambient scales
     * the sky *reflection* as well as the diffuse fill, so raising ambient on a
     * glossy hull makes it glassier rather than brighter. Take the sheen off
     * here first, then light it.
     */
    speederRough: 0.86,
    /**
     * Flat sun-coloured fill on the craft, as a fraction of the sun's radiance.
     *
     * This is the one that actually lifts it off black, and the reason the other
     * two could not. `speederAmbient` scales a dawn sky that is genuinely dim,
     * and `speederTint` scales an albedo that is then multiplied by a cosine
     * which, at a thirteen-degree sun, is near zero over most of the hull. Both
     * were scaling something small. This adds a term that does not care which
     * way a facet points.
     *
     * Roughly calibrated rather than picked: sunlit snow sits near 12 in linear
     * (see `exposure`), and at 1.0 the hull's fill lands around 4.5 — a mid grey
     * aircraft against a white field, which is what a T-47 is.
     */
    speederFill: 0.08,
    /**
     * How far to pull the sun's colour cast off the craft, 0 none, 1 fully white.
     *
     * The scene's sun is a thirteen-degree one and genuinely orange, which is
     * right for the snow and wrong for this: a T-47's maps are painted grey with
     * red flashes, and under that beam the grey comes back cream. This balances
     * only the beam that lights the craft — not the sky ambient, which stays cool
     * on purpose, and not the aerial haze, which belongs to the scene.
     *
     * Affects colour, not quantity: the beam is mixed toward its own luminance,
     * so nothing gets brighter or darker.
     */
    speederDesat: 0.67,

    /** Exhaust nozzle nudges, metres, on top of the engine's measured position. */
    jetSpan: 3.56,
    jetDropY: 0.15,
    jetBackZ: 0.12,
    /** Plume shape: girth, drawn length, and how much it widens downstream. */
    jetWidth: 1.0,
    jetLength: 1.0,
    jetFlare: 1.0,

    /**
     * The speeder's cannon bolt: body colour, half-width and drawn length.
     *
     * The shader lays a pink fringe outside this colour and a near-white core
     * inside it, so this is the mid-tone rather than the whole look — pushing it
     * red gives an Imperial bolt, green a Rebel one.
     */
    boltR: 1.0,
    boltG: 0.58,
    boltB: 0.18,
    boltWidth: 0.38,
    boltLength: 9.0,
    /**
     * Velocity multiplier on the bolt — the same flight covered in less time,
     * so the impact timing, the crater and the sound all stay in step.
     */
    boltSpeed: 1.0,
    /**
     * Metres the speeder's bolt actually flies before fading. Separate from
     * `boltLength` (the drawn ribbon) so the shot reaches the field and
     * craters it like the walker's does, instead of dying beside the canopy.
     */
    boltRange: 400,
    /**
     * Where the cannon bolts are born, craft-local metres — the pair of
     * wingtip guns. Span is mirrored left/right; tune these until the shots
     * visibly leave the gun heads. Defaults are the model's measured muzzles.
     */
    /**
     * Multiplier on the plume's HDR intensity. The flame is pushed an order of
     * magnitude over the snow so the bloom pass has something to spread — this
     * is the knob over how much of that halo washes back over the hull. 1 is
     * the tuned look; drop it if the craft reads as smeared by its own engines.
     */
    jetGlow: 1.0,
    /**
     * Fraction of the plume's length the throat brightness ramps in over. The
     * bloom halo spreads from wherever the plume is brightest — ramping the
     * first stretch pushes that peak aft of the nozzle, so the glow bleeds
     * back off the engines instead of forward over the hull. 0 restores the
     * throat hard against the nozzle.
     */
    jetHaloBack: 0.1,
    muzzleSpan: 0.84,
    muzzleDropY: -0.196,
    muzzleFwdZ: 2.58,

    /**
     * Width of the trench the craft drags through the snow, as a multiple of the
     * snowboard groove it is currently borrowing. The hull is far wider than a
     * board, so 1.0 leaves a furrow that reads as a foot passing rather than a
     * five-metre craft.
     */
    surfWidth: 1.0,
    /**
     * How hard the boost smears the frame, 0 off. Driven by shift and the speed
     * it buys, not by the guns — see `Speeder.streak01`. Multiplies into the
     * post chain's own `streakStrength`.
     */
    speederStreak: 0.55,
    /**
     * Draw one of the lighting's inputs instead of the shaded craft.
     *
     * `albedo` is the one that settles the argument: if the hull comes back a
     * textured mid grey then the maps, the UVs and the material slots all
     * arrived and the darkness is in the lighting; if it comes back black then
     * nothing about the lighting is worth touching yet.
     */
    speederDebug: "off",

    // ----------------------------------------------------------- speeder feel
    /**
     * Master switch for the flight-feel polish layer.
     *
     * Everything under it is presentation — the physics the player has tuned
     * their hands to is untouched either way — and every term is subtle at its
     * default, so this exists less as an option than as an A/B: flip it while
     * flying the same line and what should change is how *filmed* the run
     * feels, not how the craft answers the keys.
     */
    cinematicCam: true,
    /**
     * How much the camera's turn-follow relaxes with speed, 0..1.
     *
     * The rig always chases the craft's heading through a damped follow (that
     * follow is what killed the keyboard pan-snap, and it is not optional).
     * At 0 the follow stays near-welded at any speed. Raising it lets the
     * follow slacken as speed builds, so a fast hard turn has the craft
     * visibly leading the frame and showing its flank — the shot a chase
     * camera is for — before the rig catches up on the straight.
     */
    camYawLag: 0.5,
    /**
     * Banking that leads the turn, 0 off.
     *
     * A steer-rate term on the hull's roll target: on turn entry the craft
     * rolls a few degrees past its settling bank and eases back as the lean
     * catches up, and un-banks with the same lead on exit. Reads as a pilot
     * committing to the turn rather than a hull being rotated by the physics.
     */
    speederBankLead: 0.12,
    /**
     * Boost-speed micro-buffet, metres, 0 off.
     *
     * A deterministic two-sine vibration on the hover height (and a tenth of
     * it on the roll), quadratic in speed so it only really exists on the
     * reheat. At the default it is under two centimetres — felt as the hull
     * trembling against the air, never actually seen.
     */
    // Off by default: the speed-squared buffet read as unintended jitter in
    // testing rather than as reheat tremble. Opt back in from the slider.
    speederTurbulence: 0.0,
    /**
     * The damage burn, positioned: metres behind the hull the trail sheds,
     * and metres above the pilot position. "Burn preview" lights the same
     * smoke-and-fire on the player craft so the sliders can be dialled by
     * eye instead of waiting for a wingman to be shot down.
     */
    burnPreview: false,
    burnBackZ: 2.4,
    burnY: 0.95,
    /**
     * How far the frame inhales on the boost, metres of extra arm, 0 off.
     *
     * While shift is held the spring arm eases out by this much and the FOV
     * opens a touch more, both settling back on release. Rides on top of the
     * composed arm length rather than the zoom target, so the player's own
     * mousewheel distance is never touched.
     */
    camBoostBreath: 0.5,
    /**
     * How high the E latch takes the craft, metres above the base path. Tap E
     * to transition up and stay there, tap again to settle back. The climb is
     * an exponential approach, so this is an asymptote rather than a wall —
     * "higher but not too high" — and on the way up the trench and downwash
     * fade out (`snowContact.js`) and the path flattens off the dunes
     * (`controller.js` cruise blend).
     */
    // The E ladder's ceiling (rung 3); rung 2 sits at 0.45x of it. Raised
    // from the old single-latch 6 m — one cruise height read as "too low",
    // and the top rung should stand well clear of the dune crests.
    speederClimbMax: 18.0,
    /**
     * How eagerly it climbs (and, at 0.6x, settles back). Exponential rate per
     * second: 2.2 reaches ~90% of the ceiling in about a second.
     */
    speederClimbRate: 2.2,
    /**
     * The throttle flight scheme (overlay "Throttle flight"). On: shift is
     * the throttle, S climbs and W dives — a held vertical axis walking a
     * target at `speederClimbSpeed` m/s up to `speederCeiling` — and E is
     * the reheat. Off (default): the classic scheme above, untouched — W/S
     * thrust and brake, shift boost, E the cruise-altitude latch. Live, so
     * the two can be A/B'd mid-flight; the switch adopts the current height.
     */
    flightThrottle: false,
    speederClimbSpeed: 9.0,
    speederCeiling: 24.0,

    // ----------------------------------------------------------------- fleet
    /**
     * The Imperial fleet on station: baked, shadowless, textureless Star
     * Destroyers hung high over the bearing the walkers march in from. Set
     * dressing — they hold formation relative to the player like the far
     * mountains do, so the shot is always composed.
     */
    showDestroyers: true,
    destroyerCount: 3,
    /** Metres above the field. */
    destroyerAlt: 1540,
    /** Metres out along the fleet bearing. */
    destroyerDist: 3200,
    /** Uniform scale on the ~1.5 km hull — forced perspective knob. */
    destroyerScale: 0.23,
    /** Degrees off the sun's azimuth (where the walkers come from). */
    destroyerBearing: 159,
    /** Formation heading, degrees — turns every hull's profile at once. */
    destroyerYaw: -103,
    /**
     * The AI wingman: a second T-47 flying strafing runs on the walkers.
     * Read at boot to decide whether the craft is built at all (like
     * `speeder`); mid-session the toggle only hides it, and enabling it from
     * off needs a reload.
     */
    showWingman: true,

    // ---------------------------------------------------------------- walker
    /** The machines on the horizon. Off hides them and stops them stepping. */
    showWalker: true,
    /**
     * How many of them. Live — the herd builds a new one on demand and parks the
     * surplus rather than tearing anything down — and capped by `MAX_WALKERS` in
     * `walkers/walker.js`, which is what sizes the shared transform texture.
     */
    walkerCount: 3,
    /**
     * Multiplier on the model's own size. 1 is the canonical twenty-two and a
     * half metres, which is already twelve times the character.
     */
    walkerScale: 1.3,
    /**
     * Multiplier on the gait. It drives the cycle rate and the ground speed
     * together — they come off one number in `walker.js` — so the feet stay
     * planted at any setting. 1 is the 1.45 m/s the clip actually walks at.
     */
    walkerSpeed: 1.0,
    /** How much snow has settled on the hull's upward faces. */
    walkerSnow: 0.45,
    /**
     * The red viewport band, nudged live off the measured slit: metres up,
     * metres forward of the face, and a width multiplier. Overlay "Walker"
     * group — dial it on a machine standing close.
     */
    eyeLift: 0.8,
    eyeOut: -0.1,
    eyeSpan: 0.9,
    /** The chin guns. Off stops the firing and the bolts, not the head tracking. */
    walkerFire: true,
    /**
     * The walker's cannon bolt: body colour, half-width and travel reach.
     * Defaults are the tuned look (magenta, a fat 1.88 m core, 620 m reach);
     * everything still scales with `walkerScale` on top so a giant walker
     * keeps a giant bolt. Same convention as the speeder's `boltR/G/B` —
     * channels may exceed 1 to push into HDR.
     */
    walkerBoltR: 0.9,
    walkerBoltG: 0.08,
    walkerBoltB: 0.96,
    walkerBoltWidth: 1.88,
    walkerBoltReach: 620,
    /** Velocity multiplier — see `boltSpeed`. */
    walkerBoltSpeed: 1.0,
    /**
     * Offsets on the walker's chin-gun muzzles, head-local metres, zero being
     * the model's measured gun heads. Span pushes the pair apart (mirrored),
     * Y is up the face, Z is out of it.
     */
    walkerMuzzleSpan: 0.0,
    walkerMuzzleY: 0.0,
    walkerMuzzleZ: 0.42,

    // ----------------------------------------------------------------- at-st
    /**
     * The AT-ST escort: scout walkers on the same baked-herd machinery as the
     * AT-ATs (`models/atst.bin`), spawned deeper so they come in from behind
     * the line. Their gait speed is the clip's own measured 3.17 m/s.
     */
    showAtst: true,
    /** How many scouts. Live, like `walkerCount`; same `MAX_WALKERS` cap. */
    atstCount: 5,
    /** Multiplier on the canonical 8.6 m hull. */
    atstScale: 1.0,
    /**
     * Pace trim *relative to the AT-ATs*. The escort's ground speed is pinned
     * to the walkers' (see the tuning in `main.js`) so the scouts hold
     * formation behind the line rather than overtaking it; 1 is exactly the
     * herd's pace, and this scales on top for a hurrying or a lagging escort.
     */
    atstSpeed: 1.0,
    /** Snow on the hull's upward faces. Less than the AT-ATs: it moves more. */
    atstSnow: 0.3,
    /**
     * Draw a ring at every point a cannon bolt is born — walker chin guns and
     * speeder wingtips — through hulls, riding the muzzle sliders live. A
     * tuning tool: leave it off when not placing muzzles.
     */
    showMuzzles: false,

    // ---------------------------------------------------------------- spells
    /** Master toggle. Off cancels everything in flight and hides both meshes. */
    showSpells: true,
    /** Brightness of the dynamic lights the spells emit. */
    spellLight: 1.0,
    /** Density of the spray every spell throws. */
    spellSpray: 1.0,
    /**
     * Artistic scale on the water's absorption path — glacial melt at one end,
     * tap water at the other. The right value depends on the sun elevation, so
     * it is a slider rather than a constant.
     */
    waterDepthTint: 1.0,

    // ------------------------------------------------------------------ post
    taa: true,
    ssr: true,
    dof: true,
    bloom: true,
    grain: true,
    sharpen: true,
    tonemap: "agx", // "agx" | "aces" | "none"
    // Measured, not guessed: sunlit snow here sits around 12 in linear, and at
    // this exposure it lands near AgX normalised 0.79, where the curve's slope
    // is 0.09 per stop. Higher exposures push it into the shoulder, where the
    // slope collapses and every lit slope resolves to the same flat white.
    exposure: 0.105,
    contrast: 1.14,
    bloomStrength: 0.22,
    grainStrength: 0.022,
    sharpenStrength: 0.55,

    // ----------------------------------------------------------------- audio
    /**
     * Master mute. This is the whole of "is the demo audible" — the audio engine
     * cannot be heard while it is true, whatever the faders say, and both the
     * overlay toggle and the corner button write it rather than keeping their own
     * copy. Note that muting does not unlock a locked engine: sound still needs
     * its one gesture first.
     */
    audioMuted: false,
    masterVolume: 0.8,
    /**
     * The wind bed's level, and the only place it is set.
     *
     * The ambience bus carries nothing else, so this *is* the bed's volume rather
     * than a trim on top of one: the manifest holds the file at unity and the
     * soundscape only ever rides it downward with speed, which makes this a
     * ceiling the bed never exceeds. Change it here or on the overlay's Ambience
     * fader — both are live, and neither is fighting a second number.
     *
     * Low on purpose. The bed's job is to sit under the board, the carves and the
     * voice; a wind loop you can pick out of the mix while doing nineteen metres a
     * second is already too loud.
     */
    ambienceVolume: 0.14,
    /**
     * The score's level. The two files are loudness-matched to each other in
     * the manifest — see the `music` entry's measured EBU R 128 gain — so
     * fader positions compare honestly: this sits a step above the bed on
     * purpose, the score leading the wind now that the cannons no longer sit
     * on a loudness floor at every range.
     */
    musicVolume: 0.45,
    sfxVolume: 1.0,

    // --------------------------------------------------------------- systems
    showTerrain: true,
    showCharacter: true,
    showWake: true,
    showLightShafts: true,
    wireframe: false,
    freezeTime: false,

    // ----------------------------------------------------------------- debug
    debugView: "beauty", // beauty | deform | normals | depth | cascades | footprint | fineNormals
};

/**
 * Widget metadata. `t`: "f" float slider, "b" bool toggle, "e" enum.
 * @type {{group:string, items:Array<{k?:string,l:string,t:string,min?:number,max?:number,step?:number,opts?:string[],kr?:string,kg?:string,kb?:string}>}[]}
 */
export const SCHEMA = [
    {
        group: "Sun & Sky",
        items: [
            { k: "sunAzimuth", l: "Azimuth", t: "f", min: 0, max: 360, step: 1 },
            { k: "sunElevation", l: "Elevation", t: "f", min: 0.5, max: 45, step: 0.1 },
            { k: "sunIntensity", l: "Intensity", t: "f", min: 0, max: 10, step: 0.05 },
            { k: "sunTempWarm", l: "Warmth", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "ambientIntensity", l: "Ambient", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "ambientBlue", l: "Ambient blue", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Atmosphere",
        items: [
            { k: "fogDensity", l: "Fog density", t: "f", min: 0, max: 0.03, step: 0.0001 },
            { k: "fogHeightFalloff", l: "Height falloff", t: "f", min: 0, max: 0.3, step: 0.001 },
            { k: "aerialStrength", l: "Aerial persp.", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "windDirection", l: "Wind dir", t: "f", min: 0, max: 360, step: 1 },
            { k: "windStrength", l: "Wind strength", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showMountains", l: "Far range", t: "b" },
            { k: "mountainHeight", l: "Range height", t: "f", min: 0, max: 2500, step: 10 },
            { k: "showLightShafts", l: "Light shafts", t: "b" },
            { k: "shaftStrength", l: "Shaft amt", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Snow",
        items: [
            { k: "glintIntensity", l: "Glint", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "glintGrazing", l: "Glint gate", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sssStrength", l: "SSS strength", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "sssRadius", l: "SSS radius", t: "f", min: 0.1, max: 3, step: 0.01 },
            { k: "detailNormalStrength", l: "Detail normals", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "macroHeightScale", l: "Dune height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "sastrugiStrength", l: "Sastrugi", t: "f", min: 0, max: 2, step: 0.01 },
        ],
    },
    {
        group: "Deformation",
        items: [
            { k: "deformDepth", l: "Depth", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "deformBerm", l: "Berm mass", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "refillRate", l: "Refill rate", t: "f", min: 0, max: 4, step: 0.01 },
        ],
    },
    {
        group: "Snow-surf",
        items: [
            { k: "wakeHeight", l: "Wake height", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "wakeSpray", l: "Plume density", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "windStreaks", l: "Speed streaks", t: "b" },
            { k: "streakStrength", l: "Streak amt", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "showWake", l: "Wake mesh", t: "b" },
        ],
    },
    {
        group: "Player",
        items: [
            // Boot-time: the craft and its pipelines are only built when this is
            // already true, so flipping it needs a reload to take effect.
            { k: "speeder", l: "Speeder (reload)", t: "b" },
        ],
    },
    {
        // Its own group rather than four more rows under Player: these are the
        // knobs for making a dark, low-poly, matte-painted craft read against a
        // 0.85-albedo field, and they are meant to be found and dragged.
        group: "Speeder look",
        items: [
            { k: "speederFill", l: "Fill light", t: "f", min: 0, max: 4, step: 0.02 },
            { k: "speederTint", l: "Albedo", t: "f", min: 0.5, max: 4, step: 0.05 },
            { k: "speederRough", l: "Roughness", t: "f", min: 0.06, max: 1, step: 0.01 },
            { k: "speederAmbient", l: "Sky ambient", t: "f", min: 0, max: 16, step: 0.1 },
            { k: "speederDesat", l: "Sun de-warm", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "jetSpan", l: "Jet spread", t: "f", min: 0, max: 8, step: 0.02 },
            { k: "jetDropY", l: "Jet up/down", t: "f", min: -1, max: 1, step: 0.01 },
            // Wide enough to pull the flames well clear of the hull: the
            // nozzle anchor sits at -2.63, so -6 here parks the plume roots
            // more than eight metres astern.
            { k: "jetBackZ", l: "Jet fwd/back", t: "f", min: -6, max: 3, step: 0.01 },
            { k: "jetWidth", l: "Jet girth", t: "f", min: 0.1, max: 6, step: 0.05 },
            { k: "jetLength", l: "Jet length", t: "f", min: 0.1, max: 6, step: 0.05 },
            { k: "jetFlare", l: "Jet flare", t: "f", min: 0.1, max: 4, step: 0.05 },
            { k: "jetGlow", l: "Jet glow", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "jetHaloBack", l: "Halo back-off", t: "f", min: 0, max: 0.5, step: 0.01 },
            { k: "burnPreview", l: "Burn preview", t: "b" },
            { k: "burnBackZ", l: "Burn fwd/back", t: "f", min: -2, max: 6, step: 0.05 },
            { k: "burnY", l: "Burn up/down", t: "f", min: -1.5, max: 3, step: 0.05 },
            { l: "Bolt colour", t: "c", kr: "boltR", kg: "boltG", kb: "boltB" },
            { k: "boltR", l: "Bolt red", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "boltG", l: "Bolt green", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "boltB", l: "Bolt blue", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "boltWidth", l: "Bolt diameter", t: "f", min: 0.02, max: 1.2, step: 0.01 },
            { k: "boltLength", l: "Bolt length", t: "f", min: 1, max: 30, step: 0.5 },
            { k: "boltSpeed", l: "Bolt speed", t: "f", min: 0.2, max: 4, step: 0.05 },
            { k: "boltRange", l: "Bolt range", t: "f", min: 30, max: 1500, step: 10 },
            { k: "muzzleSpan", l: "Muzzle spread", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "muzzleDropY", l: "Muzzle up/down", t: "f", min: -1.5, max: 1.5, step: 0.01 },
            { k: "muzzleFwdZ", l: "Muzzle fwd/back", t: "f", min: -2, max: 6, step: 0.01 },
            { k: "showMuzzles", l: "Muzzle markers", t: "b" },
            { k: "surfWidth", l: "Snow trail width", t: "f", min: 0.1, max: 8, step: 0.05 },
            { k: "speederStreak", l: "Boost blur", t: "f", min: 0, max: 3, step: 0.02 },
            {
                k: "speederDebug", l: "Debug view", t: "e",
                opts: ["off", "albedo", "normal", "slot", "ao", "roughness",
                       "sun cosine", "shadow"],
            },
        ],
    },
    {
        // The flight-feel layer, separate from "Speeder look" because these are
        // motion knobs, not lighting ones: the master toggle is the A/B, and
        // each slider below it is one cinematic term at a deliberately subtle
        // default. None of them touch the physics.
        group: "Speeder feel",
        items: [
            { k: "cinematicCam", l: "Cinematic cam", t: "b" },
            { k: "camYawLag", l: "Turn lag", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "speederBankLead", l: "Bank lead", t: "f", min: 0, max: 0.5, step: 0.01 },
            { k: "speederTurbulence", l: "Boost buffet", t: "f", min: 0, max: 0.05, step: 0.001 },
            { k: "camBoostBreath", l: "Boost breath", t: "f", min: 0, max: 2, step: 0.01 },
            { k: "speederClimbMax", l: "Climb height", t: "f", min: 0, max: 30, step: 0.5 },
            { k: "speederClimbRate", l: "Climb response", t: "f", min: 0.3, max: 6, step: 0.1 },
            { k: "flightThrottle", l: "Throttle flight", t: "b" },
            { k: "speederClimbSpeed", l: "Climb speed", t: "f", min: 2, max: 20, step: 0.5 },
            { k: "speederCeiling", l: "Flight ceiling", t: "f", min: 4, max: 40, step: 1 },
        ],
    },
    {
        group: "Fleet",
        items: [
            { k: "showDestroyers", l: "Star Destroyers", t: "b" },
            { k: "destroyerCount", l: "Count", t: "f", min: 1, max: 3, step: 1 },
            { k: "destroyerAlt", l: "Altitude", t: "f", min: 200, max: 2000, step: 10 },
            { k: "destroyerDist", l: "Distance", t: "f", min: 800, max: 3600, step: 20 },
            { k: "destroyerScale", l: "Scale", t: "f", min: 0.05, max: 1, step: 0.01 },
            { k: "destroyerBearing", l: "Bearing", t: "f", min: -180, max: 180, step: 1 },
            { k: "destroyerYaw", l: "Heading", t: "f", min: -180, max: 180, step: 1 },
            { k: "showWingman", l: "Wingman (reload)", t: "b" },
        ],
    },
    {
        group: "Walker",
        items: [
            { k: "showWalker", l: "Walkers", t: "b" },
            { k: "walkerCount", l: "Count", t: "f", min: 1, max: 6, step: 1 },
            { k: "walkerScale", l: "Scale", t: "f", min: 0.4, max: 3, step: 0.05 },
            { l: "Bolt colour", t: "c", kr: "walkerBoltR", kg: "walkerBoltG", kb: "walkerBoltB" },
            { k: "walkerBoltR", l: "Bolt red", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "walkerBoltG", l: "Bolt green", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "walkerBoltB", l: "Bolt blue", t: "f", min: 0, max: 2, step: 0.02 },
            { k: "walkerBoltWidth", l: "Bolt diameter", t: "f", min: 0.1, max: 3, step: 0.02 },
            { k: "walkerBoltReach", l: "Bolt reach", t: "f", min: 100, max: 1500, step: 10 },
            { k: "walkerBoltSpeed", l: "Bolt speed", t: "f", min: 0.2, max: 4, step: 0.05 },
            { k: "walkerMuzzleSpan", l: "Muzzle spread", t: "f", min: -1, max: 2, step: 0.01 },
            { k: "walkerMuzzleY", l: "Muzzle up/down", t: "f", min: -2, max: 2, step: 0.01 },
            { k: "walkerMuzzleZ", l: "Muzzle fwd/back", t: "f", min: -2, max: 4, step: 0.01 },
            { k: "eyeLift", l: "Eyes up/down", t: "f", min: -1.5, max: 2.5, step: 0.02 },
            { k: "eyeOut", l: "Eyes fwd/back", t: "f", min: -1.5, max: 1.5, step: 0.02 },
            { k: "eyeSpan", l: "Eyes width", t: "f", min: 0.3, max: 2, step: 0.02 },
            { k: "showMuzzles", l: "Muzzle markers", t: "b" },
            { k: "walkerSpeed", l: "Gait rate", t: "f", min: 0, max: 5, step: 0.05 },
            { k: "walkerSnow", l: "Snow on hull", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "walkerFire", l: "Cannons", t: "b" },
            { k: "showAtst", l: "AT-STs", t: "b" },
            { k: "atstCount", l: "AT-ST count", t: "f", min: 0, max: 6, step: 1 },
            { k: "atstScale", l: "AT-ST scale", t: "f", min: 0.4, max: 3, step: 0.05 },
            { k: "atstSpeed", l: "AT-ST gait", t: "f", min: 0, max: 5, step: 0.05 },
            { k: "atstSnow", l: "AT-ST snow", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Spells",
        items: [
            { k: "showSpells", l: "Spells", t: "b" },
            { k: "spellLight", l: "Spell light", t: "f", min: 0, max: 3, step: 0.01 },
            { k: "spellSpray", l: "Spell spray", t: "f", min: 0, max: 2.5, step: 0.01 },
            { k: "waterDepthTint", l: "Water depth", t: "f", min: 0, max: 3, step: 0.01 },
        ],
    },
    {
        group: "Post",
        items: [
            { k: "taa", l: "TAA", t: "b" },
            { k: "ssr", l: "SSR (ice)", t: "b" },
            { k: "dof", l: "Depth of field", t: "b" },
            { k: "bloom", l: "Bloom", t: "b" },
            { k: "grain", l: "Film grain", t: "b" },
            { k: "sharpen", l: "Sharpen", t: "b" },
            { k: "tonemap", l: "Tonemap", t: "e", opts: ["agx", "aces", "none"] },
            { k: "exposure", l: "Exposure", t: "f", min: 0.01, max: 0.6, step: 0.005 },
            { k: "contrast", l: "Contrast", t: "f", min: 0.5, max: 2, step: 0.01 },
            { k: "bloomStrength", l: "Bloom amt", t: "f", min: 0, max: 1, step: 0.005 },
            { k: "grainStrength", l: "Grain amt", t: "f", min: 0, max: 0.1, step: 0.001 },
            { k: "sharpenStrength", l: "Sharpen amt", t: "f", min: 0, max: 1, step: 0.01 },
        ],
    },
    {
        group: "Audio",
        items: [
            { k: "audioMuted", l: "Mute", t: "b" },
            { k: "masterVolume", l: "Master", t: "f", min: 0, max: 1, step: 0.01 },
            // Ambience tops out at the file's own level — there is nothing to be
            // gained from amplifying a wind loop past unity, and the fader reads
            // as a fraction of the asset rather than an arbitrary scale.
            { k: "ambienceVolume", l: "Ambience", t: "f", min: 0, max: 1, step: 0.01 },
            // Same range and same default as Ambience, because the two assets are
            // loudness-matched: level them by ear against each other and the
            // sliders agree with what you hear.
            { k: "musicVolume", l: "Music", t: "f", min: 0, max: 1, step: 0.01 },
            { k: "sfxVolume", l: "Effects", t: "f", min: 0, max: 1.5, step: 0.01 },
        ],
    },
    {
        group: "Systems",
        items: [
            { k: "captureShot", l: "Start location", t: "a", bl: "copy", done: "copied" },
            { k: "showTerrain", l: "Terrain", t: "b" },
            { k: "showCharacter", l: "Character", t: "b" },
            { k: "wireframe", l: "Wireframe", t: "b" },
            { k: "freezeTime", l: "Freeze time", t: "b" },
            { k: "resolutionScale", l: "Resolution", t: "f", min: 0.5, max: 1.5, step: 0.05 },
            {
                k: "debugView", l: "Debug view", t: "e",
                opts: ["beauty", "deform", "normals", "depth", "cascades", "footprint",
                       "fineNormals", "shadow", "ndotl", "shadowMap", "albedo"],
            },
        ],
    },
];

/** Quality presets. Only the keys that differ from `ultra` need listing. */
export const PRESETS = {
    ultra: {},
    high: { deformResolution: 2048, resolutionScale: 1.0, ssr: true, dof: true },
    balanced: {
        deformResolution: 1024, resolutionScale: 0.85,
        ssr: false, dof: false,
    },
};

/** @type {Map<string, Set<(v:any, k:string) => void>>} */
const listeners = new Map();

/**
 * Subscribe to a settings key. Returns an unsubscribe function.
 * @param {string|string[]} keys
 * @param {(v:any, k:string) => void} fn
 */
export function onChange(keys, fn) {
    const list = typeof keys === "string" ? [keys] : keys;
    for (let i = 0; i < list.length; i++) {
        let set = listeners.get(list[i]);
        if (!set) {
            set = new Set();
            listeners.set(list[i], set);
        }
        set.add(fn);
    }
    return () => {
        for (let i = 0; i < list.length; i++) listeners.get(list[i])?.delete(fn);
    };
}

/**
 * Write a settings value and notify subscribers. Never called from the render
 * loop — only from the overlay and preset application.
 * @param {string} k
 * @param {number|boolean|string} v
 */
export function set(k, v) {
    if (S[k] === v) return;
    S[k] = v;
    const set_ = listeners.get(k);
    if (set_) for (const fn of set_) fn(v, k);
}

/** @param {keyof typeof PRESETS} name */
export function applyPreset(name) {
    const p = PRESETS[name];
    if (!p) return;
    S.preset = name;
    for (const k in p) set(k, p[k]);
}
