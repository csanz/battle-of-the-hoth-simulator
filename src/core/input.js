/**
 * Raw input state. Everything lands in one mutable struct that systems poll —
 * no events fired into game code, no per-frame allocation.
 *
 * Mouse look uses pointer lock, which frees the right button for snow-surf.
 *
 * Touch is a second writer into the same struct rather than a second path
 * through the game. `ui/touchControls.js` fills in `touch` below and adds
 * straight into `lookX` / `lookY` / `zoomDelta`, so nothing downstream of here
 * knows or cares which one moved the character. The one place the two have to be
 * reconciled is `pollInput`, because keys and a stick both claim the movement
 * axes and whichever is actually being used has to win.
 */

import { S } from "./settings.js";

export const input = {
    // Movement axes, camera-relative, already normalised to a unit disc.
    moveX: 0,
    moveZ: 0,
    moving: false,

    // Accumulated mouse delta since last `endFrame()`, in radians.
    lookX: 0,
    lookY: 0,

    // Zoom, consumed by the camera rig.
    zoomDelta: 0,

    surf: false, // space or RMB held — the snow-surf slide
    fire: false, // the same two, when the player is flying rather than surfing
    sprint: false, // shift
    /**
     * E altitude ladder, flying only: 1 rides the deck with the snow effects
     * on, 2 and 3 climb clean above them. E steps up and wraps back to the
     * deck. Starts at the top rung — the game opens at altitude.
     */
    riseLevel: 3,

    // The throttle flight scheme (`S.flightThrottle`), all three inert in the
    // classic scheme and on foot — see pollInput.
    thrust: false, // shift — the throttle
    boost: false, // E (or Q) — the reheat
    vert: 0, // S climbs (+1), W dives (-1)

    /** @type {number} 0 = none, else 1..5 — set on keydown, cleared each frame */
    spellPressed: 0,
    /** @type {boolean} spell 2 (Ribbon) is a held cast */
    spellHeld2: false,

    locked: false,
};

/**
 * What the on-screen stick and buttons are saying this frame.
 *
 * Separate from `input` rather than written into it directly: `pollInput`
 * rebuilds the movement axes from scratch every frame off the held keys, so a
 * stick that wrote `input.moveX` would be erased before anything read it.
 */
export const touch = {
    /** True once a real touch has been seen and the rig is up. */
    present: false,
    /** Stick deflection, already dead-zoned and clamped to a unit disc. */
    x: 0,
    z: 0,
    active: false,
    sprint: false,
    surf: false,
};

const keys = Object.create(null);

const LOOK_SCALE = 0.0022;

/**
 * Right mouse held. Kept separate from `input.surf` because the slide has two
 * bindings now — this and the space bar — and `pollInput` has to OR them rather
 * than let whichever was released last decide.
 */
let rmbHeld = false;

/** Set once a touch has been seen on the canvas; suppresses the pointer lock. */
let touchSeen = false;

/** @type {(() => void)|null} */
let onToggleOverlay = null;
/** @type {(() => void)|null} */
let onToggleFps = null;

/**
 * @param {HTMLCanvasElement} canvas
 * @param {{ onToggleOverlay?: () => void, onToggleFps?: () => void }} [hooks]
 */
export function initInput(canvas, hooks) {
    onToggleOverlay = hooks?.onToggleOverlay ?? null;
    onToggleFps = hooks?.onToggleFps ?? null;

    // Pointer lock is a mouse idea. Asking for it from a touch tap does nothing
    // useful on any engine and throws on some, and on a hybrid laptop it would
    // capture the cursor the moment somebody prodded the screen.
    canvas.addEventListener("pointerdown", (e) => {
        if (e.pointerType === "touch") touchSeen = true;
    });

    canvas.addEventListener("click", () => {
        if (touchSeen || input.locked) return;
        canvas.requestPointerLock();
    });

    document.addEventListener("pointerlockchange", () => {
        input.locked = document.pointerLockElement === canvas;
        if (!input.locked) {
            // Drop held state so the character doesn't run off while unfocused.
            for (const k in keys) keys[k] = false;
            rmbHeld = false;
            input.surf = false;
            input.spellHeld2 = false;
        }
    });

    document.addEventListener("mousemove", (e) => {
        if (!input.locked) return;
        input.lookX += e.movementX * LOOK_SCALE;
        input.lookY += e.movementY * LOOK_SCALE;
    });

    canvas.addEventListener("contextmenu", (e) => e.preventDefault());

    document.addEventListener("mousedown", (e) => {
        if (!input.locked) return;
        if (e.button === 2) rmbHeld = true;
    });

    document.addEventListener("mouseup", (e) => {
        if (e.button === 2) rmbHeld = false;
    });

    document.addEventListener(
        "wheel",
        (e) => {
            if (!input.locked) return;
            e.preventDefault();
            input.zoomDelta += e.deltaY * 0.0016;
        },
        { passive: false }
    );

    window.addEventListener("keydown", (e) => {
        // Overlay toggle works whether or not the pointer is locked.
        if (e.code === "F1" || e.code === "Backquote") {
            e.preventDefault();
            onToggleOverlay?.();
            return;
        }
        // F shows the frame rate on its own, for when the full panel would cover
        // the thing being measured. Same rule as the overlay: works locked or not.
        if (e.code === "KeyF") {
            e.preventDefault();
            if (!e.repeat) onToggleFps?.();
            return;
        }
        // E is a ladder, not a hold: each tap steps the craft up a rung —
        // deck, mid, high — and wraps back to the deck past the top. The
        // controller eases every transition both ways. Under the throttle
        // scheme W/S own the vertical instead, and E falls through to the
        // held keys as the reheat.
        if (e.code === "KeyE" && S.flightThrottle !== true) {
            if (!e.repeat) {
                input.riseLevel = input.riseLevel >= 3 ? 1 : input.riseLevel + 1;
            }
            return;
        }
        // Space is the slide. Swallowed here so it cannot also scroll the page or
        // re-activate whatever button was clicked last — the sound button is one
        // keystroke from the canvas, and a space that toggles the mixer while the
        // player is trying to carve is not a slide binding.
        if (e.code === "Space") e.preventDefault();
        if (e.repeat) return;
        keys[e.code] = true;

        const n = SPELL_KEYS[e.code];
        if (n) {
            input.spellPressed = n;
            if (n === 2) input.spellHeld2 = true;
        }
    });

    window.addEventListener("keyup", (e) => {
        keys[e.code] = false;
        if (SPELL_KEYS[e.code] === 2) input.spellHeld2 = false;
    });

    window.addEventListener("blur", () => {
        for (const k in keys) keys[k] = false;
        rmbHeld = false;
        input.surf = false;
        input.spellHeld2 = false;
        // A backgrounded tab gets no pointerup, so a held stick or slide button
        // would still be held when the player came back.
        touch.active = false;
        touch.surf = false;
        touch.sprint = false;
        touch.x = 0;
        touch.z = 0;
    });
}

