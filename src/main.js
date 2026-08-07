/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGL2 only, by design (this build; the original was WebGPU-only). Three.js
 * is a rasterizer here — no feature-detect branches: if the context or the
 * float render targets aren't there we say so once and stop.
 */

import * as THREE from "three";
import { inject as injectAnalytics } from "@vercel/analytics";

import { registerShaders } from "./shaders/registry.js";
import { S, onChange, applyPreset } from "./core/settings.js";
import {
    sample, checkSpike, stats, mark, installDrawCounter, endFrameDraws,
} from "./core/perf.js";
import { initInput, pollInput, endFrame, input } from "./core/input.js";
import { CameraRig } from "./core/camera.js";
import { createGfx } from "./core/gfx.js";
import { CharacterController } from "./character/controller.js";
import { Character } from "./character/character.js";
import { SnowContact } from "./character/snowContact.js";
import { SprayField } from "./vfx/particles.js";
import { Explosions } from "./vfx/explosion.js";
import { MuzzleMarkers } from "./vfx/muzzleMarkers.js";
import { EyeBands } from "./vfx/eyeBands.js";
import { SmokeTrails } from "./vfx/smokeTrails.js";
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { WalkerHerd } from "./walkers/walker.js";
import { loadWalkerAsset } from "./walkers/walkerAsset.js";
import { Speeder } from "./player/speeder.js";
import { Wingman } from "./player/wingman.js";
import { Overlay } from "./ui/overlay.js";
import { createFpsMeter } from "./ui/fpsMeter.js";
import { Sky } from "./render/sky.js";
import { Destroyers } from "./render/destroyers.js";
import { ShadowSystem } from "./render/shadows.js";
import { Terrain } from "./terrain/terrain.js";
import { DepthPass } from "./render/depthPass.js";
import { PostChain } from "./post/postChain.js";
import { whenReady } from "./core/gpuUtil.js";
import * as loading from "./core/loading.js";
import { audio } from "./audio/engine.js";
import { Soundscape } from "./audio/soundscape.js";
import { createSoundButton } from "./ui/soundButton.js";
import { createTouchControls } from "./ui/touchControls.js";
import { createIntroFilm } from "./ui/introFilm.js";
import { OPENING, applyOpening, installShotCapture } from "./core/openingShot.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new THREE.Vector3();

/** Beauty clear — linear (§2.6). */
const CLEAR_COLOR = [0.02, 0.03, 0.05, 1];

// Vercel Web Analytics: page views and visitors on the deployment. The
// injected script is served from the site's own origin (/_vercel/insights),
// so there is nothing to allowlist; in dev it runs in debug mode and sends
// nothing.
injectAnalytics();

