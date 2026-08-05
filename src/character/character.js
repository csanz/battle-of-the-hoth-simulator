/**
 * The character system.
 *
 * Owns the skeleton, the garment simulation, the three meshes and the seven
 * pipelines that draw them, and the single small texture that carries every
 * per-frame transform to the GPU.
 *
 * The transform texture is the spine of the whole thing. Rows 0-3 hold bone
 * skinning matrices, rows 4 and beyond hold simulated cloth nodes, and one
 * `update()` per frame writes both into a pre-allocated staging array and
 * uploads it once. Nothing else crosses to the GPU: no per-frame buffers, no
 * matrix uniforms, no vertex data.
 *
 * Allocation per frame: none.
 *
 * Port note on `viewProjection`: Babylon auto-bound it from the active camera.
 * Here every beauty/prepass material shares one module-scope `Matrix4`, and an
 * `onBeforeRender` hook on the meshes rebuilds it from the token camera —
 * whose matrices are the rig's jittered view/projection, copied by
 * `gfx.syncTokenCamera` at the top of the frame's render — immediately before
 * the draw. Same numbers, same jitter, no dependency on the rig object this
 * constructor never receives.
 */

import * as THREE from "three";

import { Figure, BONE_COUNT } from "./figure.js";
import { makePanels, ClothSolver } from "./cloth.js";
import { buildBody, buildFur, buildClothMesh } from "./build.js";
import { S } from "../core/settings.js";
import { makeMaterial, whenReady } from "../core/gpuUtil.js";
import { getShader } from "../shaders/registry.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";

/** Transform texture geometry. Width covers the widest of bones or panel cols. */
const TEX_W = 48;
const TEX_H = 64;
/** First texture row available to cloth panels; 0-3 are the bone matrices. */
const CLOTH_ROW0 = 4;

/** How many cascades the figure casts into. See `ShadowSystem.registerCaster`. */
const CHAR_CASCADES = 2;

/**
 * Material palette. Eight slots, uploaded as two vec4 arrays so every value is
 * live-tunable and nothing is baked into the shader: deep indigo wool, a
 * lighter blue-grey mantle, a pale under-layer at the collar, dark leather.
 *
 * Two properties of these numbers are deliberate and were measured off the
 * render rather than picked as colours.
 *
 * They are *very* saturated. At thirteen degrees the sun has lost most of its
 * blue — the direct beam here is roughly 17:13:6 — so a merely blue-ish albedo
 * comes back out of the multiply as warm grey. The blue has to be about four
 * times the red in the albedo just to survive to two-to-one in the lit areas.
 *
 * They are *very* dark. AgX compresses hard, so an eighth of the snow's albedo
 * is only about three stops down and lands near mid grey on screen. Anything
 * lighter stops reading as a silhouette against the field, which is the one
 * thing the figure has to do at fifteen metres.
 */
const PALETTE = [
    // rgb, roughness
    [0.030, 0.048, 0.125, 0.80], // 0 robe, deep indigo
    [0.075, 0.105, 0.185, 0.74], // 1 mantle, blue-grey
    [0.230, 0.225, 0.205, 0.82], // 2 collar lining, warm pale
    [0.048, 0.033, 0.024, 0.60], // 3 leather
    [0.135, 0.095, 0.072, 0.85], // 4 skin, deep in shade
    [0.120, 0.195, 0.310, 0.70], // 5 trim / scarf, pale blue
    [0.700, 0.720, 0.760, 0.85], // 6 fur (unused by the fabric shader)
    [0.100, 0.100, 0.100, 0.80], // 7 spare
];

/**
 * (sheen, anisotropy, transmission, weave depth) per slot.
 *
 * Transmission is the number to be careful with. Sunlight through a *blue*
 * robe, multiplied by a *warm* sun, comes back grey — so a generous
 * transmission term does not make the garment glow, it desaturates it to the
 * point where the albedo stops mattering. Heavy wool is close to opaque; only
 * the thin under-layer gets a real value.
 */
