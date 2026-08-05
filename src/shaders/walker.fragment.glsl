// -----------------------------------------------------------------------------
// The walker's armour.
//
// A metal-workflow GGX surface — which for once is the honest model, because
// unlike the snow and the cloth this genuinely is a painted metal shell. What
// matters here is not the BRDF, it is that every term *around* the BRDF is the
// same code the rest of the scene runs: the same cascade selection and PCSS, the
// same spherical-harmonic sky, the same aerial perspective. An object that
// spends most of its life at two hundred metres is almost entirely inscatter by
// the time it reaches the eye, so getting the extinction from the same include
// as the snow it is standing on is what decides whether it belongs in the shot.
//
// Two additions on top of the imported maps.
//
// Snow. The machine is walking across a field in a wind, and a clean hull would
// read as a model dropped into a photograph. Upward-facing surfaces take a rime
// that is masked by the geometric normal and broken up by world-space noise, so
// it lands on the hull top, the leg shoulders and the cannon barrels and not in
// the recesses under them.
//
// Distance roughening. Every specular highlight this shell can produce is
// sub-pixel by a hundred metres, and a sub-pixel highlight is not a highlight —
// it is a flickering white dot that TAA smears into a comet. Roughness rises
// with view distance, which is the cheap and stable version of the filtering
// that should be happening in the normal map's mip chain.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;
precision highp sampler2D;
precision highp sampler2DArray;

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in float vSlot;
in float vViewDist;

uniform sampler2DArray albedoTex;
uniform sampler2DArray ormTex;
uniform sampler2D skyLUT;
uniform sampler2D cascade0;
uniform sampler2D cascade1;
uniform sampler2D cascade2;

uniform vec3 cameraPos;
uniform vec3 sunDir;
uniform vec3 sunRadiance;
uniform vec4 shR[9];

uniform mat4 cascadeMatrices[3];
uniform vec4 cascadeSplits;
uniform vec4 cascadeParams[3];
uniform float shadowTexel;
uniform float shadowSoftness;
uniform float shadowBias;

/// Per material slot: (roughness factor, metallic factor, occlusion strength, tint).
/// Eight, which is more slots than either model uses — the walker has four
/// materials and the speeder five, and one array that covers both is cheaper
/// than a second shader.
uniform vec4 matFactors[8];

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;
uniform float ambientIntensity;
/// How much snow has settled on the hull, 0-1.
uniform float snowCover;

/**
 * Which intermediate to draw instead of the shaded result. 0 shades normally.
 *
 * Here because "the craft is too dark" is not one question, it is six, and
 * arguing about which from the outside is slower than looking. Each mode isolates
 * one input to the lighting so a wrong one is visible rather than inferred: if
 * `albedo` shows a mid-grey textured hull then the maps and the UVs arrived and
 * the problem is downstream; if it shows black, nothing downstream matters.
 */
uniform float debugView;
/**
 * What to multiply a debug value by so the tonemap does not eat it.
 *
 * The chain still runs after this shader — a raw albedo of 0.5 written straight
 * out would come back through an exposure of about a tenth and read as black,
 * which is exactly the thing being tested for. Set to 1/exposure from the JS
 * side, so a debug value of 1.0 lands at roughly white.
 */
uniform float debugGain;

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowShadowLookup>

layout(location = 0) out vec4 fragColor;

/// Karis' analytic split-sum environment BRDF. Same term, and for the same
/// reason, as the one in char.fragment.wgsl: without it a rough surface's
/// grazing reflectance runs to `1 - roughness` and every silhouette pixel
/// returns a fifth of the whole sky.
vec3 envBRDFApprox(vec3 f0, float roughness, float NdotV) {
    vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = vec4(roughness) * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    return f0 * (-1.04 * a004 + r.z) + (1.04 * a004 + r.w);
}

