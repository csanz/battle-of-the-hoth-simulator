/**
 * The terrain state buffer — persistent, additive snow deformation.
 *
 * Two RGBA16F targets ping-ponged by one full-screen pass per frame
 * (`deformSim.fragment.glsl`). The pass scrolls, relaxes and splats in a single
 * dispatch; there is no separate clear, no copy and no readback.
 *
 * Geometry:
 *   COVERAGE metres of world, RES texels across, centred on the player and
 *   snapped to texel boundaries so the field does not swim under the surface.
 *   Addressing is toroidal, so following the player costs nothing.
 *
 * Everything that touches the snow writes here through `brush()` — feet, the
 * surf wake, every spell. That shared write path is what makes the effects part
 * of the snow rather than decals floating above it.
 *
 * Allocation: none per frame. The brush staging array is sized once at
 * construction and written in place.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { FullscreenPass, whenReady } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

/**
 * Window coverage in metres: 80 m at 2048², so 3.9 cm texels.
 *
 * The trade favours area. A surf run crosses 80 m in four seconds and the whole
 * groove should stay in frame; halving the texel instead would mean a 4096²
 * target — 4x the VRAM and 4x the cost of a pass that runs every frame — to
 * resolve detail the fragment shader's grain layer already synthesises.
 */
export const COVERAGE = 80;

/** Rows in the brush data texture. Must match `deformSim.fragment.glsl`. */
const BRUSH_ROWS = 3;
const MAX_BRUSHES = 96;

/** Seconds of relaxation banked before it is worth applying. See `_relaxOwed`. */
const RELAX_STEP = 0.4;

export class DeformationField {
    /** @param {import("../core/gfx.js").Gfx} gfx */
    constructor(gfx) {
        this.gfx = gfx;
        // Read ONCE: presets must be applied before construction (see main.js).
        this.res = Math.max(512, S.deformResolution | 0);
        this.size = COVERAGE;
        this.texel = this.size / this.res;

        /** Window centre this frame, texel-snapped. */
        this.center = new THREE.Vector2(0, 0);
        this._prevCenter = new THREE.Vector2(0, 0);

        // ------------------------------------------------------------ brushes
        // (x, z, radius, elongation) / (cos, sin, depth, berm) /
        // (compression, ice, edgeRoughness, seed)
        this._brushData = new Float32Array(MAX_BRUSHES * BRUSH_ROWS * 4);
        this._brushCount = 0;
        this._brushDirty = false;

        this.brushTex = new THREE.DataTexture(
            this._brushData, MAX_BRUSHES, BRUSH_ROWS,
            THREE.RGBAFormat, THREE.FloatType
        );
        this.brushTex.name = "brushTex";
        this.brushTex.colorSpace = THREE.NoColorSpace;
        this.brushTex.flipY = false;
        this.brushTex.premultiplyAlpha = false;
        this.brushTex.generateMipmaps = false;
        this.brushTex.minFilter = THREE.NearestFilter;
        this.brushTex.magFilter = THREE.NearestFilter;
        this.brushTex.wrapS = THREE.ClampToEdgeWrapping;
        this.brushTex.wrapT = THREE.ClampToEdgeWrapping;
        this.brushTex.needsUpdate = true;

        // -------------------------------------------------------- ping-pong
        // Half float, not full: the channels are metres in a range of roughly
        // ±1, where half float resolves well under a tenth of a millimetre.
        // Full float would double the bandwidth of a pass that runs every frame
        // and buy nothing. Toroidal addressing depends on the wrap mode.
        this._targets = [this._makeTarget(0), this._makeTarget(1)];
        this._write = 0;

        // One material serves both targets; the pass writes every texel
        // unconditionally, so there is no clear.
        this._pass = new FullscreenPass(gfx, {
            name: "deformSim",
            fragment: getShader("deformSimPixelShader"),
            uniforms: {
                prevTex: { value: this._targets[1].texture },
                brushTex: { value: this.brushTex },
                center: { value: this.center },
                prevCenter: { value: this._prevCenter },
                size: { value: this.size },
                res: { value: this.res },
                dt: { value: 0 },
                brushCount: { value: 0 },
                refillRate: { value: 1 },
                maxDepth: { value: 1 },
                maxBerm: { value: 1 },
                windAngle: { value: 0 },
            },
        });

        /**
         * Seconds of relaxation owed to the buffer but not yet spent.
         *
         * The relax terms are too slow to survive a half-float store at frame
         * cadence: a 400-second decay asks for a change well under one ULP, and
         * the rounding turns it into a ten-second decay. Time is banked here and
         * spent in steps big enough to land on a different number.
         */
        this._relaxOwed = 0;

        /** The texture holding this frame's state. Bound by the terrain. */
        this.texture = this._targets[0].texture;

        this._warmed = false;
    }

    /** @param {number} i */
    _makeTarget(i) {
        return this.gfx.makeRenderTarget("deform" + i, this.res, this.res, {
            type: THREE.HalfFloatType,
            format: THREE.RGBAFormat,
            filter: THREE.LinearFilter,
            wrap: THREE.RepeatWrapping,
            depth: false,
        });
    }

