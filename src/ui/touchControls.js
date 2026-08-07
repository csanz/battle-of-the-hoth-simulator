/**
 * Touch controls — the on-screen rig for phones and tablets.
 *
 * Hand-rolled rather than nipplejs or one of the other standard sticks, for one
 * reason: those libraries own a DOM node and emit events, and this demo's input
 * is a single mutable struct that systems poll once a frame with no events
 * anywhere in it. Bridging one would mean a listener that writes into `input`
 * every move — which is the whole of what a stick is — plus a dependency, plus a
 * second set of visual conventions to reconcile with the overlay. The stick
 * below is the standard one: fixed base, floating recentre, dead zone, radius
 * clamp, unit-disc output.
 *
 * The layout is the one every twin-stick game on a phone uses, because it is the
 * one thumbs are already trained on:
 *
 *   left half    the stick. It recentres wherever the thumb lands, so there is
 *                no hunting for a fixed base you cannot see under your own hand.
 *   right half   look. Drag to turn, pinch to zoom.
 *   bottom right fire, with the climb/descend pair above it.
 *   top left     settings, because there is no F1 on a phone and the overlay
 *                itself lives down the right edge.
 *
 * Every control is its own pointer id. Multi-touch falls out of that: the stick
 * tracks the pointer that started on it and nothing else, so steering while
 * looking while holding the slide is three independent captures rather than a
 * gesture recogniser.
 *
 * Nothing here runs — nothing is even visible — until a real touch arrives. A
 * laptop with a touchscreen is a mouse-and-keyboard machine until somebody puts
 * a finger on it, and a joystick pasted over the corner of that screen is worse
 * than no joystick at all.
 */

import { input, touch } from "../core/input.js";

/** Radians per pixel of look drag. Above the mouse's, because a thumb travels
 *  a fraction of the distance a mouse does before it runs out of screen. */
const LOOK_SCALE = 0.0034;
/** Stick radius in px — the throw from centre to full deflection. */
const RADIUS = 62;
/** Fraction of the radius that reads as zero, so a resting thumb does not creep. */
const DEAD_ZONE = 0.14;
/** Deflection past which the character sprints, so there is no sprint button. */
const SPRINT_AT = 0.86;
/** Pinch scale, matched to the wheel's feel at a typical two-finger spread. */
const PINCH_SCALE = 0.004;

const CSS = `
#tc {
  position: fixed; inset: 0; z-index: 60;
  pointer-events: none;
  touch-action: none;
  -webkit-user-select: none; user-select: none;
  -webkit-tap-highlight-color: transparent;
  opacity: 0; transition: opacity 400ms ease;
}
#tc.on { opacity: 1; }

/* The look surface sits under everything else in the layer and takes whatever
   the controls did not, so there is no hit-testing to write. */
#tc .look { position: absolute; inset: 0; pointer-events: auto; }

#tc .stick {
  position: absolute; left: 0; bottom: 0;
  width: 48%; height: 62%;
  pointer-events: auto;
}
#tc .base, #tc .knob {
  position: absolute; border-radius: 50%;
  transform: translate(-50%, -50%);
  pointer-events: none;
  transition: opacity 220ms ease;
}
#tc .base {
  width: ${RADIUS * 2}px; height: ${RADIUS * 2}px;
  border: 1px solid rgba(143, 196, 232, 0.20);
  background: rgba(8, 12, 19, 0.28);
  backdrop-filter: blur(6px);
  opacity: 0.5;
}
#tc .knob {
  width: 54px; height: 54px;
  border: 1px solid rgba(143, 196, 232, 0.4);
  background: rgba(143, 196, 232, 0.14);
  opacity: 0.75;
}
#tc .stick.held .base { opacity: 0.85; }
#tc .stick.held .knob { opacity: 1; background: rgba(143, 196, 232, 0.26); }

#tc .btn {
  position: absolute; pointer-events: auto;
  display: grid; place-items: center;
  border: 1px solid rgba(143, 196, 232, 0.18);
  border-radius: 3px;
  background: rgba(8, 12, 19, 0.5);
  backdrop-filter: blur(10px);
  color: rgba(219, 230, 242, 0.62);
  font: inherit; font-size: 10px; font-weight: 400;
  letter-spacing: 0.18em; text-indent: 0.18em; text-transform: uppercase;
  transition: background 120ms ease, color 120ms ease, border-color 120ms ease;
}
#tc .btn.down {
  background: rgba(143, 196, 232, 0.24);
  border-color: rgba(143, 196, 232, 0.5);
  color: #eaf4ff;
}

#tc .fire {
  right: 20px; bottom: calc(24px + env(safe-area-inset-bottom, 0px));
  width: 108px; height: 62px; border-radius: 34px;
}
#tc .alt {
  right: 26px; width: 54px; height: 54px; border-radius: 50%;
  letter-spacing: 0; text-indent: 0; font-size: 16px;
}
/* The opening hint is centred on the bottom edge, which on a phone is where the
   fire button and the altitude pair are. Lifted above them and narrowed to clear
   the right-hand stack; it fades out after a few seconds either way. */
body.touch #hint {
  bottom: calc(108px + env(safe-area-inset-bottom, 0px));
  max-width: 58vw;
  line-height: 1.9;
}

#tc .gear {
  left: calc(14px + env(safe-area-inset-left, 0px));
  top: calc(14px + env(safe-area-inset-top, 0px));
  width: 34px; height: 34px;
  letter-spacing: 0; text-indent: 0; font-size: 13px;
}
`;

