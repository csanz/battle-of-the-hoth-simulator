/**
 * The walkers.
 *
 * A herd of imported machines, twenty-two metres tall, lumbering across the field
 * toward the player. Everything about how one is drawn is borrowed from the
 * character: a mesh placed entirely by its vertex program, skinned out of an
 * RGBA32F transform texture rewritten once per frame, drawn by five pipelines
 * (beauty, three shadow cascades, depth prepass) that all run the identical
 * skinning code from one include.
 *
 * What is *not* borrowed is where the pose comes from. The character solves a
 * skeleton every frame; this replays one baked cycle. `tools/bakeWalker.mjs` has
 * already flattened the glTF node graph, the inverse binds and the keyframe
 * interpolation into a flat table of world-space matrices, so the whole animation
 * system here is two array reads and a lerp.
 *
 * Three things are solved at runtime rather than baked, because all three depend
 * on the world:
 *
 *   heading   Each walks toward the player, turning at a rate a machine this
 *             size could plausibly turn at, and stops re-aiming once it is close
 *             so that it strides past rather than pivoting on the spot.
 *   ground    Four height samples under the corners of its footprint give both
 *             the height it stands at and the plane it stands on, so it leans
 *             into dune faces instead of intersecting them.
 *   speed     Not a made-up number. The clip walks on the spot, so the baker
 *             measured how fast a planted foot slides backwards through the
 *             body's frame and wrote that out; matching it here is the whole of
 *             why the feet do not skate.
 *
 * ------------------------------------------------------------------ the budget
 *
 * A walker is drawn five times a frame and there are several of them, so the
 * naive cost is the model's triangle count times five times the herd. Two things
 * hold that down — and a third, a decimated LOD chain, is built here and turned
 * off, because on this model the decimator eats the legs. See `LOD_SPEC` in
 * `tools/bakeWalker.mjs`.
 *
 *   sharing   One set of GPU buffers per level and one pair of texture arrays,
 *             built once and referenced by every walker. Adding a walker costs
 *             a mesh, five materials and four texture rows — no geometry.
 *   one upload  The whole herd's pose is one texture with four rows per machine,
 *             so a frame is a single upload of a few kilobytes however many
 *             of them are out there.
 *
 * Allocation per frame: none.
 */

import * as THREE from "three";

import { S } from "../core/settings.js";
import { Bolts } from "./bolts.js";
import { expDamp } from "../core/camera.js";
import { whenReady, makeMaterial } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { CASCADE_COUNT } from "../render/shadows.js";

/** How many cascades a walker casts into. All of them: it is the one thing in
 *  the scene big enough to still be a legible shadow at three hundred metres. */
const WALKER_CASCADES = 3;

/** Hard ceiling on the herd. Sizes the shared transform texture at build time. */
export const MAX_WALKERS = 8;

/**
 * Where the herd starts, relative to the player, in metres, and how far apart
 * across the line abreast. See the source for the measured reasoning: 200 m is
 * the second clear window over the dune crests on the opening bearings.
 */
const SPAWN_DISTANCE = 200;
const SPAWN_SPREAD = 46;

/**
 * The opening shot, laid out in angles rather than in metres: both numbers are
 * fractions of the horizontal half-field, resolved per frame, so the layout is
 * the same picture at any aspect — the herd between the view axis and the sun,
 * straddling the glare rather than sitting inside it, never near an edge.
 */
/** How far of the way to the sun the herd sits. See the note in `place`. */
const SUN_REACH = 0.62;
const SUN_BIAS = 0.5;
const SPREAD = 0.30;
/** Ceiling on the spread, radians, so a very wide window does not scatter them. */
const SPREAD_MAX = 0.30;

/** How many footfalls per cycle the gait detector will report. See `deriveFootfalls`. */
const MAX_FOOTFALLS = 4;

/**
 * The head.
 *
 * It tracks the player, but only once there is a player worth tracking: at four
 * hundred metres a machine sweeping its head around reads as a turret rather
 * than as something that has noticed you.
 */
const LOOK_RANGE = 260;
const LOOK_YAW_MAX = 0.62;    // radians the neck will swing, about 35 degrees
const LOOK_PITCH_MAX = 0.26;
/** How fast the head eases onto its target. Slow: it is a very large head. */
const LOOK_EASE = 0.8;

/**
 * The guns. Nothing is aimed *at* the player and nothing is hit — the bolts go
 * past. This is scenery, not a fight.
 */
/** The same range the head tracks at, deliberately: a machine that has turned
 *  its head to look at you is a machine that can shoot at you. */
const FIRE_RANGE = LOOK_RANGE;
/** Seconds between bursts, and the gap between the paired barrels inside one. */
const FIRE_INTERVAL = 3.4;
const FIRE_STAGGER = 0.11;
/** How far off the player a bolt is aimed, radians. */
const FIRE_SPRAY = 0.055;

/**
 * How far past the player one gets before it is put back on the horizon.
 * Well beyond the last shadow cascade, and past the distance the aerial
 * perspective has dissolved it into the sky.
 */
const RECYCLE = 520;

/** How far one is allowed to wander from the field's centre. */
const LEASH = 900;

/**
 * Closest two hulls may come, in metres at scale 1, before they are eased apart.
 */
const SEPARATION = 30;

/**
 * LOD thresholds, in projected pixels of hull height. Inert while the bake
 * ships a single level — the selector clamps to the coarsest level that
 * actually exists — and live the moment it ships more.
 */
const LOD_PIXELS = [420, 150];
const LOD_HYSTERESIS = 1.22;

// ------------------------------------------------------- module-scope scratch
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _up = new THREE.Vector3();
const _foot = new THREE.Vector2();
const _tmp = new THREE.Vector3();
/** Scratch for the overlay-offset muzzle point, head-local metres. */
const _muzzleLocal = new Float32Array(3);
const _identity = new THREE.Matrix4();

/** Shared prepass fragment (owned by the depth-pass subsystem); a byte-exact
 *  fallback keeps bring-up alive if that file has not landed yet. */
const PREPASS_FRAGMENT_FALLBACK = `precision highp float;
precision highp int;

in float vViewZ;
in float vMask;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
`;

/** Shared cascade-caster fragment (owned by the terrain subsystem); same
 *  fallback reasoning — it writes window depth into the R32F color target. */
const DEPTH_FRAGMENT_FALLBACK = `precision highp float;
precision highp int;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
`;

function shaderOr(name, fallback) {
    try {
        return getShader(name);
    } catch (err) {
        console.warn("[walkers] missing shared shader " + name + "; using fallback");
        return fallback;
    }
}

/**
 * When, in the cycle, a foot lands.
 *
 * Derived from the baked clip rather than stored in it. A foot is the thing
 * that travels furthest vertically and gets closest to the ground, and it is
 * planted at the bottom of that travel — so the lowest frame of each of the
 * four largest movers is the footfall, and its frame index over the frame
 * count is the phase.
 *
 * @param {Int16Array} anim @param {any} header
 * @returns {number[]} phases, ascending
 */