const PARAMS = [
    [0.22, 0.55, 0.05, 1.00],
    [0.28, 0.45, 0.07, 0.90],
    [0.35, 0.30, 0.22, 1.10],
    [0.06, 0.20, 0.01, 0.35],
    [0.05, 0.00, 0.08, 0.00],
    [0.25, 0.60, 0.12, 1.00],
    [1.00, 0.00, 0.90, 0.00],
    [0.20, 0.00, 0.00, 0.50],
];

// ------------------------------------------------------- module-scope scratch
const _droop = new THREE.Vector3();
const _screen = new THREE.Vector2();
const _furCol = new THREE.Color(0.74, 0.755, 0.795);

/**
 * The one `viewProjection` every character material binds (§7.1). Rebuilt from
 * the token camera right before any character mesh draws — after the post
 * chain has jittered the projection and `gfx.syncTokenCamera` has copied it.
 */
const _viewProjection = new THREE.Matrix4();

function _refreshViewProjection(renderer, scene, camera) {
    _viewProjection.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
}

/** Fetch a shared shader, tolerating an absent peer file during bring-up (G1). */
function shaderOr(name, fallback) {
    try {
        return getShader(name);
    } catch (err) {
        console.warn("[character] missing peer shader", name, "- using fallback");
        return fallback;
    }
}

/** Contract §1.5: caster fragments write window depth into the R32F color RT. */
const FALLBACK_DEPTH_FRAGMENT = `precision highp float;
precision highp int;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
`;

/** Contract §7.9: the shared prepass output. */
const FALLBACK_PREPASS_FRAGMENT = `precision highp float;
precision highp int;

in float vViewZ;
in float vMask;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
`;

