/**
 * The ice formations Crystallise grows.
 *
 * A fixed pool of prisms in one data-driven mesh: one draw, one 3 x 96 upload,
 * and no geometry generated at any point. A crystal that is not alive has zero
 * height, which collapses every one of its triangles onto its base point.
 *
 * Lifetime is deliberately long. This spell alters the surface semi-permanently
 * through the ice channel of the terrain state buffer, which decays on a
 * fifteen-minute constant, so a patch of glazed snow is still there long after
 * the geometry has gone. The prisms themselves sublimate over
 * about forty seconds, which is long enough that the player can walk around a
 * formation and look at it, and short enough that a session does not silently
 * fill up with ice.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { CASCADE_COUNT } from "../render/shadows.js";

/** Pool size. Two full formations' worth. */
export const CRYSTAL_MAX = 96;

/** Vertices per crystal: two rings of six, plus an apex. Matches the include. */
export const VERTS = 13;
export const RING = 6;

/** How many cascades a 40 cm prism is worth drawing into. */
export const CRYSTAL_CASCADES = 2;

/**
 * Fallback fragment bodies (G1): the depth and prepass fragments are owned by
 * peer tasks and may not have landed yet during bring-up. The fallbacks are the
 * exact contract of those shaders — window depth in R for the cascades,
 * (viewZ, mask) for the prepass — so a missing peer costs nothing but a
 * console warning.
 */
const DEPTH_FRAG_FALLBACK = `precision highp float;
precision highp int;
layout(location = 0) out vec4 fragColor;
void main() {
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
`;

const PREPASS_FRAG_FALLBACK = `precision highp float;
precision highp int;
in float vViewZ;
in float vMask;
layout(location = 0) out vec4 fragColor;
void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
`;

function shaderOr(name, fallback) {
    try {
        return getShader(name);
    } catch (err) {
        console.warn("[spells] missing peer shader " + name + "; using contract fallback");
        return fallback;
    }
}

/** Resolve the sky LUT handle to a bindable texture, or a black stub (G1). */
function lutTexture(sky, gfx) {
    const lut = sky && sky.lut;
    if (!lut) return gfx.blackTex;
    if (lut.isTexture) return lut;
    if (lut.texture) return lut.texture;
    return gfx.blackTex;
}

/** Resolve one cascade map, or a black stub (G1). */
function cascadeTexture(shadows, i, gfx) {
    const map = shadows && shadows.maps && shadows.maps[i];
    return map || gfx.blackTex;
}

export class CrystalField {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./spellLights.js").SpellLights} lights
     * @param {import("../core/camera.js").CameraRig} rig
     */
    constructor(gfx, sky, shadows, lights, rig) {
        this.gfx = gfx;
        this.sky = sky;
        this.shadows = shadows;
        this.lights = lights;
        this.rig = rig;

        // Rows: (x,y,z,height) / (axis,radius) / (growth, seed, tint, -)
        this._texData = new Float32Array(CRYSTAL_MAX * 3 * 4);
        this.dataTex = new THREE.DataTexture(
            this._texData, CRYSTAL_MAX, 3,
            THREE.RGBAFormat, THREE.FloatType
        );
        this.dataTex.colorSpace = THREE.NoColorSpace;
        this.dataTex.flipY = false;
        this.dataTex.premultiplyAlpha = false;
        this.dataTex.generateMipmaps = false;
        this.dataTex.minFilter = THREE.NearestFilter;
        this.dataTex.magFilter = THREE.NearestFilter;
        this.dataTex.wrapS = THREE.ClampToEdgeWrapping;
        this.dataTex.wrapT = THREE.ClampToEdgeWrapping;
        this.dataTex.needsUpdate = true;

        // CPU-side lifetime. Kept out of the texture because none of it is read
        // by a shader and packing it there would mean re-uploading to age.
        this.age = new Float32Array(CRYSTAL_MAX);
        this.life = new Float32Array(CRYSTAL_MAX);
        /** Seconds the crystal spends growing from nothing to full size. */
        this.grow = new Float32Array(CRYSTAL_MAX);
        this.alive = new Uint8Array(CRYSTAL_MAX);
        this._next = 0;
        this.liveCount = 0;

        this._camPos = new THREE.Vector3();
        this._dirty = true;

        this.mesh = buildMesh();
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // Opaque, with the terrain (LAYER.OPAQUE, renderOrder 20 — after the
        // order-10 opaques, before anything blended). See the note at the top of
        // the fragment shader: the refracted lookup already carries what is
        // behind the ice, so blending buys nothing and costs correct depth.
        gfx.addMesh(this.mesh, gfx.LAYER.OPAQUE, 20);
        this.mesh.visible = false;

        /** @type {import("three").RawShaderMaterial[]} */
        this._depthMats = [];
        if (shadows && shadows.registerCaster) {
            shadows.registerCaster(
                this.mesh, (c) => this._makeDepthMaterial(c), CRYSTAL_CASCADES
            );
        }
    }