function deriveFootfalls(anim, header) {
    const bones = header.boneCount;
    const frames = header.frameCount;
    const ts = header.transScale;

    let lowest = Infinity;
    const stat = [];
    for (let b = 0; b < bones; b++) {
        let lo = Infinity, hi = -Infinity, at = 0;
        for (let f = 0; f < frames; f++) {
            // Translation is the fourth column: components 9, 10, 11.
            const y = anim[(f * bones + b) * 12 + 10] * ts;
            if (y < lo) { lo = y; at = f; }
            if (y > hi) hi = y;
        }
        stat.push({ lo, range: hi - lo, at });
        if (lo < lowest) lowest = lo;
    }

    // Something that lifts, ordered by how close to the ground it gets. Sorted
    // by depth rather than by travel: the deepest four are four soles.
    const feet = stat
        .filter((s) => s.range > 0.6)
        .sort((a, b) => a.lo - b.lo);

    const phases = [];
    for (const f of feet) {
        const p = f.at / frames;
        // Wrap-aware: 0.98 and 0.01 are the same moment in a looping cycle.
        const near = (q) => {
            const d = Math.abs(q - p);
            return Math.min(d, 1 - d) < 0.07;
        };
        if (!phases.some(near)) phases.push(p);
        if (phases.length >= MAX_FOOTFALLS) break;
    }
    return phases.sort((a, b) => a - b);
}

/**
 * Where the head is.
 *
 * Nothing in the baked file says "this bone is the neck", and nothing needs to:
 * the geometry knows. Every vertex names the bone that drives it, so a bone's
 * *location* is the centroid of its own vertices — pushed through that bone's
 * frame-zero matrix, which lands it in the walker's standing frame in metres.
 * The head is then simply the bones that live at the front and the top of the
 * machine.
 *
 * @param {import("./walkerAsset.js").WalkerAsset} asset @param {any} header
 */
function deriveHead(asset, header) {
    const bones = header.boneCount;
    const lod = asset.lods[0];
    const pos = lod.positions;
    const idx = lod.boneIdx;
    const wt = lod.boneWt;
    const n = lod.vertexCount;

    // Centroid of the vertices each bone dominates, in bind space.
    const sum = new Float64Array(bones * 3);
    const count = new Float64Array(bones);
    for (let v = 0; v < n; v++) {
        // The dominant influence, which for a mech is very nearly the only one.
        let best = 0, bw = -1;
        for (let k = 0; k < 4; k++) {
            const w = wt[v * 4 + k];
            if (w > bw) { bw = w; best = idx[v * 4 + k]; }
        }
        sum[best * 3] += pos[v * 3];
        sum[best * 3 + 1] += pos[v * 3 + 1];
        sum[best * 3 + 2] += pos[v * 3 + 2];
        count[best]++;
    }

    // Through each bone's standing matrix, into the walker's own frame.
    const anim = asset.anim;
    const bs = header.basisScale, ts = header.transScale;
    const at = new Float64Array(bones * 3);
    const live = new Uint8Array(bones);
    for (let b = 0; b < bones; b++) {
        if (count[b] < 8) continue; // a bone with almost no geometry decides nothing
        const cx = sum[b * 3] / count[b];
        const cy = sum[b * 3 + 1] / count[b];
        const cz = sum[b * 3 + 2] / count[b];
        const o = b * 12;
        at[b * 3] = (anim[o] * cx + anim[o + 3] * cy + anim[o + 6] * cz) * bs + anim[o + 9] * ts;
        at[b * 3 + 1] = (anim[o + 1] * cx + anim[o + 4] * cy + anim[o + 7] * cz) * bs
            + anim[o + 10] * ts;
        at[b * 3 + 2] = (anim[o + 2] * cx + anim[o + 5] * cy + anim[o + 8] * cz) * bs
            + anim[o + 11] * ts;
        live[b] = 1;
    }

    const max = header.bounds.max;
    const flags = new Uint8Array(bones);
    let pivotZ = Infinity, pivotY = 0;
    let noseZ = -Infinity, headTop = 0, headBottom = Infinity;
    let found = 0;
    for (let b = 0; b < bones; b++) {
        if (!live[b]) continue;
        const y = at[b * 3 + 1], z = at[b * 3 + 2];
        // Forward of the hull and high on it. Loose enough to take the neck
        // segments as well as the head: rotating a head off a neck that stays
        // put opens a seam at the collar.
        if (z < max[2] * 0.40 || y < max[1] * 0.55) continue;
        flags[b] = 1;
        found++;
        if (z < pivotZ) { pivotZ = z; pivotY = y; }
        if (z > noseZ) noseZ = z;
        if (y > headTop) headTop = y;
        if (y < headBottom) headBottom = y;
    }

    if (!found) {
        return { bones: null, pivot: [0, 0, 0], height: 0, muzzles: null, aim: null };
    }

    // The chin guns: either side of the nose, low on the face. Slightly proud of
    // it, so a bolt starts in front of the plating rather than inside it.
    const chinY = headBottom + (headTop - headBottom) * 0.18;
    const noseOut = noseZ + 1.2;
    return {
        bones: flags,
        // On the centre line, whatever the rearmost neck bone's own geometry
        // averages out to. A head that swings about an axis 2.7 m off centre
        // does not turn, it swerves.
        pivot: [0, pivotY, pivotZ],
        height: headTop,
        muzzles: [
            new Float32Array([-1.05, chinY, noseOut]),
            new Float32Array([1.05, chinY, noseOut]),
        ],
        // A point straight out of the face, used to derive the firing direction
        // through whatever rotation the head currently has.
        aim: new Float32Array([0, chinY, noseOut + 40]),
    };
}

/**
 * One machine. Owns its state, its mesh and its five materials; everything
 * expensive belongs to the herd and is handed in.
 */
class Walker {
    /**
     * @param {WalkerHerd} herd
     * @param {number} index which block of four texture rows is this one's
     */
    constructor(herd, index) {
        this.herd = herd;
        this.index = index;
        this.gfx = herd.gfx;
        this.terrain = herd.terrain;

        this.position = new THREE.Vector3();
        this.yaw = 0;
        this.phase = 0;
        /** Smoothed stance plane: the up vector the body actually uses. */
        this._up = new THREE.Vector3(0, 1, 0);
        this._groundY = 0;
        this._settled = false;

        /** The world transform, as three basis columns and an origin. */
        this._world = new Float32Array(12);

        /**
         * Footfalls since this machine was built. The soundscape polls it and
         * plays a step on every change — the same "read the game state, own no
         * mixer" contract the spell system's cast counter has.
         */
        this.stepCount = 0;

        /** Neck deflection, eased, radians. */
        this.headYaw = 0;
        this.headPitch = 0;
        /** Extra head rotation as a 3x4, rebuilt each frame. Identity when idle. */
        this._head = new Float32Array(12);
        this._headActive = false;

        /** Shots fired, polled by the soundscape exactly as `stepCount` is. */
        this.shotCount = 0;
        this._fireTimer = FIRE_INTERVAL * (0.4 + 0.6 * ((index * 0.41) % 1));
        this._barrel = 0;
        /** World position of the muzzle that last fired, for the sound and the bolt. */
        this.muzzle = new THREE.Vector3();
        this.muzzleDir = new THREE.Vector3(0, 0, 1);

        /**
         * Tempo trim, eased. Separation works through this rather than through
         * position — see the note in `WalkerHerd.update`.
         */
        this.rateBias = 1;
        this._rateWant = 1;

        this.lod = herd.lods.length - 1;
        this.material = this._makeSurfaceMaterial();
        this.mesh = this._buildMesh();
        this.mesh.material = this.material;

        /** @type {THREE.RawShaderMaterial[]} */
        this._depthMats = [];
        if (herd.shadows && herd.shadows.registerCaster) {
            herd.shadows.registerCaster(
                this.mesh, (c) => this._makeDepthMaterial(c), WALKER_CASCADES
            );
        }
    }

