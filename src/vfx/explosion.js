/**
 * Shellbursts — the Hoth fireball, raymarched, where the cannon fire lands
 * close to the fight.
 *
 * Two pooled meshes and nothing else. The fireballs are three camera-facing
 * billboards whose fragment shader marches a soot-marbled fbm volume (see
 * `explosion.fragment.glsl` for the look and why its emission out-runs the
 * snow); the embers are a shared pool of velocity-stretched streak quads,
 * CPU-simmed the same way the spray is. The snow the blast throws, the crater
 * and the infantry's reaction are not this module's business: the bolts
 * already do all three on every impact, and this only adds the fire.
 *
 * Spawning is gated, not per-impact. The guns land seven bolts a second on an
 * attack run and a fireball each would be a wall of orange — so a burst asks
 * for an explosion only when it lands close to something that matters (the
 * armour, the squads), rolls a die, and honours a global cooldown. The misses
 * still crater and spray; the hits, sometimes, blossom.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { mulMat4 } from "../core/mat4.js";

/** Concurrent fireballs. The fourth-oldest would be invisible behind the new. */
const MAX = 3;
/** Seconds a burst lives, matched to DUR in the fragment shader. */
const DUR = 3.2;
/** Metres, the fireball's max radius. */
const RADIUS = 4.5;
/** Metres the volume's centre sits above the impact — base on the snow. */
const LIFT = 2.4;

/** Streaked embers per burst, and the shared pool. */
const EMB_PER = 22;
const EMB_N = MAX * EMB_PER;

/** Seconds between bursts, globally — drama is a scarcity economy. Short
 *  enough that the walkers' incoming shells visibly claim their share of it
 *  alongside the player's and the wingmen's fire. */
const COOLDOWN = 1.0;
/** How often a qualifying impact actually blossoms. */
const CHANCE = 0.6;

const _corners = [[0, -1], [0, 1], [1, -1], [1, 1]];