export class Character {
    /**
     * @param {import("../core/gfx.js").Gfx} gfx
     * @param {import("../terrain/terrain.js").Terrain} terrain
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./controller.js").CharacterController} controller
     */
    constructor(gfx, terrain, sky, shadows, controller) {
        this.gfx = gfx;
        this.terrain = terrain;
        this.sky = sky;
        this.shadows = shadows;
        this.controller = controller;

        this.figure = new Figure(terrain);
        this.panels = makePanels();
        this.solver = new ClothSolver(this.panels, terrain);

        // ---- transform texture -------------------------------------------
        this._texData = new Float32Array(TEX_W * TEX_H * 4);
        let row = CLOTH_ROW0;
        /** Flat (rowBase, cols, rows, 0) per panel, for the vertex shaders. */
        this._panelParams = new Float32Array(6 * 4);
        for (let i = 0; i < this.panels.length; i++) {
            const p = this.panels[i];
            if (p.cols > TEX_W) throw new Error("panel wider than the transform texture");
            p.nodeRow = row;
            this._panelParams[i * 4] = row;
            this._panelParams[i * 4 + 1] = p.cols;
            this._panelParams[i * 4 + 2] = p.rows;
            row += p.rows;
        }
        if (row > TEX_H) throw new Error("transform texture too short for the panels");

        this.charTex = new THREE.DataTexture(
            this._texData, TEX_W, TEX_H, THREE.RGBAFormat, THREE.FloatType
        );
        this.charTex.name = "charTex";
        this.charTex.minFilter = THREE.NearestFilter;
        this.charTex.magFilter = THREE.NearestFilter;
        this.charTex.wrapS = THREE.ClampToEdgeWrapping;
        this.charTex.wrapT = THREE.ClampToEdgeWrapping;
        this.charTex.generateMipmaps = false;
        this.charTex.colorSpace = THREE.NoColorSpace;
        this.charTex.flipY = false;
        this.charTex.premultiplyAlpha = false;
        this.charTex.needsUpdate = true;

        // ---- palette ------------------------------------------------------
        this._matAlbedo = new Float32Array(32);
        this._matParams = new Float32Array(32);
        for (let i = 0; i < 8; i++) {
            for (let k = 0; k < 4; k++) {
                this._matAlbedo[i * 4 + k] = PALETTE[i][k];
                this._matParams[i * 4 + k] = PARAMS[i][k];
            }
        }

        // ---- shared uniform value objects (stub-tolerant, zero-copy) ------
        this._cameraPos = new THREE.Vector3();
        this._lut = sky && sky.lut ? sky.lut : gfx.blackTex;
        this._sunDir = sky && sky.sunDir ? sky.sunDir : new THREE.Vector3(0, 1, 0);
        this._sunRadiance = sky && sky.sunRadiance ? sky.sunRadiance : new THREE.Color(1, 1, 1);
        this._shR = sky && sky.sh ? sky.sh : new Float32Array(36);

        const maps = shadows && shadows.maps ? shadows.maps : null;
        this._cascadeTex = [];
        for (let i = 0; i < CASCADE_COUNT; i++) {
            // A cascade cleared to 1.0 is "fully lit" — white is the safe stub.
            this._cascadeTex.push(maps && maps[i] ? maps[i] : gfx.whiteTex);
        }
        this._cascadeMatrices = shadows && shadows.matrixValues
            ? shadows.matrixValues
            : [new THREE.Matrix4(), new THREE.Matrix4(), new THREE.Matrix4()];
        this._cascadeParams = shadows && shadows.paramData
            ? shadows.paramData
            : new Float32Array(12);
        this._splits = shadows && shadows.splitsVec4
            ? shadows.splitsVec4
            : new THREE.Vector4(26, 95, 330, 330);
        this._shadowTexel = shadows && shadows.texelSize ? shadows.texelSize : 1 / 2048;

        // ---- meshes and materials -----------------------------------------
        this.bodyMesh = buildBody(gfx);
        this.clothMesh = buildClothMesh(gfx, this.panels);
        this.furMesh = buildFur(gfx);

        this.bodyMat = this._makeSurfaceMaterial("charBody", "char", "char", false);
        this.clothMat = this._makeSurfaceMaterial("charCloth", "cloth", "char", true);
        this.furMat = this._makeFurMaterial();

        this.bodyMesh.material = this.bodyMat;
        this.clothMesh.material = this.clothMat;
        this.furMesh.material = this.furMat;

        // Opaque scene group (§4.4): body and cloth at 10; the fur draws last
        // within the group — its `discard` disables early-Z, so it wants every
        // opaque depth already laid down when it runs.
        gfx.addMesh(this.bodyMesh, gfx.LAYER.OPAQUE, 10);
        gfx.addMesh(this.clothMesh, gfx.LAYER.OPAQUE, 10);
        gfx.addMesh(this.furMesh, gfx.LAYER.OPAQUE, 10.5);

        for (const m of [this.bodyMesh, this.clothMesh, this.furMesh]) {
            m.onBeforeRender = _refreshViewProjection;
        }

        /** @type {THREE.RawShaderMaterial[]} */
        this._depthMats = [];
        if (shadows && shadows.registerCaster) {
            shadows.registerCaster(
                this.bodyMesh, (c) => this._makeDepthMaterial("charDepth", c, false), CHAR_CASCADES
            );
            shadows.registerCaster(
                this.clothMesh, (c) => this._makeDepthMaterial("clothDepth", c, true), CHAR_CASCADES
            );
        }
        // Fur is not registered as a caster. Its shadow lands inside the hood's
        // own, an alpha-tested 22-shell depth pass is not cheap, and what it
        // would contribute is a slightly fuzzier edge on a shadow already an
        // order of magnitude softer than that.

        this.triangles =
            this.bodyMesh.metadata.triangles +
            this.clothMesh.metadata.triangles +
            this.furMesh.metadata.triangles;

        this._mats = [this.bodyMat, this.clothMat, this.furMat];
        this._fabricMats = [this.bodyMat, this.clothMat];
        this._needSettle = true;

        this._visible = true;
        this.setVisible(S.showCharacter !== false);
    }