    _buildMesh() {
        const mesh = new THREE.Mesh(this.herd.lods[this.lod].geometry, this.material);
        mesh.name = "walker" + this.index;

        // Placed entirely by the vertex shader from the transform texture, so its
        // world matrix is the identity for ever and its bounding box is a lie.
        //
        // Never frustum-culled, deliberately (`addMesh` pins that): culling it
        // against the view frustum would save a few hundred thousand vertices
        // while it is behind the camera — and would also drop it out of the
        // shadow cascades, where a twenty-two metre machine standing just off
        // the left edge of the screen casts right across it under a thirteen-
        // degree sun.
        mesh.metadata = { triangles: 0, vertices: 0 };
        this.gfx.addMesh(mesh, this.gfx.LAYER.OPAQUE, 10);
        return mesh;
    }

    /**
     * Swap in a different level of detail.
     *
     * One mesh whose geometry is replaced, rather than three meshes being hidden
     * and shown. That is the whole reason the shadow cascades and the depth
     * prepass follow the switch without knowing it happened: they hold a
     * reference to this mesh and to the material registered against it, and
     * neither changes.
     *
     * @param {number} level
     */
    setLOD(level) {
        if (level === this.lod) return;
        this.lod = level;
        const lod = this.herd.lods[level];
        this.mesh.geometry = lod.geometry;
        this.mesh.metadata.triangles = lod.triangleCount;
        this.mesh.metadata.vertices = lod.vertexCount;
    }

    _makeSurfaceMaterial() {
        const herd = this.herd;
        const gfx = this.gfx;
        const sky = herd.sky;
        const sh = herd.shadows;

        const uniforms = {
            viewProjection: {
                value: herd.rig && herd.rig.camera
                    ? herd.rig.camera.viewProjection : _identity,
            },
            cameraPos: { value: new THREE.Vector3() },
            boneRow: { value: this.index * 4 },

            sunDir: { value: sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0) },
            sunRadiance: {
                value: sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(1, 1, 1),
            },
            shR: { value: sky && sky.sh ? sky.sh : new Float32Array(36) },

            cascadeMatrices: {
                value: sh && sh.matrixValues
                    ? sh.matrixValues : [_identity, _identity, _identity],
            },
            cascadeSplits: {
                value: sh && sh.splitsVec4 ? sh.splitsVec4 : new THREE.Vector4(26, 95, 330, 330),
            },
            cascadeParams: { value: sh && sh.paramData ? sh.paramData : new Float32Array(12) },
            shadowTexel: { value: sh && sh.texelSize ? sh.texelSize : 1 / 2048 },
            shadowSoftness: { value: 1.4 },
            // Looser than the character's. The hull is a two-metre-thick slab of
            // depth seen almost edge-on in cascade 2, where one texel is a third
            // of a metre, and a tight bias acnes the whole flank.
            shadowBias: { value: 0.06 },

            matFactors: { value: herd.factors },

            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity },
            snowCover: { value: S.walkerSnow },
            // The debug views are the speeder's; the walker always shades normally.
            debugView: { value: 0 },
            debugGain: { value: 1 },

            spellLightPos: { value: new Float32Array(16) },
            spellLightCol: { value: new Float32Array(16) },
            spellLightCount: { value: 0 },

