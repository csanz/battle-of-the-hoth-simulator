/**
 * Settings + performance overlay. Hidden by default, toggled with F1 / backtick.
 *
 * This is the only UI in the demo. It is built once from `SCHEMA`; the readouts
 * refresh on a 4 Hz timer rather than per frame, because formatting numbers into
 * strings 90 times a second is steady garbage for no benefit. The frame graph
 * redraws at 20 Hz — fast enough to watch a hitch appear, cheap enough to
 * ignore.
 */

import { S, SCHEMA, set, applyPreset } from "../core/settings.js";
import { stats, systemMs, FrameGraph, spikes, resetSpikes } from "../core/perf.js";

const CSS = `
#ov {
  position: fixed; top: 0; right: 0; bottom: 0; z-index: 80;
  width: 336px; display: none;
  font: 400 11px/1.5 ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace;
  color: #cddaea;
  background: rgba(8, 12, 19, 0.86);
  backdrop-filter: blur(18px) saturate(1.2);
  border-left: 1px solid rgba(143, 196, 232, 0.14);
  overflow-y: auto; overscroll-behavior: contain;
  padding: 14px 16px 40px;
}
#ov.show { display: block; }
#ov::-webkit-scrollbar { width: 8px; }
#ov::-webkit-scrollbar-thumb { background: rgba(143,196,232,0.16); border-radius: 4px; }

#ov h2 {
  font-size: 10px; font-weight: 500; letter-spacing: 0.22em; text-transform: uppercase;
  color: #6f8296; margin: 20px 0 8px; padding-bottom: 6px;
  border-bottom: 1px solid rgba(143, 196, 232, 0.10);
}
#ov h2:first-child { margin-top: 0; }

#ov .hdr {
  display: flex; align-items: baseline; justify-content: space-between;
  margin-bottom: 12px;
}
#ov .hdr b { font-size: 11px; font-weight: 600; letter-spacing: 0.3em; color: #e6eff8; }
#ov .hdr i { font-style: normal; font-size: 9px; letter-spacing: 0.14em; color: #55677a; }

#ov canvas { width: 100%; height: 66px; display: block;
  background: rgba(0,0,0,0.32); border: 1px solid rgba(143,196,232,0.10); border-radius: 3px; }

#ov .nums { display: grid; grid-template-columns: 1fr 1fr; gap: 2px 10px; margin-top: 8px; }
#ov .num { display: flex; justify-content: space-between; }
#ov .num span:first-child { color: #6f8296; }
#ov .num span:last-child { font-variant-numeric: tabular-nums; color: #dbe6f2; }
#ov .num.warn span:last-child { color: #e8b04f; }
#ov .num.bad  span:last-child { color: #e8734f; }

#ov .row { display: flex; align-items: center; gap: 8px; margin: 5px 0; }
#ov .row > label { flex: 0 0 108px; color: #8fa3b8; cursor: default; }
#ov .row > .val { flex: 0 0 46px; text-align: right; font-variant-numeric: tabular-nums; color: #dbe6f2; }

#ov input[type=range] { flex: 1; -webkit-appearance: none; appearance: none;
  height: 2px; background: rgba(143,196,232,0.18); border-radius: 2px; outline: none; }
#ov input[type=range]::-webkit-slider-thumb { -webkit-appearance: none; appearance: none;
  width: 10px; height: 10px; border-radius: 50%; background: #8fc4e8; cursor: grab;
  box-shadow: 0 0 8px rgba(143,196,232,0.5); }
#ov input[type=range]::-webkit-slider-thumb:active { cursor: grabbing; background: #eaf4ff; }

#ov .tog { flex: 1; display: flex; align-items: center; justify-content: flex-end; }
#ov .sw { width: 26px; height: 14px; border-radius: 7px; background: rgba(143,196,232,0.16);
  position: relative; cursor: pointer; transition: background 140ms ease; }
#ov .sw::after { content: ""; position: absolute; top: 2px; left: 2px; width: 10px; height: 10px;
  border-radius: 50%; background: #7d8ea3; transition: transform 140ms cubic-bezier(0.4,0,0.2,1), background 140ms ease; }
#ov .sw.on { background: rgba(143,196,232,0.34); }
#ov .sw.on::after { transform: translateX(12px); background: #eaf4ff; }

#ov select { flex: 1; background: rgba(0,0,0,0.35); color: #dbe6f2;
  border: 1px solid rgba(143,196,232,0.16); border-radius: 3px; padding: 2px 5px;
  font: inherit; outline: none; cursor: pointer; }

#ov .presets { display: flex; gap: 6px; margin-top: 4px; }
#ov .presets button { flex: 1; background: rgba(143,196,232,0.07); color: #8fa3b8;
  border: 1px solid rgba(143,196,232,0.14); border-radius: 3px; padding: 5px 0;
  font: inherit; letter-spacing: 0.08em; cursor: pointer; transition: all 140ms ease; }
#ov .presets button:hover { background: rgba(143,196,232,0.14); color: #dbe6f2; }
#ov .presets button.on { background: rgba(143,196,232,0.22); color: #eaf4ff; border-color: rgba(143,196,232,0.4); }

#ov .budget { margin-top: 4px; }
#ov .budget .num span:last-child { color: #9fb4c8; }

#ov .nums.one { grid-template-columns: 1fr; gap: 1px; }
/* white-space: pre so the sign-padding in fmt2 survives — without it the
   columns shift by a character every time a coordinate crosses zero. */
#ov .cam .num span:last-child { color: #a9d3ef; letter-spacing: 0.02em; white-space: pre; }
#ov .pose { margin-top: 7px; padding: 6px 7px; border-radius: 3px;
  background: rgba(0,0,0,0.34); border: 1px solid rgba(143,196,232,0.10);
  color: #7f93a8; font-size: 10px; line-height: 1.45; word-break: break-all;
  user-select: text; cursor: text; }
`;

