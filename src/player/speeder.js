/**
 * The airspeeder — the thing the player is, when they are not the figure.
 *
 * It is drawn by the walker's own pipelines and reads out of the walker's own
 * asset container, which is not a shortcut so much as the point of having baked
 * the walker that way: the baker flattens a static prop into a single-bone rig,
 * so a craft with no skeleton and no clip arrives as a machine with one bone
 * whose matrix never changes, and every shader, material and level-of-detail path
 * written for the walker takes it without knowing what it is.
 *
 * What is genuinely different is the motion. A walker is placed on the ground; a
 * speeder is placed *above* it, and everything that sells the hover is in how it
 * sits rather than in where it is:
 *
 *   height   The ground under the nose and the tail, not under the centre, so it
 *            noses up over a crest and drops into a trough instead of clipping
 *            through either.
 *   bank     Into the turn, from the controller's own lateral lean — the same
 *            signal the camera banks on, so the two agree by construction.
 *   pitch    Nose down under power, nose up off the throttle. Backwards from a
 *            plane, and correct for a repulsorlift: the thrust is underneath.
 *   bob      A slow idle wallow that fades out with speed, because a craft
 *            holding station drifts and one at nineteen metres a second does not.
 *
 * The guns are the walker's, pointed the other way: the same pooled bolts, the
 * same craters and glazing where they land.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { input } from "../core/input.js";
import { expDamp } from "../core/camera.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { mulMat4 } from "../core/mat4.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { Bolts } from "../walkers/bolts.js";
import { Jet } from "./jet.js";

/** Metres of clearance under the hull at rest. */
const HOVER = 2.6;
/** Extra lift with speed: it planes, so it rides higher the faster it goes. */
const HOVER_SPEED_LIFT = 1.5;
/** How hard it banks into a turn, radians at full lean. */
const BANK = 0.62;
/** Nose-down under power, radians at full throttle. */
const PITCH = 0.16;
/** Idle wallow: metres, and radians of roll, at a standstill. */
const BOB_HEIGHT = 0.22;
const BOB_ROLL = 0.05;

/**
 * Debug view names, in the order `walker.fragment.glsl` branches on them. Index
 * 0 is "off", so the list and the shader's `v == n` cases line up by position.
 */
const DEBUG_VIEWS = [
    "off", "albedo", "normal", "slot", "ao", "roughness", "sun cosine", "shadow",
];

/** Seconds between shots while the trigger is held. */
const FIRE_RATE = 0.14;
/** How far ahead the guns converge, metres. */
const CONVERGE = 90;

/**
 * Where the exhaust leaves the hull, craft-local metres.
 *
 * Measured off the engine material's own geometry rather than guessed as a
 * fraction of the whole craft's bounds. That block — the ribbed grille low and
 * central across the back — has its rear face at z -2.63 and is 1.48 m across;
 * the old fractions put the flame at z -2.28, which is inside it, so the plume
 * appeared to start from the middle of the hull rather than from the nozzle.
 *
 * The two nozzles sit at the centres of the block's left and right halves.
 */
const ENGINE_NOZZLE = { spanX: 0.42, dropY: -0.124, backZ: -2.63 };

/**
 * Where the cannon bolts are born, craft-local metres.
 *
 * The tips of the barrels the model actually has: 0.84 m out from the centre
 * line and a shade below it, at the very nose. Previously 0.82 of the half-span
 * and 0.55 of the half-length, which is out at the wingtips and half a hull too
 * far back — the bolts left from empty air either side of the canopy.
 */
const MUZZLE = { x: 0.84, y: -0.196, z: 2.58 };

// ------------------------------------------------------- module-scope scratch
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _nozzle = { spanX: 0, dropY: 0, backZ: 0 };