            walkerTex: { value: herd.walkerTex },
            albedoTex: { value: herd.albedoTex },
            ormTex: { value: herd.ormTex },
            skyLUT: { value: sky && sky.lut ? sky.lut : gfx.blackTex },
        };
        for (let i = 0; i < CASCADE_COUNT; i++) {
            uniforms["cascade" + i] = {
                value: sh && sh.maps && sh.maps[i] ? sh.maps[i] : gfx.whiteTex,
            };
        }

        // The hatches and the toe plates are single-sided sheets and the fragment
        // shader turns its normal toward the viewer anyway, so there is nothing to
        // gain from culling and a hole in the hull to lose.
        return makeMaterial({
            name: "walker" + this.index,
            vertex: getShader("walkerVertexShader"),
            fragment: getShader("walkerPixelShader"),
            uniforms,
            side: THREE.DoubleSide,
            transparent: false,
        });
    }

    _makeDepthMaterial(cascade) {
        // A distinct material per cascade, so each holds its own matrix without
        // any mid-frame uniform juggling (the Babylon build did the same with a
        // cache-key define).
        const mat = makeMaterial({
            name: `walkerDepth${this.index}_${cascade}`,
            vertex: getShader("walkerDepthVertexShader"),
            fragment: shaderOr("terrainDepthPixelShader", DEPTH_FRAGMENT_FALLBACK),
            uniforms: {
                lightViewProjection: { value: new THREE.Matrix4() },
                boneRow: { value: this.index * 4 },
                walkerTex: { value: this.herd.walkerTex },
            },
            side: THREE.DoubleSide,
        });
        this._depthMats.push(mat);
        return mat;
    }

    /** @param {import("../render/depthPass.js").DepthPass} depth */
    registerPrepass(depth) {
        const mat = makeMaterial({
            name: "walkerPrepass" + this.index,
            vertex: getShader("walkerPrepassVertexShader"),
            fragment: shaderOr("prepassPixelShader", PREPASS_FRAGMENT_FALLBACK),
            uniforms: {
                viewProjection: {
                    value: this.herd.rig && this.herd.rig.camera
                        ? this.herd.rig.camera.viewProjection : _identity,
                },
                boneRow: { value: this.index * 4 },
                walkerTex: { value: this.herd.walkerTex },
            },
            side: THREE.DoubleSide,
        });
        this._prepassMat = mat;
        depth.registerCaster(this.mesh, mat);
    }

    /**
     * Advance along a fixed heading. Grounding is deliberately not done here —
     * the herd separates everyone first, and a walker that is about to be nudged
     * sideways must not have already decided what height it is standing at.
     *
     * There is no steering. The heading was set when it was placed and is not
     * touched again until it is placed anew; see `RECYCLE`.
     *
     * @param {number} dt @param {THREE.Vector3} target the player
     */
    step(dt, target) {
        const scale = S.walkerScale;
        const rate = S.walkerSpeed;

        // Ground speed and cycle rate come off the same number, which is the
        // entire mechanism that keeps the feet planted.
        // The tempo trim multiplies the ground speed and the cycle rate together,
        // which is the only way it can be applied without the feet skating.
        this.rateBias = expDamp(this.rateBias, this._rateWant, 1.4, dt);
        const r = rate * this.rateBias;

        const speed = this.herd.baseSpeed * scale * r;
        this.position.x += Math.sin(this.yaw) * speed * dt;
        this.position.z += Math.cos(this.yaw) * speed * dt;

        const prev = this.phase;
        this.phase = (this.phase + (r * dt) / this.herd.duration) % 1;
        // Count the footfalls the cycle just walked through. The wrap case is the
        // only subtlety: a frame that crosses the loop point covers `prev..1` and
        // `0..phase`, and a foot landing in either half still landed.
        const falls = this.herd.footfalls;
        for (let k = 0; k < falls.length; k++) {
            const p = falls[k];
            const crossed = prev <= this.phase
                ? (p > prev && p <= this.phase)
                : (p > prev || p <= this.phase);
            if (crossed) this.stepCount++;
        }

        // Off the back of the world, or walked past and away: put it out on the
        // horizon again, aimed once, and let it come.
        const away = Math.hypot(target.x - this.position.x, target.z - this.position.z);
        const leash = Math.hypot(this.position.x, this.position.z);
        if (away > RECYCLE || leash > LEASH) this.herd.place(this, target);
    }

    /**
     * Find the ground, build the world transform, aim the head, maybe shoot, and
     * write four texture rows.
     * @param {number} dt @param {Float32Array} texData the herd's staging array
     * @param {THREE.Vector3} [target] the player
     */
    settle(dt, texData, target) {
        const scale = S.walkerScale;
        _fwd.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));

        // ------------------------------------------------------------ ground
        // Four probes under the corners of the footprint. Their mean is the
        // height it stands at; their differences are the plane it stands on.
        const b = this.herd.bounds;
        const halfZ = b.max[2] * 0.82 * scale;
        const halfX = b.max[0] * 0.82 * scale;
        const hFF = this._probe(halfX, halfZ);
        const hFB = this._probe(-halfX, halfZ);
        const hBF = this._probe(halfX, -halfZ);
        const hBB = this._probe(-halfX, -halfZ);

        const mean = (hFF + hFB + hBF + hBB) * 0.25;
        // Slopes along the body's own axes, in metres per metre.
        const dFwd = ((hFF + hFB) - (hBF + hBB)) / (4 * halfZ);
        const dRight = ((hFF + hBF) - (hFB + hBB)) / (4 * halfX);

        // The legs absorb most of the terrain — a machine that pitched with every
        // dune would look like a boat — so the plane is only partly followed, and
        // eased on top of that.
        const TILT = 0.55;
        _up.set(
            -dRight * TILT * _right.x - dFwd * TILT * _fwd.x,
            1,
            -dRight * TILT * _right.z - dFwd * TILT * _fwd.z
        );
        _up.normalize();

        if (!this._settled) {
            this._groundY = mean;
            this._up.copy(_up);
            this._settled = true;
        } else {
            this._groundY = expDamp(this._groundY, mean, 2.2, dt);
            this._up.x = expDamp(this._up.x, _up.x, 1.6, dt);
            this._up.y = expDamp(this._up.y, _up.y, 1.6, dt);
            this._up.z = expDamp(this._up.z, _up.z, 1.6, dt);
            this._up.normalize();
        }
        // Sunk a little: at this mass the feet are through the crust, and a
        // machine floating exactly on the surface reads as a decal.
        this.position.y = this._groundY - 0.35 * scale;

        this._composeWorld(scale);
        this._aimHead(dt, target);
        this._fire(dt);
        this._writeRows(texData);
    }

    /**
     * Swing the neck toward the player.
     *
     * The rotation is applied to the head chain's bone matrices — see
     * `_writeRows` — about the base of the neck, in the walker's own frame, so it
     * composes with the baked pose rather than replacing any of it. The clip
     * keeps rocking the head with the gait underneath; this only adds a look.
     *
     * @param {number} dt @param {THREE.Vector3} target
     */
    _aimHead(dt, target) {
        const herd = this.herd;
        let wantYaw = 0;
        let wantPitch = 0;

        if (herd.headBones && target) {
            const dx = target.x - this.position.x;
            const dz = target.z - this.position.z;
            const dist = Math.hypot(dx, dz);
            if (dist < LOOK_RANGE) {
                // Bearing to the player relative to the body's own heading: the
                // neck turns within the machine, so everything here is local.
                let rel = Math.atan2(dx, dz) - this.yaw;
                rel = Math.atan2(Math.sin(rel), Math.cos(rel));
                // Fade the whole gesture in with proximity, so it does not snap on
                // at the range gate.
                const near = 1 - dist / LOOK_RANGE;
                wantYaw = Math.max(-LOOK_YAW_MAX, Math.min(LOOK_YAW_MAX, rel)) * near;
                // Look down at something on the ground. The head is twenty metres
                // up, so the closer it gets the further down it has to look.
                const drop = herd.headHeight * S.walkerScale;
                wantPitch = Math.min(LOOK_PITCH_MAX, Math.atan2(drop, Math.max(dist, 1))) * near;
            }
        }

        this.headYaw = expDamp(this.headYaw, wantYaw, LOOK_EASE, dt);
        this.headPitch = expDamp(this.headPitch, wantPitch, LOOK_EASE, dt);

        this._headActive = Math.abs(this.headYaw) > 1e-4 || Math.abs(this.headPitch) > 1e-4;
        if (!this._headActive) return;

        // R = translate(pivot) . yaw . pitch . translate(-pivot), flattened to the
        // same three-basis-columns-and-an-origin layout everything else here uses.
        const cy = Math.cos(this.headYaw), sy = Math.sin(this.headYaw);
        const cp = Math.cos(this.headPitch), sp = Math.sin(this.headPitch);
        const m = this._head;
        // Ry * Rx
        m[0] = cy;        m[1] = 0;    m[2] = -sy;
        m[3] = sy * sp;   m[4] = cp;   m[5] = cy * sp;
        m[6] = sy * cp;   m[7] = -sp;  m[8] = cy * cp;
        const p = herd.headPivot;
        m[9] = p[0] - (m[0] * p[0] + m[3] * p[1] + m[6] * p[2]);
        m[10] = p[1] - (m[1] * p[0] + m[4] * p[1] + m[7] * p[2]);
        m[11] = p[2] - (m[2] * p[0] + m[5] * p[1] + m[8] * p[2]);
    }

    /**
     * Fire the chin guns.
     *
     * A burst is two bolts a tenth of a second apart, because the head carries
     * two barrels and firing them together is one flash rather than a pair. The
     * aim is deliberately loose and deliberately not at the player: this is
     * scenery.
     *
     * @param {number} dt
     */
    _fire(dt) {
        const herd = this.herd;
        if (!herd.muzzles || S.walkerFire === false) return;

        this._fireTimer -= dt;
        if (this._fireTimer > 0) return;

        const target = herd._lastTarget;
        const dist = target
            ? Math.hypot(target.x - this.position.x, target.z - this.position.z)
            : Infinity;
        if (dist > FIRE_RANGE * S.walkerScale) {
            // Out of range: check again shortly rather than banking a burst that
            // would fire the instant it closed.
            this._fireTimer = 0.6;
            return;
        }

        // Muzzle in world space: the local chin position, through the head's own
        // rotation, then through the body. The overlay's offsets ride on top of
        // the measured chin points — span mirrors with the barrel's side — so
        // zeroed sliders are exactly the model's own gun heads.
        const local = herd.muzzles[this._barrel % herd.muzzles.length];
        this._barrel++;
        _muzzleLocal[0] = local[0] + Math.sign(local[0]) * S.walkerMuzzleSpan;
        _muzzleLocal[1] = local[1] + S.walkerMuzzleY;
        _muzzleLocal[2] = local[2] + S.walkerMuzzleZ;
        this._muzzleWorld(_muzzleLocal, this.muzzle);
        this._muzzleWorld(herd.muzzleAim, _tmp);
        this.muzzleDir.set(
            _tmp.x - this.muzzle.x, _tmp.y - this.muzzle.y, _tmp.z - this.muzzle.z
        );
        this.muzzleDir.normalize();
        // A little spray, so a burst is not two bolts down one line.
        const a = (Math.random() - 0.5) * FIRE_SPRAY;
        const b = (Math.random() - 0.5) * FIRE_SPRAY;
        this.muzzleDir.set(
            this.muzzleDir.x + a, this.muzzleDir.y + b * 0.5, this.muzzleDir.z - a
        );
        this.muzzleDir.normalize();

        this.shotCount++;
        herd.onShot?.(this);

        // Alternate barrels: a short gap inside a burst, a long one between.
        this._fireTimer = this._barrel % 2 === 0
            ? FIRE_INTERVAL * (0.75 + Math.random() * 0.5)
            : FIRE_STAGGER;
    }

    /** A point in the walker's own frame, through the head rotation and the body. */
    _muzzleWorld(local, out) {
        let x = local[0], y = local[1], z = local[2];
        if (this._headActive) {
            const h = this._head;
            const rx = h[0] * x + h[3] * y + h[6] * z + h[9];
            const ry = h[1] * x + h[4] * y + h[7] * z + h[10];
            const rz = h[2] * x + h[5] * y + h[8] * z + h[11];
            x = rx; y = ry; z = rz;
        }
        const w = this._world;
        out.set(
            w[0] * x + w[3] * y + w[6] * z + w[9],
            w[1] * x + w[4] * y + w[7] * z + w[10],
            w[2] * x + w[5] * y + w[8] * z + w[11]
        );
        return out;
    }

    /** Terrain height at an offset in the walker's own frame. */
    _probe(right, fwd) {
        _foot.set(
            this.position.x + _right.x * right + _fwd.x * fwd,
            this.position.z + _right.z * right + _fwd.z * fwd
        );
        return this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(_foot.x, _foot.y) : 0;
    }

    /**
     * Build the world transform: an orthonormal frame from the smoothed stance
     * plane and the heading, scaled, sitting at the position.
     *
     * Deriving the frame from the terrain normal rather than from pitch and roll
     * angles means the tilt is exact on any slope and there is no order-of-
     * rotation convention to get wrong.
     */
    _composeWorld(scale) {
        const u = this._up;
        // Re-orthogonalise the heading against the stance plane. `_fwd` came out
        // of the yaw and is level; projecting the stance normal out of it is what
        // tips the machine into the slope it is standing on.
        const d = _fwd.x * u.x + _fwd.y * u.y + _fwd.z * u.z;
        _fwd.x -= u.x * d;
        _fwd.y -= u.y * d;
        _fwd.z -= u.z * d;
        _fwd.normalize();
        _right.crossVectors(u, _fwd);
        _right.normalize();

        const w = this._world;
        w[0] = _right.x * scale; w[1] = _right.y * scale; w[2] = _right.z * scale;
        w[3] = u.x * scale; w[4] = u.y * scale; w[5] = u.z * scale;
        w[6] = _fwd.x * scale; w[7] = _fwd.y * scale; w[8] = _fwd.z * scale;
        w[9] = this.position.x; w[10] = this.position.y; w[11] = this.position.z;
    }

    /**
     * Sample the baked cycle, fold in the world transform, write this walker's
     * four rows of the herd's shared staging array.
     *
     * The two frames either side of the phase are lerped component-wise. Linear
     * interpolation of skinning matrices is not a rotation-correct blend, but at
     * twenty-four frames a second on a gait this slow the largest angle between
     * two neighbouring frames is under two degrees, where the difference from a
     * proper slerp is beneath the quantisation the matrices are stored at.
     */
    _writeRows(d) {
        const herd = this.herd;
        const a = herd.anim;
        const n = herd.frameCount;
        const bones = herd.boneCount;

        const fpos = this.phase * n;
        const f0 = Math.floor(fpos) % n;
        const f1 = (f0 + 1) % n;
        const t = fpos - Math.floor(fpos);
        const it = 1 - t;

        const o0 = f0 * bones * 12;
        const o1 = f1 * bones * 12;
        const bs = herd.basisScale;
        const ts = herd.transScale;

        const w = this._world;
        const m = herd.boneScratch;
        const row0 = this.index * 4;
        const headBones = herd.headBones;
        const head = this._head;
        const bendHead = this._headActive && !!headBones;

        for (let b = 0; b < bones; b++) {
            const p0 = o0 + b * 12;
            const p1 = o1 + b * 12;
            for (let k = 0; k < 9; k++) m[k] = (a[p0 + k] * it + a[p1 + k] * t) * bs;
            for (let k = 9; k < 12; k++) m[k] = (a[p0 + k] * it + a[p1 + k] * t) * ts;

            // The neck. Composed on the left of the baked matrix and on the right
            // of the world one — head * bone, so the gait still rocks it — and
            // only for the bones the head chain actually drives.
            if (bendHead && headBones[b]) {
                for (let c = 0; c < 4; c++) {
                    const x = m[c * 3], y = m[c * 3 + 1], z = m[c * 3 + 2];
                    const tr = c === 3 ? 1 : 0;
                    m[c * 3] = head[0] * x + head[3] * y + head[6] * z + head[9] * tr;
                    m[c * 3 + 1] = head[1] * x + head[4] * y + head[7] * z + head[10] * tr;
                    m[c * 3 + 2] = head[2] * x + head[5] * y + head[8] * z + head[11] * tr;
                }
            }

            // world * bone, four columns of it. The first three are directions
            // and take no translation; the fourth is the origin and does.
            for (let c = 0; c < 4; c++) {
                const x = m[c * 3], y = m[c * 3 + 1], z = m[c * 3 + 2];
                const o = ((row0 + c) * bones + b) * 4;
                d[o] = w[0] * x + w[3] * y + w[6] * z + (c === 3 ? w[9] : 0);
                d[o + 1] = w[1] * x + w[4] * y + w[7] * z + (c === 3 ? w[10] : 0);
                d[o + 2] = w[2] * x + w[5] * y + w[8] * z + (c === 3 ? w[11] : 0);
                d[o + 3] = 1;
            }
        }
    }

    /** Push this frame's uniforms. @param {THREE.Vector3} cameraPos */
    sync(cameraPos) {
        const u = this.material.uniforms;

        // The shared objects — sun, SH, cascade matrices/params/splits — were
        // bound by reference at construction and are mutated in place by their
        // owners (§7.2/§7.3), so only the copies and the settings scalars are
        // written here.
        u.cameraPos.value.copy(cameraPos);

        u.fogDensity.value = S.fogDensity;
        u.fogHeightFalloff.value = S.fogHeightFalloff;
        u.fogStart.value = S.fogStart;
        u.aerialStrength.value = S.aerialStrength;
        u.ambientIntensity.value = S.ambientIntensity;
        u.snowCover.value = S.walkerSnow;
        // The debug views are the speeder's; the walker always shades normally.
        u.debugView.value = 0;
        u.debugGain.value = 1;
    }

    setVisible(v) {
        this.mesh.visible = v;
    }

    dispose() {
        this.gfx.scene.remove(this.mesh);
        this.material.dispose();
        for (const m of this._depthMats) m.dispose();
        this._prepassMat?.dispose();
    }
}

