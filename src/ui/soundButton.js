/**
 * The persistent sound button, bottom-left.
 *
 * Left, not right: the settings overlay is a full-height panel down the right
 * edge, and a button at the same corner is simply behind it whenever the panel
 * is open.
 *
 * Two jobs. For a player who entered muted it is the gesture that starts audio
 * at all — the boot gate is gone by then, and without this the only way back to
 * sound would be a reload. For everyone else it is a mute toggle that does not
 * need the settings panel open.
 *
 * State lives in `S.audioMuted`, not here: the overlay has the same toggle, and
 * two widgets over one boolean have to read it rather than each remember it.
 */

import { S, set, onChange } from "../core/settings.js";

const CSS = `
#snd {
  position: fixed; left: 14px; bottom: 14px; z-index: 70;
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 1px solid rgba(143, 196, 232, 0.14);
  border-radius: 3px;
  background: rgba(8, 12, 19, 0.55);
  backdrop-filter: blur(10px);
  color: rgba(219, 230, 242, 0.42);
  cursor: pointer;
  opacity: 0; pointer-events: none;
  transition: opacity 600ms ease, color 160ms ease,
              background 160ms ease, border-color 160ms ease;
}
#snd.ready { opacity: 1; pointer-events: auto; }
#snd:hover { color: #dbe6f2; background: rgba(13, 20, 31, 0.78);
  border-color: rgba(143, 196, 232, 0.3); }
#snd.on { color: #8fc4e8; border-color: rgba(143, 196, 232, 0.34); }
#snd.on:hover { color: #eaf4ff; }
#snd svg { width: 15px; height: 15px; display: block; }
#snd:focus-visible { outline: 1px solid #8fc4e8; outline-offset: 2px; }
`;

// Two glyphs, one shared speaker body. Drawn inline because a 15 px icon is not
// worth a network request, and the demo ships no image assets.
const SPEAKER = '<path d="M3 6h2.2L9 2.6v10.8L5.2 10H3z" fill="currentColor"/>';
const ON = SPEAKER +
    '<path d="M11.2 4.6a4.4 4.4 0 0 1 0 6.8M12.9 2.2a7.2 7.2 0 0 1 0 11.6" ' +
    'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';
const OFF = SPEAKER +
    '<path d="M11.4 5.6l3.4 4.8M14.8 5.6l-3.4 4.8" ' +
    'fill="none" stroke="currentColor" stroke-width="1.2" stroke-linecap="round"/>';

/**
 * @param {import("../audio/engine.js").AudioEngine} audio
 * @param {{ onEnable?: () => void }} [hooks]
 *   `onEnable` fires the first time this button unlocks the engine — that is the
 *   soundscape's cue to open its continuous voices.
 */
export function createSoundButton(audio, hooks) {
    const style = document.createElement("style");
    style.textContent = CSS;
    document.head.appendChild(style);

    const btn = document.createElement("button");
    btn.id = "snd";
    btn.type = "button";
    document.body.appendChild(btn);

    const svg = (paths) =>
        '<svg viewBox="0 0 16 16" aria-hidden="true">' + paths + "</svg>";

    const sync = () => {
        const audible = audio.unlocked && !S.audioMuted;
        btn.classList.toggle("on", audible);
        btn.innerHTML = svg(audible ? ON : OFF);
        btn.title = audible ? "mute" : "sound on";
        btn.setAttribute("aria-label", btn.title);
        btn.setAttribute("aria-pressed", String(audible));
    };

    btn.addEventListener("click", () => {
        // Hand focus back immediately: space is the slide, and a focused button
        // would eat it as an activation.
        btn.blur();
        // Unlock first and without awaiting: this handler *is* the gesture, and
        // handing the turn back to the event loop before calling `resume()` is
        // how Safari ends up refusing it.
        if (!audio.unlocked) {
            const p = audio.unlock();
            set("audioMuted", false);
            p.then((ok) => {
                if (ok) hooks?.onEnable?.();
                sync();
            });
            return;
        }
        set("audioMuted", !S.audioMuted);
        sync();
    });

    // The overlay writes the same key; keep the glyph honest when it does.
    onChange("audioMuted", sync);
    sync();

    return {
        /** Fade the button in. Called once the boot screen is out of the way. */
        reveal() {
            btn.classList.add("ready");
        },
        sync,
        el: btn,
    };
}