    _makeMaterial() {
        const gfx = this.gfx;
        const sky = this.sky;
        const sh = this.shadows;

        const uniforms = {
            viewProjection: {
                value: this.rig && this.rig.camera
                    ? this.rig.camera.viewProjection
                    : new THREE.Matrix4(),
            },
            cameraPos: { value: this._camPos },

            sunDir: { value: sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0) },
            sunRadiance: {
                value: sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(1, 1, 1),
            },
            shR: { value: sky && sky.sh ? sky.sh : new Float32Array(36) },

            cascadeMatrices: {
                value: sh && sh.matrixValues ? sh.matrixValues
                    : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
            },
            cascadeSplits: {
                value: sh && sh.splitsVec4 ? sh.splitsVec4
                    : new THREE.Vector4(26, 95, 330, 330),
            },
            cascadeParams: { value: sh && sh.paramData ? sh.paramData : new Float32Array(12) },
            shadowTexel: { value: sh && sh.texelSize ? sh.texelSize : 1 / 2048 },
            shadowSoftness: { value: 1.3 },
            shadowBias: { value: 0.012 },

            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity },
            sssStrength: { value: S.sssStrength },
            glintIntensity: { value: S.glintIntensity },
            glintGrazing: { value: S.glintGrazing },

            // SPELL_LIGHT_UNIFORMS — bound zero-copy to the pool's flat arrays.
            spellLightPos: { value: this.lights.pos },
            spellLightCol: { value: this.lights.col },
            spellLightCount: { value: 0 },