// -----------------------------------------------------------------------------

export class WalkerHerd {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./walkerAsset.js").WalkerAsset} asset
     * @param {{ yaw:number, camera:{ fov:number, viewProjection:THREE.Matrix4 } }} rig
     */
    constructor(gfx, terrain, sky, shadows, asset, rig) {
        this.gfx = gfx;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.rig = rig;

        const h = asset.header;
        this.boneCount = h.boneCount;
        this.frameCount = h.frameCount;
        this.duration = h.duration;
        /** Metres per second at scale 1, solved off the clip's stance phase. */
        this.baseSpeed = h.speed;
        this.height = h.height;
        this.bounds = h.bounds;
        this.basisScale = h.basisScale;
        this.transScale = h.transScale;
        this.anim = asset.anim;
        this.boneScratch = new Float32Array(12);
        /** Cycle phases, 0..1, at which a foot is on the ground. */
        this.footfalls = deriveFootfalls(asset.anim, h);

        // Which bones the head chain drives, where the neck pivots, and where the
        // chin guns sit — all read off the geometry, so no re-bake.
        const head = deriveHead(asset, h);
        this.headBones = head.bones;
        this.headPivot = head.pivot;
        this.headHeight = head.height;
        this.muzzles = head.muzzles;
        this.muzzleAim = head.aim;
        /**
         * The bolts every walker in the herd fires, in one pool and one draw.
         * Owned here rather than per walker for the same reason the geometry is:
         * a second machine should cost a mesh, not a system.
         */
        this.bolts = new Bolts(gfx, {
            terrain, spray: null,
            // Tunable look (overlay "Walker" section); the scale multiplier the
            // default look applied stays on top so size tracks the machine.
            look: () => {
                const s = Math.max(0.4, S.walkerScale);
                return {
                    r: S.walkerBoltR, g: S.walkerBoltG, b: S.walkerBoltB,
                    width: S.walkerBoltWidth * s,
                    reach: S.walkerBoltReach * s,
                    speed: S.walkerBoltSpeed,
                };
            },
        });
        if (rig && rig.camera && rig.camera.viewProjection) {
            this.bolts.material.uniforms.viewProjection.value = rig.camera.viewProjection;
        }
        /** Called with the walker that just fired — the soundscape polls instead. */
        this.onShot = (w) => this.bolts.spawn(w.muzzle, w.muzzleDir);

        // ---- shared transform texture --------------------------------------
        // Column = bone, row = matrix column, four rows per walker. Byte-identical
        // in layout to the character's, which is why `snowWalkerSkin` reads like
        // `snowCharSkin`; the only addition is the row offset that picks a block.
        //
        // Built before the walkers, which bind it into their materials.
        this._texData = new Float32Array(this.boneCount * 4 * MAX_WALKERS * 4);
        this.walkerTex = new THREE.DataTexture(
            this._texData, this.boneCount, 4 * MAX_WALKERS,
            THREE.RGBAFormat, THREE.FloatType
        );
        this.walkerTex.colorSpace = THREE.NoColorSpace;
        this.walkerTex.flipY = false;
        this.walkerTex.premultiplyAlpha = false;
        this.walkerTex.generateMipmaps = false;
        this.walkerTex.minFilter = THREE.NearestFilter;
        this.walkerTex.magFilter = THREE.NearestFilter;
        this.walkerTex.wrapS = THREE.ClampToEdgeWrapping;
        this.walkerTex.wrapT = THREE.ClampToEdgeWrapping;
        this.walkerTex.needsUpdate = true;

        // ---- shared material maps -------------------------------------------
        const size = asset.albedoSize || h.textureSize;
        // The walker's materials do carry ORM maps, so this is `size` for it;
        // it is one texel for a model whose materials carry none. See
        // `loadWalkerAsset`.
        const ormSize = asset.ormSize || size;
        const layers = asset.layers || 4;
        const aniso = Math.min(16, gfx.renderer.capabilities.getMaxAnisotropy());
        const makeArray = (data, s) => {
            const tex = new THREE.DataArrayTexture(data, s, s, layers);
            tex.format = THREE.RGBAFormat;
            tex.type = THREE.UnsignedByteType;
            tex.colorSpace = THREE.NoColorSpace;
            tex.flipY = false;
            tex.premultiplyAlpha = false;
            tex.wrapS = THREE.RepeatWrapping;
            tex.wrapT = THREE.RepeatWrapping;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
            tex.generateMipmaps = true;
            // 16x, because the hull is seen at grazing angles for most of its
            // approach and its panel lines are the first thing to go to mush.
            tex.anisotropy = aniso;
            tex.needsUpdate = true;
            return tex;
        };
        this.albedoTex = makeArray(asset.albedo, size);
        this.ormTex = makeArray(asset.orm, ormSize);

        /** (roughness, metallic, occlusion strength, albedo tint) per slot. */
        this.factors = new Float32Array(32);
        for (const m of h.materials) {
            const o = m.slot * 4;
            this.factors[o] = m.roughness;
            this.factors[o + 1] = m.metallic;
            this.factors[o + 2] = 1;
            // The interior has no maps at all and would otherwise come back
            // white; it is the inside of a hatch and belongs in shadow.
            this.factors[o + 3] = m.albedoImage < 0 ? 0.18 : 1;
        }

        // ---- shared geometry ----------------------------------------------
        // One set of GPU buffers per level, referenced by every walker. Adding a
        // machine to the herd allocates a mesh and five materials and not one
        // byte of vertex data.
        this.lods = asset.lods.map((lod, i) => ({
            geometry: this._makeGeometry(lod, i),
            triangleCount: lod.triangleCount,
            vertexCount: lod.vertexCount,
        }));

        // ---- the herd --------------------------------------------------------
        /** @type {Walker[]} */
        this.walkers = [];
        this._visible = true;
        this._depth = null;
        /**
         * Called with each new walker's surface material.
         *
         * The herd can grow after boot — `S.walkerCount` is a live slider — and a
         * machine that appeared later must still be lit by the spells. This is
         * how `main.js` keeps the spell system's consumer list complete without
         * the herd knowing what a spell is.
         * @type {((m: THREE.RawShaderMaterial) => void)|null}
         */
        this.onMaterial = null;
        this.setCount(Math.min(MAX_WALKERS, Math.max(1, Math.round(S.walkerCount))));
        this.setVisible(S.showWalker !== false);
    }

