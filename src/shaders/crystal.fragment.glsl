// -----------------------------------------------------------------------------
// Crystallise — ice shading.
//
// What sells this spell is not the geometry. It is that a facet of clear ice
// does three different things depending on where you stand relative to it, all at
// once and all sharply divided by the facet edges:
//
//   near grazing   almost a mirror. Fresnel at 0.02 base reflectance still
//                  returns nearly everything at 80 degrees, and against this
//                  scene's low warm sun that is a hard bright edge.
//   head on        you see through it, bent, and tinted by the path — which on a
//                  30 cm crystal is a real blue, because ice absorbs red about
//                  fifteen times faster than blue.
//   backlit        it glows. Ice scatters internally at every inclusion and
//                  bubble, and a crystal with the sun behind it lights up along
//                  its whole length rather than going to silhouette.
//
// **Blended, but depth-writing.** The usual pair of options is opaque (correct
// depth, no transparency) or alpha-blended with depth write off (transparency,
// no depth). Neither is right for a cluster of forty overlapping prisms: the
// first gives blue spikes, and the second gives a grey smear where every prism
// blends over every other one in index order.
//
// Writing depth while blending gives the third thing. The first surface at a
// pixel blends over whatever the terrain and the character already put there —
// so you genuinely see the snow through the ice — and every surface *behind* it
// is depth-rejected, so no crystal is ever blended over another one. The result
// is order-dependent in principle and completely stable in practice, because the
// only thing the order decides is which face of a solid you see, and any of them
// is a correct answer.
//
// The normal comes from the derivatives of the world position, so every facet is
// exactly flat and the edges between them are exactly hard. That hard edge is
// what makes the material read: adjacent facets of one prism return wildly
// different amounts of sky, and that facet-to-facet jump *is* the look of ice.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

in vec3 vWorld;
in vec3 vBase;
in float vHeight01;
in float vSeed;
in float vGrowth;
in float vViewDist;

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

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;
uniform float ambientIntensity;
uniform float sssStrength;
uniform float glintIntensity;
uniform float glintGrazing;

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowShadowLookup>

/// Absorption per metre. Real ice is roughly (1.5, 0.35, 0.10) in the visible;
/// this is a little stronger so a hand-sized crystal shows the colour a
/// glacier-sized one really would — but not so strong that the whole formation
/// saturates to one flat blue, which is what 4.2 in red did.
const vec3 ICE_ABSORB = vec3(2.35, 0.60, 0.24);

layout(location = 0) out vec4 fragColor;

