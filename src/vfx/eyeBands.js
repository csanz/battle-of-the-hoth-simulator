/**
 * The walkers' eyes.
 *
 * One thin red glow-band per machine, laid across the head's viewport slit
 * and riding the head's own look — the AT-AT's lit cockpit strip from the
 * film. Content, not tooling: always on, and depth-tested, so a band goes
 * dark behind a dune or when the head faces away, unlike the tuning rings
 * it borrows its data-texture lattice from.
 *
 * The herd hands in two world points per machine — the band's ends, already
 * through the head rotation and the world transform — and everything else
 * (billboarding, the glow) happens on the GPU. Allocation per frame: none.
 */

import * as THREE from "three";
import { makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";

const POOL = 16;
/** Band height as a fraction of its half-length. */
const HEIGHT = 0.17;

export class EyeBands {
    /** @param {import("../core/gfx.js").Gfx} gfx */
    constructor(gfx) {
        this.gfx = gfx;

        /** (centre xyz, halfLen) then (axis xyz, halfHeight), per band. */
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
            name: "eyeBands",
            vertex: getShader("eyesVertexShader"),
            fragment: getShader("eyesPixelShader"),
            uniforms: {
                viewProjection: { value: new THREE.Matrix4() },
                cameraPos: { value: this._cameraPos },
                eyeTex: { value: this.texture },
                time: { value: 0 },
            },
            // Additive light over the face plating, but honestly occluded:
            // the band sits just proud of the viewport and the head's own
            // depth hides it the moment the machine looks away.
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
        this.mesh.material = this.material;
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 55);
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
        // Placed entirely by the vertex shader, so the CPU-side bounds are a
        // fiction — pin them rather than letting three derive nonsense from
        // the lattice indices.
        geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
        const mesh = new THREE.Mesh(geometry);
        mesh.name = "eyeBands";
        mesh.metadata = { triangles: POOL * 2, vertices: POOL * 4 };
        return mesh;
    }

    /** Point the bands through the same (jittered) camera as the scene. */
    bindCamera(viewProjection) {
        this.material.uniforms.viewProjection.value = viewProjection;
    }

    /** Start a frame's worth of bands. */
    begin() {
        this._count = 0;
    }

    /**
     * One band, by its two world ends — left edge to right edge of the slit.
     * The axis and length come off the segment, so the caller only has to
     * know where the viewport's corners are.
     */
    add(ax, ay, az, bx, by, bz) {
        if (this._count >= POOL) return;
        const rx = (bx - ax) * 0.5, ry = (by - ay) * 0.5, rz = (bz - az) * 0.5;
        const halfLen = Math.hypot(rx, ry, rz);
        if (halfLen < 1e-5) return;
        const i = this._count++;
        const a = i * 4;
        this._data[a] = (ax + bx) * 0.5;
        this._data[a + 1] = (ay + by) * 0.5;
        this._data[a + 2] = (az + bz) * 0.5;
        this._data[a + 3] = halfLen;
        const c = (POOL + i) * 4;
        this._data[c] = rx / halfLen;
        this._data[c + 1] = ry / halfLen;
        this._data[c + 2] = rz / halfLen;
        this._data[c + 3] = halfLen * HEIGHT;
    }

    /** Upload the frame's bands; zero added means nothing draws. */
    commit(cameraPos, time) {
        if (cameraPos) this._cameraPos.copy(cameraPos);
        if (time !== undefined) this.material.uniforms.time.value = time;
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