    /**
     * Queue a brush for this frame. Called from character contact and from
     * spells; accumulates additively into whatever is already there.
     *
     * Positions are absolute world metres — the shader wraps them into the
     * window itself, so callers never think about the toroid.
     *
     * @param {number} x world X
     * @param {number} z world Z
     * @param {number} radius metres, across the short axis
     * @param {number} depth metres of depression at the centre
     * @param {number} berm metres of displaced mass thrown to the rim
     * @param {number} compression 0..1 added to the compression channel
     * @param {number} ice 0..1, taken as a max rather than added
     * @param {number} [yaw] radians, orients the long axis
     * @param {number} [elongation] long-axis multiple of `radius`, 1 = round
     * @param {number} [edge] 0..1 rim roughness; 0 is a clean bevel
     */
    brush(x, z, radius, depth, berm, compression, ice, yaw, elongation, edge) {
        if (this._brushCount >= MAX_BRUSHES) return;
        if (radius <= 0) return;

        // Outside the window entirely — nothing it could write to.
        const halfPlus = this.size * 0.5 + radius * 2;
        if (Math.abs(x - this.center.x) > halfPlus) return;
        if (Math.abs(z - this.center.y) > halfPlus) return;

        const i = this._brushCount++;
        const d = this._brushData;
        const stride = MAX_BRUSHES * 4;
        const a = i * 4;

        const yw = yaw || 0;
        d[a] = x;
        d[a + 1] = z;
        d[a + 2] = radius;
        d[a + 3] = elongation || 1;

        d[stride + a] = Math.cos(yw);
        d[stride + a + 1] = Math.sin(yw);
        d[stride + a + 2] = depth;
        d[stride + a + 3] = berm;

        d[stride * 2 + a] = compression;
        d[stride * 2 + a + 1] = ice;
        d[stride * 2 + a + 2] = edge === undefined ? 1 : edge;
        // Decorrelates the rim wobble and the berm granularity between brushes,
        // so a line of footprints does not repeat one silhouette.
        d[stride * 2 + a + 3] = (x * 0.37 + z * 0.71) % 100;

        this._brushDirty = true;
    }

    /**
     * Advance the simulation one frame and return the texture holding the
     * result.
     *
     * @param {number} dt seconds
     * @param {{x:number, z:number}} focus world position the window follows
     */
    update(dt, focus) {
        this._prevCenter.copy(this.center);

        // Snap to texel boundaries. Without this the toroidal mapping shifts by
        // a fraction of a texel every frame and the whole field crawls.
        const t = this.texel;
        this.center.x = Math.round(focus.x / t) * t;
        this.center.y = Math.round(focus.z / t) * t;

        // Zero out the tail of the brush texture once after a busy frame, so a
        // stale radius can never be picked up by a later, shorter frame.
        if (this._brushDirty || this._brushCount > 0) {
            this._uploadBrushes();
        }

        // Bank the frame's time and spend it only once it is worth spending.
        // 0.4 s of a 400 s decay is a relative change of 1e-3, comfortably clear
        // of the 4.9e-4 half-float ULP, and far too small a step to see.
        this._relaxOwed += dt;
        let relaxDt = 0;
        if (this._relaxOwed >= RELAX_STEP) {
            relaxDt = this._relaxOwed;
            this._relaxOwed = 0;
        }

        const rt = this._targets[this._write];
        const prev = this._targets[1 - this._write];

        const u = this._pass.material.uniforms;
        u.prevTex.value = prev.texture;
        // center/prevCenter are bound by reference and already mutated above.
        u.size.value = this.size;
        u.res.value = this.res;
        u.dt.value = relaxDt;
        u.brushCount.value = this._brushCount;
        u.refillRate.value = S.refillRate;
        u.maxDepth.value = 0.55 * S.deformDepth;
        u.maxBerm.value = 0.34 * S.deformBerm;
        u.windAngle.value = (S.windDirection * Math.PI) / 180;

        this._pass.render(rt);

        this.texture = rt.texture;
        this._write = 1 - this._write;
        this._brushCount = 0;
        return this.texture;
    }

    _uploadBrushes() {
        // Only the live brushes carry meaning; the shader reads exactly
        // `brushCount` of them, so the tail can stay stale. But radius 0 is the
        // shader's own skip test, so clearing it is a cheap safety net.
        const d = this._brushData;
        for (let i = this._brushCount; i < MAX_BRUSHES; i++) {
            d[i * 4 + 2] = 0;
        }
        this.brushTex.needsUpdate = true;
        this._brushDirty = false;
    }

    /**
     * Compile the pass and zero both targets, behind the loading screen.
     *
     * The targets start as uninitialised VRAM. Two passes with the previous
     * centre placed far outside the window make every texel read as "just
     * scrolled in", which the shader answers by writing zero — so the buffer is
     * cleared by the same code path that runs every frame, rather than by a
     * special case that could rot.
     */
    async warmUp() {
        await whenReady(this.gfx, this._pass, "deform sim");

        this._brushCount = 0;
        this._uploadBrushes();

        const u = this._pass.material.uniforms;
        for (let i = 0; i < 2; i++) {
            const rt = this._targets[this._write];
            u.prevTex.value = this._targets[1 - this._write].texture;
            // Far enough away that no texel can have been inside it.
            this._prevCenter.set(this.center.x + 1e6, this.center.y + 1e6);
            u.size.value = this.size;
            u.res.value = this.res;
            u.dt.value = 0;
            u.brushCount.value = 0;
            u.refillRate.value = 1;
            u.maxDepth.value = 1;
            u.maxBerm.value = 1;
            u.windAngle.value = 0;
            this._pass.render(rt);
            this.texture = rt.texture;
            this._write = 1 - this._write;
        }
        this._warmed = true;
    }

    dispose() {
        this._targets[0].dispose();
        this._targets[1].dispose();
        this.brushTex.dispose();
    }
}