void main() {
    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    // Flat facet normal, from the geometry itself.
    vec3 dx = dFdx(world);
    vec3 dy = dFdy(world);
    vec3 N = normalize(cross(dx, dy));
    if (dot(N, V) < 0.0) { N = -N; }
    vec3 geoN = N;

    float NdotV = clamp(dot(N, V), 1e-4, 1.0);
    float NdotL = dot(N, L);
    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;
    float shadow = sunShadow(world, geoN, vViewDist, noiseRot);

    vec3 sun = sunRadiance;
    const float INV_PI = 0.31830988618;

    // ---- frost --------------------------------------------------------------
    // Where the crystal comes out of the drift it is not clear — it is packed
    // with the snow it grew through. That gradient is what attaches it to the
    // ground; without it a crystal looks placed on the surface rather than grown
    // out of it, which is the single failure this effect cannot afford.
    // Confined to the bottom fifth: the frost is there to attach the crystal to
    // the drift, and any more of it than that is a white prism with a clear tip
    // rather than an ice prism standing in snow.
    float grain = noise2(world.xz * 34.0 + vSeed * 19.0) * 0.5 + 0.5;
    float frost = clamp(
        (1.0 - smoothstep(0.01, 0.22, vHeight01)) * (0.45 + 0.6 * grain),
        0.0, 1.0
    );

    // Optical path through the crystal: long across a facet seen edge-on, short
    // through one seen face-on, and longer near the thick base than at the tip.
    // The constant term carries the colour through the middle of the prism; a
    // path that only opens up at grazing puts all of the blue on the silhouette,
    // where the Fresnel reflection then replaces it with sky.
    float path = clamp(
        (0.16 + 0.42 * (1.0 - vHeight01)) * (0.7 + 2.0 * (1.0 - NdotV)),
        0.02, 1.4
    );
    vec3 transmit = exp(-ICE_ABSORB * path);

    // ---- refraction, with dispersion ---------------------------------------
    // Same construction as the spell water: the sky LUT holds both the sky and
    // the solved snow bounce, so one lookup along the refracted ray is a
    // physically-derived estimate of what is behind the crystal in any direction.
    vec3 mirror = reflect(-V, N);
    vec3 rr = refract(-V, N, 1.0 / 1.3050);
    vec3 rg = refract(-V, N, 1.0 / 1.3090);
    vec3 rb = refract(-V, N, 1.0 / 1.3170);
    vec3 dr = dot(rr, rr) > 0.5 ? rr : mirror;
    vec3 dg = dot(rg, rg) > 0.5 ? rg : mirror;
    vec3 db = dot(rb, rb) > 0.5 ? rb : mirror;

    vec3 behind = vec3(
        textureLod(skyLUT, dirToLatLong(dr), 0.9).r,
        textureLod(skyLUT, dirToLatLong(dg), 0.9).g,
        textureLod(skyLUT, dirToLatLong(db), 0.9).b
    );
    vec3 color = behind * transmit;

    // ---- internal transport -------------------------------------------------
    // A crystal with the sun behind it lights along its whole length: the light
    // enters the far facet, scatters off inclusions,
    // and leaves toward the eye, tinted by everything it did not survive.
    // The 1/PI belongs in front of a scattering lobe; see the same note in the
    // water material, where leaving it out clipped the whole body to white.
    float through = backScatter(N, L, V, 0.42, 2.2, 1.0);
    vec3 deepTint = mix(vec3(0.42, 0.74, 1.0), vec3(0.86, 0.95, 1.0), exp(-path * 2.5));
    color += sun * INV_PI * deepTint * through * sssStrength * 1.6
           * mix(0.25, 1.0, shadow);

    // Sky through the body, which is what keeps a crystal standing in shadow
    // alive rather than black.
    color += shIrradiance(N, shR) * ambientIntensity * INV_PI
           * deepTint * 0.9;

    // ---- frosted skin -------------------------------------------------------
    if (frost > 0.002) {
        vec3 fa = vec3(0.88, 0.915, 0.965);
        vec3 fc = fa * INV_PI * sun * wrapDiffuse(NdotL, 0.62) * shadow;
        fc += fa * INV_PI * shIrradiance(N, shR) * ambientIntensity;
        fc += snowSubsurface(N, L, V, sun, 0.4, sssStrength, 1.3)
            * fa * mix(0.4, 1.0, shadow);
        color = mix(color, fc, frost * 0.9);
    }

    // ---- surface ------------------------------------------------------------
    float rough = mix(0.045, 0.42, frost);
    vec3 F = fresnelSchlick(NdotV, vec3(0.021));
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(mirror), rough * 6.0).rgb;
    color = mix(color, skyRefl, F * (1.0 - frost * 0.75));

    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        float Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        vec3 Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3(0.021));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    if (glintIntensity > 0.001) {
        float g = snowGlints(
            world.xz, N, V, L, max(length(dx.xz) + length(dy.xz), 1e-4),
            glintIntensity * (0.4 + 1.2 * frost), glintGrazing
        );
        color += sun * g * shadow * 0.6;
    }

    if (spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, mix(vec3(0.3, 0.6, 0.85), vec3(0.88), frost),
            vec3(0.021), rough, 0.5,
            spellLightPos, spellLightCol, spellLightCount
        );
    }

    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    // ---- opacity ------------------------------------------------------------
    //
    // Three things drive it, and they are the three things that decide how much
    // of a real crystal you can see through:
    //
    //   path      a thin tip is nearly clear; the thick base is not.
    //   grazing   a facet seen edge-on presents a long optical path and a strong
    //             reflection, and both make it opaque.
    //   frost     where the prism is packed with the snow it grew through, it is
    //             not transparent at all.
    //
    // The floor is high enough that a crystal never disappears against the field
    // behind it.
    float alpha = clamp(
        0.46 + 0.34 * (1.0 - exp(-path * 2.2)) + 0.26 * (1.0 - NdotV) + frost * 0.55,
        0.0, 1.0
    );
    fragColor = vec4(color, alpha);
}