            crystalTex: { value: this.dataTex },
            skyLUT: { value: lutTexture(sky, gfx) },
            cascade0: { value: cascadeTexture(sh, 0, gfx) },
            cascade1: { value: cascadeTexture(sh, 1, gfx) },
            cascade2: { value: cascadeTexture(sh, 2, gfx) },
        };

        // A prism is a closed solid, but a dead crystal's triangles are
        // degenerate and a growing one is very thin — culling buys nothing here
        // and costs a black inside face wherever the winding flips.
        //
        // Blended *and* depth-writing. See the note at the top of
        // `crystal.fragment.glsl`: this is what gives transparency against the
        // snow without letting forty prisms blend over each other.
        return makeMaterial({
            name: "iceCrystal",
            vertex: getShader("crystalVertexShader"),
            fragment: getShader("crystalPixelShader"),
            uniforms,
            transparent: true,
            blending: THREE.NormalBlending,
            depthWrite: true,
            depthTest: true,
            side: THREE.DoubleSide,
        });
    }

    _makeDepthMaterial(cascade) {
        const mat = makeMaterial({
            name: "crystalDepth" + cascade,
            vertex: getShader("crystalDepthVertexShader"),
            fragment: shaderOr("terrainDepthPixelShader", DEPTH_FRAG_FALLBACK),
            uniforms: {
                lightViewProjection: { value: new THREE.Matrix4() },
                crystalTex: { value: this.dataTex },
            },
            side: THREE.DoubleSide,
            defines: { CRYSTAL_CASCADE: cascade },
        });
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * The camera-space depth prepass material.
     *
     * This is the one caster that writes a non-zero specular mask, and the only
     * reason the mask channel exists: ice is the sole mirror in a field of matte
     * snow, so the reflection pass can early-out on it and cost nothing on every
     * frame where nobody has cast Crystallise.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = makeMaterial({
            name: "crystalPrepass",
            vertex: getShader("crystalPrepassVertexShader"),
            fragment: shaderOr("prepassPixelShader", PREPASS_FRAG_FALLBACK),
            uniforms: {
                viewProjection: {
                    value: this.rig && this.rig.camera
                        ? this.rig.camera.viewProjection
                        : new THREE.Matrix4(),
                },
                crystalTex: { value: this.dataTex },
            },
            side: THREE.DoubleSide,
        });
        this.prepassMat = mat;
        if (depth && depth.registerCaster) depth.registerCaster(this.mesh, mat);
    }

    /**
     * Plant one crystal.
     *
     * @param {number} x @param {number} y @param {number} z base, world
     * @param {number} ax @param {number} ay @param {number} az growth axis
     * @param {number} height metres at full growth
     * @param {number} radius metres at full growth
     * @param {number} growSeconds time from nothing to full size
     * @param {number} life seconds before it starts sublimating
     */
    plant(x, y, z, ax, ay, az, height, radius, growSeconds, life) {
        let i = this._next;
        for (let n = 0; n < CRYSTAL_MAX; n++) {
            if (!this.alive[i]) break;
            i = (i + 1) % CRYSTAL_MAX;
            // Pool full: the oldest formation is the one to sacrifice, but
            // hunting for it costs more than it is worth at this count. Dropping
            // the new crystal loses one prism out of a cluster of forty, which
            // nobody can see.
            if (n === CRYSTAL_MAX - 1) return;
        }
        this._next = (i + 1) % CRYSTAL_MAX;

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        let o = i * 4;
        d[o] = x; d[o + 1] = y; d[o + 2] = z; d[o + 3] = height;
        o += w;
        d[o] = ax; d[o + 1] = ay; d[o + 2] = az; d[o + 3] = radius;
        o += w;
        d[o] = 0; d[o + 1] = (i * 0.618034 + x * 0.137 + z * 0.311) % 1;
        d[o + 2] = 0; d[o + 3] = 0;

        this.age[i] = 0;
        this.life[i] = life;
        this.grow[i] = Math.max(growSeconds, 0.05);
        this.alive[i] = 1;
        this._dirty = true;
    }

    /**
     * Age the field and upload.
     * @param {number} dt
     * @param {THREE.Vector3} cameraPos
     */
    update(dt, cameraPos) {
        this._camPos.copy(cameraPos);

        const d = this._texData;
        const w = CRYSTAL_MAX * 4;
        const growRow = w * 2;
        let live = 0;

        for (let i = 0; i < CRYSTAL_MAX; i++) {
            if (!this.alive[i]) continue;
            this.age[i] += dt;
            const a = this.age[i];
            const life = this.life[i];

            let g;
            if (a < this.grow[i]) {
                g = a / this.grow[i];
            } else if (a < life) {
                g = 1;
            } else {
                // Sublimation: the prism retreats rather than fading, so it goes
                // back into the drift it came out of. Nothing here pops.
                const t = (a - life) / 6.0;
                if (t >= 1) {
                    this.alive[i] = 0;
                    d[growRow + i * 4] = 0;
                    this._dirty = true;
                    continue;
                }
                g = 1 - t;
            }

            d[growRow + i * 4] = g;
            live++;
        }

        this.liveCount = live;
        this.mesh.visible = live > 0 && S.showSpells !== false;

        if (this.mesh.visible || this._dirty) {
            this.dataTex.needsUpdate = true;
            this._dirty = false;
        }
        if (this.mesh.visible) this._pushUniforms();
    }

    _pushUniforms() {
        const u = this.material.uniforms;
        const sky = this.sky;
        const sh = this.shadows;

        if (sky && sky.sunDir) u.sunDir.value = sky.sunDir;
        if (sky && sky.sunRadiance) u.sunRadiance.value = sky.sunRadiance;
        if (sky && sky.sh) u.shR.value = sky.sh;

        if (sh && sh.matrixValues) u.cascadeMatrices.value = sh.matrixValues;
        if (sh && sh.splitsVec4) u.cascadeSplits.value = sh.splitsVec4;
        if (sh && sh.paramData) u.cascadeParams.value = sh.paramData;
        if (sh && sh.texelSize) u.shadowTexel.value = sh.texelSize;
        u.shadowSoftness.value = 1.3;
        u.shadowBias.value = 0.012;
        for (let i = 0; i < CASCADE_COUNT; i++) {
            u["cascade" + i].value = cascadeTexture(sh, i, this.gfx);
        }
        u.skyLUT.value = lutTexture(sky, this.gfx);

        u.fogDensity.value = S.fogDensity;
        u.fogHeightFalloff.value = S.fogHeightFalloff;
        u.fogStart.value = S.fogStart;
        u.aerialStrength.value = S.aerialStrength;
        u.ambientIntensity.value = S.ambientIntensity;
        u.sssStrength.value = S.sssStrength;
        u.glintIntensity.value = S.glintIntensity;
        u.glintGrazing.value = S.glintGrazing;

        this.lights.apply(this.material);
    }

    get triangles() {
        return this.mesh.visible ? this.liveCount * (RING * 3) : 0;
    }

    /**
     * Compile both pipelines behind the loading screen.
     *
     * The crystal is planted and **left standing** through the warm-up frames.
     * See the same note on `WaterBody.warmUp`: compiling the program is not the
     * whole cost — the driver finalises the blend/depth/target state on the
     * first triangle actually drawn through it. Hiding the mesh here moved that
     * cost onto the first cast, where it measured 156 ms in the original.
     */
    async warmUp(x, y, z) {
        this.plant(x, y + 0.02, z, 0.1, 1, 0.05, 0.6, 0.09, 0.2, 999);
        this.update(0.21, this._camPos);
        this.mesh.visible = true;
        this._pushUniforms();

        await whenReady(this.gfx, this.material, "crystal material");
        for (let i = 0; i < this._depthMats.length; i++) {
            await whenReady(this.gfx, this._depthMats[i], this._depthMats[i].name);
        }
        if (this.prepassMat) {
            await whenReady(this.gfx, this.prepassMat, "crystal prepass");
        }
    }

    /**
     * Retire the warm-up crystal, after the warm-up frames have drawn it. It
     * must not be standing in the first frame the player sees.
     */
    finishWarmUp() {
        for (let i = 0; i < CRYSTAL_MAX; i++) this.alive[i] = 0;
        this._texData.fill(0);
        this.dataTex.needsUpdate = true;
        this.liveCount = 0;
        this._next = 0;
        this.mesh.visible = false;
    }

    dispose() {
        if (this.mesh.parent) this.mesh.parent.remove(this.mesh);
        this.mesh.geometry.dispose();
        this.material.dispose();
        for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
        if (this.prepassMat) this.prepassMat.dispose();
        this.dataTex.dispose();
    }
}

