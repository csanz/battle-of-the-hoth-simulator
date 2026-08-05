/**
 * Muzzle-tuning markers.
 *
 * Little camera-facing rings pinned to wherever cannon bolts are born — the
 * walker's chin guns, the speeder's wingtips — refreshed every frame from the
 * same offset math the fire paths use, so a ring is exactly where the next
 * bolt will start and moves live under the overlay's muzzle sliders.
 *
 * Tooling, not content: nothing draws unless `S.showMuzzles` is on, and the
 * whole thing is one 32-quad mesh fed from a data texture, the same shape as
 * the bolt pool it exists to place.
 */

import * as THREE from "three";
import { makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

const POOL = 32;

export class MuzzleMarkers {
    /** @param {import("../core/gfx.js").Gfx} gfx */
    constructor(gfx) {
        this.gfx = gfx;

        /** (centre xyz, radius) then (rgb, 1), one column per marker. */
        this._data = new Float32Array(POOL * 2 * 4);
        this._count = 0;
        this._cameraPos = new THREE.Vector3();

        this.texture = new THREE.DataTexture(
            this._data, POOL, 2, THREE.RGBAFormat, THREE.FloatType
        );
        this.texture.colorSpace = THREE.NoColorSpace;
        this.texture.flipY = false;
        this.texture.premultiplyAlpha = false;
        this.texture.generateMipmaps = false;
        this.texture.minFilter = THREE.NearestFilter;
        this.texture.magFilter = THREE.NearestFilter;
        this.texture.wrapS = THREE.ClampToEdgeWrapping;
        this.texture.wrapT = THREE.ClampToEdgeWrapping;
        this.texture.needsUpdate = true;

        this.mesh = this._buildMesh();
        this.material = makeMaterial({
            name: "marker",
            vertex: getShader("markerVertexShader"),
            fragment: getShader("markerPixelShader"),
            uniforms: {
                // Rebound by main to the rig's shared jittered matrix, the way
                // the bolt owners do.
                viewProjection: { value: new THREE.Matrix4() },
                cameraPos: { value: this._cameraPos },
                markerTex: { value: this.texture },
            },
            // Additive light, no depth at all: a tuning ring must be visible
            // through the hull whose guns it is marking.
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: false,
            side: THREE.DoubleSide,
        });
        this.mesh.material = this.material;
        // Late in the blended pass, over the bolts it calibrates.
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 60);
        this.mesh.visible = false;
    }

    _buildMesh() {
        const positions = new Float32Array(POOL * 4 * 3);
        const indices = new Uint16Array(POOL * 6);
        const corners = [[-1, -1], [1, -1], [-1, 1], [1, 1]];
        for (let m = 0; m < POOL; m++) {
            const v = m * 4;
            for (let c = 0; c < 4; c++) {
                positions[(v + c) * 3] = m;
                positions[(v + c) * 3 + 1] = corners[c][0];
                positions[(v + c) * 3 + 2] = corners[c][1];
            }
            const o = m * 6;
            indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
            indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        const mesh = new THREE.Mesh(geometry);
        mesh.name = "muzzleMarkers";
        mesh.metadata = { triangles: POOL * 2, vertices: POOL * 4 };
        return mesh;
    }

    /** Point the markers through the same (jittered) camera as the scene. */
    bindCamera(viewProjection) {
        this.material.uniforms.viewProjection.value = viewProjection;
    }

    /** Start a frame's worth of rings. */
    begin() {
        this._count = 0;
    }

    /** One ring: world centre, radius in metres, ring colour. */
    add(x, y, z, radius, r, g, b) {
        if (this._count >= POOL) return;
        const i = this._count++;
        const a = i * 4;
        this._data[a] = x;
        this._data[a + 1] = y;
        this._data[a + 2] = z;
        this._data[a + 3] = radius;
        const c = (POOL + i) * 4;
        this._data[c] = r;
        this._data[c + 1] = g;
        this._data[c + 2] = b;
        this._data[c + 3] = 1;
    }

    /** Upload the frame's rings; zero added means nothing draws. */
    commit(cameraPos) {
        if (cameraPos) this._cameraPos.copy(cameraPos);
        for (let i = this._count; i < POOL; i++) this._data[i * 4 + 3] = 0;
        this.texture.needsUpdate = true;
        this.mesh.visible = this._count > 0;
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        this.texture.dispose();
    }
}
