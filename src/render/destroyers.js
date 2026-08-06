/**
 * The Imperial fleet on station.
 *
 * Three Star Destroyers hang high over the bearing the walkers march in from —
 * the AT-ATs came from somewhere, and this is somewhere. They are set dressing
 * in the truest sense: one baked position-only mesh (`tools/bakeDestroyer.mjs`
 * clusters the 1.35M-triangle rip down to ~47k), no shadows, no prepass, no
 * textures, lit by the same sun/SH/aerial the rest of the scene breathes so
 * they sit *in* the sky rather than on it.
 *
 * Placement is settings-driven and recomputed per frame (three matrix writes),
 * so the Fleet sliders move them live. Import-safe and stub-tolerant: a
 * missing bin costs the backdrop, not the boot.
 */

import * as THREE from "three";
import { S } from "../core/settings.js";
import { makeMaterial, whenReady } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { fetchAsset } from "../core/assets.js";

const COUNT = 3;

/** Per-ship formation offsets: (along-bearing, lateral, altitude, yaw, scale). */
const FORMATION = [
    [0, 0, 0, 0.55, 1.0],
    [420, -680, 140, 0.9, 0.82],
    [780, 540, 260, 0.25, 0.68],
];

export class Destroyers {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("./sky.js").Sky} sky
     */
    constructor(gfx, sky) {
        this.gfx = gfx;
        this.sky = sky;
        this.triangles = 0;
        /** @type {THREE.Mesh[]} */
        this.meshes = [];
        /** @type {THREE.RawShaderMaterial[]} */
        this.materials = [];
        this._models = [];
        this._cameraPos = new THREE.Vector3();
        this._ready = false;

        this._loadPromise = this._load().catch((err) => {
            console.warn("[destroyers] unavailable:", err);
        });
    }

    async _load() {
        const res = await fetchAsset("models/destroyer.bin");
        const buf = await res.arrayBuffer();
        const dv = new DataView(buf);
        if (dv.getUint32(0, true) !== 0x54534453 || dv.getUint32(4, true) !== 1) {
            throw new Error("not an SDST v1 file");
        }
        const vertCount = dv.getUint32(8, true);
        const triCount = dv.getUint32(12, true);
        const HEADER = 16 + 24;
        const positions = new Float32Array(buf, HEADER, vertCount * 3);
        const indices = new Uint32Array(buf, HEADER + vertCount * 12, triCount * 3);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        // Bounds from the bake's own header — nothing downstream should ever
        // need to walk 23k vertices to learn them (and culling is off anyway;
        // placement lives in the `model` uniform, invisible to Three).
        const lo2 = new THREE.Vector3(
            dv.getFloat32(16, true), dv.getFloat32(20, true), dv.getFloat32(24, true)
        );
        const hi2 = new THREE.Vector3(
            dv.getFloat32(28, true), dv.getFloat32(32, true), dv.getFloat32(36, true)
        );
        const center = lo2.clone().add(hi2).multiplyScalar(0.5);
        geometry.boundingSphere = new THREE.Sphere(center, hi2.distanceTo(lo2) * 0.5);
        geometry.boundingBox = new THREE.Box3(lo2, hi2);

        for (let i = 0; i < COUNT; i++) {
            const model = new THREE.Matrix4();
            const material = makeMaterial({
                name: "destroyer",
                vertex: getShader("destroyerVertexShader"),
                fragment: getShader("destroyerPixelShader"),
                uniforms: {
                    model: { value: model },
                    // The camera may have been bound before this async load
                    // finished — without honouring it here every ship draws
                    // with an identity view-projection: clip-space garbage,
                    // a fleet that exists and is never seen.
                    viewProjection: { value: this._boundVP || new THREE.Matrix4() },
                    cameraPos: { value: this._cameraPos },
                    sunDir: { value: this.sky.sunDir },
                    sunColor: { value: this.sky.sunRadiance },
                    ambientSky: { value: new THREE.Vector3(0.1, 0.12, 0.16) },
                    skyLUT: { value: this.sky.lut },
                    fogDensity: { value: S.fogDensity },
                    fogHeightFalloff: { value: S.fogHeightFalloff },
                    fogStart: { value: S.fogStart },
                    aerialStrength: { value: S.aerialStrength },
                },
                // The bake does not preserve winding (clustering scrambles it)
                // and the shader faces its derivative normals at the viewer,
                // so both sides are the same hull.
                side: THREE.DoubleSide,
                depthWrite: true,
                depthTest: true,
            });
            const mesh = new THREE.Mesh(geometry, material);
            mesh.name = "destroyer" + i;
            mesh.metadata = { triangles: triCount, vertices: vertCount };
            // Early in the opaque pass: effectively sky-distance, everything
            // else will depth-test in front of it.
            this.gfx.addMesh(mesh, this.gfx.LAYER.OPAQUE, 6);
            mesh.visible = false;
            this.meshes.push(mesh);
            this.materials.push(material);
            this._models.push(model);
        }
        this.triangles = triCount * COUNT;
        this._ready = true;
    }

    /** Alias the rig's (jittered) matrix into every ship, once at boot. */
    bindCamera(viewProjection) {
        this._boundVP = viewProjection;
        for (const m of this.materials) m.uniforms.viewProjection.value = viewProjection;
    }

    /**
     * Re-place the formation from the Fleet settings and refresh the shared
     * lighting uniforms. Cheap enough to run every frame, which is what makes
     * the sliders live.
     * @param {{x:number, z:number}} anchor usually the player
     * @param {THREE.Vector3} cameraPos
     */
    update(anchor, cameraPos) {
        if (!this._ready) return;
        const show = S.showDestroyers !== false;
        const n = show ? Math.min(COUNT, Math.max(1, S.destroyerCount | 0)) : 0;

        this._cameraPos.copy(cameraPos);
        const bearing = ((S.sunAzimuth + (S.destroyerBearing || 0)) * Math.PI) / 180;
        const bx = Math.sin(bearing), bz = Math.cos(bearing);
        const scaleBase = S.destroyerScale || 0.35;

        for (let i = 0; i < COUNT; i++) {
            const mesh = this.meshes[i];
            if (i >= n) {
                mesh.visible = false;
                continue;
            }
            mesh.visible = true;
            const [along, lateral, rise, yawOff, sizeK] = FORMATION[i];
            const dist = (S.destroyerDist || 2600) + along;
            const px = anchor.x + bx * dist + bz * lateral;
            const pz = anchor.z + bz * dist - bx * lateral;
            const py = (S.destroyerAlt || 850) + rise;
            // Broadside-biased: faced along the bearing plus the formation's
            // own yaw, so each hull shows a different profile.
            const yaw = bearing + yawOff + ((S.destroyerYaw || 0) * Math.PI) / 180;
            const k = scaleBase * sizeK;
            const c = Math.cos(yaw), s = Math.sin(yaw);
            const e = this._models[i].elements;
            e[0] = c * k; e[1] = 0; e[2] = -s * k; e[3] = 0;
            e[4] = 0; e[5] = k; e[6] = 0; e[7] = 0;
            e[8] = s * k; e[9] = 0; e[10] = c * k; e[11] = 0;
            e[12] = px; e[13] = py; e[14] = pz; e[15] = 1;

            const u = this.materials[i].uniforms;
            u.fogDensity.value = S.fogDensity;
            u.fogHeightFalloff.value = S.fogHeightFalloff;
            u.fogStart.value = S.fogStart;
            u.aerialStrength.value = S.aerialStrength;
            // Ambient from the sky's SH DC band — enough for a grey hull, and
            // it tracks every sun/atmosphere slider for free.
            const sh = this.sky.sh;
            u.ambientSky.value.set(
                Math.max(0, sh[0] * 0.886),
                Math.max(0, sh[1] * 0.886),
                Math.max(0, sh[2] * 0.886)
            );
        }
    }

    async warmUp() {
        await this._loadPromise;
        if (!this._ready || !this.meshes.length) return;
        await whenReady(this.gfx, this.materials[0], "destroyer material");
    }
}