const SPELL_KEYS = {
    Digit1: 1,
    Digit2: 2,
    Digit3: 3,
    Digit4: 4,
    Digit5: 5,
};

/** Resolve held keys into movement axes. Called once per frame before update. */
export function pollInput() {
    let x = 0;
    let z = 0;
    if (keys.KeyW || keys.ArrowUp) z += 1;
    if (keys.KeyS || keys.ArrowDown) z -= 1;
    if (keys.KeyD || keys.ArrowRight) x += 1;
    if (keys.KeyA || keys.ArrowLeft) x -= 1;

    const flying = S.speeder !== false;
    const throttle = flying && S.flightThrottle === true;

    // Clamp to a unit disc so diagonals aren't faster. Not under the throttle
    // scheme, where W/S are the vertical rather than an axis sharing the disc
    // with the steer — normalising would soften A/D whenever they are held.
    let len = Math.sqrt(x * x + z * z);
    if (len > 1 && !throttle) {
        x /= len;
        z /= len;
        len = 1;
    }

    // The stick wins while it is being held, rather than summing with the keys:
    // a device with both is one player using one of them at a time, and adding
    // the two would let a stick at full deflection plus a key exceed the disc
    // the clamp above exists to enforce.
    if (touch.active) {
        x = touch.x;
        z = touch.z;
        len = Math.hypot(x, z);
    }

    input.moveX = x;
    input.moveZ = z;
    input.moving = len > 0.001;
    const shift = !!(keys.ShiftLeft || keys.ShiftRight) || touch.sprint;
    input.sprint = shift;

    // The throttle scheme's own axes, dead outside it. Shift (or the touch
    // sprint button) opens the throttle, E or Q lights the reheat, and W/S
    // fly the craft down and up — stick-style, push forward to descend. On
    // touch the stick's vertical axis is the climb.
    input.thrust = throttle && shift;
    input.boost = throttle && !!(keys.KeyE || keys.KeyQ);
    input.vert = !throttle ? 0
        : touch.active ? touch.z
            : (keys.KeyS || keys.ArrowDown ? 1 : 0) - (keys.KeyW || keys.ArrowUp ? 1 : 0);

    // Any binding holds the slide; releasing one while another is down must not
    // end it.
    // One trigger, two meanings. On foot it is the slide; in the speeder there is
    // no slide to hold — the craft always hovers — so the same key fires the guns
    // and the surf blend is pinned shut. Doing it here rather than in either
    // consumer keeps "what is the player holding" in the one place that already
    // answers that question.
    const held = rmbHeld || !!keys.Space || touch.surf;
    // Flying, the slide is held *permanently*. That is not a trick to save a
    // controller: the momentum-carrying mode is what the craft's motion should
    // feel like — thrust, drift, grip that bleeds into a slide through a hard
    // turn — and a repulsorlift has no walking gear to fall back to. It also
    // frees the key, which is the whole reason the trigger is on it.
    input.surf = flying ? true : held;
    input.fire = flying ? held : false;
}

/** Clear per-frame accumulators. Called at the very end of the frame. */
export function endFrame() {
    input.lookX = 0;
    input.lookY = 0;
    input.zoomDelta = 0;
    input.spellPressed = 0;
}

export function isDown(code) {
    return !!keys[code];
}