    /**
     * The uniform slots every character material shares. Values are the *same
     * objects* across materials — the rig/sky/shadow systems mutate them in
     * place and Three re-uploads per draw, so `sync` never copies matrices.
     */
    _sharedUniforms() {
        return {
            viewProjection: { value: _viewProjection },
            cameraPos: { value: this._cameraPos },
            sunDir: { value: this._sunDir },
            sunRadiance: { value: this._sunRadiance },
            shR: { value: this._shR },
            cascadeMatrices: { value: this._cascadeMatrices },
            cascadeSplits: { value: this._splits },
            cascadeParams: { value: this._cascadeParams },
            shadowTexel: { value: this._shadowTexel },
            shadowSoftness: { value: 1.4 },
            // Tighter than the terrain's: the figure is small, its cascade is
            // the near one, and a large bias here detaches the contact shadow
            // between the boots and the snow — which is the shadow that tells
            // you the character is standing on the ground rather than in it.
            shadowBias: { value: 0.012 },
            fogDensity: { value: S.fogDensity },
            fogHeightFalloff: { value: S.fogHeightFalloff },
            fogStart: { value: S.fogStart },
            aerialStrength: { value: S.aerialStrength },
            ambientIntensity: { value: S.ambientIntensity },
            charTex: { value: this.charTex },
            skyLUT: { value: this._lut },
            cascade0: { value: this._cascadeTex[0] },
            cascade1: { value: this._cascadeTex[1] },
            cascade2: { value: this._cascadeTex[2] },
        };
    }

    /**
     * One surface material. The body and the garments differ only in their
     * vertex program — the fabric shading, the shadow lookup and the aerial
     * perspective are literally the same code.
     */
    _makeSurfaceMaterial(name, vertex, fragment, isCloth) {
        const uniforms = this._sharedUniforms();
        uniforms.matAlbedo = { value: this._matAlbedo };
        uniforms.matParams = { value: this._matParams };
        uniforms.sssStrength = { value: S.sssStrength };
        // Threads per metre. Coarse hand-woven wool, which is what puts the
        // weave right at the edge of visibility at the distance the figure
        // is normally framed — present in a close-up, gone by ten metres.
        uniforms.weaveDensity = { value: 210 };
        uniforms.screenSize = { value: _screen };
        for (const key of SPELL_LIGHT_UNIFORMS) {
            uniforms[key] = { value: key === "spellLightCount" ? 0 : new Float32Array(16) };
        }
        if (isCloth) uniforms.panelParams = { value: this._panelParams };

        // Every garment is an open sheet and the cowl is a shell, so both faces
        // are visible. The fragment shader turns the normal toward the viewer
        // rather than trusting winding — see the note there.
        return makeMaterial({
            name,
            vertex: getShader(vertex + "VertexShader"),
            fragment: getShader(fragment + "PixelShader"),
            uniforms,
            side: THREE.DoubleSide,
        });
    }

    _makeFurMaterial() {
        const uniforms = this._sharedUniforms();
        uniforms.furDroop = { value: _droop };
        uniforms.furDensity = { value: 250 };
        uniforms.furColor = { value: _furCol };

        return makeMaterial({
            name: "charFur",
            vertex: getShader("furVertexShader"),
            fragment: getShader("furPixelShader"),
            uniforms,
            side: THREE.DoubleSide,
        });
    }

    _makeDepthMaterial(vertex, cascade, isCloth) {
        const uniforms = {
            // One material instance per cascade, each holding its own matrix —
            // the ShadowSystem writes into it every refit. No mid-pass juggling.
            lightViewProjection: { value: new THREE.Matrix4() },
            charTex: { value: this.charTex },
        };
        if (isCloth) uniforms.panelParams = { value: this._panelParams };
        const mat = makeMaterial({
            name: vertex + cascade,
            vertex: getShader(vertex + "VertexShader"),
            fragment: shaderOr("terrainDepthPixelShader", FALLBACK_DEPTH_FRAGMENT),
            uniforms,
            side: THREE.DoubleSide,
        });
        this._depthMats.push(mat);
        return mat;
    }