export class Speeder {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("../walkers/walkerAsset.js").WalkerAsset} asset
     * @param {import("../character/controller.js").CharacterController} controller
     * @param {import("../vfx/particles.js").SprayField} [spray]
     */
    constructor(gfx, terrain, sky, shadows, asset, controller, spray) {
        this.gfx = gfx;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.controller = controller;

        const h = asset.header;
        this.bounds = h.bounds;
        this.basisScale = h.basisScale;
        this.transScale = h.transScale;
        this.anim = asset.anim;
        this.boneCount = h.boneCount;

        this.position = new THREE.Vector3();
        this.yaw = 0;
        this.roll = 0;
        this.pitch = 0;
        this._bob = 0;
        /** Clock for the boost buffet — its own accumulator, its own rates. */
        this._buffet = 0;
        this._settled = false;
        /**
         * How hard the screen streaks, 0-1.
         *
         * The craft has its own, because the character's is `surf * speed` and
         * on the speeder `surf` is the space bar — the guns. Firing is not what
         * should smear the frame; reheat is. So this keys off shift and the
         * speed it actually buys, and eases rather than snapping, because the
         * effect arriving on the same frame as the key reads as a glitch.
         */
        this.streak01 = 0;

        /** The world transform: three basis columns and an origin. */
        this._world = new Float32Array(12);
        this._bone = new Float32Array(12);

        // ---- geometry, one level, shared nothing ---------------------------
        const lod = asset.lods[0];
        this.geometry = this._makeGeometry(lod);
        this.triangles = lod.triangleCount;

        // ---- the transform texture ----------------------------------------
        // Four rows and one column, because the prop is a one-bone rig. The
        // walker's vertex shader does not care that the herd it is skinning has a
        // population of one.
        this._texData = new Float32Array(this.boneCount * 4 * 4);
        this.tex = new THREE.DataTexture(
            this._texData, this.boneCount, 4, THREE.RGBAFormat, THREE.FloatType
        );
        this.tex.minFilter = THREE.NearestFilter;
        this.tex.magFilter = THREE.NearestFilter;
        this.tex.wrapS = THREE.ClampToEdgeWrapping;
        this.tex.wrapT = THREE.ClampToEdgeWrapping;
        this.tex.generateMipmaps = false;
        this.tex.flipY = false;
        this.tex.premultiplyAlpha = false;
        this.tex.colorSpace = THREE.NoColorSpace;
        this.tex.needsUpdate = true;

        const size = asset.albedoSize || h.textureSize;
        // Not the same edge as the albedo's: a model whose materials carry no
        // metallic-roughness maps gets a one-texel ORM rather than a full array
        // of white. See `loadWalkerAsset`.
        const ormSize = asset.ormSize || size;
        const layers = asset.layers || 4;
        const aniso = Math.min(16, gfx.renderer.capabilities.getMaxAnisotropy());
        // Mip generation off, and this is a live suspect rather than a choice.
        //
        // The maps on disk are a light grey hull — verified against the source
        // glTF byte for byte, and looked at — and the craft renders black. Every
        // term that multiplies albedo therefore does nothing, which matches the
        // symptom exactly: tint, ambient and a flat fill all changed nothing,
        // while roughness changed the look because it drives the specular lobe
        // through `f0 = 0.04` and never touches albedo. That is a texture that
        // reads as zero, not a lighting problem.
        //
        // If sampling a mip of this array is what returns zero, mips-off restores
        // it, at the cost of aliasing on the panel lines. The walkers would not
        // have revealed the same bug: at two hundred metres they are about
        // two-thirds aerial inscatter.
        this.albedoTex = new THREE.DataArrayTexture(asset.albedo, size, size, layers);
        this.albedoTex.generateMipmaps = false;
        this.albedoTex.minFilter = THREE.LinearFilter;
        this.ormTex = new THREE.DataArrayTexture(asset.orm, ormSize, ormSize, layers);
        this.ormTex.generateMipmaps = true;
        this.ormTex.minFilter = THREE.LinearMipmapLinearFilter;
        for (const t of [this.albedoTex, this.ormTex]) {
            t.format = THREE.RGBAFormat;
            t.type = THREE.UnsignedByteType;
            t.magFilter = THREE.LinearFilter;
            t.wrapS = THREE.RepeatWrapping;
            t.wrapT = THREE.RepeatWrapping;
            t.anisotropy = aniso;
            t.flipY = false;
            t.premultiplyAlpha = false;
            t.colorSpace = THREE.NoColorSpace;
            t.needsUpdate = true;
        }

        // (roughness, metallic, occlusion strength, albedo tint) per slot.
        this.factors = new Float32Array(32);
        this._materials = h.materials;
        this._updateFactors();

        // ---- mesh + materials ---------------------------------------------
        /**
         * The jittered view-projection of the frame being drawn, shared by the
         * surface and prepass materials. Babylon auto-bound it from the active
         * camera; here it is recomputed from the token camera — whose matrices
         * main syncs from the rig at the top of `renderFrame`, before any pass
         * draws — in `onBeforeRender`.
         */
        this._viewProj = new THREE.Matrix4();
        this._cameraPos = new THREE.Vector3();

        this.material = this._makeSurfaceMaterial();

        this.mesh = new THREE.Mesh(this.geometry, this.material);
        this.mesh.metadata = { triangles: lod.triangleCount, vertices: lod.vertexCount };
        // renderingGroupId 1 → the opaque layer.
        gfx.addMesh(this.mesh, gfx.LAYER.OPAQUE, 10);
        const tc = gfx.threeCamera;
        this.mesh.onBeforeRender = () => {
            mulMat4(
                this._viewProj.elements,
                tc.projectionMatrix.elements,
                tc.matrixWorldInverse.elements
            );
        };

        /** @type {THREE.RawShaderMaterial[]} */
        this._depthMats = [];
        // Two cascades, not three. It is a five-metre craft flying a few metres
        // off the snow — its shadow is under it, and cascade 2 covers 330 m.
        shadows.registerCaster(this.mesh, (c) => this._makeDepthMaterial(c), 2);

        // ---- the guns -------------------------------------------------------
        // Its own look: the walker's bolt is sized to read at two hundred metres
        // and scaled by the machine firing it, neither of which suits a cannon
        // five metres from the camera.
        let bolts = null;
        try {
            bolts = new Bolts(gfx, {
                terrain,
                spray: spray || null,
                look: () => ({
                    r: S.boltR, g: S.boltG, b: S.boltB,
                    width: S.boltWidth, reach: S.boltRange,
                    length: S.boltLength,
                    // Metres per second, not a multiplier: seen from five
                    // metres away a bolt has to be *watchable* — the walker's
                    // 2.8 km/s reads fine at three hundred metres and reads as
                    // hitscan here.
                    velocity: 170 * S.boltSpeed,
                }),
            });
        } catch (err) {
            // Stub tolerance: a missing peer costs the guns, not the boot.
            console.warn("[speeder] bolts unavailable:", err);
        }
        this.bolts = bolts;
        if (bolts) {
            // Babylon auto-bound the bolt material's viewProjection from the
            // active camera; here the owner rebinds it (bolts.js §port note).
            // Share the hull's matrix, and refresh it from the bolts mesh's own
            // hook too, so live bolts — which reach hundreds of metres and can
            // outlive the hull's visibility — never draw with a stale matrix.
            bolts.material.uniforms.viewProjection.value = this._viewProj;
            bolts.mesh.onBeforeRender = () => {
                mulMat4(
                    this._viewProj.elements,
                    tc.projectionMatrix.elements,
                    tc.matrixWorldInverse.elements
                );
            };
        }
        this.shotCount = 0;
        this._fireTimer = 0;
        this._barrel = 0;
        this._muzzle = new THREE.Vector3();

        // The exhaust. Owned here because it is placed off this craft's own
        // transform and has nothing to say to anything else.
        this.jet = new Jet(gfx);

        this._visible = true;
    }

    /**
     * Rebuild the per-slot material factors from the settings.
     *
     * Cheap enough to run every frame — five slots and twenty floats — and doing
     * so is what makes the albedo slider live rather than a reload.
     */
    _updateFactors() {
        const tint = S.speederTint;
        for (const m of this._materials) {
            const o = m.slot * 4;
            // The source's own 0.5 is overridden rather than scaled: there is no
            // roughness map behind it — the glTF has no metallic-roughness
            // texture at all — so this factor is the whole value, and a hull
            // that is meant to be matte paint should not inherit a number that
            // makes it lacquer. See `speederRough`.
            this.factors[o] = S.speederRough;
            this.factors[o + 1] = m.metallic;
            this.factors[o + 2] = 1;
            // The interior slots have no map and would come back white; they are
            // the inside of a hatch and belong in shadow, so they do not take the
            // tint that the painted panels do.
            this.factors[o + 3] = m.albedoImage < 0 ? 0.18 : tint;
        }
        // Slot 7's x, which no material occupies: the flat fill. See the note in
        // walker.fragment.glsl for why it rides here rather than in a uniform of
        // its own. The walker leaves this zero and is untouched.
        this.factors[28] = S.speederFill;
        // Slot 7's y: how much of the sun's warm cast to take off this craft.
        // 0 means unchanged, which is what the walker's zeroed array reads.
        this.factors[29] = S.speederDesat;
    }

    _makeGeometry(lod) {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", new THREE.BufferAttribute(lod.positions, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(lod.normals, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(lod.uvs, 2));
        geom.setAttribute("aux", new THREE.BufferAttribute(lod.aux, 2));
        geom.setAttribute("boneIdx", new THREE.BufferAttribute(lod.boneIdx, 4));
        geom.setAttribute("boneWt", new THREE.BufferAttribute(lod.boneWt, 4));
        geom.setIndex(new THREE.BufferAttribute(lod.indices, 1));
        return geom;
    }

    _makeSurfaceMaterial() {
        const gfx = this.gfx;
        const sky = this.sky;
        const sh = this.shadows;

        const uniforms = {
            viewProjection: { value: this._viewProj },
            cameraPos: { value: this._cameraPos },
            boneRow: { value: 0 },

            sunDir: { value: (sky && sky.sunDir) || new THREE.Vector3(0, 1, 0) },
            sunRadiance: { value: (sky && sky.sunRadiance) || new THREE.Color(1, 1, 1) },
            shR: { value: (sky && sky.sh) || new Float32Array(36) },

            cascadeMatrices: {
                value: (sh && sh.matrixValues) ||
                    [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()],
            },
            cascadeSplits: {
                value: (sh && sh.splitsVec4) || new THREE.Vector4(26, 95, 330, 330),
            },
            cascadeParams: { value: (sh && sh.paramData) || new Float32Array(12) },
            shadowTexel: { value: (sh && sh.texelSize) || 1 / 2048 },
            shadowSoftness: { value: 1.4 },
            shadowBias: { value: 0.11 },

            matFactors: { value: this.factors },

            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity * S.speederAmbient },
            snowCover: { value: 0 },

            debugView: { value: 0 },
            debugGain: { value: 1 / Math.max(0.001, S.exposure) },

            walkerTex: { value: this.tex },
            albedoTex: { value: this.albedoTex },
            ormTex: { value: this.ormTex },
            skyLUT: { value: (sky && sky.lut) || gfx.blackTex },
        };
        // spellLightPos / spellLightCol / spellLightCount — the spell system
        // rebinds `.value` on every consumer; the names just have to exist.
        uniforms[SPELL_LIGHT_UNIFORMS[0]] = { value: new Float32Array(16) };
        uniforms[SPELL_LIGHT_UNIFORMS[1]] = { value: new Float32Array(16) };
        uniforms[SPELL_LIGHT_UNIFORMS[2]] = { value: 0 };
        for (let i = 0; i < CASCADE_COUNT; i++) {
            uniforms["cascade" + i] = {
                value: (sh && sh.maps && sh.maps[i]) || gfx.whiteTex,
            };
        }

        return makeMaterial({
            name: "speeder",
            vertex: getShader("walkerVertexShader"),
            fragment: getShader("walkerPixelShader"),
            uniforms,
            side: THREE.DoubleSide,
        });
    }

    _makeDepthMaterial(cascade) {
        const mat = makeMaterial({
            name: "speederDepth" + cascade,
            vertex: getShader("walkerDepthVertexShader"),
            fragment: getShader("terrainDepthPixelShader"),
            uniforms: {
                lightViewProjection: { value: new THREE.Matrix4() },
                boneRow: { value: 0 },
                walkerTex: { value: this.tex },
            },
            // The define exists only to make the two cascade materials distinct
            // programs; nothing in the shader reads it.
            defines: { SPEEDER_CASCADE: cascade },
            side: THREE.DoubleSide,
        });
        this._depthMats.push(mat);
        return mat;
    }

    /** @param {import("../render/depthPass.js").DepthPass} depth */
    registerPrepass(depth) {
        const mat = makeMaterial({
            name: "speederPrepass",
            vertex: getShader("walkerPrepassVertexShader"),
            fragment: getShader("prepassPixelShader"),
            uniforms: {
                viewProjection: { value: this._viewProj },
                boneRow: { value: 0 },
                walkerTex: { value: this.tex },
            },
            side: THREE.DoubleSide,
        });
        this._prepassMat = mat;
        depth.registerCaster(this.mesh, mat);
    }

    setVisible(v) {
        this._visible = !!v;
        this.mesh.visible = this._visible;
        this.jet.setVisible(this._visible);
        if (!this._visible && this.bolts && this.bolts.mesh) {
            this.bolts.mesh.visible = false;
        }
    }

    /**
     * Fly it. The controller is still the thing that decides where the player is
     * — this only decides what that looks like from outside.
     *
     * @param {number} dt
     */
    update(dt) {
        if (!this._visible) return;
        // Same clamp the controller integrates under. Without it a hitch let
        // the presentation damps advance the full real dt while the physics
        // advanced at most 33 ms, and the hull visibly over-settled against the
        // motion it was tracking for one frame after every stutter.
        dt = Math.min(dt, 1 / 30);
        const c = this.controller;

        this.yaw = c.facing;
        _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

        const speed01 = Math.min(1, c.speed01);

        // ---- height -------------------------------------------------------
        // Sampled at the nose and the tail rather than under the centre, so a
        // crest lifts the front before it lifts the back.
        const half = this.bounds.max[2] * 0.9;
        const nose = this.terrain.heightAt(
            c.position.x + _fwd.x * half, c.position.z + _fwd.z * half
        );
        const tail = this.terrain.heightAt(
            c.position.x - _fwd.x * half, c.position.z - _fwd.z * half
        );
        const groundTrack = Math.max(nose, tail);
        // Cruising, the hull leaves the dune-by-dune probes behind and rides
        // the controller's flattened path; low, the probes are what make it
        // hug the field. `lift01` blends the two the same way the controller
        // blends its own snap, and the floor keeps a genuinely tall dune from
        // shaving the skids while the blend is mid-way.
        const lift01 = Math.min(1, Math.max(0, c.lift01 || 0));
        const ground = groundTrack + ((c.pathY ?? groundTrack) - groundTrack) * lift01;

        this._bob += dt * 1.6;
        const idle = 1 - speed01;
        // `c.climb` is the E-key altitude the controller holds above its path —
        // without it here the controller (and the camera chasing it) rises
        // while the hull stays glued to hover height, which reads exactly as
        // "E lifts the camera, not the aircraft".
        const lift = HOVER + HOVER_SPEED_LIFT * speed01 + (c.climb || 0);
        let wantY = ground + lift + Math.sin(this._bob) * BOB_HEIGHT * idle;
        wantY = Math.max(wantY, groundTrack + 1.2);

        // ---- attitude ------------------------------------------------------
        // Bank off the controller's own lean, which is the same signal the camera
        // banks on — so the horizon and the craft always agree about the turn.
        let wantRoll = -c.lean * BANK + Math.sin(this._bob * 0.7) * BOB_ROLL * idle;

        // Bank lead: a steer-rate term, so the hull rolls a few degrees *into*
        // the turn ahead of its settling bank and eases back as the lean catches
        // up — a pilot committing, not a hull being rotated. The rate comes off
        // the controller's slewed steer, which is what keeps it finite and
        // smooth; /8 normalises its onset peak to roughly 1.
        if (S.cinematicCam && S.speederBankLead > 0) {
            const sr = Math.max(-1, Math.min(1, c.steerRate / 8));
            wantRoll -= sr * BANK * S.speederBankLead;
        }

        // Boost buffet: a deterministic two-sine vibration, quadratic in speed
        // so it only really exists on the reheat. Sub-2 cm at the default — the
        // hull trembling against the air rather than gliding on glass. No RNG,
        // so it never fights the expDamps below.
        if (S.cinematicCam && S.speederTurbulence > 0) {
            this._buffet += dt;
            const t = this._buffet;
            const b = S.speederTurbulence * c.speedRaw * c.speedRaw
                * (Math.sin(t * 13.7) + 0.6 * Math.sin(t * 29.3 + 1.7));
            wantY += b;
            wantRoll += b * 0.1;
        }
        // Nose down under power. A repulsorlift pushes from underneath, so
        // accelerating tips the nose in, which is the opposite of an aeroplane
        // and the reason this reads as hovering rather than flying.
        const along = c.velocity.x * _fwd.x + c.velocity.z * _fwd.z;
        // Two terms, and the second one has to be kept on a lead. Following the
        // slope under the hull is what stops the craft looking pasted onto a dune
        // face, but the nose and tail samples are five metres apart on terrain
        // that can fall two metres in that distance, so unclamped it dominates
        // the throttle and the craft flies permanently nose-down.
        // Cruising flattens the slope-follow too — a craft that has left the
        // deck flies level over the dunes it no longer traces.
        const slope = Math.max(-0.35, Math.min(0.35, (nose - tail) / (2 * half)))
            * (1 - lift01);
        const wantPitch =
            -Math.min(1, Math.abs(along) / 19) * PITCH * Math.sign(along || 1)
            + slope * 0.3;

        if (!this._settled) {
            this.position.set(c.position.x, wantY, c.position.z);
            this.roll = wantRoll;
            this.pitch = wantPitch;
            this._settled = true;
        } else {
            this.position.x = c.position.x;
            this.position.z = c.position.z;
            // The height eases and the position does not: the craft is exactly
            // where the player is, and only *floats* vertically.
            this.position.y = expDamp(this.position.y, wantY, 5.5, dt);
            this.roll = expDamp(this.roll, wantRoll, 4.0, dt);
            this.pitch = expDamp(this.pitch, wantPitch, 3.2, dt);
        }

        this._compose();
        this._fire(dt);
        this._upload();

        // Two states, not a ramp, because that is what the craft has: a
        // repulsorlift holding station, and a repulsorlift being asked for
        // everything. Hovering, the engines are lit but *short* — a stub of flame
        // at the nozzle and no more, which is what "it is holding itself up"
        // looks like. On the boost they stretch into a jet.
        //
        // Cruising without shift sits between the two and much closer to the
        // hover: moving at speed is not the same as reheat, and if the plume is
        // already fully out at cruise the boost has nothing left to say.
        const drive = input.moving ? 1 : 0;
        const boosting = input.sprint ? 1 : 0;
        // Three readable states rather than a curve: holding station, under way,
        // and lit up. W is a *basic* jet — visibly running, plainly not trying —
        // and shift is the one that stretches it, because a plume already at
        // full extension on the throttle leaves the boost nothing to show.
        const hover = 0.14;
        const cruise = 0.30 * drive + 0.16 * speed01;
        const reheat = boosting * (0.85 + 0.45 * speed01);
        const want = Math.min(1.55, hover + cruise + reheat);
        this.streak01 = expDamp(
            this.streak01, boosting * Math.min(1, speed01) * S.speederStreak,
            boosting ? 5.0 : 2.5, dt
        );
        // Slower off the boost than onto it: reheat lights fast and dies slowly.
        this._throttle = expDamp(
            this._throttle || 0, want, boosting ? 7.0 : 2.2, dt
        );
    }

    /** Build the world transform from yaw, then bank and pitch inside it. */
    _compose() {
        const cy = Math.cos(this.yaw), sy = Math.sin(this.yaw);
        const cr = Math.cos(this.roll), sr = Math.sin(this.roll);
        const cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);

        // Yaw about world up, then pitch about the craft's right, then roll about
        // its own forward. Composed by hand rather than through three matrices,
        // because it is nine multiplies and one place to look.
        _fwd.set(sy * cp, -sp, cy * cp);
        _right.set(cy, 0, -sy);
        _up.crossVectors(_fwd, _right);
        _up.normalize();
        // Roll: spin right and up about forward.
        const rx = _right.x * cr + _up.x * sr;
        const ry = _right.y * cr + _up.y * sr;
        const rz = _right.z * cr + _up.z * sr;
        const ux = _up.x * cr - _right.x * sr;
        const uy = _up.y * cr - _right.y * sr;
        const uz = _up.z * cr - _right.z * sr;

        const w = this._world;
        w[0] = rx; w[1] = ry; w[2] = rz;
        w[3] = ux; w[4] = uy; w[5] = uz;
        w[6] = _fwd.x; w[7] = _fwd.y; w[8] = _fwd.z;
        w[9] = this.position.x; w[10] = this.position.y; w[11] = this.position.z;
    }

    /**
     * One tuning ring per wingtip gun, pushed onto `markers` — the same
     * craft-frame math `_fire` uses, so the rings are exactly where the bolts
     * are born and track the muzzle sliders live.
     * @param {import("../vfx/muzzleMarkers.js").MuzzleMarkers} markers
     */
    collectMuzzles(markers) {
        const w = this._world;
        for (let side = -1; side <= 1; side += 2) {
            const wing = S.muzzleSpan * side;
            const rise = S.muzzleDropY;
            const nose = S.muzzleFwdZ;
            markers.add(
                w[0] * wing + w[3] * rise + w[6] * nose + w[9],
                w[1] * wing + w[4] * rise + w[7] * nose + w[10],
                w[2] * wing + w[5] * rise + w[8] * nose + w[11],
                0.12, S.boltR, S.boltG, S.boltB
            );
        }
    }

    /**
     * The cannons. Held down, they fire on a timer and alternate wingtips; the
     * pair converge a long way out so the two streams read as aimed rather than
     * parallel.
     */
    _fire(dt) {
        this._fireTimer -= dt;
        // Floor it first: a long hitch — or a trigger released for a while —
        // must not bank shots and pay them out as a burst.
        if (this._fireTimer < -FIRE_RATE) this._fireTimer = 0;
        if (!input.fire || this._fireTimer > 0) return;
        // Carry the negative remainder into the next period instead of
        // discarding it, so the cadence holds at FIRE_RATE exactly instead of
        // wandering by up to a frame per shot.
        this._fireTimer += FIRE_RATE;

        // The barrel tip, in the craft's own frame, alternating sides.
        const side = (this._barrel++ % 2) === 0 ? 1 : -1;
        // Settings-driven so the muzzles can be walked onto the gun heads by
        // eye from the overlay; `MUZZLE` above holds the measured defaults.
        const wing = S.muzzleSpan * side;
        const nose = S.muzzleFwdZ;
        const rise = S.muzzleDropY;
        const w = this._world;
        this._muzzle.set(
            w[0] * wing + w[3] * rise + w[6] * nose + w[9],
            w[1] * wing + w[4] * rise + w[7] * nose + w[10],
            w[2] * wing + w[5] * rise + w[8] * nose + w[11]
        );
        // Converging: aim at a point on the centre line well ahead, so the two
        // barrels cross rather than running side by side for ever.
        _dir.set(
            w[6] * CONVERGE + w[9] - this._muzzle.x,
            w[7] * CONVERGE + w[10] - this._muzzle.y,
            w[8] * CONVERGE + w[11] - this._muzzle.z
        );
        _dir.normalize();

        if (this.bolts) this.bolts.spawn(this._muzzle, _dir);
        this.shotCount++;
    }

    _upload() {
        const a = this.anim;
        const bs = this.basisScale;
        const ts = this.transScale;
        const w = this._world;
        const m = this._bone;
        const d = this._texData;
        const bones = this.boneCount;

        for (let b = 0; b < bones; b++) {
            const p = b * 12;
            for (let k = 0; k < 9; k++) m[k] = a[p + k] * bs;
            for (let k = 9; k < 12; k++) m[k] = a[p + k] * ts;
            for (let c = 0; c < 4; c++) {
                const x = m[c * 3], y = m[c * 3 + 1], z = m[c * 3 + 2];
                const o = (c * bones + b) * 4;
                d[o] = w[0] * x + w[3] * y + w[6] * z + (c === 3 ? w[9] : 0);
                d[o + 1] = w[1] * x + w[4] * y + w[7] * z + (c === 3 ? w[10] : 0);
                d[o + 2] = w[2] * x + w[5] * y + w[8] * z + (c === 3 ? w[11] : 0);
                d[o + 3] = 1;
            }
        }
        this.tex.needsUpdate = true;
    }

    /** @param {THREE.Vector3} cameraPos */
    sync(cameraPos) {
        if (!this._visible) return;
        this._cameraPos.copy(cameraPos);

        const u = this.material.uniforms;
        const sh = this.shadows;

        // cameraPos / sunDir / sunRadiance / shR / cascadeMatrices / splits /
        // params are bound zero-copy: the rig, the sky and the shadow system
        // mutate the very objects the uniforms hold, and Three re-uploads them
        // each draw.

        // Republished every frame so the albedo slider takes effect as it moves.
        this._updateFactors();

        u.shadowTexel.value = (sh && sh.texelSize) || 1 / 2048;
        u.shadowSoftness.value = 1.4;
        // Far looser than the walker's, and this is the reason the hull went
        // black at random.
        //
        // The craft casts into the near cascades and then shadow-tests against
        // the map it just wrote. Its hull is a broad, nearly flat plate a few
        // metres above the snow, seen at a grazing angle by a thirteen-degree
        // sun, which is the exact geometry a depth bias has to work hardest on —
        // and whether it was enough depended on how the cascade happened to be
        // fitted that frame, which is why it came and went with the camera. A
        // five-metre craft cannot peter-pan its own shadow at this bias, and it
        // stops the whole machine reading as shadowed by itself.
        u.shadowBias.value = 0.11;

        u.fogDensity.value = S.fogDensity;
        u.fogHeightFalloff.value = S.fogHeightFalloff;
        u.fogStart.value = S.fogStart;
        u.aerialStrength.value = S.aerialStrength;
        // Ambient, hard, and for a physical reason rather than to cheat the
        // exposure — see `speederAmbient` in the settings for why the craft is
        // owed a great deal more of it than anything standing on the ground.
        // Live off the setting so it can be dialled against the actual frame
        // rather than argued about in the abstract.
        u.ambientIntensity.value = S.ambientIntensity * S.speederAmbient;
        // No rime on a craft that is moving and warm.
        u.snowCover.value = 0;
        // Debug modes bypass the shading entirely — see `debugView` in
        // walker.fragment.glsl. The gain undoes the exposure the post chain is
        // about to apply, so a raw value of 1.0 reads as white rather than grey.
        u.debugView.value = DEBUG_VIEWS.indexOf(S.speederDebug) + 0;
        u.debugGain.value = 1 / Math.max(0.001, S.exposure);

        if (this.bolts) this.bolts.update(this._lastDt || 0.016, cameraPos);
        // Nudgeable, because where a flame *looks* right is not quite where the
        // nozzle is: the plume has width and a flare, and the eye reads its
        // leading edge rather than its origin.
        _nozzle.spanX = ENGINE_NOZZLE.spanX * S.jetSpan;
        _nozzle.dropY = ENGINE_NOZZLE.dropY + S.jetDropY;
        _nozzle.backZ = ENGINE_NOZZLE.backZ + S.jetBackZ;
        this.jet.update(
            this._lastDt || 0.016, this._world, _nozzle,
            this._throttle || 0, cameraPos
        );
    }

    /** @param {number} dt kept for the bolts, which tick in `sync`. */
    tick(dt) {
        this._lastDt = dt;
    }

    async warmUp() {
        await whenReady(this.gfx, this.material, "speeder material");
        for (const m of this._depthMats) await whenReady(this.gfx, m, m.name);
        if (this._prepassMat) {
            await whenReady(this.gfx, this._prepassMat, "speederPrepass");
        }
        if (this.bolts) await this.bolts.warmUp();
        await this.jet.warmUp();
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.material.dispose();
        this.tex.dispose();
        this.albedoTex.dispose();
        this.ormTex.dispose();
        this.geometry.dispose();
        if (this.bolts) this.bolts.dispose();
        this.jet.dispose();
        for (const m of this._depthMats) m.dispose();
        this._prepassMat?.dispose();
    }
}