    /**
     * One level's GPU buffers, built once and shared by the whole herd.
     * @param {import("./walkerAsset.js").WalkerLOD} lod
     */
    _makeGeometry(lod, level) {
        const geom = new THREE.BufferGeometry();
        geom.name = "walkerLOD" + level;
        geom.setAttribute("position", new THREE.BufferAttribute(lod.positions, 3));
        geom.setAttribute("normal", new THREE.BufferAttribute(lod.normals, 3));
        geom.setAttribute("uv", new THREE.BufferAttribute(lod.uvs, 2));
        geom.setAttribute("aux", new THREE.BufferAttribute(lod.aux, 2));
        geom.setAttribute("boneIdx", new THREE.BufferAttribute(lod.boneIdx, 4));
        geom.setAttribute("boneWt", new THREE.BufferAttribute(lod.boneWt, 4));
        geom.setIndex(new THREE.BufferAttribute(lod.indices, 1));
        return geom;
    }

    /**
     * Grow or shrink the herd. Walkers are built lazily and never destroyed —
     * turning the count down parks them rather than freeing five materials and a
     * mesh that the next turn of the slider would rebuild.
     *
     * @param {number} n
     */
    setCount(n) {
        const want = Math.min(MAX_WALKERS, Math.max(0, Math.round(n)));
        // Set before building, not after: `place()` centres the opening line on
        // the herd's size, and a walker placed while this still held the old
        // count would be framed for a herd it is not part of.
        this.count = want;
        while (this.walkers.length < want) {
            const w = new Walker(this, this.walkers.length);
            this.place(w, this._lastTarget);
            if (this._depth) w.registerPrepass(this._depth);
            this.onMaterial?.(w.material);
            this.walkers.push(w);
        }
        for (let i = 0; i < this.walkers.length; i++) {
            this.walkers[i].setVisible(this._visible && i < want);
        }
    }

