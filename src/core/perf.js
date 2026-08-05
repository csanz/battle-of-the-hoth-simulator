/**
 * Frame-time statistics and the graph renderer behind the overlay.
 *
 * Averages hide hitches, so everything here is percentile-based: the headline
 * numbers are the median and the 1% low (the 99th-percentile frame time), which
 * is what actually tells you whether a GC pause or a pipeline compile snuck in.
 *
 * Allocation policy: every buffer is created once at module load. `sample()`
 * runs per frame and allocates nothing; `recompute()` sorts an in-place typed
 * array copy and is throttled to 4 Hz.
 */

const CAP = 512; // ~5.7 s of history at 90 fps

const times = new Float32Array(CAP); // ring buffer of frame times, ms
const sorted = new Float32Array(CAP); // scratch for percentiles
let head = 0;
let count = 0;

/** Per-system timings, in ms, written by systems each frame via `mark()`. */
export const systemMs = Object.create(null);

/** Rolling stats, mutated in place — never reassigned, so consumers can hold a ref. */
export const stats = {
    last: 0,
    median: 0,
    mean: 0,
    p99: 0, // 1% low frame time
    p95: 0,
    max: 0,
    fps: 0,
    fpsLow: 0, // 1% low fps
    drawCalls: 0,
    triangles: 0,
    // WebGL2 has no dependable GPU timer (`EXT_disjoint_timer_query_webgl2` is
    // widely disabled), so this stays 0 and the overlay shows its dash.
    gpuMs: 0,
};

let sinceRecompute = 0;

/**
 * Push one frame time.
 * @param {number} ms
 */
export function sample(ms) {
    times[head] = ms;
    head = (head + 1) % CAP;
    if (count < CAP) count++;
    stats.last = ms;

    sinceRecompute += ms;
    if (sinceRecompute >= 250) {
        sinceRecompute = 0;
        recompute();
    }
}

function recompute() {
    const n = count;
    if (n === 0) return;

    let sum = 0;
    let max = 0;
    for (let i = 0; i < n; i++) {
        const v = times[i];
        sorted[i] = v;
        sum += v;
        if (v > max) max = v;
    }

    // TypedArray sort is in-place and allocation-free.
    const view = n === CAP ? sorted : sorted.subarray(0, n);
    view.sort();

    stats.mean = sum / n;
    stats.max = max;
    stats.median = view[(n * 0.5) | 0];
    stats.p95 = view[Math.min(n - 1, (n * 0.95) | 0)];
    stats.p99 = view[Math.min(n - 1, (n * 0.99) | 0)];
    stats.fps = stats.median > 0 ? 1000 / stats.median : 0;
    stats.fpsLow = stats.p99 > 0 ? 1000 / stats.p99 : 0;
}

// --------------------------------------------------------------- draw counter

/**
 * Three keeps an accurate per-frame draw count in `renderer.info`, so unlike
 * the Babylon build there is nothing to wrap — only a reset to take over.
 * `autoReset` is turned off so the count survives until `endFrameDraws()`
 * latches it, whole-frame, for the overlay.
 */
let _renderer = null;

/** @param {import("./gfx.js").Gfx} gfx */
export function installDrawCounter(gfx) {
    _renderer = gfx.renderer;
    _renderer.info.autoReset = false;
}

/** Latch the frame's draw count. Call once, after the frame's last render. */
export function endFrameDraws() {
    if (!_renderer) return;
    stats.drawCalls = _renderer.info.render.calls;
    _renderer.info.reset();
}

/** Record a per-system cost in ms (overwrites; call once per frame per system). */
export function mark(name, ms) {
    systemMs[name] = ms;
}

/** Number of frames exceeding `median + 4 ms`. */
export const spikes = { count: 0, sinceReset: 0 };

export function checkSpike(ms) {
    spikes.sinceReset++;
    if (stats.median > 0 && ms > stats.median + 4) spikes.count++;
}

export function resetSpikes() {
    spikes.count = 0;
    spikes.sinceReset = 0;
}

// --------------------------------------------------------------------- graph

/**
 * Draws the frame-time history into a 2D canvas. Bars are coloured by which
 * budget band they land in, so a red column is instantly readable as a hitch.
 */
export class FrameGraph {
    /** @param {HTMLCanvasElement} canvas */
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
        this.w = canvas.width;
        this.h = canvas.height;
        this.maxMs = 22; // y-axis top, eased toward the observed max
    }

    draw() {
        const ctx = this.ctx;
        const w = this.w;
        const h = this.h;
        if (!ctx) return;

        // Ease the axis so it doesn't jump around while you read it.
        const want = Math.max(22, Math.min(60, stats.max * 1.25));
        this.maxMs += (want - this.maxMs) * 0.08;
        const inv = h / this.maxMs;

        ctx.clearRect(0, 0, w, h);

        // Budget guides: 11.1 ms (90 fps) and 16.7 ms (60 fps).
        ctx.fillStyle = "rgba(143,196,232,0.10)";
        ctx.fillRect(0, h - 11.1 * inv, w, 1);
        ctx.fillStyle = "rgba(232,160,120,0.12)";
        ctx.fillRect(0, h - 16.7 * inv, w, 1);

        const n = count;
        if (n === 0) return;

        const step = w / CAP;
        for (let i = 0; i < n; i++) {
            // Walk oldest→newest so the graph scrolls left.
            const idx = (head - n + i + CAP * 2) % CAP;
            const v = times[idx];
            const bh = Math.min(h, v * inv);

            ctx.fillStyle =
                v > 16.7 ? "#e8734f" : v > 11.1 ? "#e8b04f" : "#6fb2e0";
            ctx.fillRect(i * step, h - bh, Math.max(1, step), bh);
        }

        // Median line on top of the bars.
        ctx.fillStyle = "rgba(219,230,242,0.55)";
        ctx.fillRect(0, h - stats.median * inv, w, 1);
    }
}
