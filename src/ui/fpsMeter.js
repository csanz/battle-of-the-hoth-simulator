/**
 * A standalone frame-rate readout, toggled with F.
 *
 * The full overlay already carries these numbers, but it is a 336-pixel panel
 * down the side of the screen — reaching for it to answer "am I still at 90?"
 * means covering a third of the thing being measured. This is the same two
 * figures and nothing else, so it can sit in a corner while the demo is
 * actually being played.
 *
 * Reads `stats` rather than timing anything itself: `main.js` already calls
 * `sample()` every frame whether or not any UI is listening, so the numbers are
 * there to be borrowed and there is no second clock to disagree with the first.
 *
 * Refreshes at 4 Hz, matching the overlay, because a per-frame readout is
 * unreadable and formatting numbers ninety times a second is steady garbage.
 */

import { stats } from "../core/perf.js";

const CSS = `
#fpsm {
  position: fixed; top: 10px; left: 12px; z-index: 90; display: none;
  font: 400 11px/1.4 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  color: #cddaea;
  background: rgba(8, 12, 19, 0.72);
  backdrop-filter: blur(18px) saturate(1.2);
  border: 1px solid rgba(143, 196, 232, 0.14); border-radius: 4px;
  padding: 5px 9px;
  font-variant-numeric: tabular-nums;
  pointer-events: none; user-select: none;
}
#fpsm.show { display: block; }
#fpsm b { font-weight: 600; font-size: 13px; color: #e6eff8; }
#fpsm i { font-style: normal; color: #6f8296; }
#fpsm.warn b { color: #f2d08a; }
#fpsm.bad b { color: #f09a8a; }
`;

/** Refresh period, ms. The overlay's own readouts use the same 4 Hz. */
const PERIOD = 250;

export function createFpsMeter() {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const el = document.createElement("div");
    el.id = "fpsm";
    el.innerHTML = `<b>--</b> <i>fps</i>`;
    document.body.appendChild(el);

    const num = el.querySelector("b");
    let visible = false;
    let acc = 0;

    return {
        get visible() {
            return visible;
        },

        toggle() {
            visible = !visible;
            el.classList.toggle("show", visible);
            // So the first frame after opening shows a number rather than the
            // dash it was left on.
            acc = PERIOD;
        },

        /** @param {number} dtMs */
        update(dtMs) {
            if (!visible) return;
            acc += dtMs;
            if (acc < PERIOD) return;
            acc = 0;
            const f = stats.fps;
            num.textContent = f > 0 ? f.toFixed(0) : "--";
            // The same thresholds the overlay colours its fps row on, so the two
            // never disagree about what counts as a bad frame.
            el.className = "show" + (f < 60 ? " bad" : f < 88 ? " warn" : "");
        },

        dispose() {
            el.remove();
            style.remove();
        },
    };
}
