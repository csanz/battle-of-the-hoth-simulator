/**
 * The opening shot — pinned, or computed.
 *
 * By default this file does nothing: `OPENING` is null, and the herd frames
 * itself against the sun and the window (see `place()` in `walkers/walker.js`).
 * That rule is aspect-aware and holds up from a phone to an ultrawide, which a
 * fixed set of coordinates cannot.
 *
 * But a rule is not a composition, and sometimes the shot you want is a
 * particular machine on a particular ridge with the sun in a particular gap.
 * For that: fly the camera there, arrange the walkers, press **F2**, and paste
 * what lands on the clipboard into `OPENING` below. The next load starts exactly
 * there — camera, player and every walker — and nothing else in the demo has to
 * know it was authored rather than derived.
 *
 *   F2                     capture the current shot to the clipboard, and log it
 *   SNOWFLOW.captureShot() the same thing, from the console
 *
 * Pinned coordinates are absolute, so a pinned shot is a fixed aspect ratio's
 * shot: it will frame differently on a phone than on the monitor it was authored
 * on. That is the trade — exactness for adaptability — and it is why the default
 * is the rule rather than a capture.
 */

/**
 * @typedef {{
 *   camera: { yaw: number, pitch: number, distance: number },
 *   player: { x: number, z: number },
 *   walkers: Array<{ x: number, z: number, yaw: number, phase?: number }>,
 * }} OpeningShot
 */

/**
 * Paste a captured block here to pin the opening. Leave null to let the herd
 * frame itself.
 * @type {OpeningShot|null}
 */
export const OPENING = null;

/**
 * Put the world into a captured shot.
 *
 * Called once at boot, before the first frame, so nothing has moved yet and no
 * system has read a position it would have to be told about again.
 *
 * @param {OpeningShot} shot
 * @param {import("./camera.js").CameraRig} rig
 * @param {import("../character/controller.js").CharacterController} character
 * @param {import("../walkers/walker.js").WalkerHerd} herd
 * @param {{ heightAt(x: number, z: number): number }} terrain
 */
export function applyOpening(shot, rig, character, herd, terrain) {
    if (!shot) return;

    if (shot.camera) {
        rig.yaw = shot.camera.yaw;
        rig.pitch = shot.camera.pitch;
        rig.distance = rig.distanceTarget = shot.camera.distance;
    }

    if (shot.player) {
        character.position.x = shot.player.x;
        character.position.z = shot.player.z;
        character.position.y = terrain.heightAt(shot.player.x, shot.player.z);
    }

    const list = shot.walkers || [];
    // Grow the herd to match rather than silently dropping the tail: a shot with
    // four machines in it is a shot with four machines in it.
    if (list.length) herd.setCount(list.length);
    for (let i = 0; i < list.length && i < herd.walkers.length; i++) {
        const w = herd.walkers[i];
        const s = list[i];
        w.position.x = s.x;
        w.position.z = s.z;
        w.position.y = terrain.heightAt(s.x, s.z);
        w.yaw = s.yaw;
        if (s.phase !== undefined) w.phase = s.phase;
        // Placed, so the recycle later on mirrors this heading rather than
        // re-deriving the opening framing halfway through a run.
        w._placed = true;
        w._settled = false;
    }
}

/**
 * Snapshot the world as a paste-able `OPENING` block.
 *
 * @param {import("./camera.js").CameraRig} rig
 * @param {import("../character/controller.js").CharacterController} character
 * @param {import("../walkers/walker.js").WalkerHerd} herd
 * @returns {string}
 */
export function captureOpening(rig, character, herd) {
    const n = (v) => Number(v.toFixed(3));
    const walkers = herd.walkers.slice(0, herd.count).map((w) => ({
        x: n(w.position.x),
        z: n(w.position.z),
        yaw: n(w.yaw),
        phase: n(w.phase),
    }));

    const lines = [
        "export const OPENING = {",
        `    camera: { yaw: ${n(rig.yaw)}, pitch: ${n(rig.pitch)}, ` +
            `distance: ${n(rig.distanceTarget)} },`,
        `    player: { x: ${n(character.position.x)}, z: ${n(character.position.z)} },`,
        "    walkers: [",
        ...walkers.map(
            (w) => `        { x: ${w.x}, z: ${w.z}, yaw: ${w.yaw}, phase: ${w.phase} },`
        ),
        "    ],",
        "};",
    ];
    return lines.join("\n");
}

/**
 * Wire F2 to the capture.
 *
 * The clipboard write is best-effort: it needs a secure context and can be
 * refused, and a capture that only reaches the console is still a capture.
 */
export function installShotCapture(rig, character, herd) {
    const capture = () => {
        const text = captureOpening(rig, character, herd);
        console.log(
            "%c[opening shot] paste into src/core/openingShot.js",
            "color:#8fc4e8", "\n\n" + text + "\n"
        );
        navigator.clipboard?.writeText(text).then(
            () => console.log("[opening shot] copied to clipboard"),
            () => console.log("[opening shot] clipboard refused — copy it from above")
        );
        return text;
    };

    window.addEventListener("keydown", (e) => {
        if (e.code !== "F2") return;
        e.preventDefault();
        capture();
    });

    return capture;
}