export class Explosions {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {{ herd: { count:number, walkers:{position:THREE.Vector3}[] },
     *           radius: number }[]} near what an impact must land close to
     *   before it qualifies, and how close counts for each herd.
     */
    constructor(gfx, terrain, sky, near) {
        this.gfx = gfx;
        this.terrain = terrain || null;
        this._near = near || [];

        // ---- burst state ---------------------------------------------------
        /** Seconds since each slot detonated; past DUR the slot is free. */
        this._t = new Float32Array(MAX).fill(DUR + 1);
        this._seed = new Float32Array(MAX);
        this._center = new Float32Array(MAX * 3);
        this._cooldown = 0;
        this._time = 0;

        /** Flat vec4[MAX] uniform stores — (centre, R) and (t01, seed, t, 0). */
        this._expPos = new Float32Array(MAX * 4);
        this._expAnim = new Float32Array(MAX * 4);

        // ---- shared camera bindings ---------------------------------------
        // Same pattern as the speeder and its bolts: one jittered matrix,
        // recomputed in onBeforeRender from the token camera both passes use.
        this._viewProj = new THREE.Matrix4();
        this._cameraPos = new THREE.Vector3();
        const tc = gfx.threeCamera;
        const refresh = () => {
            mulMat4(
                this._viewProj.elements,
                tc.projectionMatrix.elements,
                tc.matrixWorldInverse.elements
            );
        };

        // ---- the fireballs -------------------------------------------------
        this.material = makeMaterial({
            name: "explosion",
            vertex: getShader("explosionVertexShader"),
            fragment: getShader("explosionPixelShader"),
            uniforms: {
                viewProjection: { value: this._viewProj },
                cameraPos: { value: this._cameraPos },
                sunDir: { value: (sky && sky.sunDir) || new THREE.Vector3(0, 1, 0) },
                expPos: { value: this._expPos },
                expAnim: { value: this._expAnim },
                explosionGlow: { value: 1 },
            },
            // Premultiplied over: the march composites front-to-back inside the
            // volume, and this carries that result straight onto the frame —
            // the smoke's alpha genuinely occludes what is behind it.
            transparent: true,
            blending: THREE.CustomBlending,
            blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor,
            blendDst: THREE.OneMinusSrcAlphaFactor,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
        this.mesh = this._buildFireballMesh();
        this.mesh.material = this.material;
        this.mesh.onBeforeRender = refresh;
        // After the bolts (41): the burst a bolt started draws over it.
        gfx.addMesh(this.mesh, gfx.LAYER.BLEND, 42);
        this.mesh.visible = false;

        // ---- the embers ----------------------------------------------------
        this._emPos = new Float32Array(EMB_N * 3);
        this._emVel = new Float32Array(EMB_N * 3);
        this._emLife = new Float32Array(EMB_N);
        this._emLife0 = new Float32Array(EMB_N).fill(1);
        this._emDelay = new Float32Array(EMB_N);
        this._emSize = new Float32Array(EMB_N);
        this._emSeed = new Float32Array(EMB_N);
        /** False once every ember is dead and the buffers hold the zeros. */
        this._emberDirty = false;

        this.emberMaterial = makeMaterial({
            name: "ember",
            vertex: getShader("emberVertexShader"),
            fragment: getShader("emberPixelShader"),
            uniforms: {
                viewProjection: { value: this._viewProj },
                cameraPos: { value: this._cameraPos },
                emberTime: { value: 0 },
            },
            // Additive and no depth write, exactly as the bolts: an ember is
            // light. Terrain in front still occludes it.
            transparent: true,
            blending: THREE.AdditiveBlending,
            depthWrite: false,
            depthTest: true,
            side: THREE.DoubleSide,
        });
        this.emberMesh = this._buildEmberMesh();
        this.emberMesh.material = this.emberMaterial;
        this.emberMesh.onBeforeRender = refresh;
        gfx.addMesh(this.emberMesh, gfx.LAYER.BLEND, 43);
        this.emberMesh.visible = false;
    }

    _buildFireballMesh() {
        const positions = new Float32Array(MAX * 4 * 3);
        const indices = new Uint16Array(MAX * 6);
        for (let s = 0; s < MAX; s++) {
            const v = s * 4;
            for (let c = 0; c < 4; c++) {
                positions[(v + c) * 3] = s;
                positions[(v + c) * 3 + 1] = _corners[c][0] === 0 ? -1 : 1;
                positions[(v + c) * 3 + 2] = _corners[c][1];
            }
            const o = s * 6;
            indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
            indices[o + 3] = v + 1; indices[o + 4] = v + 3; indices[o + 5] = v + 2;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        const mesh = new THREE.Mesh(geometry);
        mesh.name = "explosions";
        mesh.metadata = { triangles: MAX * 2, vertices: MAX * 4 };
        return mesh;
    }

    _buildEmberMesh() {
        const positions = new Float32Array(EMB_N * 4 * 3);
        const vel = new Float32Array(EMB_N * 4 * 3);
        const data = new Float32Array(EMB_N * 4 * 3);
        const corner = new Float32Array(EMB_N * 4 * 2);
        const indices = new Uint16Array(EMB_N * 6);
        for (let i = 0; i < EMB_N; i++) {
            const v = i * 4;
            for (let c = 0; c < 4; c++) {
                corner[(v + c) * 2] = _corners[c][0];
                corner[(v + c) * 2 + 1] = _corners[c][1];
            }
            const o = i * 6;
            indices[o] = v; indices[o + 1] = v + 1; indices[o + 2] = v + 2;
            indices[o + 3] = v + 2; indices[o + 4] = v + 1; indices[o + 5] = v + 3;
        }
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
        geometry.setAttribute("aVel", new THREE.BufferAttribute(vel, 3));
        geometry.setAttribute("aData", new THREE.BufferAttribute(data, 3));
        geometry.setAttribute("aCorner", new THREE.BufferAttribute(corner, 2));
        geometry.setIndex(new THREE.BufferAttribute(indices, 1));
        const mesh = new THREE.Mesh(geometry);
        mesh.name = "embers";
        mesh.metadata = { triangles: EMB_N * 2, vertices: EMB_N * 4 };
        return mesh;
    }

    /**
     * A bolt landed. Maybe blossom — see the header for the gate.
     * Wire this *alongside* the bolts' existing `onImpact` consumers, not in
     * place of them; the crater and the flinching squad still belong to them.
     *
     * @param {boolean} [anywhere] skip the proximity roll — the player's own
     *   guns. A deliberate shot into the snow that does nothing reads as a
     *   misfire, so the player's impacts always blossom; the cooldown alone
     *   keeps a held trigger from becoming a wall of orange.
     */
    impact(x, y, z, anywhere = false, force = false) {
        if (S.showExplosions === false) return;
        // `force` is for events, not fire: a crashing airframe detonates
        // whatever the ration says.
        if (this._cooldown > 0 && !force) return;
        if (!anywhere) {
            let close = false;
            for (const n of this._near) {
                const herd = n.herd;
                if (!herd || !herd.walkers) continue;
                const count = Math.min(herd.count, herd.walkers.length);
                for (let i = 0; i < count; i++) {
                    const w = herd.walkers[i];
                    if (!w || !w.position) continue;
                    const d = Math.hypot(w.position.x - x, w.position.z - z);
                    if (d < n.radius) { close = true; break; }
                }
                if (close) break;
            }
            if (!close || Math.random() > CHANCE) return;
        }

        // Oldest slot, so a fresh burst never waits on a dying one.
        let slot = 0;
        for (let s = 1; s < MAX; s++) {
            if (this._t[s] > this._t[slot]) slot = s;
        }
        this._cooldown = COOLDOWN;
        this._t[slot] = 0;
        this._seed[slot] = Math.random() * 37;
        const cx = x, cy = y + LIFT, cz = z;
        this._center[slot * 3] = cx;
        this._center[slot * 3 + 1] = cy;
        this._center[slot * 3 + 2] = cz;

        // Embers: born on the young fireball's surface, thrown outward, a few
        // "heroes" that fly bigger and live longer — uniformity reads as fake.
        for (let k = 0; k < EMB_PER; k++) {
            const i = slot * EMB_PER + k;
            const a = Math.random() * Math.PI * 2;
            const up = 0.05 + Math.random() * 0.85;
            const hor = Math.sqrt(Math.max(0, 1 - up * up));
            const dx = Math.cos(a) * hor, dz = Math.sin(a) * hor;
            const sp = 7 + Math.random() * 15;
            const r0 = 0.35 + Math.random() * 0.65;
            this._emPos[i * 3] = cx + dx * r0;
            this._emPos[i * 3 + 1] = cy + up * r0;
            this._emPos[i * 3 + 2] = cz + dz * r0;
            this._emVel[i * 3] = dx * sp;
            this._emVel[i * 3 + 1] = up * sp;
            this._emVel[i * 3 + 2] = dz * sp;
            const hero = Math.random() < 0.12;
            this._emLife0[i] = this._emLife[i] =
                (0.5 + Math.random() * 1.0) * (hero ? 1.9 : 1);
            this._emDelay[i] = Math.random() * 0.16;
            this._emSize[i] = (0.45 + Math.random() * 0.9) * (hero ? 1.6 : 1);
            this._emSeed[i] = Math.random();
        }
        this._emberDirty = true;
    }

    /** @param {number} dt @param {THREE.Vector3} cameraPos */
    update(dt, cameraPos) {
        this._time += dt;
        this._cooldown = Math.max(0, this._cooldown - dt);
        if (cameraPos) this._cameraPos.copy(cameraPos);

        // ---- bursts --------------------------------------------------------
        let live = 0;
        for (let s = 0; s < MAX; s++) {
            if (this._t[s] <= DUR) {
                this._t[s] += dt;
                if (this._t[s] <= DUR) live++;
            }
            const t01 = this._t[s] / DUR;
            const o = s * 4;
            this._expPos[o] = this._center[s * 3];
            this._expPos[o + 1] = this._center[s * 3 + 1];
            this._expPos[o + 2] = this._center[s * 3 + 2];
            this._expPos[o + 3] = RADIUS;
            this._expAnim[o] = t01 < 1 ? t01 : -1;
            this._expAnim[o + 1] = this._seed[s];
            this._expAnim[o + 2] = this._t[s];
            this._expAnim[o + 3] = 0;
        }
        this.mesh.visible = live > 0 && S.showExplosions !== false;

        // ---- embers --------------------------------------------------------
        // Idle, the whole block is three comparisons: every ember dead, the
        // buffers already zeroed, nothing simulated and nothing uploaded.
        // The pool spends most of the game in exactly that state, and a
        // steady ~11 KB/frame of attribute upload for an empty pool is the
        // kind of quiet tax this codebase does not pay.
        if (!this._emberDirty && live === 0) {
            this.emberMesh.visible = false;
            this.emberMaterial.uniforms.emberTime.value = this._time;
            this.material.uniforms.explosionGlow.value = S.explosionGlow ?? 1;
            return;
        }
        const terrain = this.terrain;
        let emberLive = 0;
        const posAttr = this.emberMesh.geometry.attributes.position;
        const velAttr = this.emberMesh.geometry.attributes.aVel;
        const dataAttr = this.emberMesh.geometry.attributes.aData;
        for (let i = 0; i < EMB_N; i++) {
            if (this._emDelay[i] > 0) {
                this._emDelay[i] -= dt;
            } else if (this._emLife[i] > 0) {
                this._emLife[i] -= dt;
                const k = Math.max(0, 1 - 2.1 * dt);
                this._emVel[i * 3] *= k;
                this._emVel[i * 3 + 1] = this._emVel[i * 3 + 1] * k - 13 * dt;
                this._emVel[i * 3 + 2] *= k;
                this._emPos[i * 3] += this._emVel[i * 3] * dt;
                this._emPos[i * 3 + 1] += this._emVel[i * 3 + 1] * dt;
                this._emPos[i * 3 + 2] += this._emVel[i * 3 + 2] * dt;
                // Dead the moment it meets the snow: an ember does not bounce,
                // it quenches.
                if (terrain && terrain.heightAt && this._emPos[i * 3 + 1] <
                    terrain.heightAt(this._emPos[i * 3], this._emPos[i * 3 + 2])
                        + 0.05) {
                    this._emLife[i] = 0;
                }
            }
            const l01 = this._emDelay[i] > 0 ? 0
                : Math.max(0, this._emLife[i] / this._emLife0[i]);
            if (l01 > 0) emberLive++;
            for (let c = 0; c < 4; c++) {
                const v = (i * 4 + c) * 3;
                posAttr.array[v] = this._emPos[i * 3];
                posAttr.array[v + 1] = this._emPos[i * 3 + 1];
                posAttr.array[v + 2] = this._emPos[i * 3 + 2];
                velAttr.array[v] = this._emVel[i * 3];
                velAttr.array[v + 1] = this._emVel[i * 3 + 1];
                velAttr.array[v + 2] = this._emVel[i * 3 + 2];
                dataAttr.array[v] = l01;
                dataAttr.array[v + 1] = this._emSize[i];
                dataAttr.array[v + 2] = this._emSeed[i];
            }
        }
        posAttr.needsUpdate = true;
        velAttr.needsUpdate = true;
        dataAttr.needsUpdate = true;
        this.emberMesh.visible = emberLive > 0 && S.showExplosions !== false;
        // This pass wrote the buffers; once it wrote them all-dead, the next
        // idle frame takes the early-out above and stops uploading.
        this._emberDirty = emberLive > 0;

        this.emberMaterial.uniforms.emberTime.value = this._time;
        this.material.uniforms.explosionGlow.value = S.explosionGlow ?? 1;
    }

    get triangles() {
        return (this.mesh.visible ? MAX * 2 : 0)
            + (this.emberMesh.visible ? EMB_N * 2 : 0);
    }

    async warmUp() {
        // Same trick as the bolts: fake one live burst so the pipeline has
        // something real to compile against, then take it back.
        this._expAnim[0] = 0.5;
        this._expAnim[2] = DUR * 0.5;
        this._expPos[3] = RADIUS;
        this.mesh.visible = true;
        this.emberMesh.visible = true;
        await whenReady(this.gfx, this.material, "explosion material");
        await whenReady(this.gfx, this.emberMaterial, "ember material");
        this._expAnim[0] = -1;
        this.mesh.visible = false;
        this.emberMesh.visible = false;
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.gfx.scene.remove(this.emberMesh);
        this.mesh.geometry.dispose();
        this.emberMesh.geometry.dispose();
        this.material.dispose();
        this.emberMaterial.dispose();
    }
}
