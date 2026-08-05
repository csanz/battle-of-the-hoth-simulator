/**
 * GPU helpers: material construction, fullscreen passes, and warm-up.
 *
 * In the Babylon build these existed because WebGPU compiles asynchronously
 * and a material constructed on one line was not usable on the next. WebGL2
 * compiles synchronously but janks instead, so the shape survives: everything
 * still compiles behind the loading screen, via `renderer.compileAsync` (which
 * rides `KHR_parallel_shader_compile` where present), and the 25 s labelled
 * watchdog stays as the compile-error diagnostic it always was.
 */

import * as THREE from "three";
import { composeShader } from "../shaders/registry.js";

// --------------------------------------------------------------- makeMaterial

/**
 * Build a `RawShaderMaterial` with `#include<snowXxx>` chunks resolved.
 *
 * @param {{
 *   name?: string,
 *   vertex: string,   // raw GLSL ES 3.0 body (no #version line)
 *   fragment: string,
 *   uniforms?: Record<string, {value: any}>,
 * } & Record<string, any>} opts any other keys pass through as material flags
 *   (transparent, blending, depthWrite, side, …)
 * @returns {THREE.RawShaderMaterial}
 */
export function makeMaterial(opts) {
    const { name, vertex, fragment, uniforms, ...flags } = opts;
    const mat = new THREE.RawShaderMaterial({
        glslVersion: THREE.GLSL3,
        vertexShader: composeShader(vertex),
        fragmentShader: composeShader(fragment),
        uniforms: uniforms || {},
        ...flags,
    });
    mat.name = name || "";
    return mat;
}

// ------------------------------------------------------------ fullscreen pass

/**
 * One shared clip-space triangle (−1..3) for every fullscreen pass. `vUV` is
 * in [0,1] over the viewport with v = 0 at the BOTTOM (GL convention) — the
 * orientation every bake and post shader in this port assumes.
 */
let _triGeometry = null;

function triGeometry() {
    if (!_triGeometry) {
        _triGeometry = new THREE.BufferGeometry();
        _triGeometry.setAttribute(
            "position",
            new THREE.BufferAttribute(new Float32Array([-1, -1, 3, -1, -1, 3]), 2)
        );
    }
    return _triGeometry;
}

const FS_VERTEX = /* glsl */ `precision highp float;
precision highp int;

in vec2 position;
out vec2 vUV;

void main() {
    vUV = position * 0.5 + vec2(0.5);
    gl_Position = vec4(position, 0.0, 1.0);
}
`;

export class FullscreenPass {
    /**
     * @param {import("./gfx.js").Gfx} gfx
     * @param {{name?: string, fragment: string, uniforms?: Record<string, {value:any}>}} opts
     */
    constructor(gfx, opts) {
        this.gfx = gfx;
        this.name = opts.name || "fullscreen";

        this._material = new THREE.RawShaderMaterial({
            glslVersion: THREE.GLSL3,
            vertexShader: FS_VERTEX,
            fragmentShader: composeShader(opts.fragment),
            uniforms: opts.uniforms || {},
            depthTest: false,
            depthWrite: false,
        });
        this._material.name = this.name;

        this._mesh = new THREE.Mesh(triGeometry(), this._material);
        this._mesh.frustumCulled = false;
        this._mesh.matrixAutoUpdate = false;

        this._scene = new THREE.Scene();
        this._scene.add(this._mesh);
        this._camera = new THREE.Camera();
    }

    get material() {
        return this._material;
    }

    /**
     * Draw the triangle once into `target` (or the canvas when null).
     * @param {THREE.WebGLRenderTarget|null} target
     */
    render(target) {
        const r = this.gfx.renderer;
        r.setRenderTarget(target || null);
        r.render(this._scene, this._camera);
    }
}

// -------------------------------------------------------------------- warm-up

const WATCHDOG_MS = 25000;

// Shared scaffolding for compiling a bare material.
let _compileScene = null;

function compileMaterial(gfx, material) {
    if (!_compileScene) _compileScene = new THREE.Scene();
    const mesh = new THREE.Mesh(triGeometry(), material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    _compileScene.add(mesh);
    return gfx.renderer
        .compileAsync(_compileScene, gfx.threeCamera)
        .finally(() => _compileScene.remove(mesh));
}

/**
 * Compile whatever `materialOrPass` is, behind a labelled 25 s watchdog.
 *
 * Accepts a `FullscreenPass`, a raw material, or any object carrying a
 * `.material` (a subsystem pass wrapper). When `drawFn` is given it is awaited
 * instead — for passes whose compilation needs a real draw.
 *
 * @param {import("./gfx.js").Gfx} gfx
 * @param {any} materialOrPass
 * @param {string} label used in the timeout message
 * @param {() => any} [drawFn]
 * @returns {Promise<void>}
 */
export function whenReady(gfx, materialOrPass, label, drawFn) {
    let timer = null;
    const watchdog = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
            reject(new Error(
                label + " never became ready after 25s — " +
                "almost always a GLSL compile error; check the console."
            ));
        }, WATCHDOG_MS);
    });

    const work = (async () => {
        if (drawFn) {
            await drawFn();
            return;
        }
        const obj = materialOrPass;
        if (!obj) return;
        if (obj instanceof FullscreenPass) {
            await gfx.renderer.compileAsync(obj._scene, obj._camera);
            return;
        }
        if (obj.isMaterial) {
            await compileMaterial(gfx, obj);
            return;
        }
        if (obj.material && obj.material.isMaterial) {
            await compileMaterial(gfx, obj.material);
            return;
        }
        // Nothing compilable — a stub peer. Tolerated (G1).
    })();

    return Promise.race([work, watchdog]).finally(() => clearTimeout(timer));
}

/**
 * The bake pattern: compile a fullscreen pass, then render it exactly once.
 * @param {FullscreenPass} pass
 * @param {THREE.WebGLRenderTarget|null} target
 * @param {string} [label]
 */
export async function bakeOnce(pass, target, label) {
    await whenReady(pass.gfx, pass, label || pass.name);
    pass.render(target);
}

/**
 * Compile every material currently in the main scene.
 * @param {import("./gfx.js").Gfx} gfx
 */
export function compileAll(gfx) {
    return gfx.renderer.compileAsync(gfx.scene, gfx.threeCamera);
}