export class Overlay {
    /**
     * @param {{ rig?: import("../core/camera.js").CameraRig,
     *           character?: import("../character/controller.js").CharacterController }} [refs]
     *   Live systems the debug readouts sample. Optional so the overlay can be
     *   constructed before they exist; see `attach()`.
     */
    constructor(refs) {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);

        const el = document.createElement("div");
        el.id = "ov";
        document.body.appendChild(el);
        this.el = el;

        this.visible = false;

        // --------------------------------------------------------- header
        const hdr = document.createElement("div");
        hdr.className = "hdr";
        hdr.innerHTML = "<b>SNOWFLOW</b><i>F1 to close</i>";
        el.appendChild(hdr);

        // ----------------------------------------------------- frame graph
        const cv = document.createElement("canvas");
        cv.width = 304;
        cv.height = 66;
        el.appendChild(cv);
        this.graph = new FrameGraph(cv);

        // --------------------------------------------------------- numbers
        const nums = document.createElement("div");
        nums.className = "nums";
        el.appendChild(nums);

        /** @type {Record<string, HTMLElement>} */
        this.readouts = {};
        this._mkNum(nums, "fps", "fps");
        this._mkNum(nums, "fpsLow", "1% low");
        this._mkNum(nums, "median", "median");
        this._mkNum(nums, "p99", "99th");
        this._mkNum(nums, "gpu", "gpu ms");
        this._mkNum(nums, "draws", "draws");
        this._mkNum(nums, "tris", "tris");
        this._mkNum(nums, "spikes", "spikes");
        this._mkNum(nums, "res", "res");

        // ---------------------------------------------------- frame budget
        const bh = document.createElement("h2");
        bh.textContent = "Frame budget";
        el.appendChild(bh);
        const budget = document.createElement("div");
        budget.className = "nums budget";
        el.appendChild(budget);
        this.budgetEl = budget;
        /** @type {Map<string, HTMLElement>} */
        this.budgetRows = new Map();

        // --------------------------------------------------------- camera
        // Debug readout for framing a view and reproducing it later: everything
        // the pose line below needs, in the units the rig actually stores.
        this.rig = refs?.rig ?? null;
        this.character = refs?.character ?? null;
        /** Named callbacks for `t: "a"` action rows in the SCHEMA. */
        this.actions = refs?.actions ?? {};

        const ch = document.createElement("h2");
        ch.textContent = "Camera";
        el.appendChild(ch);
        const cam = document.createElement("div");
        cam.className = "nums one cam";
        el.appendChild(cam);
        this._mkNum(cam, "camPos", "eye");
        this._mkNum(cam, "camAng", "yaw / pitch");
        this._mkNum(cam, "camArm", "arm / fov");
        this._mkNum(cam, "chrPos", "player");
        this._mkNum(cam, "chrMot", "speed / facing");