/**
 * Build the rig. Returns a handle with `dispose()`; nothing else needs poking
 * from outside, because everything it produces goes into `input`.
 *
 * @param {{ onToggleOverlay?: () => void }} [hooks]
 */
export function createTouchControls(hooks) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const root = document.createElement("div");
    root.id = "tc";
    root.innerHTML = `
      <div class="look"></div>
      <div class="stick">
        <div class="base"></div>
        <div class="knob"></div>
      </div>
      <button class="btn fire" type="button">fire</button>
      <button class="btn alt up" type="button" aria-label="climb">&#9650;</button>
      <button class="btn alt down" type="button" aria-label="descend">&#9660;</button>
      <button class="btn gear" type="button" aria-label="settings">&#9881;</button>
    `;
    document.body.appendChild(root);

    const look = /** @type {HTMLElement} */ (root.querySelector(".look"));
    const stick = /** @type {HTMLElement} */ (root.querySelector(".stick"));
    const base = /** @type {HTMLElement} */ (root.querySelector(".base"));
    const knob = /** @type {HTMLElement} */ (root.querySelector(".knob"));
    const fireBtn = /** @type {HTMLElement} */ (root.querySelector(".fire"));
    const upBtn = /** @type {HTMLElement} */ (root.querySelector(".alt.up"));
    const downBtn = /** @type {HTMLElement} */ (root.querySelector(".alt.down"));
    const gearBtn = /** @type {HTMLElement} */ (root.querySelector(".gear"));

    // The altitude pair, stacked above the trigger: taps ride the same E
    // ladder the keyboard uses — up a rung toward the ceiling, down a rung
    // toward the deck. (The walking demo's five spell buttons lived here;
    // flying hides the whole spell system, so they went with it.)
    upBtn.style.bottom = "calc(170px + env(safe-area-inset-bottom, 0px))";
    downBtn.style.bottom = "calc(104px + env(safe-area-inset-bottom, 0px))";

    // ------------------------------------------------------------------ stick
    let stickId = -1;
    let originX = 0, originY = 0;
    const restX = RADIUS + 34;

    const placeStick = (x, y) => {
        const r = stick.getBoundingClientRect();
        base.style.left = knob.style.left = `${x - r.left}px`;
        base.style.top = knob.style.top = `${y - r.top}px`;
    };
    const restStick = () => {
        const r = stick.getBoundingClientRect();
        const x = r.left + restX;
        const y = r.bottom - RADIUS - 46;
        originX = x; originY = y;
        placeStick(x, y);
    };
    restStick();
    window.addEventListener("resize", restStick);

    stick.addEventListener("pointerdown", (e) => {
        if (stickId !== -1) return;
        stickId = e.pointerId;
        try { stick.setPointerCapture(e.pointerId); } catch { /* released already */ }
        stick.classList.add("held");
        // Recentre under the thumb. A base you cannot see because your own hand
        // is on top of it is a base you will miss.
        originX = e.clientX;
        originY = e.clientY;
        placeStick(originX, originY);
        e.preventDefault();
    });

    stick.addEventListener("pointermove", (e) => {
        if (e.pointerId !== stickId) return;
        const dx = e.clientX - originX;
        const dy = e.clientY - originY;
        const len = Math.hypot(dx, dy);

        // Direction first, off the *unclamped* delta — clamping and then
        // normalising divides the direction by the clamped length and skews
        // every reading once the thumb travels past the ring.
        const ux = len > 1e-4 ? dx / len : 0;
        const uy = len > 1e-4 ? dy / len : 0;
        const throwPx = Math.min(len, RADIUS);

        const r = stick.getBoundingClientRect();
        knob.style.left = `${originX - r.left + ux * throwPx}px`;
        knob.style.top = `${originY - r.top + uy * throwPx}px`;

        // Dead zone rescaled rather than clipped, so the first millimetre of
        // real movement starts from zero instead of stepping to 0.14.
        const mag = throwPx / RADIUS;
        const scaled = mag <= DEAD_ZONE ? 0 : (mag - DEAD_ZONE) / (1 - DEAD_ZONE);
        if (scaled <= 0) {
            touch.x = 0; touch.z = 0; touch.active = false; touch.sprint = false;
            return;
        }
        touch.x = ux * scaled;
        // Screen down is world back: the stick's Y is negated into the forward
        // axis, which is the convention `pollInput` gives the W key.
        touch.z = -uy * scaled;
        touch.active = true;
        touch.sprint = mag > SPRINT_AT;
    });

    const releaseStick = (e) => {
        if (e.pointerId !== stickId) return;
        stickId = -1;
        stick.classList.remove("held");
        touch.x = 0; touch.z = 0; touch.active = false; touch.sprint = false;
        restStick();
    };
    stick.addEventListener("pointerup", releaseStick);
    stick.addEventListener("pointercancel", releaseStick);

    // ------------------------------------------------------------------- look
    /** @type {Map<number, {x:number, y:number}>} live pointers on the look surface */
    const looks = new Map();
    let pinchDist = 0;

    look.addEventListener("pointerdown", (e) => {
        try { look.setPointerCapture(e.pointerId); } catch { /* released already */ }
        looks.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (looks.size === 2) pinchDist = spread(looks);
        e.preventDefault();
    });

    look.addEventListener("pointermove", (e) => {
        const prev = looks.get(e.pointerId);
        if (!prev) return;
        const dx = e.clientX - prev.x;
        const dy = e.clientY - prev.y;
        prev.x = e.clientX;
        prev.y = e.clientY;

        if (looks.size >= 2) {
            // Two fingers is a pinch, not a look — turning the camera at the same
            // time makes the zoom feel like a slip.
            const d = spread(looks);
            input.zoomDelta -= (d - pinchDist) * PINCH_SCALE;
            pinchDist = d;
            return;
        }
        input.lookX += dx * LOOK_SCALE;
        input.lookY += dy * LOOK_SCALE;
    });

    const endLook = (e) => {
        looks.delete(e.pointerId);
        if (looks.size === 2) pinchDist = spread(looks);
    };
    look.addEventListener("pointerup", endLook);
    look.addEventListener("pointercancel", endLook);

    // ---------------------------------------------------------------- buttons
    bindButton(fireBtn, () => { touch.surf = true; }, () => { touch.surf = false; });
    bindButton(upBtn, () => {
        input.riseLevel = Math.min(3, (input.riseLevel || 1) + 1);
    }, null);
    bindButton(downBtn, () => {
        input.riseLevel = Math.max(1, (input.riseLevel || 1) - 1);
    }, null);
    bindButton(gearBtn, () => hooks?.onToggleOverlay?.(), null);

    // ----------------------------------------------------------------- reveal
    // The first genuine touch anywhere on the page turns the rig on. A pointer
    // event is the only honest signal — `maxTouchPoints` is non-zero on plenty of
    // laptops nobody will ever touch.
    let shown = false;
    const reveal = (e) => {
        if (shown || e.pointerType !== "touch") return;
        shown = true;
        root.classList.add("on");
        document.body.classList.add("touch");
        touch.present = true;
        restStick();
        const hint = document.getElementById("hint");
        if (hint) hint.textContent = "stick to fly · drag to look · hold fire";
    };
    window.addEventListener("pointerdown", reveal, { capture: true });

    return {
        get visible() { return shown; },
        dispose() {
            window.removeEventListener("pointerdown", reveal, { capture: true });
            window.removeEventListener("resize", restStick);
            root.remove();
            style.remove();
        },
    };
}

/** Distance between the first two live pointers. */
function spread(map) {
    const it = map.values();
    const a = it.next().value;
    const b = it.next().value;
    if (!a || !b) return 0;
    return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Press/release on a button, from pointer events rather than `click`.
 *
 * `click` is far too late for a held control — it fires on release — and the
 * synthesised mouse events that follow a touch would fire everything twice.
 * Capture also means a thumb that slides off the slide button still counts as
 * held, which is what a thumb on a moving phone does constantly.
 */
function bindButton(el, onDown, onUp) {
    el.addEventListener("pointerdown", (e) => {
        // A fast tap can release the pointer before capture lands; capture is
        // a nicety (slide-off-still-held), losing it must not cost the press.
        try { el.setPointerCapture(e.pointerId); } catch { /* released already */ }
        el.classList.add("down");
        onDown?.();
        e.preventDefault();
    });
    const up = () => {
        el.classList.remove("down");
        onUp?.();
    };
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);
    // A button that keeps the browser's own click semantics would also fire a
    // 300 ms-late synthetic click on some engines; there is nothing to gain from
    // it here and a double-cast to lose.
    el.addEventListener("click", (e) => e.preventDefault());
}