    /**
     * Put a walker out on the horizon and aim it, once.
     *
     * The bearing is the camera's at boot — the one direction the player is
     * guaranteed to be looking at frame one — and thereafter the direction each
     * one happens to be walking, mirrored to the far side so it comes back across
     * the field rather than trudging away.
     *
     * The stagger is what stops them reading as copies: lateral spacing alternates
     * either side of the line so it grows outward from the middle, distance is
     * dealt out unevenly, and the gait phase is offset per machine — two AT-ATs
     * stepping in perfect unison is a parade, and this is not a parade.
     *
     * Aimed at where the player is *now*, and then never corrected. That is the
     * whole of the behaviour: walking toward you is a heading, following you is a
     * feedback loop, and only one of them belongs in a landscape shot.
     *
     * @param {Walker} walker
     * @param {{x:number, z:number}} [target] the player; the origin at boot
     */
    place(walker, target) {
        const i = walker.index;
        const scale = S.walkerScale;
        const side = (i % 2 === 0 ? 1 : -1) * Math.ceil(i / 2);
        const first = !walker._placed;
        walker._placed = true;

        let bearing, lateral;
        if (first) {
            // Framed: toward the sun, straddling it, clamped into the window.
            const rigYaw = this.rig ? this.rig.yaw : 0;
            const halfH = this._halfField();
            const sunBearing = (/** @type {number} */ (S.sunAzimuth) * Math.PI) / 180;
            let toSun = sunBearing - rigYaw;
            toSun = Math.atan2(Math.sin(toSun), Math.cos(toSun));
            // Most of the way to the sun rather than all of it. Dead on the
            // sun's bearing the hull is inside the glare and the bloom eats it;
            // a little inboard and the sun is behind the herd and still in the
            // frame, which is the picture — backlit, not swallowed.
            const want = toSun * SUN_REACH;
            const bias = Math.max(-halfH * SUN_BIAS, Math.min(halfH * SUN_BIAS, want));
            const spread = Math.min(SPREAD_MAX, halfH * SPREAD);
            // Straddle the bias rather than starting on it: the first machine
            // sitting exactly on the sun's bearing is the one that disappears
            // into the glare, which is the whole thing this layout is avoiding.
            const span = i - (this.count - 1) * 0.5;
            bearing = rigYaw + bias + span * spread;
            // The angle carries the spacing, so there is nothing left to add in
            // metres — doing both would widen the line at every aspect but the
            // one it was measured at.
            lateral = 0;
        } else {
            // Recycled: keep travelling on the line it was already on, mirrored
            // to the far side, so the herd fans out across the field instead of
            // pacing one corridor. Nothing frames this one, so metres are fine.
            bearing = walker.yaw + Math.PI;
            lateral = side * SPAWN_SPREAD * scale + (i % 3) * 11 - 11;
        }

        // Uneven depth so the line is a group rather than a rank.
        const depth = SPAWN_DISTANCE + (i % 3) * 30;
        const tx = target ? target.x : 0;
        const tz = target ? target.z : 0;

        walker.position.set(
            tx + Math.sin(bearing) * depth + Math.cos(bearing) * lateral,
            0,
            tz + Math.cos(bearing) * depth - Math.sin(bearing) * lateral
        );
        walker.position.y = this.terrain && this.terrain.heightAt
            ? this.terrain.heightAt(walker.position.x, walker.position.z) : 0;
        // Aimed at the player from wherever it ended up — including the lateral
        // offset, so a line abreast converges very slightly rather than marching
        // down parallel tracks.
        walker.yaw = Math.atan2(tx - walker.position.x, tz - walker.position.z);
        walker.phase = (i * 0.37) % 1;
        walker._settled = false;
    }

    /**
     * The horizontal half-field, radians.
     *
     * The camera's `fov` is vertical, so this is the number that actually
     * decides what is on screen — and it moves with the window *and* with speed,
     * since the rig widens the FOV as the player accelerates. Aspect comes from
     * the drawing buffer, exactly as Babylon's `getRenderWidth/Height` did.
     */
    _halfField() {
        const gfx = this.gfx;
        const aspect = gfx.renderWidth / Math.max(1, gfx.renderHeight);
        const fov = this.rig && this.rig.camera ? this.rig.camera.fov : 1.02;
        return Math.atan(Math.tan(fov * 0.5) * aspect);
    }