void main() {
    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    int slot = clamp(int(vSlot + 0.5), 0, 7);
    vec4 fac = matFactors[slot];

    // The hull is closed and the winding is trustworthy, but the hatches and the
    // toe plates are single-sided sheets, so the normal is turned to face the
    // viewer exactly as the garments' is.
    vec3 N = normalize(vNormal);
    if (dot(N, V) < 0.0) { N = -N; }
    vec3 geoN = N;

    // ------------------------------------------------------------- maps
    int layer = slot;
    vec3 albedo = texture(albedoTex, vec3(vUV, float(layer))).rgb;
    vec3 orm = texture(ormTex, vec3(vUV, float(layer))).rgb;

    float ao = mix(1.0, orm.r, fac.z);
    float roughness = clamp(orm.g * fac.x, 0.06, 1.0);
    float metal = clamp(orm.b * fac.y, 0.0, 1.0);
    albedo *= fac.w;

    // ------------------------------------------------------------- settled snow
    //
    // Masked on the *geometric* normal so it follows the plating rather than the
    // texture, and broken by two octaves of world-space noise so the edge of a
    // drift on the hull is ragged. Metres, not UV — a shared world scale is what
    // keeps the pattern consistent across three separate texture charts.
    if (snowCover > 0.001) {
        float n1 = noise2(world.xz * 0.6 + world.y * 0.35);
        float n2 = noise2(world.xz * 2.7 - world.y * 1.1);
        float broken = 0.5 + 0.34 * n1 + 0.16 * n2;
        float facing = smoothstep(0.18, 0.78, geoN.y);
        float snow = clamp(facing * snowCover * 1.6 - (1.0 - broken) * 0.9, 0.0, 1.0);
        // Wind-packed snow, not fresh: the demo's field albedo, a shade duller
        // for sitting on a warm machine.
        albedo = mix(albedo, vec3(0.74, 0.775, 0.84), snow);
        roughness = mix(roughness, 0.88, snow);
        metal = metal * (1.0 - snow);
        ao = mix(ao, 1.0, snow * 0.6);
    }

    // Specular anti-aliasing by distance. 0.35 of a roughness unit by 250 m,
    // which is where the whole machine is a few hundred pixels tall and no
    // highlight on it is resolvable anyway.
    roughness = clamp(
        roughness + 0.35 * smoothstep(40.0, 250.0, vViewDist), 0.06, 1.0
    );

    vec3 f0 = mix(vec3(0.04), albedo, metal);
    vec3 diffuseAlbedo = albedo * (1.0 - metal);

    // ------------------------------------------------------------- lighting
    float NdotL = dot(N, L);
    float NdotV = clamp(dot(N, V), 1e-4, 1.0);
    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;

    float shadow = 1.0;
    if (NdotL > -0.15) {
        shadow = sunShadow(world, geoN, vViewDist, noiseRot);
    }

    vec3 sun = sunRadiance;
    const float INV_PI = 0.31830988618;

    // A whiter sun for this surface only, without touching the scene's.
    //
    // At thirteen degrees the beam has lost most of its blue to air mass — that
    // is `sunRadiance` around (16.9, 12.9, 6.5), and it is the whole warm-light /
    // cool-shadow split the snow is built on. Correct for the field, and too much
    // for a hull that is meant to read as the grey aircraft its maps are painted
    // as: a white surface under that beam comes back cream.
    //
    // So the cast is pulled toward the beam's own luminance, which changes the
    // colour without touching how much light there is. Carried in
    // `matFactors[7].y`, and defined so that 0 is *unchanged* rather than
    // neutral — the walker never writes that slot, so it keeps the warm sun it
    // is supposed to have and this stays the speeder's alone.
    //
    // Only the beam is balanced. The sky ambient keeps its own colour, because
    // the cool bounce is what stops the shaded flank going muddy, and the aerial
    // perspective below keeps the unbalanced `sun`, because haze belongs to the
    // scene rather than to the object inside it.
    float sunLuma = dot(sun, vec3(0.2126, 0.7152, 0.0722));
    vec3 sunLit = mix(sun, vec3(sunLuma), clamp(matFactors[7].y, 0.0, 1.0));

    vec3 color = diffuseAlbedo * INV_PI * sunLit * max(NdotL, 0.0) * shadow;

    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float NdotH = clamp(dot(N, H), 0.0, 1.0);
        float VdotH = clamp(dot(V, H), 0.0, 1.0);
        float D = distributionGGX(NdotH, roughness);
        float Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        vec3 F = fresnelSchlick(VdotH, f0);
        color += sunLit * D * Vis * F * NdotL * shadow;
    }

    // --- ambient ------------------------------------------------------------
    vec3 irradiance = shIrradiance(N, shR) * ambientIntensity;
    // The same snow bounce the character gets, and it matters more here: nine
    // hundred square metres of downward-facing belly and leg underside see
    // nothing but an 85%-albedo field, and without it they read as holes.
    float up = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3(0.0, 1.0, 0.0), shR)
                * ambientIntensity * 0.45 * up;
    color += diffuseAlbedo * INV_PI * irradiance * ao;

    // Ambient specular from the sky at a roughness-selected mip.
    vec3 R = reflect(-V, N);
    float mip = sqrt(roughness) * 6.0;
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(R), mip).rgb;
    color += skyRefl * envBRDFApprox(f0, roughness, NdotV) * ambientIntensity * ao;

    // The flat fill. After the ambient specular on purpose: it lifts the diffuse
    // only, so turning it up brightens the hull instead of polishing it.
    //
    // Carried in `matFactors[7].x` rather than in a uniform of its own.
    //
    // The array is eight slots because one of them has to cover both models, and
    // neither model fills it: the walker declares four materials and the speeder
    // five, so slot 7 is spare in both. The walker's factors are a zeroed
    // Float32Array it only writes its own slots into, so it reads exactly 0.0
    // here and this term vanishes for it — no branch, no define, and nothing for
    // me to get wrong on a model that is already right.
    //
    // What it is: a flat fill that ignores the normal and the shadow both. That
    // is the point rather than a shortcut. At a thirteen-degree sun most of this
    // hull's facets have a cosine near zero, so every term that respects the
    // cosine has nothing to lift, and the craft is the one opaque thing in the
    // scene close enough to the camera to receive none of the aerial haze that is
    // doing most of the work on the walkers.
    color += diffuseAlbedo * INV_PI * sunLit * matFactors[7].x;

    // --- spell light --------------------------------------------------------
    if (spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, diffuseAlbedo, f0, roughness, 0.15,
            spellLightPos, spellLightCol, spellLightCount
        ) * ao;
    }

    // ------------------------------------------------------- aerial perspective
    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    // ------------------------------------------------------------------- debug
    // Substituted at the end rather than returned early from the middle, exactly
    // as the source: none of the modes read `color`; it is written last only
    // because that is the one place a fragment shader has a single exit.
    int dv = int(debugView + 0.5);
    if (dv > 0) {
        vec3 d = vec3(0.0);
        if (dv == 1) {
            // What the texture array actually returned, times the tint. A light
            // grey hull here means the maps arrived.
            d = albedo;
        } else if (dv == 2) {
            // Shading normal, packed to 0-1. Flat colour over a facet is correct
            // for this model; wild variation or a hard seam is not.
            d = N * 0.5 + 0.5;
        } else if (dv == 3) {
            // Material slot, 0-4 over the greyscale. Five flat bands, one per
            // material; anything else means `aux` is not arriving.
            d = vec3(float(slot) * 0.25);
        } else if (dv == 4) {
            d = vec3(ao);
        } else if (dv == 5) {
            d = vec3(roughness);
        } else if (dv == 6) {
            // The sun's cosine alone. This is the term that is near zero over
            // most of the hull at a thirteen-degree sun.
            d = vec3(max(NdotL, 0.0));
        } else if (dv == 7) {
            d = vec3(shadow);
        }
        color = d * debugGain;
    }

    fragColor = vec4(color, 1.0);
}