        const pose = document.createElement("div");
        pose.className = "pose";
        pose.textContent = "—";
        el.appendChild(pose);
        this.poseEl = pose;

        const pb = document.createElement("div");
        pb.className = "presets";
        el.appendChild(pb);
        const copy = document.createElement("button");
        copy.textContent = "copy pose";
        copy.onclick = () => this._copyPose(copy);
        pb.appendChild(copy);

        // -------------------------------------------------------- presets
        const ph = document.createElement("h2");
        ph.textContent = "Quality";
        el.appendChild(ph);
        const pr = document.createElement("div");
        pr.className = "presets";
        el.appendChild(pr);
        this.presetBtns = {};
        for (const name of ["ultra", "high", "balanced"]) {
            const b = document.createElement("button");
            b.textContent = name;
            b.onclick = () => {
                applyPreset(name);
                this._syncPresets();
                this._syncWidgets();
            };
            pr.appendChild(b);
            this.presetBtns[name] = b;
        }
        this._syncPresets();

        // ------------------------------------------------------- controls
        /** @type {Array<{k:string, sync:() => void}>} */
        this.widgets = [];
        for (let g = 0; g < SCHEMA.length; g++) this._mkGroup(SCHEMA[g]);

        // Cached number formatting so the 4 Hz refresh reuses one buffer path.
        this._lastText = Object.create(null);
        this._acc = 0;
        this._graphAcc = 0;
        this._camAcc = 0;
        this._pose = "";
    }

    /**
     * Late-bind the systems the camera readout samples.
     * @param {{ rig?: any, character?: any }} refs
     */
    attach(refs) {
        if (refs.rig) this.rig = refs.rig;
        if (refs.character) this.character = refs.character;
    }

    _mkNum(parent, key, label) {
        const d = document.createElement("div");
        d.className = "num";
        const a = document.createElement("span");
        a.textContent = label;
        const b = document.createElement("span");
        b.textContent = "—";
        d.appendChild(a);
        d.appendChild(b);
        parent.appendChild(d);
        this.readouts[key] = b;
        this.readouts[key + "_row"] = d;
    }

    _mkGroup(group) {
        const h = document.createElement("h2");
        h.textContent = group.group;
        this.el.appendChild(h);

        for (let i = 0; i < group.items.length; i++) {
            const it = group.items[i];
            const row = document.createElement("div");
            row.className = "row";
            const lab = document.createElement("label");
            lab.textContent = it.l;
            row.appendChild(lab);

            if (it.t === "f") {
                const r = document.createElement("input");
                r.type = "range";
                r.min = String(it.min);
                r.max = String(it.max);
                r.step = String(it.step);
                r.value = String(S[it.k]);
                const v = document.createElement("span");
                v.className = "val";
                v.textContent = fmtNum(S[it.k], it.step);
                r.oninput = () => {
                    const n = parseFloat(r.value);
                    set(it.k, n);
                    v.textContent = fmtNum(n, it.step);
                };
                row.appendChild(r);
                row.appendChild(v);
                this.widgets.push({
                    k: it.k,
                    sync: () => {
                        r.value = String(S[it.k]);
                        v.textContent = fmtNum(S[it.k], it.step);
                    },
                });
            } else if (it.t === "b") {
                const wrap = document.createElement("div");
                wrap.className = "tog";
                const sw = document.createElement("div");
                sw.className = "sw" + (S[it.k] ? " on" : "");
                sw.onclick = () => {
                    const n = !S[it.k];
                    set(it.k, n);
                    sw.classList.toggle("on", n);
                };
                wrap.appendChild(sw);
                row.appendChild(wrap);
                this.widgets.push({
                    k: it.k,
                    sync: () => sw.classList.toggle("on", !!S[it.k]),
                });
            } else if (it.t === "c") {
                // Colour picker over a trio of scalar channel keys (kr/kg/kb).
                // The picker writes 0..1; the channel sliders stay the place to
                // push a channel past 1 into HDR, so the swatch shows the hue
                // clamped and never writes unless the user actually picks.
                const c = document.createElement("input");
                c.type = "color";
                const toHex = () => {
                    const h = (k) =>
                        Math.round(Math.min(1, Math.max(0, S[k])) * 255)
                            .toString(16).padStart(2, "0");
                    return "#" + h(it.kr) + h(it.kg) + h(it.kb);
                };
                c.value = toHex();
                c.oninput = () => {
                    set(it.kr, parseInt(c.value.slice(1, 3), 16) / 255);
                    set(it.kg, parseInt(c.value.slice(3, 5), 16) / 255);
                    set(it.kb, parseInt(c.value.slice(5, 7), 16) / 255);
                    this._syncWidgets();
                };
                row.appendChild(c);
                this.widgets.push({ k: it.kr, sync: () => (c.value = toHex()) });
            } else if (it.t === "a") {
                // An action row: a button wired to a named callback the owner
                // passed in — the panel stays declarative, the work stays in
                // main. Flashes its label briefly so a copy has feedback.
                const btn = document.createElement("button");
                btn.type = "button";
                btn.textContent = it.bl || "run";
                btn.style.cssText =
                    "font:inherit;font-size:9px;letter-spacing:0.14em;" +
                    "text-transform:uppercase;color:inherit;cursor:pointer;" +
                    "background:rgba(143,196,232,0.08);" +
                    "border:1px solid rgba(143,196,232,0.28);" +
                    "border-radius:2px;padding:4px 12px;";
                btn.onclick = () => {
                    const fn = this.actions[it.k];
                    if (!fn) return;
                    fn();
                    const old = btn.textContent;
                    btn.textContent = it.done || "done";
                    setTimeout(() => (btn.textContent = old), 900);
                };
                row.appendChild(btn);
            } else if (it.t === "e") {
                const sel = document.createElement("select");
                for (let o = 0; o < it.opts.length; o++) {
                    const op = document.createElement("option");
                    op.value = it.opts[o];
                    op.textContent = it.opts[o];
                    sel.appendChild(op);
                }
                sel.value = String(S[it.k]);
                sel.onchange = () => set(it.k, sel.value);
                row.appendChild(sel);
                this.widgets.push({ k: it.k, sync: () => (sel.value = String(S[it.k])) });
            }

            this.el.appendChild(row);
        }
    }

    _syncPresets() {
        for (const k in this.presetBtns) {
            this.presetBtns[k].classList.toggle("on", S.preset === k);
        }
    }

    _syncWidgets() {
        for (let i = 0; i < this.widgets.length; i++) this.widgets[i].sync();
    }

    toggle() {
        this.visible = !this.visible;
        this.el.classList.toggle("show", this.visible);
        if (this.visible) this._syncWidgets();
    }

    /**
     * @param {number} dtMs
     * @param {import("../core/gfx.js").Gfx} gfx
     */
    update(dtMs, gfx) {
        if (!this.visible) return;

        this._graphAcc += dtMs;
        if (this._graphAcc >= 50) {
            this._graphAcc = 0;
            this.graph.draw();
        }

        // Camera refreshes faster than the perf numbers — at 4 Hz you can't tell
        // which way you nudged the rig.
        this._camAcc += dtMs;
        if (this._camAcc >= 100) {
            this._camAcc = 0;
            this._updateCamera();
        }

        this._acc += dtMs;
        if (this._acc < 250) return;
        this._acc = 0;

        const r = this.readouts;
        this._txt(r.fps, stats.fps.toFixed(0));
        this._txt(r.fpsLow, stats.fpsLow.toFixed(0));
        this._txt(r.median, stats.median.toFixed(2));
        this._txt(r.p99, stats.p99.toFixed(2));
        // A dash rather than 0.00 when the adapter has no timestamp query: an
        // unavailable number and a zero one are not the same claim.
        this._txt(r.gpu, stats.gpuMs > 0 ? stats.gpuMs.toFixed(2) : "—");
        this._txt(r.draws, String(stats.drawCalls));
        this._txt(r.tris, fmtK(stats.triangles));
        this._txt(r.spikes, String(spikes.count));
        this._txt(r.res, gfx.renderWidth + "x" + gfx.renderHeight);

        r.fps_row.className = "num" + (stats.fps < 60 ? " bad" : stats.fps < 88 ? " warn" : "");
        r.fpsLow_row.className = "num" + (stats.fpsLow < 60 ? " bad" : stats.fpsLow < 75 ? " warn" : "");
        r.spikes_row.className = "num" + (spikes.count > 0 ? " warn" : "");

        // Per-system costs — rows are created lazily and then only mutated.
        for (const name in systemMs) {
            let row = this.budgetRows.get(name);
            if (!row) {
                this._mkNum(this.budgetEl, "sys_" + name, name);
                row = this.readouts["sys_" + name];
                this.budgetRows.set(name, row);
            }
            this._txt(row, systemMs[name].toFixed(2));
        }
    }

    // ------------------------------------------------------------- camera
    _updateCamera() {
        const rig = this.rig;
        const r = this.readouts;
        if (!rig) {
            this._txt(r.camPos, "no rig");
            return;
        }

        const p = rig.camera.position;
        this._txt(r.camPos, fmt2(p.x) + "  " + fmt2(p.y) + "  " + fmt2(p.z));
        // Yaw wrapped to a compass reading; pitch signed, positive = looking
        // down, which is the rig's own convention.
        this._txt(
            r.camAng,
            wrapDeg(rig.yaw * RAD).toFixed(1) + "°  " + signDeg(rig.pitch * RAD)
        );
        this._txt(
            r.camArm,
            rig.distance.toFixed(2) + " m  " + (rig.fov * RAD).toFixed(1) + "° v"
        );

        const c = this.character;
        if (c) {
            const q = c.position;
            this._txt(r.chrPos, fmt2(q.x) + "  " + fmt2(q.y) + "  " + fmt2(q.z));
            this._txt(
                r.chrMot,
                c.speed.toFixed(2) + " m/s  " + wrapDeg(c.facing * RAD).toFixed(0) + "°" +
                (c.surf > 0.01 ? "  surf " + c.surf.toFixed(2) : "")
            );
        } else {
            this._txt(r.chrPos, "—");
            this._txt(r.chrMot, "—");
        }

        this._pose = this._poseScript();
        this._txt(this.poseEl, this._pose);
    }

    /** A one-liner that reproduces the current pose. Paste it into the console. */
    _poseScript() {
        const rig = this.rig;
        if (!rig) return "—";
        const c = this.character;
        let s = "const s=SNOWFLOW;";
        if (c) {
            s +=
                "s.character.position.set(" +
                fmt2(c.position.x) + "," + fmt2(c.position.y) + "," + fmt2(c.position.z) +
                ");s.character.facing=" + c.facing.toFixed(3) + ";";
        }
        s +=
            "s.rig.yaw=" + rig.yaw.toFixed(3) +
            ";s.rig.pitch=" + rig.pitch.toFixed(3) +
            ";s.rig.distance=s.rig.distanceTarget=" + rig.distance.toFixed(2) + ";";
        return s;
    }

    _copyPose(btn) {
        const text = this._pose || this._poseScript();
        const done = (ok) => {
            btn.textContent = ok ? "copied" : "see console";
            if (!ok) console.log(text);
            setTimeout(() => (btn.textContent = "copy pose"), 1200);
        };
        // Clipboard access can be refused (no focus, insecure context); the
        // console fallback still gets the pose out.
        try {
            navigator.clipboard.writeText(text).then(() => done(true), () => done(false));
        } catch {
            done(false);
        }
    }

    /** Only touch the DOM when the string actually changed. */
    _txt(el, s) {
        if (el._v !== s) {
            el._v = s;
            el.textContent = s;
        }
    }

    resetSpikes() {
        resetSpikes();
    }
}

const RAD = 180 / Math.PI;

/** Fixed-width two-decimal metres, sign-padded so columns don't jitter. */
function fmt2(v) {
    const s = v.toFixed(2);
    return v < 0 ? s : " " + s;
}

function wrapDeg(d) {
    d %= 360;
    return d < 0 ? d + 360 : d;
}

function signDeg(d) {
    return (d >= 0 ? "+" : "") + d.toFixed(1) + "°";
}

function fmtNum(v, step) {
    if (step >= 1) return v.toFixed(0);
    if (step >= 0.01) return v.toFixed(2);
    if (step >= 0.001) return v.toFixed(3);
    return v.toFixed(4);
}

function fmtK(n) {
    if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
    if (n >= 1e3) return (n / 1e3).toFixed(0) + "k";
    return String(n);
}