    /**
     * Depth-prepass materials for the body and the garments.
     *
     * The fur is left out on the same grounds it is left out of the shadow
     * cascades: it is an alpha-tested twenty-two-shell pass, and what it would
     * contribute is a fractionally fuzzier occlusion edge on a hood rim that is
     * already inside its own baked cavity.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        this._prepassMats = [];
        for (const spec of [
            { mesh: this.bodyMesh, vertex: "charPrepass", cloth: false },
            { mesh: this.clothMesh, vertex: "clothPrepass", cloth: true },
        ]) {
            const uniforms = {
                viewProjection: { value: _viewProjection },
                charTex: { value: this.charTex },
            };
            if (spec.cloth) uniforms.panelParams = { value: this._panelParams };
            const mat = makeMaterial({
                name: spec.vertex,
                vertex: getShader(spec.vertex + "VertexShader"),
                fragment: shaderOr("prepassPixelShader", FALLBACK_PREPASS_FRAGMENT),
                uniforms,
                side: THREE.DoubleSide,
            });
            this._prepassMats.push(mat);
            if (depth && depth.registerCaster) depth.registerCaster(spec.mesh, mat);
        }
    }

    setVisible(v) {
        this._visible = !!v;
        this.bodyMesh.visible = this._visible;
        this.clothMesh.visible = this._visible;
        this.furMesh.visible = this._visible;
    }

    /**
     * Advance the figure and the garments, then push one texture upload and one
     * set of uniforms.
     *
     * Order matters: the skeleton has to be posed before the cloth can find its
     * kinematic targets, and both have to be written before the texture goes up,
     * or the garments render one frame behind the body they hang from.
     *
     * @param {number} dt
     */
    update(dt) {
        const ch = this.controller;
        this.figure.update(dt, ch);
        if (this._needSettle) {
            this._settleCloth();
            this._needSettle = false;
        }
        this.solver.update(dt, this.figure, ch);
        this._uploadTransforms();
    }

    /**
     * Push this frame's uniforms. Split from `update` because the garments have
     * to be solved before the contact system reads the feet, while the uniforms
     * cannot be written until the camera has moved and the cascades have been
     * refitted. Doing both at one point in the frame means one of them is a
     * frame stale, and the visible symptom — a shadow that lags the figure by a
     * frame during a fast carve — is exactly the sort of thing that reads as
     * "cheap" without being identifiable.
     *
     * @param {THREE.Vector3} cameraPos
     */
    sync(cameraPos) {
        this._cameraPos.copy(cameraPos);
        this._pushUniforms();
    }

