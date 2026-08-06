/**
 * The intro transmission — Luke in a small square, top right, talking the
 * flight in while the escorts sweep overhead.
 *
 * It does not simply appear. The entrance is staged so the player's eye is
 * *brought* to it rather than assumed to be on it:
 *
 *   hold     ~1.7 s of nothing — the fly-in and the formation own the frame;
 *   tune-in  the square snaps in full of animated TV static under a pulsing
 *            glow and a blinking INCOMING TRANSMISSION label. Static moving
 *            in a corner is the one thing peripheral vision cannot ignore,
 *            which is the whole job of this phase;
 *   signal   the static drops away and the clip plays, voice and all.
 *
 * The video carries its own voice track, so when it plays, the standalone
 * `lukeIntro` line must not: the caller picks one (see the gate wiring in
 * main). Playback is armed by the boot gate's click — the gesture that makes
 * sound legal — and actually starts at the reveal; if the browser has let
 * the activation lapse by then, the picture runs muted and `onVoiceLost`
 * hands the voice back to the audio-only line.
 *
 * Preloaded the way everything else in the boot is: fetched to a blob behind
 * the loading screen, so the reveal plays local bytes instantly — the static
 * is theater, not buffering. A failed fetch is stub-tolerant: `ok` stays
 * false and the caller falls back to the audio-only line, the film costing
 * the entrance rather than the boot.
 *
 * When the clip ends (or is clicked away at any phase), the square fades and
 * removes itself; nothing else in the game knows it existed.
 */

/** Seconds of open field before the square appears. */
const HOLD = 1.7;
/** Seconds of static before the signal resolves. */
const TUNE = 1.2;

/**
 * @param {string|string[]} url the clip — one location or several to try in
 *   order. Dev serves the local copy same-origin and instantly; a deploy that
 *   does not ship the file falls through to the hosted blob. Public Vercel
 *   blobs answer with `access-control-allow-origin: *`, so the cross-origin
 *   fetch-to-blob works the same as the local one.
 * @returns {{
 *   preload(): Promise<boolean>,
 *   play(onVoiceLost?: () => void): void,
 *   ok: boolean,
 *   duration: number|null,
 *   leadIn: number,
 * }}
 */