async function boot() {
    const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById("view"));

    // A coarse pointer means a phone or a tablet, and a phone is a tile-based GPU
    // with a fraction of the bandwidth this was tuned against. Drop to the
    // balanced preset *here*, before anything is built: the deformation buffer's
    // resolution is read once at construction, so a preset applied after the
    // terrain exists would leave the single largest target at its desktop size.
    if (window.matchMedia?.("(pointer: coarse)").matches) {
        applyPreset("balanced");
        S.resolutionScale = 0.7;
    }

    // Kick the audio download off before the device exists and await it at the
    // far end of the boot sequence. It is the only thing here that touches the
    // network, and it has nothing to do with the GPU work that follows — so it
    // runs underneath all of it and is, on any warm cache, long finished by the
    // time anything asks. Not awaited here on purpose; see "loading audio" below.
    const audioReady = audio.load();
    // The intro transmission rides the same reasoning: a megabyte of video
    // fetched to a blob underneath the GPU work, so the boot gate's click
    // plays local bytes instantly. Stub-tolerant — a miss costs the film,
    // not the boot, and the audio-only line takes over.
    const introFilm = createIntroFilm([
        "video/luke-intro.mp4",
        "https://zpumgyyt6ujxyrej.public.blob.vercel-storage.com/video/luke-intro.mp4",
    ]);
    const filmReady = introFilm.preload();
    // Same reasoning for the walkers: 4.4 MB of geometry, three levels of detail
    // and one baked gait, none of which needs a device to arrive. It is awaited
    // well after the terrain.
    const walkerReady = loadWalkerAsset("models/walker");
    // The AT-ST escort rides the same loader and the same herd machinery —
    // and so does the infantry walking beside it.
    const atstReady = loadWalkerAsset("models/atst");
    const trooperReady = loadWalkerAsset("models/trooper");
    // The crash-site pilot — one death clip, played once and held.
    const pilotReady = loadWalkerAsset("models/pilot");
    // Only when it is actually going to fly. Off — which is the default — the
    // speeder costs nothing at all: no fetch, no decode, no pipeline.
    const FLYING = S.speeder === true;
    // `srgbAlbedo` is deliberately *off*.
    //
    // The hull reading dark looked like an sRGB-decoded map being read as linear,
    // and it is not: decoding it moves the mid-tones down and the craft got
    // darker still, when a T-47 is a light grey aircraft. So the maps arrive in
    // the space they are wanted in and something else is eating the value. The
    // option stays because the next model through here may genuinely need it.
    // The wingman flies the same model whether or not the player does, so the
    // craft asset loads if either seat is occupied. Latched at boot like
    // S.speeder — the toggle needs a reload to *create* the craft, and only
    // hides it live.
    const WINGMAN = S.showWingman !== false;
    const speederReady = FLYING || WINGMAN ? loadWalkerAsset("models/speeder") : null;

    await loading.phase("creating device", 0.05);

    // WebGL2 + EXT_color_buffer_float gate lives inside createGfx; it fails
    // the boot screen itself with the precise reason, so a null is just "stop".
    const gfx = createGfx(canvas);
    if (!gfx) return;

    const applyScale = () => gfx.setRenderScale(S.resolutionScale);
    applyScale();
    onChange("resolutionScale", applyScale);
    window.addEventListener("resize", () => gfx.resize());

    installDrawCounter(gfx);
    registerShaders();

    await loading.phase("building scene", 0.12);

    const rig = new CameraRig(gfx, canvas);

    // ------------------------------------------------------------------ sky
    await loading.phase("integrating atmosphere", 0.2);
    const sky = new Sky(gfx);
    // The Imperial fleet on station over the walkers' bearing — set dressing,
    // loaded async and tolerated absent.
    const destroyers = new Destroyers(gfx, sky);
    destroyers.bindCamera(rig.camera.viewProjection);
    await sky.solve();

    // -------------------------------------------------------------- shadows
    const shadows = new ShadowSystem(gfx);

    // The camera-space depth prepass. Babylon scheduled it by registration
    // order; here the schedule is the explicit pass list in `renderFrame`.
    const depthPass = new DepthPass(gfx);

    // -------------------------------------------------------------- terrain
    await loading.phase("baking heightfield", 0.34);
    const terrain = new Terrain(gfx, sky, shadows);
    await terrain.build();
    onChange("showTerrain", (v) => {
        if (terrain.mesh) terrain.mesh.visible = v;
    });
    depthPass.registerCaster(terrain.mesh, terrain.makePrepassMaterial());

    await loading.phase("placing character", 0.62);

    const character = new CharacterController(terrain);
    character.position.set(0, 0, 0);
    character.position.y = terrain.heightAt(0, 0);
    // Flying, the arm is a chase camera and A/D drags it round with the nose —
    // so it has to *start* behind the nose. The figure's opening bearing is a
    // composition (it frames the walkers); a craft's is simply where it points.
    if (S.speeder === true) rig.yaw = character.facing;

    // The figure: skeleton, garment simulation, shell fur. Hidden while the
    // player is flying — it is still simulated, because the speeder reads the
    // same controller and the cloth solve costs a fraction of a millisecond, but
    // nothing draws it.
    const figure = new Character(gfx, terrain, sky, shadows, character);
    figure.registerPrepass(depthPass);
    const showFigure = () => figure.setVisible(S.showCharacter !== false && !FLYING);
    onChange("showCharacter", showFigure);

    // ----------------------------------------------------------- the walkers
    // Twenty-two metres of imported machine apiece, baked offline into the same
    // shape of asset everything else here is: one mesh, one transform texture,
    // five pipelines, three levels of detail. See `tools/bakeWalker.mjs`.
    await loading.phase("landing the walkers", 0.70);
    const walkers = new WalkerHerd(gfx, terrain, sky, shadows, await walkerReady, rig, {
        // The centre machine — where the eye lands first — steps well back,
        // so the opening line reads as an advance in depth rather than three
        // hulls crowding the middle of the frame.
        depthStagger: (i) => [0, 110, 40][i % 3],
    });
    onChange("showWalker", (v) => walkers.setVisible(v));
    walkers.registerPrepass(depthPass);

    // The second wave: two more AT-ATs deep behind the line — reinforcements
    // already on the march when the game opens. Same asset, same machinery,
    // their own herd so the opening line's count slider and composition stay
    // untouched; every shared look slider (scale, speed, bolts) still reads
    // through. Spawned at 600 m — under RECYCLE (640), or they would be
    // re-placed the moment they landed — so they stand half-dissolved in the
    // aerial haze and resolve as they come, well clear of the scouts' band.
    const walkers2 = new WalkerHerd(gfx, terrain, sky, shadows, await walkerReady, rig, {
        count: () => 2,
        maxCount: () => 2,
        spawnDistance: () => 600,
        respawnDistance: () => 600,
        // A pair at 600 m on the stock spread stands nearly shoulder to
        // shoulder over the first wave's centre — doubled, they straddle the
        // line as wide wings instead.
        spreadScale: () => 2.0,
    });
    onChange("showWalker", (v) => walkers2.setVisible(v));
    walkers2.registerPrepass(depthPass);

    // The AT-ST escort: scouts on the same machinery, tuned to their own
    // sliders and spawned deeper than the AT-AT line (200-260 m), so they
    // come up the field from behind it. No head tracking and no cannons —
    // the head geometry the deriver finds on this rig is most of the cabin,
    // and a cabin that swivels to stare at the player is a different machine.
    const atstAsset = await atstReady;
    const atsts = new WalkerHerd(gfx, terrain, sky, shadows, atstAsset, rig, {
        count: () => /** @type {number} */ (S.atstCount),
        scale: () => /** @type {number} */ (S.atstScale),
        // Paced to the herd, not to their own clip. The AT-ST's cycle walks at
        // 3.17 m/s to the AT-AT's 1.45, and an escort that outruns its line and
        // arrives first is leading a charge. The rate is chosen so ground speed
        // equals the AT-ATs' — tracking their scale and gait sliders live —
        // and the cycle slows with it, so the feet stay planted; `S.atstSpeed`
        // rides on top as a trim *relative to the walkers*.
        speed: () => {
            const walkerGround = walkers.baseSpeed
                * /** @type {number} */ (S.walkerScale)
                * /** @type {number} */ (S.walkerSpeed);
            const atstAtRate1 = atstAsset.header.speed
                * Math.max(0.05, /** @type {number} */ (S.atstScale));
            return (walkerGround / atstAtRate1) * /** @type {number} */ (S.atstSpeed);
        },
        snow: () => /** @type {number} */ (S.atstSnow),
        visible: () => S.showAtst !== false,
        // The chin gun, under the same overlay toggle as the walkers' cannons.
        // No head tracking — the deriver's "head" on this rig is gun mounts
        // without the cabin — so the shots go straight down the heading, and
        // the level gate holds them for the flat part of the gait.
        fire: () => S.walkerFire !== false,
        headLook: () => false,
        levelGate: () => true,
        // The derived muzzle pair sits at the AT-AT's +-1.05 m chin span; the
        // AT-ST's twin barrels are dead centre of the face, so the span offset
        // walks both onto the middle, slightly tucked back toward the plating.
        muzzle: () => ({ span: -0.9, y: -0.15, z: -0.5 }),
        // Red, slim, and shorter-lived than the walker's magenta shell — a
        // scout's gun, not artillery. The width is also what keys the smaller
        // crater and spray at the impact end.
        bolt: () => {
            const s = Math.max(0.4, /** @type {number} */ (S.atstScale));
            return {
                r: 1.0, g: 0.16, b: 0.10,
                width: 0.55 * s, reach: 420 * s, speed: 1.1,
            };
        },
        // The scouts' own band: behind the first wave's deepest machine
        // (490 m) and in front of the second wave (600 m) — never under
        // either. 515 + the default stagger tops out at 575, and a recycled
        // scout re-enters the same band rather than the old 470 default,
        // which would put it back under the first wave's centre.
        spawnDistance: () => 515,
        respawnDistance: () => 515,
        // The default separation is thirty metres at walker scale; scouts
        // stand nearer each other than mechs twelve times their mass.
        separation: () => 30 * Math.max(0.4, /** @type {number} */ (S.atstScale)),
        sink: () => 0.35 * /** @type {number} */ (S.atstScale),
    });
    atsts.registerPrepass(depthPass);

    // The snowtroopers: five per AT-ST, anchored around it — three walking
    // the flanks, two trailing behind the hull. Same herd machinery again at
    // a twelfth the height — the anchor hook places each squad around its
    // scout wherever the scout is, entry and re-entry both, and the pace is
    // pinned to the walkers' like everything else on this field, so the
    // whole advance moves as one line.
    const trooperAsset = await trooperReady;

    /** Push a point straight out of every AT-AT's keep-clear radius. */
    const clearOfWalkers = (p, min) => {
        for (const herd of [walkers, walkers2]) {
            const wn = Math.min(herd.count, herd.walkers.length);
            for (let k = 0; k < wn; k++) {
                const W = herd.walkers[k];
                const dx = p.x - W.position.x;
                const dz = p.z - W.position.z;
                const d = Math.hypot(dx, dz);
                if (d < min && d > 1e-3) {
                    p.x = W.position.x + (dx / d) * min;
                    p.z = W.position.z + (dz / d) * min;
                }
            }
        }
        return p;
    };

    /**
     * Where trooper `i` belongs *right now*: a lane in the wedge behind its
     * scout, kept out of the walkers' keep-clear. One function, three
     * callers — placement, re-entry, and the per-frame formation follow —
     * so a soldier's station is never two different opinions.
     */
    const trooperStation = (i) => {
        const n = Math.min(atsts.count, atsts.walkers.length);
        if (!n) return null;
        const host = atsts.walkers[Math.floor(i / 5) % n];
        const station = i % 5;
        // The whole squad marches *behind* its scout: infantry follows
        // armour, it does not screen it. Five lanes fanned across the
        // scout's six, staggered in depth so the squad reads as a loose
        // wedge trailing the hull rather than a rank — with a little
        // per-squad twist so two escorts do not read as copies.
        const lane = station - 2; // -2..2 across the line of advance
        const back = host.yaw + Math.PI
            + lane * 0.26 + (Math.floor(i / 5) % 3 - 1) * 0.12;
        const r = 10 + Math.abs(lane) * 2.5 + (station % 2) * 3;
        const p = clearOfWalkers({
            x: host.position.x + Math.sin(back) * r,
            z: host.position.z + Math.cos(back) * r,
        }, 30 * /** @type {number} */ (S.walkerScale));
        p.host = host;
        return p;
    };

    const troopers = new WalkerHerd(gfx, terrain, sky, shadows, trooperAsset, rig, {
        count: () => Math.min(30, Math.round(5 * /** @type {number} */ (S.atstCount))),
        maxCount: () => 30,
        scale: () => 1,
        speed: () => {
            const ground = walkers.baseSpeed
                * /** @type {number} */ (S.walkerScale)
                * /** @type {number} */ (S.walkerSpeed);
            return ground / trooperAsset.header.speed;
        },
        snow: () => 0.15,
        visible: () => S.showAtst !== false,
        // The squads return fire: little carbine bolts, close range only —
        // the player has to be down among them before the lasers come up.
        // Deliberately absent from the soundscape: fifteen carbines popping
        // would bury the mix, and silent tracer reads fine at this scale.
        fire: () => S.walkerFire !== false,
        fireRange: () => 150,
        muzzle: () => ({ span: 0, y: 0, z: 0 }),
        bolt: () => ({
            r: 1.0, g: 0.16, b: 0.1,
            width: 0.13, reach: 170, speed: 1.4,
        }),
        headLook: () => false,
        separation: () => 2.2,
        sink: () => 0.12,
        anchor: (i) => trooperStation(i),
    });
    troopers.registerPrepass(depthPass);
    onChange("showAtst", (v) => {
        atsts.setVisible(v);
        troopers.setVisible(v);
    });

    // ------------------------------------------------------- the crash sites
    // Three wreck slots (one per seat) and the pilots thrown from them. A
    // slot is claimed at ground contact and *kept* — the hull stays sunk in
    // the snow, burning down and slowly frosting over, until its seat crashes
    // again and reclaims it.
    /** @type {{hull:any, ctl:any, active:boolean, burnT:number, age:number,
     *          smokeT:number, pilotX:number, pilotZ:number}[]} */
    const wrecks = [];
    const pilotAsset = await pilotReady;
    const pilots = new WalkerHerd(gfx, terrain, sky, shadows, pilotAsset, rig, {
        count: () => wrecks.reduce((n, w) => n + (w.active ? 1 : 0), 0),
        maxCount: () => 3,
        scale: () => 1,
        // A body does not pace itself to anything.
        speed: () => 0,
        snow: () => 0.35,
        visible: () => S.showWingman !== false,
        fire: () => false,
        headLook: () => false,
        separation: () => 0.01,
        sink: () => 0.08,
        anchor: (i) => {
            const w = wrecks[i];
            return w && w.active ? { x: w.pilotX, z: w.pilotZ } : null;
        },
    });
    pilots.registerPrepass(depthPass);

    // Airborne snow: footfall kick now, the surf plume and spell spray later.
    const spray = new SprayField(gfx, terrain, sky, shadows);
    // Shellbursts where the cannon fire lands close to the fight — the Hoth
    // fireball, gated and rationed. See `vfx/explosion.js` for the economy.
    const explosions = new Explosions(gfx, terrain, sky, [
        { herd: walkers, radius: 16 },
        { herd: walkers2, radius: 16 },
        { herd: atsts, radius: 10 },
        { herd: troopers, radius: 7 },
    ]);
    // Tuning rings on the gun heads, live under the overlay's muzzle sliders.
    const muzzleMarkers = new MuzzleMarkers(gfx);
    muzzleMarkers.bindCamera(rig.camera.viewProjection);
    // The walkers' red viewport bands — content, not tooling, so always on.
    const eyeBands = new EyeBands(gfx);
    eyeBands.bindCamera(rig.camera.viewProjection);
    // Damage smoke and fire off wounded craft — the wingmen's ladder.
    const smoke = new SmokeTrails(gfx);
    smoke.bindCamera(rig.camera.viewProjection);

    // ------------------------------------------------------------ the speeder
    /** @type {Speeder|null} */
    const speeder = FLYING
        ? new Speeder(gfx, terrain, sky, shadows, await speederReady, character, spray)
        : null;
    speeder?.registerPrepass(depthPass);

    // ------------------------------------------------------------ the flight
    // Three AI T-47s in the fight — same presentation, different pilots. Each
    // seat flies its own bearings (seeded a third of a turn apart, orbits
    // alternating direction) and has its own appetite: one hunts the armour,
    // one flies a mixed bag, and one never leaves the trooper squads alone.
    /** @type {Wingman[]} */
    const wingmen = [];
    if (WINGMAN) {
        const speederAsset = await speederReady;
        const seats = [
            { trooperChance: 0.2 },  // the armour hunter
            { trooperChance: 0.6 },  // flies whatever the field offers
            { trooperChance: 1.0 },  // the infantry specialist
        ];
        for (let i = 0; i < seats.length; i++) {
            const w = new Wingman(
                gfx, terrain, sky, shadows, speederAsset,
                walkers, spray, character, troopers,
                { ...seats[i], seat: i }
            );
            w.registerPrepass(depthPass);
            wingmen.push(w);
        }
    }
    const wingman = wingmen[0] ?? null;

    // Where a cannon bolt lands, the infantry reacts — the player's guns and
    // the wingman's both report through the same handler. Three rings around
    // the burst:
    //
    //   < 1.7 m   a hit. One of the three deaths, held on its final frame; the
    //             body lies in the snow a while, then the herd recycles it
    //             back in at its squad's station like any other re-entry.
    //   < 6 m     a near miss. The trooper dives *away from* the burst —
    //             jumpLeft for an impact on his right, jumpRight for his
    //             left — then the get-up, then the walk again.
    //   < 9 m     close enough to flinch.
    //
    // The get-up starts five and a half seconds in: Mixamo's clip spends its
    // first act lying still and rolling over, and a soldier who dove clear of
    // a shellburst stirs and rises rather than napping through the battle.
    const GETUP_SKIP = 5.5;
    const DEATHS = ["death1", "death2", "death3"];
    const squadImpact = (x, _y, z) => {
        const n = Math.min(troopers.count, troopers.walkers.length);
        for (let i = 0; i < n; i++) {
            const w = troopers.walkers[i];
            const d = Math.hypot(w.position.x - x, w.position.z - z);
            if (d > 9) continue;
            if (d < 1.7) {
                w.react(DEATHS[(Math.random() * DEATHS.length) | 0], {
                    hold: true, linger: 12,
                });
            } else if (d < 6) {
                // Which side the burst is on, in the trooper's own frame.
                const rightward = (x - w.position.x) * Math.cos(w.yaw)
                    - (z - w.position.z) * Math.sin(w.yaw);
                w.react(rightward > 0 ? "jumpLeft" : "jumpRight", {
                    then: { name: "gettingUp", startAt: GETUP_SKIP },
                });
            } else {
                w.react("hitReaction");
            }
        }
    };
    for (const w of wingmen) {
        if (w.craft?.bolts) w.craft.bolts.ctx.onImpact = squadImpact;
    }
    if (speeder?.bolts) speeder.bolts.ctx.onImpact = squadImpact;
    // The same impacts, one more listener: a qualifying burst sometimes
    // blossoms into a fireball. Chained over whatever handler is installed
    // rather than replacing it — the crater, the spray and the flinching
    // squad all still belong to the bolts and the handler above.
    const chainBurst = (bolts, anywhere) => {
        if (!bolts) return;
        const prev = bolts.ctx.onImpact;
        bolts.ctx.onImpact = (x, y, z) => {
            prev?.(x, y, z);
            explosions.impact(x, y, z, anywhere);
        };
    };
    for (const w of wingmen) chainBurst(w.craft?.bolts, false);
    // The player's own guns blossom wherever they land — a deliberate shot
    // into the snow that does nothing reads as a misfire.
    chainBurst(speeder?.bolts, true);
    // And the AT-ATs' artillery: their shells land around the *player*, far
    // from anything the proximity gate watches, so they ride the same
    // always-blossom path — incoming fire that bursts into flame is most of
    // what makes the walk toward the line feel like a bombardment. The
    // AT-STs' slim chin guns stay a kick of snow; a scout is not artillery.
    chainBurst(walkers.bolts, true);
    chainBurst(walkers2.bolts, true);

    // The wingmen can be shot down — by the *Imperial* guns only. Three hits,
    // spaced by a grace window so the stages play out: black smoke, then fire,
    // then the third puts it into the snow — fireball, crater, a heavy kick of
    // thrown snow, and a fresh airframe brought in from deep for that seat.
    // The graveyard hulls: one frozen Speeder per seat, posed by the crash
    // and left there. Built only when there are wingmen to lose.
    if (wingmen.length) {
        const speederAsset2 = await speederReady;
        for (let i = 0; i < 3; i++) {
            const ctl = {
                position: new THREE.Vector3(0, -500, 0),
                velocity: new THREE.Vector3(),
                facing: 0, lean: 0.32, steerRate: 0,
                speed01: 0, speedRaw: 0,
                climb: -2.35, lift01: 0, pathY: 0, groundY: 0,
                driveHeld: false, boostHeld: false, fireHeld: false,
            };
            const hull = new Speeder(gfx, terrain, sky, shadows, speederAsset2, ctl, null);
            // A wreck, not a craft: hover, bob and jet all dead, belly laid
            // slightly under the surface so the snow reads as claiming it.
            hull.grounded = true;
            hull.registerPrepass(depthPass);
            hull.setVisible(false);
            wrecks.push({
                hull, ctl, active: false, burnT: 0, age: 0, smokeT: 0,
                pilotX: 0, pilotZ: 0,
            });
        }
    }
    let wreckNext = 0;

    const enemyFire = [walkers.bolts, walkers2.bolts, atsts.bolts, troopers.bolts];
    // The shared fate token: one ship wounded and falling at a time, ever.
    const raid = { turn: 0, size: Math.max(1, wingmen.length) };
    for (const w of wingmen) {
        w.effects = {
            smoke,
            enemy: enemyFire,
            raid,
            onCrash: (x, y, z, facing) => {
                explosions.impact(x, y, z, true, true);
                // The report, at the level and the delay its distance earns —
                // the same physics the cannons obey.
                const cd = Math.hypot(
                    x - character.position.x, z - character.position.z
                );
                const cn = Math.max(0, 1 - cd / 420);
                audio.play("speederCrash", {
                    gain: cn * cn * cn,
                    delay: Math.min(1.6, cd / 343),
                });
                // The arrival scar: the crater it dug and the trench it
                // ploughed getting there.
                terrain.deform.brush(x, z, 3.4, 0.85, 0.6, 1.0, 0.6, 0, 1.3, 1.0);
                terrain.deform.brush(
                    x - Math.sin(facing) * 4.5, z - Math.cos(facing) * 4.5,
                    2.4, 0.5, 0.55, 1.0, 0.3, facing, 3.0, 1.0
                );
                for (let k = 0; k < 42; k++) {
                    const a = Math.random() * Math.PI * 2;
                    const out = 3 + Math.random() * 9;
                    spray.emit(
                        x + Math.cos(a) * 0.5, y + 0.2, z + Math.sin(a) * 0.5,
                        Math.cos(a) * out, 4 + Math.random() * 9, Math.sin(a) * out,
                        0.05 + Math.random() * 0.08, 0.8 + Math.random() * 1.2,
                        Math.random() < 0.4 ? 1 : 0, 1.2
                    );
                }
                // Claim a wreck slot: the hull stays, sunk to its skids.
                const wk = wrecks[wreckNext];
                if (!wk) return;
                wreckNext = (wreckNext + 1) % wrecks.length;
                wk.active = true;
                wk.burnT = 32;
                wk.age = 0;
                wk.smokeT = 0;
                wk.ctl.position.set(x, 0, z);
                wk.ctl.facing = facing;
                wk.ctl.lean = (Math.random() < 0.5 ? -1 : 1)
                    * (0.25 + Math.random() * 0.15);
                wk.ctl.groundY = terrain.heightAt(x, z);
                wk.ctl.pathY = wk.ctl.groundY;
                wk.hull.snowOverride = 0;
                wk.hull.setVisible(true);
                // The pilot, thrown clear — a little away from the ship, off
                // to the side of the skid line.
                const side = facing + (Math.random() < 0.5 ? 1 : -1)
                    * (0.9 + Math.random() * 0.7);
                const throwOut = 4 + Math.random() * 1.5;
                wk.pilotX = x + Math.sin(side) * throwOut;
                wk.pilotZ = z + Math.cos(side) * throwOut;
                const slot = wrecks.indexOf(wk);
                pilots.setCount(wrecks.reduce((n2, q) => n2 + (q.active ? 1 : 0), 0));
                const body = pilots.walkers[slot];
                if (body) {
                    pilots.place(body, character.position);
                    body.yaw = Math.random() * Math.PI * 2;
                    body.oneshot = null;
                    body.react("Death From Back Headshot", { hold: true, linger: 1e9 });
                }
            },
        };
    }

    // A low pass is its own kind of near miss: the craft screaming over at
    // deck height sends the squad diving without a shot fired — same dives,
    // same get-up as the shellburst. Keyed off the hull's actual lift and
    // way: up at the clean rungs the lift is saturated and nobody flinches,
    // and a craft hovering alongside is a curiosity, not a threat. The
    // `oneshot` guard is what keeps a lingering pass from re-triggering a
    // trooper who is already in the snow.
    const buzzTroopers = () => {
        if (!speeder || S.speeder !== true) return;
        if (character.lift01 > 0.45 || character.speed < 9) return;
        const n = Math.min(troopers.count, troopers.walkers.length);
        for (let i = 0; i < n; i++) {
            const w = troopers.walkers[i];
            if (w.oneshot) continue;
            const d = Math.hypot(
                w.position.x - character.position.x,
                w.position.z - character.position.z
            );
            if (d > 8) continue;
            const rightward =
                (character.position.x - w.position.x) * Math.cos(w.yaw)
                - (character.position.z - w.position.z) * Math.sin(w.yaw);
            w.react(rightward > 0 ? "jumpLeft" : "jumpRight", {
                then: { name: "gettingUp", startAt: GETUP_SKIP },
            });
        }
    };
    speeder?.setVisible(true);
    showFigure();

    // The walkers' cannons throw snow into the same pool everything else does —
    // and the escort's, whose slimmer bolts kick up proportionally less of it.
    walkers.setSpray(spray);
    walkers2.setSpray(spray);
    atsts.setSpray(spray);

    // A trooper's footfall: the same boot print and heel-scoop kick the player
    // character stamps (see `SnowContact`), sized to a walking soldier and
    // fired off the herd's own footfall counter — so every step both marks the
    // snow and throws a little of it, which is what sells twelve small figures
    // as *wading* rather than gliding. Feet alternate on step parity.
    troopers.onStep = (w) => {
        const fx = Math.sin(w.yaw), fz = Math.cos(w.yaw);
        const side = (w.stepCount % 2 === 0 ? 1 : -1) * 0.18;
        const px = w.position.x + fz * side + fx * 0.12;
        const pz = w.position.z - fx * side + fz * 0.12;
        terrain.deform.brush(
            px, pz, 0.10, 0.16, 0.09, 0.9, 0, w.yaw, 1.7, 1.0
        );
        for (let k = 0; k < 7; k++) {
            const rx = (Math.random() - 0.5) * 0.9;
            const rz = (Math.random() - 0.5) * 0.9;
            const clod = Math.random() < 0.22 ? 1 : 0;
            spray.emit(
                px + rx * 0.09, w.position.y + 0.03 + Math.random() * 0.05,
                pz + rz * 0.09,
                -fx * (0.4 + Math.random() * 0.9) + rx * 1.2,
                (0.8 + Math.random() * 1.5) * (clod ? 1.25 : 1),
                -fz * (0.4 + Math.random() * 0.9) + rz * 1.2,
                clod ? 0.014 + Math.random() * 0.012 : 0.02 + Math.random() * 0.03,
                0.5 + Math.random() * 0.5,
                clod
            );
        }
    };

    // Feet and the surf groove write into the terrain state buffer through here.
    const contact = new SnowContact(character, terrain.deform, figure.figure, spray);

    // The breaking wave, its bow crest and the plume it sheds.
    const wake = new SurfWake(gfx, sky, shadows, character, spray, terrain);
    onChange("showWake", (v) => wake.setEnabled(v));
    wake.registerPrepass(depthPass);

    // The five spells, the water body they bend and the ice they leave.
    // Flying hides the whole snowboarding half of the demo: the spells are cast
    // by a figure that is not there, and the surf wake is thrown by a board.
    // Plain writes, not `set()` — no listeners fire.
    if (FLYING) {
        S.showSpells = false;
        S.showWake = false;
    }

    const spells = new SpellSystem(
        gfx, sky, shadows, terrain, character, figure.figure, rig, spray
    );
    // Every surface a spell can light.
    spells.addConsumers(
        terrain.material, figure.bodyMat, figure.clothMat,
        wake.material, spray.material
    );
    // The herd can grow after boot, so it hands its materials over as they are
    // built rather than being enumerated once here.
    walkers.onMaterial = (m) => spells.addConsumers(m);
    for (const w of walkers.walkers) spells.addConsumers(w.material);
    walkers2.onMaterial = (m) => spells.addConsumers(m);
    for (const w of walkers2.walkers) spells.addConsumers(w.material);
    atsts.onMaterial = (m) => spells.addConsumers(m);
    for (const w of atsts.walkers) spells.addConsumers(w.material);
    troopers.onMaterial = (m) => spells.addConsumers(m);
    pilots.onMaterial = (m) => spells.addConsumers(m);
    for (const w of pilots.walkers) spells.addConsumers(w.material);
    for (const w of troopers.walkers) spells.addConsumers(w.material);
    spells.registerPrepass(depthPass);

    // The rig needs ground heights to keep the spring arm above the snow.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    // The opening shot, if one has been pinned. Before the warm-up, so the
    // frames rendered behind the loading screen are already the shot rather than
    // wherever the default rule put things.
    applyOpening(OPENING, rig, character, walkers, terrain);

    // The flight's entrance: the three escorts restaged behind the player at
    // altitude and speed, aimed at the centre of the walker line — the game
    // opens with the formation sweeping overhead toward the battle. Called on
    // the boot gate's click rather than here: the simulation runs behind the
    // boot screen, and a flyover staged now would be long gone before the
    // player ever saw the field.
    const startFlyover = () => {
        // The opening beat: hold the player's stick until the escorts have
        // passed overhead and Luke's line has landed. Sized off the actual
        // clip and the actual formation timing rather than guessed — the
        // last ship starts 160 m back at 32 m/s. The run loop counts this
        // down, freezing movement input (the look stays free) and seeding
        // the craft's forward way the moment the hold releases.
        // The voice is the film's when the film made it down, the mp3's when
        // it didn't — whichever is actually going to play. The film's voice
        // starts late by design: an open hold for the fly-in, then the static
        // tune-in, then Luke — `leadIn` is that whole runway.
        const lead = introFilm.ok ? introFilm.leadIn : 0.5;
        const voice = introFilm.duration
            ?? audio.buffers.get("lukeIntro")?.duration ?? 3.5;
        introHold = Math.max(5.4, lead + voice + 0.4);
        if (!wingmen.length || !walkers.count) return;
        let bx = 0, bz = 0;
        const n = Math.min(walkers.count, walkers.walkers.length);
        for (let i = 0; i < n; i++) {
            bx += walkers.walkers[i].position.x;
            bz += walkers.walkers[i].position.z;
        }
        bx /= n;
        bz /= n;
        for (const w of wingmen) w.flyover(character.position, bx, bz);
        // The player's own entrance: their craft staged 150 m back along the
        // formation's bearing, making way toward the spot the boot pinned.
        // Flown by feeding the controller's velocity each frame (the intro
        // block in the run loop), so the presentation, the camera and the
        // snow all read a genuinely moving craft rather than a teleport.
        if (S.speeder === true) {
            const h = Math.atan2(
                bx - character.position.x, bz - character.position.z
            );
            introFly = {
                toX: character.position.x, toZ: character.position.z,
                heading: h,
            };
            character.position.x -= Math.sin(h) * 150;
            character.position.z -= Math.cos(h) * 150;
            character.facing = h;
        }
    };

    const post = new PostChain(gfx, rig, depthPass, sky);

    // ------------------------------------------------------------ the frame
    /**
     * The explicit render schedule (§4.3). The deform sim pass already ran
     * inside `terrain.update`; from here: cascades → prepass → beauty →
     * post chain. Beauty renders three layers into one target with a single
     * clear — depth persists from the opaques into the blended group.
     */
    const renderFrame = () => {
        gfx.syncTokenCamera(rig.camera);
        shadows.render(gfx);
        depthPass.render(gfx);
        gfx.runPass({
            target: post.sceneColor,
            clearColor: CLEAR_COLOR,
            clearDepth: true,
            layer: gfx.LAYER.SKY,
        });
        gfx.runPass({ target: post.sceneColor, layer: gfx.LAYER.OPAQUE });
        gfx.runPass({ target: post.sceneColor, layer: gfx.LAYER.BLEND });
        post.render(gfx);
    };

    // F2 snapshots the camera, the player and the herd as a paste-able block —
    // wired before the overlay so its "Start location · copy" button can share
    // the exact same capture. See `core/openingShot.js` for what to do with it.
    const captureShot = installShotCapture(rig, character, walkers);

    const overlay = new Overlay({ rig, character, actions: { captureShot } });
    const toggleOverlay = () => overlay.toggle();
    // The same two numbers the overlay carries, on their own, for when the panel
    // would cover the thing being measured.
    const fpsMeter = createFpsMeter();
    initInput(canvas, {
        onToggleOverlay: toggleOverlay,
        onToggleFps: () => fpsMeter.toggle(),
    });
    // Builds hidden and reveals itself on the first real touch, so a desktop with
    // a touchscreen never sees it. Everything it produces goes into the same
    // `input` struct the keyboard writes.
    const touchControls = createTouchControls({ onToggleOverlay: toggleOverlay });

    // The soundscape reads game state; nothing in the game knows it exists. It
    // stays silent until `start()`, which only happens on the gesture that
    // unlocks the engine — the boot gate below, or the corner button later.
    const soundscape = new Soundscape(
        audio, { controller: character, spells, walkers, atst: atsts, speeder }
    );
    const soundButton = createSoundButton(audio, { onEnable: () => soundscape.start() });

    // ------------------------------------------------------------- warm-up
    // Everything that can compile, compiles here — behind the loading screen.
    await loading.phase("compiling pipelines", 0.78);
    shadows.update(rig.camera, sky.sunDir);
    sky.render(rig, 0);
    await terrain.warmUp();
    terrain.update(rig.camera.position, character.position, 0);
    figure.update(0);
    figure.sync(rig.camera.position);
    await figure.warmUp();
    walkers.sync(rig.camera.position);
    await walkers.warmUp();
    walkers2.sync(rig.camera.position);
    await walkers2.warmUp();
    atsts.sync(rig.camera.position);
    await atsts.warmUp();
    troopers.sync(rig.camera.position);
    await troopers.warmUp();
    pilots.sync(rig.camera.position);
    await pilots.warmUp();
    destroyers.update(character.position, rig.camera.position);
    await destroyers.warmUp();
    if (speeder) {
        speeder.update(0);
        speeder?.sync(rig.camera.position);
        await speeder.warmUp();
    }
    for (const w of wingmen) await w.warmUp();
    spray.update(0, rig.camera.position);
    await spray.warmUp();
    await explosions.warmUp();
    await wake.warmUp();
    await spells.warmUp(
        character.position.x + 3, character.position.y, character.position.z + 3
    );
    await whenReady(gfx, sky.material, "sky material");
    await depthPass.warmUp();
    post.update(0, 0, rig.distance);
    const passes = post.passes;
    for (let i = 0; i < passes.length; i++) {
        await whenReady(gfx, passes[i], "post:" + passes[i].name);
    }

    await loading.phase("warming render targets", 0.92);
    // A few real frames so every render target is allocated and every pipeline
    // has actually been bound at least once.
    for (let i = 0; i < 3; i++) {
        renderFrame();
        await loading.nextFrame();
    }
    // Only now: the spell meshes had to be standing *through* those frames for
    // their render pipelines to exist. See `WaterBody.warmUp`.
    spells.finishWarmUp();

    // ------------------------------------------------------------- run loop
    let prev = performance.now();
    let time = 0;
    /** Seconds of opening hold left — set by `startFlyover`, counted here. */
    let introHold = 0;
    /**
     * The AT-AT line's advance bearing, latched from the opening line's own
     * mean heading on the first frame and never recomputed — the formation
     * marches *that* course for the whole battle, wherever the player goes.
     */
    let advanceBearing = null;
    /**
     * The player's fly-in, or null once they have arrived — set by
     * `startFlyover` alongside the escorts' own staging.
     * @type {{toX:number, toZ:number, heading:number}|null}
     */
    let introFly = null;

    gfx.renderer.setAnimationLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

        // The opening hold: escorts overhead, Luke on the wire, stick frozen.
        // Movement only — the mouse still looks around, which is the point of
        // an entrance. Releases with the craft already making way, so control
        // arrives mid-flight rather than from a standstill.
        if (introHold > 0) {
            introHold -= dt;
            input.moveX = 0;
            input.moveZ = 0;
            input.moving = false;
            input.sprint = false;
            input.thrust = false;
            input.boost = false;
            input.vert = 0;
            input.fire = false;
            if (introHold <= 0 && S.speeder === true) {
                const f = character.facing;
                character.velocity.set(Math.sin(f) * 16, 0, Math.cos(f) * 16);
            }
            // The player's entrance: velocity fed straight into the
            // controller, which integrates, terrain-snaps and banks exactly
            // as it does under a stick. The approach slows as it closes, so
            // arrival hands over a craft settling in rather than slamming to
            // a stop — and the hold's own release seeds the forward way.
            if (introFly) {
                const fdx = introFly.toX - character.position.x;
                const fdz = introFly.toZ - character.position.z;
                const remaining = Math.hypot(fdx, fdz);
                if (remaining < 4 || introHold <= 0) {
                    introFly = null;
                } else {
                    const v = Math.min(34, Math.max(12, remaining * 0.45));
                    const h = introFly.heading;
                    character.velocity.set(
                        Math.sin(h) * v, 0, Math.cos(h) * v
                    );
                }
            }
        }

        // Per-system CPU timing. There is no dependable GPU timer in WebGL2, so
        // the overlay's GPU row shows its dash and these rows stay `cpu`.
        const tFrame = performance.now();

        character.update(dt, rig);
        terrain.heightfield.clampToPlayArea(character.position);
        // Pose and simulate before the contact pass: the footprints are stamped
        // at the boot's actual planted position, which only exists once the
        // figure has been solved.
        figure.update(dt);
        contact.update(dt);
        // The walkers only read the player's position, so they can sit anywhere
        // after the controller has moved. Here, so their cost lands in the same
        // row of the overlay as the rest of the scene's inhabitants.
        walkers.update(dt, character.position);
        walkers2.update(dt, character.position);
        atsts.update(dt, character.position);
        troopers.update(dt, character.position);
        pilots.update(dt, character.position);
        // The crash sites burn down and freeze over: smoke and fire for the
        // first half minute, thinning as the heat dies, and then the slow
        // frost — the hull whitening into the field over a couple of minutes.
        for (const wk of wrecks) {
            if (!wk.active) continue;
            wk.age += dt;
            if (wk.burnT > 0) {
                wk.burnT -= dt;
                wk.smokeT -= dt;
                if (wk.smokeT <= 0) {
                    const p = wk.ctl.position;
                    const gy = wk.ctl.groundY;
                    const heat = Math.min(1, wk.burnT / 32);
                    wk.smokeT = 0.1 + (1 - heat) * 0.4;
                    smoke.emit(
                        p.x + (Math.random() - 0.5) * 1.4, gy + 1.1,
                        p.z + (Math.random() - 0.5) * 1.4,
                        (Math.random() - 0.5) * 0.5, 1.2 + Math.random() * 0.8,
                        (Math.random() - 0.5) * 0.5,
                        0.55, 1.6, 2.0 + Math.random(),
                        0.06, 0.06, 0.06, 0.5 * (0.4 + 0.6 * heat), true
                    );
                    if (wk.burnT > 3 && Math.random() < 0.75) {
                        smoke.emit(
                            p.x, gy + 0.7, p.z,
                            (Math.random() - 0.5) * 0.8, 0.9,
                            (Math.random() - 0.5) * 0.8,
                            0.4, 0.8, 0.3 + Math.random() * 0.15,
                            3.0, 1.0, 0.24, 0.7 * heat, false
                        );
                    }
                }
            }
            wk.hull.snowOverride = Math.min(1, wk.age / 150);
            wk.hull.update(dt);
        }
        buzzTroopers();
        // ---- formation discipline ------------------------------------------
        // The herd machinery aims a machine once and never corrects — right
        // for a walker crossing a field, wrong for an escort that belongs to
        // something. Every frame:
        //
        //   scouts    ease straight out of the walkers' keep-clear, so the
        //             lines never merge however the columns converge.
        //   troopers  *steer* — far from their squad station they turn toward
        //             it and press the pace; near it they fall in on the
        //             scout's own heading. A soldier can no longer march off
        //             on a stale bearing, because his bearing is his squad's.
        {
            const wrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
            // AT-AT collision avoidance, over *both* herds as one population.
            // Tempo alone cannot do this: it strings out machines on parallel
            // courses, but these converge on the player from different
            // bearings, so their paths cross and a slowed machine just meets
            // the other later. So the yielding machine (the one further from
            // the player) *steers* — a gentle bend away from anything in its
            // forward cone, at a rate a walker could plausibly turn at,
            // started early enough to be invisible. Tempo still strings out
            // the followers, and a hard emergency floor keeps hulls apart if
            // geometry conspires anyway.
            {
                const scale = /** @type {number} */ (S.walkerScale);
                const look = 95 * scale;   // begin bending away
                const hard = 30 * scale;   // absolute hull floor
                const all = [];
                for (const herd of [walkers, walkers2]) {
                    const n = Math.min(herd.count, herd.walkers.length);
                    for (let i = 0; i < n; i++) all.push(herd.walkers[i]);
                }
                const p = character.position;
                // The line advances as a *formation*: one shared bearing that
                // every machine eases its heading toward, each with a slow
                // personal wander so the line drifts naturally rather than
                // marching a parade. Parallel courses cannot cross, which is
                // the whole fix; the steer/tempo/floor below are the belt
                // over these braces.
                //
                // The bearing is the line's own, latched *once*: the circular
                // mean of the opening line's headings, computed on the first
                // frame and never touched again. Nothing about it ever reads
                // the player's position — not directly, and not laundered
                // through recycled machines re-aiming at placement — so the
                // line can never swing to face them. It marches its course.
                if (all.length) {
                    if (advanceBearing === null) {
                        let sx = 0, sz = 0;
                        for (const w of all) {
                            sx += Math.sin(w.yaw);
                            sz += Math.cos(w.yaw);
                        }
                        advanceBearing = Math.atan2(sx, sz);
                    }
                    for (let i = 0; i < all.length; i++) {
                        const w = all[i];
                        const wander = Math.sin(time * 0.07 + i * 2.1) * 0.09;
                        const want = advanceBearing + wander;
                        w.yaw = wrap(w.yaw + wrap(want - w.yaw) * Math.min(1, dt * 0.5));
                    }
                }
                for (let i = 0; i < all.length; i++) {
                    for (let k = i + 1; k < all.length; k++) {
                        const A = all[i];
                        const B = all[k];
                        const dx = B.position.x - A.position.x;
                        const dz = B.position.z - A.position.z;
                        const d = Math.hypot(dx, dz);
                        if (d >= look) continue;
                        const crowd = 1 - d / look;
                        const dA = Math.hypot(p.x - A.position.x, p.z - A.position.z);
                        const dB = Math.hypot(p.x - B.position.x, p.z - B.position.z);
                        const yieldW = dA > dB ? A : B;
                        const other = dA > dB ? B : A;
                        // Steer: only if the other machine sits ahead-ish of
                        // the yielder's course; bend away from it, harder as
                        // it gets closer.
                        const bearing = Math.atan2(
                            other.position.x - yieldW.position.x,
                            other.position.z - yieldW.position.z
                        );
                        const rel = wrap(bearing - yieldW.yaw);
                        if (Math.abs(rel) < 0.85) {
                            const turn = 0.16 * crowd * (rel >= 0 ? -1 : 1);
                            yieldW.yaw = wrap(yieldW.yaw + turn * dt);
                        }
                        // Tempo still strings the pair out.
                        yieldW._rateWant -= crowd * 0.25;
                        other._rateWant += crowd * 0.1;
                        // Emergency floor: hulls must never interpenetrate,
                        // whatever it costs the gait for a few frames.
                        if (d < hard && d > 1e-3) {
                            const push = (hard - d) * 0.5 * Math.min(1, dt * 3);
                            const nx = dx / d, nz = dz / d;
                            A.position.x -= nx * push;
                            A.position.z -= nz * push;
                            B.position.x += nx * push;
                            B.position.z += nz * push;
                        }
                    }
                }
            }
            // Scouts hold their distance from the armour.
            const an = Math.min(atsts.count, atsts.walkers.length);
            for (const herd of [walkers, walkers2]) {
                const wn = Math.min(herd.count, herd.walkers.length);
                for (let i = 0; i < an; i++) {
                    const a2 = atsts.walkers[i];
                    for (let k = 0; k < wn; k++) {
                        const W = herd.walkers[k];
                        const dx = a2.position.x - W.position.x;
                        const dz = a2.position.z - W.position.z;
                        const d = Math.hypot(dx, dz);
                        const min = 42 * /** @type {number} */ (S.walkerScale);
                        if (d < min && d > 1e-3) {
                            const push = (min - d) * Math.min(1, dt * 3.2);
                            a2.position.x += (dx / d) * push;
                            a2.position.z += (dz / d) * push;
                        }
                    }
                }
            }
            // The squads fall in on their stations.
            const tn = Math.min(troopers.count, troopers.walkers.length);
            for (let i = 0; i < tn; i++) {
                const t = troopers.walkers[i];
                if (t.oneshot) continue;
                const st = trooperStation(i);
                if (st) {
                    const dx = st.x - t.position.x;
                    const dz = st.z - t.position.z;
                    const d = Math.hypot(dx, dz);
                    // Heading: to the station when adrift, the scout's own
                    // when in place. Eased — a soldier turns, he does not snap.
                    const want = d > 5 ? Math.atan2(dx, dz) : st.host.yaw;
                    t.yaw = wrap(t.yaw + wrap(want - t.yaw) * Math.min(1, dt * 2.0));
                    // Tempo: press to catch a station that has pulled ahead,
                    // ease off when overshooting past it. Written onto the
                    // herd's own trim so the feet stay planted at any pace.
                    const ahead = dx * Math.sin(t.yaw) + dz * Math.cos(t.yaw);
                    t._rateWant += Math.max(-0.35, Math.min(0.6, ahead / 18));
                }
                // And never under a walker, whatever the station says.
                for (const herd of [walkers, walkers2]) {
                    const wn = Math.min(herd.count, herd.walkers.length);
                    for (let k = 0; k < wn; k++) {
                        const W = herd.walkers[k];
                        const dx = t.position.x - W.position.x;
                        const dz = t.position.z - W.position.z;
                        const d = Math.hypot(dx, dz);
                        const min = 24 * /** @type {number} */ (S.walkerScale);
                        if (d < min && d > 1e-3) {
                            const push = (min - d) * Math.min(1, dt * 2.2);
                            t.position.x += (dx / d) * push;
                            t.position.z += (dz / d) * push;
                        }
                    }
                }
            }
        }
        speeder?.tick(dt);
        speeder?.update(dt);
        for (const w of wingmen) {
            w.tick(dt);
            w.update(dt);
        }
        const tChar = performance.now();

        _vel.copy(character.velocity);
        // Flying, the rig is handed the craft's heading and chases it itself —
        // see CameraRig.update — rather than the controller stepping rig.yaw.
        rig.update(
            dt, character.position, _vel, character.lean, character.speed01,
            speeder ? character.facing : null
        );

        // Jitters the projection and republishes everything the screen-space
        // passes derive from the camera. Must be after the rig has moved and
        // before anything reads the view-projection — which the depth prepass
        // and the beauty pass both do.
        // The craft's streak when there is a craft: see `Speeder.streak01` for
        // why the character's is the wrong signal in the air.
        post.update(dt, speeder ? speeder.streak01 : character.streak01, rig.distance);
        sky.update();
        sky.render(rig, time);
        shadows.update(rig.camera, sky.sunDir);
        // After the shadow refit, so the water and the ice carry this frame's
        // cascade matrices; before the terrain, so the brushes every spell
        // writes are in the staging array when the simulation pass runs.
        spells.update(dt, rig.camera.position);
        const tSpells = performance.now();
        terrain.update(rig.camera.position, character.position, dt);
        const tTerrain = performance.now();
        // After the shadow refit, so the figure's uniforms carry this frame's
        // cascade matrices rather than last frame's.
        figure.sync(rig.camera.position);
        // Also picks each walker's level of detail, which needs this frame's
        // camera and this frame's field of view.
        walkers.sync(rig.camera.position);
        walkers2.sync(rig.camera.position);
        atsts.sync(rig.camera.position);
        troopers.sync(rig.camera.position);
        pilots.sync(rig.camera.position);
        for (const wk of wrecks) {
            if (wk.active) wk.hull.sync(rig.camera.position);
        }
        speeder?.sync(rig.camera.position);
        for (const w of wingmen) w.sync(rig.camera.position);
        // The fleet holds formation on the player; three matrix writes.
        destroyers.update(character.position, rig.camera.position);
        // The tuning rings, after every transform they pin to has settled.
        muzzleMarkers.begin();
        if (S.showMuzzles) {
            walkers?.collectMuzzles?.(muzzleMarkers);
            walkers2?.collectMuzzles?.(muzzleMarkers);
            speeder?.collectMuzzles?.(muzzleMarkers);
        }
        muzzleMarkers.commit(rig.camera.position);
        // The walkers' eyes, after the herd has settled this frame's heads.
        eyeBands.begin();
        walkers.collectEyes(eyeBands);
        walkers2.collectEyes(eyeBands);
        eyeBands.commit(rig.camera.position);
        // Before the spray: the wake decides where its own lip is, and the
        // grains it sheds have to be in the pool before the pool is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
        smoke.update(dt, rig.camera.position);
        explosions.update(dt, rig.camera.position);
        const tVfx = performance.now();

        // Last, and a pure reader: every signal it mixes on — surf blend, carve
        // load, speed, cast count — has settled by here.
        soundscape.update(dt);
        const tAudio = performance.now();

        renderFrame();
        post.endFrame();
        const tRender = performance.now();

        mark("cpu character", tChar - tFrame);
        mark("cpu spells", tSpells - tChar);
        mark("cpu terrain", tTerrain - tSpells);
        mark("cpu wake+spray", tVfx - tTerrain);
        mark("cpu audio", tAudio - tVfx);
        mark("cpu submit", tRender - tAudio);
        mark("cpu total", tRender - tFrame);

        endFrameDraws();
        stats.triangles =
            (terrain.mesh && terrain.mesh.metadata ? terrain.mesh.metadata.triangles : 0) +
            (S.showCharacter && !FLYING ? figure.triangles : 0) +
            (speeder ? speeder.triangles : 0) +
            wingmen.reduce((t, w) => t + w.triangles, 0) +
            walkers.triangles +
            walkers2.triangles +
            atsts.triangles +
            troopers.triangles +
            pilots.triangles +
            (wake.mesh && wake.mesh.visible ? wake.mesh.metadata.triangles : 0) +
            spells.triangles +
            spray.liveCount * 2;

        sample(dtMs);
        checkSpike(dtMs);
        overlay.update(dtMs, gfx);
        fpsMeter.update(dtMs);

        endFrame();
    });

    // ------------------------------------------------------- audio + the gate
    // Normally already resolved: the download has been running since before the
    // device existed. This phase only shows up on a cold cache or a slow line.
    await loading.phase("loading audio", 0.96);
    await audioReady;
    await filmReady;

    // One click to enter, and that click is also the gesture that makes sound
    // legal. `unlock()` is issued from inside the handler — hence the callback —
    // and merely awaited out here, so the bed is already running by the time the
    // boot screen starts to fade. Skipped entirely if nothing decoded: a button
    // whose only job is to start audio has none when there is no audio.
    /** @type {Promise<boolean>|null} */
    let unlocking = null;
    if (audio.hasAssets) {
        await loading.gate(() => {
            unlocking = audio.unlock();
        });
    }
    if (unlocking) {
        await unlocking;
        soundscape.start();
        // Luke, over the fading boot screen. The transmission square carries
        // its own voice track, so when the film made it down, the standalone
        // line stays quiet — doubling the voice is worse than either alone.
        // The film falls back to it only if it can't play with sound.
        if (!introFilm.ok) {
            audio.play("lukeIntro", { delay: 0.5 });
        }
    }
    soundButton.sync();

    // The instant the player is coming in — boot screen starting its fade —
    // stage the formation behind them, so the escorts thunder overhead in the
    // first seconds of the game rather than at some point during the loading.
    startFlyover();
    // The transmission square, on the same gesture. Ends (or is clicked away)
    // on its own; nothing waits on it.
    introFilm.play(() => audio.play("lukeIntro", { delay: 0.3 }));

    // After the loading screen has gone: it sits at a higher z-index than the
    // overlay, so opening the panel before this would hide it behind a full
    // screen of boot gradient.
    await loading.done();
    if (S.overlayOpen && !overlay.visible) overlay.toggle();
    soundButton.reveal();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SNOWFLOW = {
        gfx, scene: gfx.scene, rig, character, figure, walkers, walkers2, atsts, troopers, pilots, wrecks, speeder, wingman, wingmen, contact, spray, wake, spells, destroyers, explosions,
        overlay, touchControls, terrain, sky, shadows, post, depthPass,
        audio, soundscape,
        S, input, perfStats: stats,
        captureShot,
        /** Fake a cannon burst at (x, z) — for testing the squad's reactions. */
        squadImpact: (x, z) => squadImpact(x, 0, z),
        /**
         * Print the speeder's look settings as a paste-able block.
         *
         * These four are dialled by eye against a moving craft over bright snow,
         * which is not a thing that can be solved on paper — so the loop is drag,
         * look, and read the numbers back out. Logged as source rather than as an
         * object so the answer can go straight into `settings.js`.
         */
        speederTuning() {
            const keys = ["speederFill", "speederTint", "speederRough", "speederAmbient",
                "speederDesat", "jetSpan", "jetDropY", "jetBackZ",
                "jetWidth", "jetLength", "jetFlare",
                "jetGlow", "jetHaloBack",
                "boltR", "boltG", "boltB", "boltWidth", "boltLength", "boltSpeed",
                "boltRange", "muzzleSpan", "muzzleDropY", "muzzleFwdZ",
                "speederClimbMax", "speederClimbRate",
                "surfWidth", "speederStreak",
                // The feel layer, so a session spent dragging the "Speeder
                // feel" sliders reads back out the same way the look does.
                "cinematicCam", "camYawLag", "speederBankLead",
                "speederTurbulence", "camBoostBreath"];
            const w = Math.max(...keys.map((k) => k.length));
            const body = keys
                .map((k) => `    ${k}:${" ".repeat(w - k.length)} ${S[k]},`)
                .join("\n");
            console.log("// speeder look — tuned\n" + body);
            return Object.fromEntries(keys.map((k) => [k, S[k]]));
        },
    };
}

boot().catch((err) => {
    console.error(err);
    loading.fail("Startup failed — see console.");
});
