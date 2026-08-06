/**
 * SNOWFLOW — entry point and frame orchestration.
 *
 * WebGL2 only, by design (this build; the original was WebGPU-only). Three.js
 * is a rasterizer here — no feature-detect branches: if the context or the
 * float render targets aren't there we say so once and stop.
 */

import * as THREE from "three";

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
import { MuzzleMarkers } from "./vfx/muzzleMarkers.js";
import { EyeBands } from "./vfx/eyeBands.js";
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
import { OPENING, applyOpening, installShotCapture } from "./core/openingShot.js";

// ------------------------------------------------------- module-scope scratch
const _vel = new THREE.Vector3();

/** Beauty clear — linear (§2.6). */
const CLEAR_COLOR = [0.02, 0.03, 0.05, 1];

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
    // Same reasoning for the walkers: 4.4 MB of geometry, three levels of detail
    // and one baked gait, none of which needs a device to arrive. It is awaited
    // well after the terrain.
    const walkerReady = loadWalkerAsset("models/walker");
    // The AT-ST escort rides the same loader and the same herd machinery —
    // and so does the infantry walking beside it.
    const atstReady = loadWalkerAsset("models/atst");
    const trooperReady = loadWalkerAsset("models/trooper");
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
    const walkers = new WalkerHerd(gfx, terrain, sky, shadows, await walkerReady, rig);
    onChange("showWalker", (v) => walkers.setVisible(v));
    walkers.registerPrepass(depthPass);

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
        spawnDistance: () => 500,
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
        fire: () => false,
        headLook: () => false,
        separation: () => 2.2,
        sink: () => 0.12,
        anchor: (i) => {
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
            return {
                x: host.position.x + Math.sin(back) * r,
                z: host.position.z + Math.cos(back) * r,
            };
        },
    });
    troopers.registerPrepass(depthPass);
    onChange("showAtst", (v) => {
        atsts.setVisible(v);
        troopers.setVisible(v);
    });

    // Airborne snow: footfall kick now, the surf plume and spell spray later.
    const spray = new SprayField(gfx, terrain, sky, shadows);
    // Tuning rings on the gun heads, live under the overlay's muzzle sliders.
    const muzzleMarkers = new MuzzleMarkers(gfx);
    muzzleMarkers.bindCamera(rig.camera.viewProjection);
    // The walkers' red viewport bands — content, not tooling, so always on.
    const eyeBands = new EyeBands(gfx);
    eyeBands.bindCamera(rig.camera.viewProjection);

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
    speeder?.setVisible(true);
    showFigure();

    // The walkers' cannons throw snow into the same pool everything else does —
    // and the escort's, whose slimmer bolts kick up proportionally less of it.
    walkers.setSpray(spray);
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
    atsts.onMaterial = (m) => spells.addConsumers(m);
    for (const w of atsts.walkers) spells.addConsumers(w.material);
    troopers.onMaterial = (m) => spells.addConsumers(m);
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
        const lukeEnd = 0.5 + (audio.buffers.get("lukeIntro")?.duration ?? 3.5);
        introHold = Math.max(5.4, lukeEnd);
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
    atsts.sync(rig.camera.position);
    await atsts.warmUp();
    troopers.sync(rig.camera.position);
    await troopers.warmUp();
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
        atsts.update(dt, character.position);
        troopers.update(dt, character.position);
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
        atsts.sync(rig.camera.position);
        troopers.sync(rig.camera.position);
        speeder?.sync(rig.camera.position);
        for (const w of wingmen) w.sync(rig.camera.position);
        // The fleet holds formation on the player; three matrix writes.
        destroyers.update(character.position, rig.camera.position);
        // The tuning rings, after every transform they pin to has settled.
        muzzleMarkers.begin();
        if (S.showMuzzles) {
            walkers?.collectMuzzles?.(muzzleMarkers);
            speeder?.collectMuzzles?.(muzzleMarkers);
        }
        muzzleMarkers.commit(rig.camera.position);
        // The walkers' eyes, after the herd has settled this frame's heads.
        eyeBands.begin();
        walkers.collectEyes(eyeBands);
        eyeBands.commit(rig.camera.position);
        // Before the spray: the wake decides where its own lip is, and the
        // grains it sheds have to be in the pool before the pool is uploaded.
        wake.update(dt, rig.camera.position);
        spray.update(dt, rig.camera.position);
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
            atsts.triangles +
            troopers.triangles +
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
        // Luke, over the fading boot screen — a beat after the click so the
        // context is warm and the line lands clean.
        audio.play("lukeIntro", { delay: 0.5 });
    }
    soundButton.sync();

    // The instant the player is coming in — boot screen starting its fade —
    // stage the formation behind them, so the escorts thunder overhead in the
    // first seconds of the game rather than at some point during the loading.
    startFlyover();

    // After the loading screen has gone: it sits at a higher z-index than the
    // overlay, so opening the panel before this would hide it behind a full
    // screen of boot gradient.
    await loading.done();
    if (S.overlayOpen && !overlay.visible) overlay.toggle();
    soundButton.reveal();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SNOWFLOW = {
        gfx, scene: gfx.scene, rig, character, figure, walkers, atsts, troopers, speeder, wingman, wingmen, contact, spray, wake, spells, destroyers,
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