    /**
     * Drop every garment straight onto its kinematic target.
     *
     * Done once, on the first update. The panels are authored in bind space at
     * the world origin, and letting them fall from there to wherever the player
     * actually spawned takes a second of visible flapping — behind the loading
     * screen if we are lucky, in shot if we are not.
     */
    _settleCloth() {
        const skin = this.figure.skin;
        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            for (let k = 0; k < p.count; k++) {
                const b = p.bone[k] * 16;
                const o = k * 3;
                const x = p.bindPos[o], y = p.bindPos[o + 1], z = p.bindPos[o + 2];
                p.pos[o] = skin[b] * x + skin[b + 4] * y + skin[b + 8] * z + skin[b + 12];
                p.pos[o + 1] = skin[b + 1] * x + skin[b + 5] * y + skin[b + 9] * z + skin[b + 13];
                p.pos[o + 2] = skin[b + 2] * x + skin[b + 6] * y + skin[b + 10] * z + skin[b + 14];
            }
            p.prev.set(p.pos);
        }
    }

    _uploadTransforms() {
        const d = this._texData;
        const skin = this.figure.skin;

        // Rows 0-3: bone matrices, one column per bone, one row per matrix
        // column. Written as four separate row writes rather than one blit,
        // because the texture is column-major in bones and row-major in memory.
        for (let b = 0; b < BONE_COUNT; b++) {
            const s = b * 16;
            for (let c = 0; c < 4; c++) {
                const o = (c * TEX_W + b) * 4;
                d[o] = skin[s + c * 4];
                d[o + 1] = skin[s + c * 4 + 1];
                d[o + 2] = skin[s + c * 4 + 2];
                d[o + 3] = skin[s + c * 4 + 3];
            }
        }

        for (let pi = 0; pi < this.panels.length; pi++) {
            const p = this.panels[pi];
            const pos = p.pos;
            for (let j = 0; j < p.rows; j++) {
                const rowO = ((p.nodeRow + j) * TEX_W) * 4;
                for (let i = 0; i < p.cols; i++) {
                    const s = (j * p.cols + i) * 3;
                    const o = rowO + i * 4;
                    d[o] = pos[s];
                    d[o + 1] = pos[s + 1];
                    d[o + 2] = pos[s + 2];
                    d[o + 3] = 1;
                }
            }
        }

        // One upload per frame: Three versions the texture and re-sends the
        // backing array on the next bind.
        this.charTex.needsUpdate = true;
    }

    _pushUniforms() {
        const ch = this.controller;

        // Fur droop: gravity, plus the apparent wind, plus the character's own
        // acceleration thrown the other way. Scaled to metres of tip travel.
        const a = (S.windDirection * Math.PI) / 180;
        const ws = 0.6 * S.windStrength;
        _droop.set(
            Math.sin(a) * ws * 0.006 - ch.velocity.x * 0.0016 - ch.acceleration.x * 0.00018,
            -0.018,
            Math.cos(a) * ws * 0.006 - ch.velocity.z * 0.0016 - ch.acceleration.z * 0.00018
        );

        // Everything zero-copy (sunDir, shR, cascade matrices/params/splits,
        // cameraPos, furDroop, screenSize, palette arrays) is a shared object
        // the owner mutates; only the plain-number settings need re-assigning.
        for (let i = 0; i < this._mats.length; i++) {
            const u = this._mats[i].uniforms;
            u.fogDensity.value = S.fogDensity;
            u.fogHeightFalloff.value = S.fogHeightFalloff;
            u.fogStart.value = S.fogStart;
            u.aerialStrength.value = S.aerialStrength;
            u.ambientIntensity.value = S.ambientIntensity;
        }

        _screen.set(this.gfx.renderWidth, this.gfx.renderHeight);

        for (let i = 0; i < this._fabricMats.length; i++) {
            const u = this._fabricMats[i].uniforms;
            u.sssStrength.value = S.sssStrength;
            u.weaveDensity.value = 210;
        }
    }

    /** Compile every pipeline behind the loading screen. */
    async warmUp() {
        await whenReady(this.gfx, this.bodyMat, "character body material");
        await whenReady(this.gfx, this.clothMat, "character cloth material");
        await whenReady(this.gfx, this.furMat, "character fur material");
        for (let i = 0; i < this._depthMats.length; i++) {
            const m = this._depthMats[i];
            await whenReady(this.gfx, m, m.name);
        }
        if (this._prepassMats) {
            for (let i = 0; i < this._prepassMats.length; i++) {
                const m = this._prepassMats[i];
                await whenReady(this.gfx, m, m.name);
            }
        }
    }

    dispose() {
        const scene = this.gfx.scene;
        for (const mesh of [this.bodyMesh, this.clothMesh, this.furMesh]) {
            scene.remove(mesh);
            mesh.geometry.dispose();
        }
        this.bodyMat.dispose();
        this.clothMat.dispose();
        this.furMat.dispose();
        for (let i = 0; i < this._depthMats.length; i++) this._depthMats[i].dispose();
        if (this._prepassMats) {
            for (let i = 0; i < this._prepassMats.length; i++) this._prepassMats[i].dispose();
        }
        this.charTex.dispose();
    }
}