export function createIntroFilm(url) {
    /** @type {HTMLVideoElement|null} */
    let video = null;
    /** @type {HTMLDivElement|null} */
    let frame = null;
    let blobUrl = "";

    const film = {
        ok: false,
        duration: null,
        /** Seconds from `play()` to the voice actually starting. */
        leadIn: HOLD + TUNE,

        async preload() {
            try {
                const candidates = Array.isArray(url) ? url : [url];
                let res = null;
                for (const u of candidates) {
                    try {
                        res = await fetch(u);
                        if (res.ok) break;
                    } catch { /* next candidate */ }
                    res = null;
                }
                if (!res) throw new Error("no source answered");
                blobUrl = URL.createObjectURL(await res.blob());

                video = document.createElement("video");
                video.src = blobUrl;
                video.preload = "auto";
                video.playsInline = true;
                video.setAttribute("playsinline", "");
                video.style.cssText =
                    "display:block;width:100%;height:100%;object-fit:cover;";
                await new Promise((resolve, reject) => {
                    video.addEventListener("canplaythrough", resolve, { once: true });
                    video.addEventListener("error", reject, { once: true });
                    video.load();
                });
                film.duration = Number.isFinite(video.duration)
                    ? video.duration : null;
                film.ok = true;
            } catch (err) {
                console.warn("[introFilm] unavailable:", err);
                film.ok = false;
            }
            return film.ok;
        },

        /**
         * @param {() => void} [onVoiceLost] called if the clip can only run
         *   muted — the caller's chance to play the audio-only line instead.
         */
        play(onVoiceLost) {
            if (!film.ok || !video) return;

            /** @type {number[]} */
            const timers = [];
            let rafId = 0;
            /** @type {HTMLStyleElement|null} */
            let style = document.createElement("style");
            style.textContent = [
                "@keyframes introfilm-pop {",
                "  0% { transform: scale(0.85); opacity: 0; }",
                "  55% { transform: scale(1.03); opacity: 1; }",
                "  100% { transform: scale(1); opacity: 1; } }",
                "@keyframes introfilm-pulse {",
                "  0%, 100% { box-shadow: 0 0 18px rgba(120,170,255,0.30), 0 4px 18px rgba(0,0,0,0.45); }",
                "  50% { box-shadow: 0 0 34px rgba(150,200,255,0.75), 0 4px 18px rgba(0,0,0,0.45); } }",
                "@keyframes introfilm-blink {",
                "  0%, 60% { opacity: 1; } 61%, 100% { opacity: 0.15; } }",
            ].join("\n");
            document.head.appendChild(style);

            const dismiss = () => {
                for (const t of timers) clearTimeout(t);
                if (rafId) cancelAnimationFrame(rafId);
                video?.pause();
                if (!frame) return;
                const f = frame;
                frame = null;
                f.style.opacity = "0";
                setTimeout(() => {
                    f.remove();
                    style?.remove();
                    style = null;
                    if (blobUrl) URL.revokeObjectURL(blobUrl);
                    video = null;
                }, 400);
            };

            // ---- the hold: the fly-in owns the frame -----------------------
            timers.push(setTimeout(() => {
                if (!video) return;

                frame = document.createElement("div");
                // A comm square, not a player: thin cold border, a pulse of
                // glow while it hunts for signal, no chrome.
                frame.style.cssText = [
                    "position:fixed", "top:14px", "right:14px",
                    "width:min(300px, 34vw)", "aspect-ratio:16/9",
                    "border-radius:8px", "overflow:hidden",
                    "border:1px solid rgba(150, 195, 255, 0.55)",
                    "background:#000",
                    "z-index:40",
                    "transition:opacity 0.35s ease",
                    "cursor:pointer",
                    "animation:introfilm-pop 0.38s ease-out both,"
                        + " introfilm-pulse 0.8s ease-in-out infinite",
                ].join(";");
                frame.title = "Skip";
                frame.appendChild(video);

                // ---- static: a real one, not a gif ------------------------
                const snow = document.createElement("canvas");
                snow.width = 120;
                snow.height = 68;
                snow.style.cssText = [
                    "position:absolute", "inset:0",
                    "width:100%", "height:100%",
                    "image-rendering:pixelated",
                    "transition:opacity 0.3s ease",
                ].join(";");
                const label = document.createElement("div");
                label.textContent = "▸ INCOMING TRANSMISSION";
                label.style.cssText = [
                    "position:absolute", "left:0", "right:0", "bottom:7px",
                    "text-align:center",
                    "font-family:'Avenir Next Condensed','Helvetica Neue',Arial,sans-serif",
                    "font-size:11px", "font-weight:600",
                    "letter-spacing:0.18em",
                    "color:rgba(190, 220, 255, 0.95)",
                    "text-shadow:0 0 8px rgba(120,170,255,0.9)",
                    "transition:opacity 0.3s ease",
                    "animation:introfilm-blink 0.7s step-end infinite",
                ].join(";");
                frame.appendChild(snow);
                frame.appendChild(label);
                document.body.appendChild(frame);
                frame.addEventListener("click", dismiss, { once: true });

                const ctx = snow.getContext("2d");
                const img = ctx.createImageData(snow.width, snow.height);
                const px = img.data;
                let last = 0;
                const hiss = (now) => {
                    rafId = requestAnimationFrame(hiss);
                    if (now - last < 33) return;   // ~30 fps is what a set does
                    last = now;
                    for (let i = 0; i < px.length; i += 4) {
                        const v = (Math.random() * 255) | 0;
                        px[i] = px[i + 1] = px[i + 2] = v;
                        px[i + 3] = 255;
                    }
                    // A couple of horizontal tears per frame — the "almost
                    // caught it" of a set hunting for signal.
                    for (let t = 0; t < 2; t++) {
                        const row = (Math.random() * snow.height) | 0;
                        const bright = Math.random() < 0.5 ? 255 : 30;
                        for (let x = 0; x < snow.width; x++) {
                            const o = (row * snow.width + x) * 4;
                            px[o] = px[o + 1] = px[o + 2] = bright;
                        }
                    }
                    ctx.putImageData(img, 0, 0);
                };
                rafId = requestAnimationFrame(hiss);

                // ---- the signal resolves ----------------------------------
                timers.push(setTimeout(() => {
                    if (!video || !frame) return;
                    cancelAnimationFrame(rafId);
                    rafId = 0;
                    snow.style.opacity = "0";
                    label.style.opacity = "0";
                    // The pulse settles once the picture is up.
                    frame.style.animation = "none";
                    frame.style.boxShadow =
                        "0 0 22px rgba(120,170,255,0.35), 0 4px 18px rgba(0,0,0,0.45)";
                    setTimeout(() => { snow.remove(); label.remove(); }, 350);

                    video.addEventListener("ended", dismiss, { once: true });
                    video.play().catch(() => {
                        // The gesture window closed on us. Muted playback is
                        // always allowed — this keeps the picture, and the
                        // caller gets to restore the voice.
                        if (!video) return;
                        video.muted = true;
                        video.play().catch(dismiss);
                        onVoiceLost?.();
                    });
                }, TUNE * 1000));
            }, HOLD * 1000));
        },
    };

    return film;
}