/** Static lattice: `position` is (crystal, vertex, 0). */
function buildMesh() {
    const pos = new Float32Array(CRYSTAL_MAX * VERTS * 3);
    const idx = new Uint32Array(CRYSTAL_MAX * RING * 3 * 3);

    let vi = 0;
    let ii = 0;
    for (let i = 0; i < CRYSTAL_MAX; i++) {
        for (let v = 0; v < VERTS; v++) {
            pos[vi++] = i;
            pos[vi++] = v;
            pos[vi++] = 0;
        }
        const b = i * VERTS;
        for (let k = 0; k < RING; k++) {
            const k2 = (k + 1) % RING;
            const b0 = b + k;
            const b1 = b + k2;
            const s0 = b + RING + k;
            const s1 = b + RING + k2;
            const apex = b + RING * 2;
            // Side quad.
            idx[ii++] = b0; idx[ii++] = s0; idx[ii++] = s1;
            idx[ii++] = b0; idx[ii++] = s1; idx[ii++] = b1;
            // Tip.
            idx[ii++] = s0; idx[ii++] = apex; idx[ii++] = s1;
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    geometry.setIndex(new THREE.BufferAttribute(idx, 1));

    const mesh = new THREE.Mesh(geometry);
    mesh.name = "iceCrystals";
    mesh.metadata = { triangles: idx.length / 3, vertices: CRYSTAL_MAX * VERTS };
    return mesh;
}
