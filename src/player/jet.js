/**
 * The speeder's engine plume.
 *
 * Two nozzles, eight rungs each, one draw. The mesh carries `(nozzle, t, side)`
 * and everything else — where the engines are, which way the exhaust blows, how
 * hard — arrives as four uniforms a frame, so this allocates nothing and costs
 * thirty-two triangles.
 *
 * Drawn in the alpha group with additive blending and no depth write, like the
 * bolts: an exhaust is light, so it should brighten a dune it passes in front of
 * rather than replace it, and it should be hidden by one it passes behind.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { S } from "../core/settings.js";
import { getShader } from "../shaders/registry.js";
import { mulMat4 } from "../core/mat4.js";

/** Engines. */
const NOZZLES = 2;
/** Rungs along each plume. Enough to bend and boil without being a strip. */
const RUNGS = 8;
/** Metres at full throttle. */
const LENGTH = 7.5;
/** Half-width at the throat, metres, and how much it opens along its length. */
const WIDTH = 0.42;
const FLARE = 1.25;

export class Jet {
    /** @param {import("../core/gfx.js").Gfx} gfx */
    constructor(gfx) {
        this.gfx = gfx;
        this._time = 0;
        this._cameraPos = new THREE.Vector3();
        // Per-instance, because they are the uniform VALUES: as module scratch
        // (the original layout) a second craft's jet would overwrite the
        // player's flame every frame — both plumes drawn from one buffer.
        this._origins = new Float32Array(NOZZLES * 4);
        this._dir = new THREE.Vector4(0, 0, -1, LENGTH);
        this._params = new THREE.Vector4(0, 0, WIDTH, FLARE);
        /**
         * The jittered view-projection of the frame being drawn. Babylon
         * auto-bound this from the active camera; here it is recomputed from
         * the token camera (whose matrices main syncs from the rig before any
         * pass renders) in `onBeforeRender` — zero copies of the rig needed.
         */
        this._viewProj = new THREE.Matrix4();

        this.material = this._makeMaterial();
        this.mesh = this._buildMesh();
        this.mesh.material = this.material;
        // renderingGroupId 2 → the blended layer, additive, after the water.
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 40);

        const tc = gfx.threeCamera;
        this.mesh.onBeforeRender = () => {
            mulMat4(
                this._viewProj.elements,
                tc.projectionMatrix.elements,
                tc.matrixWorldInverse.elements
            );
        };
    }

    _buildMesh() {
        const positions = new Float32Array(NOZZLES * (RUNGS + 1) * 2 * 3);
        const indices = new Uint16Array(NOZZLES * RUNGS * 6);
        let v = 0, i = 0;
        for (let n = 0; n < NOZZLES; n++) {
            const base = v;
            for (let r = 0; r <= RUNGS; r++) {
                const t = r / RUNGS;
                for (const side of [-1, 1]) {
                    positions[v * 3] = n;
                    positions[v * 3 + 1] = t;
                    positions[v * 3 + 2] = side;
                    v++;
                }
            }
            for (let r = 0; r < RUNGS; r++) {
                const a = base + r * 2;
                indices[i++] = a; indices[i++] = a + 1; indices[i++] = a + 2;
                indices[i++] = a + 1; indices[i++] = a + 3; indices[i++] = a + 2;
            }
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));

// Placed entirely by the vertex shader, so the CPU-side bounds are a
        // fiction — pin them rather than letting three derive nonsense (or a
        // NaN radius) from the lattice indices.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        const mesh = new THREE.Mesh(geometry, this.material);
        mesh.metadata = { triangles: NOZZLES * RUNGS * 2, vertices: v };
        return mesh;
    }

    _makeMaterial() {
        return makeMaterial({
            name: "jet",
            vertex: getShader("jetVertexShader"),
            fragment: getShader("jetPixelShader"),
            uniforms: {
                viewProjection: { value: this._viewProj },
                cameraPos: { value: this._cameraPos },
                jetOrigin: { value: this._origins },
                jetDir: { value: this._dir },
                jetParams: { value: this._params },
                jetGlow: { value: 1 },
                jetHaloBack: { value: 0.1 },
                jetDebug: { value: 0 },
            },
            // ALPHA_ADD with alpha written at 1: brightens what it overlaps.
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
    }

    /**
     * @param {number} dt
     * @param {Float32Array} world the craft's 3x4 transform
     * @param {{spanX:number, dropY:number, backZ:number}} nozzle
     *   where the exhaust leaves the hull, in craft-local metres
     * @param {number} throttle 0..1
     * @param {THREE.Vector3} cameraPos
     */
    update(dt, world, nozzle, throttle, cameraPos) {
        this._time += dt;
        this._cameraPos.copy(cameraPos);

        // Where the nozzles are is the caller's business now, and it used to be
        // fractions of the craft's overall bounds — 0.86 of the half-length back,
        // which put the flame a third of a metre *inside* the engine block. The
        // craft knows where its own engine is; see `ENGINE_NOZZLE` in speeder.js.
        const spanX = nozzle.spanX;
        const backZ = nozzle.backZ;
        const dropY = nozzle.dropY;
        const origins = this._origins;
        for (let n = 0; n < NOZZLES; n++) {
            const lx = n === 0 ? -spanX : spanX;
            const o = n * 4;
            origins[o] = world[0] * lx + world[3] * dropY + world[6] * backZ + world[9];
            origins[o + 1] = world[1] * lx + world[4] * dropY + world[7] * backZ + world[10];
            origins[o + 2] = world[2] * lx + world[5] * dropY + world[8] * backZ + world[11];
            origins[o + 3] = 1;
        }
        // Straight out of the back, in world space.
        this._dir.set(-world[6], -world[7], -world[8], LENGTH * S.jetLength);
        this._params.set(throttle, this._time, WIDTH * S.jetWidth, FLARE * S.jetFlare);
        this.material.uniforms.jetGlow.value = S.jetGlow ?? 1;
        this.material.uniforms.jetHaloBack.value = S.jetHaloBack ?? 0.1;
        this.material.uniforms.jetDebug.value = S.jetDebug ? 1 : 0;
        // The uniform values are the scratch objects themselves, mutated above —
        // Three re-uploads them on the next draw; nothing else to write.
    }

    setVisible(v) {
        this.mesh.visible = !!v;
    }

    async warmUp() {
        this.mesh.visible = true;
        await whenReady(this.gfx, this.material, "jet material");
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
    }
}
