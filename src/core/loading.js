/**
 * Loading-screen driver.
 *
 * A phase-weighted progress model: each phase declares how much of the bar it
 * owns, and the bar only ever moves forward. `phase()` also yields to the
 * browser so the DOM actually repaints between heavy synchronous steps.
 *
 * The screen ends one of three ways: `gate()` (the sound choice, which is also
 * the gesture that lets audio start), `done()` (fade out), or `fail()`.
 */

const bar = /** @type {HTMLElement} */ (document.getElementById("boot-bar"));
const label = /** @type {HTMLElement} */ (document.getElementById("boot-phase"));
const root = /** @type {HTMLElement} */ (document.getElementById("boot"));
const hint = /** @type {HTMLElement} */ (document.getElementById("hint"));

let progress = 0;

/** Yield to the compositor so the loading screen repaints. */
export function nextFrame() {
    return new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
}

/**
 * @param {string} text shown under the bar
 * @param {number} to target progress, 0..1
 */
export async function phase(text, to) {
    if (label) label.textContent = text;
    progress = Math.max(progress, to);
    if (bar) bar.style.width = (progress * 100).toFixed(1) + "%";
    await nextFrame();
}

/**
 * The last step of the boot screen: one click to enter.
 *
 * This exists because of a browser rule, not a design preference — an
 * `AudioContext` cannot be resumed without a user gesture, so *something* has to
 * be clicked before the first sample plays. Putting that click here costs the
 * player nothing: they were going to click into the demo anyway, and the load is
 * already finished when they do. Sound then starts on the same click rather than
 * arriving a beat later behind an unmute button.
 *
 * Resolves exactly once; Enter and Space work as well as the mouse.
 *
 * @param {() => void} [onEnter]
 *   Called *synchronously* from inside the event handler, before the promise
 *   resolves. Safari only counts a resume as gesture-driven if it is issued from
 *   the handler itself, and a promise continuation is a turn too late — so the
 *   engine is unlocked here and merely awaited by the caller.
 * @returns {Promise<boolean>} true once entered; false if there is no gate to show
 */
export function gate(onEnter) {
    const wrap = document.getElementById("boot-gate");
    const btn = document.getElementById("gate-enter");

    // No gate markup — nothing to click, nothing to wait on.
    if (!wrap || !btn) return Promise.resolve(false);

    if (label) label.textContent = "ready";
    root?.classList.add("gated");
    wrap.classList.add("show");
    // Focus it so the keyboard path is real rather than implied. Also the reason
    // the button carries a `:focus-visible` outline.
    setTimeout(() => btn.focus(), 60);

    return new Promise((resolve) => {
        let settled = false;

        const finish = () => {
            if (settled) return;
            settled = true;
            onEnter?.();
            window.removeEventListener("keydown", onKey);
            wrap.classList.remove("show");
            btn.blur();
            resolve(true);
        };

        const onKey = (e) => {
            if (e.code === "Enter" || e.code === "Space" || e.code === "NumpadEnter") {
                e.preventDefault();
                finish();
            }
        };

        btn.addEventListener("click", finish);
        window.addEventListener("keydown", onKey);
    });
}

export async function done() {
    await phase("ready", 1);
    // Let the bar visibly land before the fade starts.
    await new Promise((r) => setTimeout(r, 360));
    root?.classList.add("gone");
    hint?.classList.add("show");
    setTimeout(() => {
        root?.remove();
        hint?.classList.remove("show");
    }, 6000);
}

export function fail(message) {
    root?.remove();
    const el = document.getElementById("nogpu");
    if (el) {
        el.classList.add("show");
        const b = el.querySelector("b");
        if (b && message) b.textContent = message;
    }
}
