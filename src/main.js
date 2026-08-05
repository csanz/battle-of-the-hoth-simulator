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
import { SurfWake } from "./vfx/surfWake.js";
import { SpellSystem } from "./spells/spellSystem.js";
import { WalkerHerd } from "./walkers/walker.js";
import { loadWalkerAsset } from "./walkers/walkerAsset.js";
import { Speeder } from "./player/speeder.js";
import { Overlay } from "./ui/overlay.js";
import { createFpsMeter } from "./ui/fpsMeter.js";
import { Sky } from "./render/sky.js";
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
    const speederReady = FLYING ? loadWalkerAsset("models/speeder") : null;

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

    // Airborne snow: footfall kick now, the surf plume and spell spray later.
    const spray = new SprayField(gfx, terrain, sky, shadows);
    // Tuning rings on the gun heads, live under the overlay's muzzle sliders.
    const muzzleMarkers = new MuzzleMarkers(gfx);
    muzzleMarkers.bindCamera(rig.camera.viewProjection);

    // ------------------------------------------------------------ the speeder
    /** @type {Speeder|null} */
    const speeder = FLYING
        ? new Speeder(gfx, terrain, sky, shadows, await speederReady, character, spray)
        : null;
    speeder?.registerPrepass(depthPass);
    speeder?.setVisible(true);
    showFigure();

    // The walkers' cannons throw snow into the same pool everything else does.
    walkers.setSpray(spray);

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
    spells.registerPrepass(depthPass);

    // The rig needs ground heights to keep the spring arm above the snow.
    rig.groundAt = (x, z) => terrain.heightAt(x, z);

    // The opening shot, if one has been pinned. Before the warm-up, so the
    // frames rendered behind the loading screen are already the shot rather than
    // wherever the default rule put things.
    applyOpening(OPENING, rig, character, walkers, terrain);

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

    const overlay = new Overlay({ rig, character });
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
    // F2 snapshots the camera, the player and the herd as a paste-able block.
    // See `core/openingShot.js` for what to do with it.
    const captureShot = installShotCapture(rig, character, walkers);

    // The soundscape reads game state; nothing in the game knows it exists. It
    // stays silent until `start()`, which only happens on the gesture that
    // unlocks the engine — the boot gate below, or the corner button later.
    const soundscape = new Soundscape(
        audio, { controller: character, spells, walkers, speeder }
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
    if (speeder) {
        speeder.update(0);
        speeder?.sync(rig.camera.position);
        await speeder.warmUp();
    }
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

    gfx.renderer.setAnimationLoop(() => {
        const now = performance.now();
        let dtMs = now - prev;
        prev = now;
        if (dtMs > 100) dtMs = 100;
        const dt = S.freezeTime ? 0 : dtMs / 1000;
        time += dt;

        pollInput();

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
        speeder?.tick(dt);
        speeder?.update(dt);
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
        speeder?.sync(rig.camera.position);
        // The tuning rings, after every transform they pin to has settled.
        muzzleMarkers.begin();
        if (S.showMuzzles) {
            walkers?.collectMuzzles?.(muzzleMarkers);
            speeder?.collectMuzzles?.(muzzleMarkers);
        }
        muzzleMarkers.commit(rig.camera.position);
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
            walkers.triangles +
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
    }
    soundButton.sync();

    // After the loading screen has gone: it sits at a higher z-index than the
    // overlay, so opening the panel before this would hide it behind a full
    // screen of boot gradient.
    await loading.done();
    if (S.overlayOpen && !overlay.visible) overlay.toggle();
    soundButton.reveal();
    setTimeout(() => overlay.resetSpikes(), 800);

    globalThis.SNOWFLOW = {
        gfx, scene: gfx.scene, rig, character, figure, walkers, speeder, contact, spray, wake, spells,
        overlay, touchControls, terrain, sky, shadows, post, depthPass,
        audio, soundscape,
        S, input, perfStats: stats,
        captureShot,
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