    /**
     * The spray field the bolts throw snow into.
     *
     * Injected rather than constructed, because there is exactly one pool in the
     * scene and the feet, the wake and every spell are already emitting into it.
     * @param {import("../vfx/particles.js").SprayField} spray
     */
    setSpray(spray) {
        if (this.bolts && this.bolts.ctx) this.bolts.ctx.spray = spray;
    }

    /** @param {import("../render/depthPass.js").DepthPass} depth */
    registerPrepass(depth) {
        this._depth = depth;
        for (const w of this.walkers) w.registerPrepass(depth);
    }

    setVisible(v) {
        this._visible = !!v;
        if (this.bolts) this.bolts.mesh.visible = false;
        for (let i = 0; i < this.walkers.length; i++) {
            this.walkers[i].setVisible(this._visible && i < this.count);
        }
    }

    /**
     * One tuning ring per gun head, pushed onto `markers` — the same offset
     * math `_fire` uses, so a ring sits exactly where the next bolt is born
     * and rides the head's aim tracking live.
     * @param {import("../vfx/muzzleMarkers.js").MuzzleMarkers} markers
     */
    collectMuzzles(markers) {
        if (!this.muzzles || !this._visible) return;
        const s = Math.max(0.4, S.walkerScale);
        for (let i = 0; i < Math.min(this.count, this.walkers.length); i++) {
            const w = this.walkers[i];
            for (let m = 0; m < this.muzzles.length; m++) {
                const local = this.muzzles[m];
                _muzzleLocal[0] = local[0] + Math.sign(local[0]) * S.walkerMuzzleSpan;
                _muzzleLocal[1] = local[1] + S.walkerMuzzleY;
                _muzzleLocal[2] = local[2] + S.walkerMuzzleZ;
                w._muzzleWorld(_muzzleLocal, _tmp);
                markers.add(
                    _tmp.x, _tmp.y, _tmp.z, 0.35 * s,
                    S.walkerBoltR, S.walkerBoltG, S.walkerBoltB
                );
            }
        }
    }

    /**
     * Step the herd, separate it, ground it, and push one texture.
     *
     * @param {number} dt seconds
     * @param {THREE.Vector3} target the player, which is what they are walking toward
     */
    update(dt, target) {
        this._lastTarget = target;
        this._lastDt = dt;
        if (S.walkerCount !== this.count) this.setCount(S.walkerCount);
        if (!this._visible) return;

        const n = this.count;
        for (let i = 0; i < n; i++) this.walkers[i].step(dt, target);

        // ---------------------------------------------------------- separation
        // All of them are walking toward the same person, so left alone they
        // converge. This used to push them apart in metres, and that was the
        // crabbing: a heading that never changes plus a position nudged sideways
        // every frame is a machine walking diagonally to the way it is facing,
        // which on something with legs reads as badly broken.
        //
        // So they separate by *tempo* instead. Whoever is further from the player
        // eases off and the nearer one presses on, and the pair strings out into
        // a line rather than colliding. It costs nothing to look at, because the
        // trim scales the ground speed and the cycle rate together — the feet stay
        // planted at any tempo — and no walker ever travels a millimetre off its
        // own heading.
        const sep = SEPARATION * S.walkerScale;
        for (let i = 0; i < n; i++) this.walkers[i]._rateWant = 1;
        for (let i = 0; i < n; i++) {
            for (let j = i + 1; j < n; j++) {
                const A = this.walkers[i];
                const B = this.walkers[j];
                const d = Math.hypot(A.position.x - B.position.x, A.position.z - B.position.z);
                if (d >= sep) continue;
                const crowd = 1 - d / sep;
                const dA = Math.hypot(target.x - A.position.x, target.z - A.position.z);
                const dB = Math.hypot(target.x - B.position.x, target.z - B.position.z);
                const behind = dA > dB ? A : B;
                const ahead = dA > dB ? B : A;
                behind._rateWant -= crowd * 0.22;
                ahead._rateWant += crowd * 0.12;
            }
        }
        for (let i = 0; i < n; i++) {
            const w = this.walkers[i];
            w._rateWant = Math.max(0.55, Math.min(1.25, w._rateWant));
        }

        for (let i = 0; i < n; i++) this.walkers[i].settle(dt, this._texData, target);
        // The whole herd's pose, one upload.
        this.walkerTex.needsUpdate = true;
    }

    /**
     * Push per-frame uniforms and choose each walker's level of detail.
     *
     * Split from `update` for the same reason the character's is: the pose has to
     * be solved before anything reads it, and the uniforms cannot be written
     * until the camera has moved and the cascades have been refitted.
     *
     * @param {THREE.Vector3} cameraPos
     */
    sync(cameraPos) {
        if (!this._visible) return;

        // Pixels of screen height per metre of object at one metre. The rig
        // widens the FOV with speed, so this is recomputed rather than cached.
        const fov = this.rig && this.rig.camera ? this.rig.camera.fov : 1.02;
        const pxPerMetre = this.gfx.renderHeight / (2 * Math.tan(fov * 0.5));
        const hullHeight = this.height * S.walkerScale;

        for (let i = 0; i < this.count; i++) {
            const w = this.walkers[i];
            const dist = Math.max(1, w.position.distanceTo(cameraPos));
            const px = (hullHeight / dist) * pxPerMetre;

            // Hysteresis: a level is only entered at its threshold but is not
            // left until the projection has fallen a fifth below it, so a walker
            // hovering on a boundary cannot swap geometry every frame.
            const coarsest = this.lods.length - 1;
            let level = coarsest;
            for (let k = 0; k < LOD_PIXELS.length && k < coarsest; k++) {
                const enter = LOD_PIXELS[k];
                const leave = enter / LOD_HYSTERESIS;
                if (px >= (w.lod <= k ? leave : enter)) { level = k; break; }
            }
            w.setLOD(level);
            w.sync(cameraPos);
        }
        // After the walkers, so a bolt fired this frame is already placed.
        this.bolts.update(this._lastDt, cameraPos);
    }

    /** Triangles the herd is actually drawing this frame. */
    get triangles() {
        if (!this._visible) return 0;
        let t = this.bolts.live * 2;
        for (let i = 0; i < this.count; i++) t += this.lods[this.walkers[i].lod].triangleCount;
        return t;
    }

    /** Compile every pipeline behind the loading screen. */
    async warmUp() {
        // One walker's materials are enough to compile every pipeline in the
        // herd — they differ only in uniform values — but every material is
        // still walked so nothing compiles on its first real frame.
        for (const w of this.walkers) {
            await whenReady(this.gfx, w.material, "walker material");
            for (const m of w._depthMats) await whenReady(this.gfx, m, m.name);
            if (w._prepassMat) await whenReady(this.gfx, w._prepassMat, "walkerPrepass");
        }
        await this.bolts.warmUp();
    }

    dispose() {
        this.bolts.dispose();
        for (const w of this.walkers) w.dispose();
        for (const l of this.lods) l.geometry.dispose();
        this.walkerTex.dispose();
        this.albedoTex.dispose();
        this.ormTex.dispose();
    }
}
