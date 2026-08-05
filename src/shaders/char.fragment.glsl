// -----------------------------------------------------------------------------
// The fabric material — shared by the skinned body and the simulated garments.
//
// A plain PBR dielectric is the wrong model for cloth and looks it. Three terms
// carry the difference:
//
//   sheen        A retroreflective lobe from the fibres standing proud of the
//                surface. It is why wool has a bright *rim* rather than a
//                bright *highlight*, and it is the single term that stops this
//                reading as painted plastic. Charlie distribution, which is an
//                inverted Gaussian: energy piles up at grazing angles instead
//                of around the mirror direction.
//   anisotropy   The weave has a direction. A GGX lobe stretched along the warp
//                gives the soft directional streak real woven cloth has, and it
//                is what makes the mantle's shoulder read as a fabric plane and
//                not a shaded cylinder.
//   transmission Thin fabric over a lit edge glows. Same back-scatter term the
//                snow uses, which is not a coincidence — it is the same physics
//                at a different mean free path.
//
// On top of that a procedural weave supplies a normal and a cavity at a scale
// far below the geometry, faded out by pixel footprint so it never aliases.
//
// Everything downstream of the BRDF — cascade selection, PCSS, aerial
// perspective — is the identical code the snow runs, from shared includes. The
// character has to sit in the same light as the field or it will look pasted on
// no matter how good the fabric is.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

in vec3 vWorld;
in vec3 vNormal;
in vec2 vUV;
in vec2 vAux;
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

/// Per material slot: rgb = albedo, a = base roughness.
uniform vec4 matAlbedo[8];
/// Per material slot: (sheen, anisotropy, transmission, weave depth).
uniform vec4 matParams[8];

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;
uniform float ambientIntensity;
uniform float sssStrength;
/// Weave threads per metre. UVs arrive in metres of surface, so this is the
/// only place the physical scale of the cloth is decided.
uniform float weaveDensity;
uniform vec2 screenSize;

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowShadowLookup>

layout(location = 0) out vec4 fragColor;

#define INV_PI 0.31830988618

/// Charlie sheen distribution. `roughness` here is the fibre roughness, and it
/// wants to be high — 0.3 or below turns the rim into a hard line.
float dCharlie(float NdotH, float roughness) {
    float invR = 1.0 / max(0.05, roughness);
    float cos2h = NdotH * NdotH;
    float sin2h = max(1.0 - cos2h, 1e-4);
    return (2.0 + invR) * pow(sin2h, invR * 0.5) / (2.0 * PI);
}

/// Ashikhmin's visibility term — cheap, and the only one that keeps sheen
/// energy sane at grazing angles where the whole lobe lives.
float vAshikhmin(float NdotV, float NdotL) {
    return 1.0 / max(1e-4, 4.0 * (NdotL + NdotV - NdotL * NdotV));
}

/// Anisotropic GGX, Burley's parameterisation.
float dGGXAniso(float TdotH, float BdotH, float NdotH, float ax, float ay) {
    float a2 = ax * ay;
    vec3 d = vec3(ay * TdotH, ax * BdotH, a2 * NdotH);
    float d2 = dot(d, d);
    if (d2 < 1e-9) { return 0.0; }
    float b2 = a2 / d2;
    return a2 * b2 * b2 / PI;
}

/// Procedural plain weave: a tangent-space normal in xy and a cavity in z.
///
/// Warp and weft alternate which one is on top, and the one on top gets the
/// stronger ridge. That alternation is the whole read — two crossed sine
/// ridges without it look like a grid, not a textile.
vec3 weave(vec2 uv) {
    vec2 p = uv * 6.28318530718;
    float warp = sin(p.x);
    float weft = sin(p.y);
    float over = smoothstep(-0.35, 0.35, warp * weft);
    float nx = cos(p.x) * mix(0.30, 1.0, over);
    float ny = cos(p.y) * mix(1.0, 0.30, over);
    // Cavity is deepest where neither thread is at its crown.
    float cav = 0.55 + 0.45 * max(abs(warp), abs(weft));
    return vec3(nx, ny, cav);
}

/// Karis' analytic split-sum environment BRDF.
///
/// Not an optimisation — a correction. Multiplying prefiltered sky radiance by
/// `fresnelSchlickRough` alone overestimates badly at grazing angles on a rough
/// surface: the roughness clamp makes the reflectance run to `1 - roughness`
/// there, which for wool is 0.2 of the *whole sky* on every silhouette pixel.
/// The result was a navy robe rendering as pale grey whenever the camera looked
/// across it, with a dark albedo that had nothing to do with the outcome.
vec3 envBRDFApprox(vec3 f0, float roughness, float NdotV) {
    vec4 c0 = vec4(-1.0, -0.0275, -0.572, 0.022);
    vec4 c1 = vec4(1.0, 0.0425, 1.04, -0.04);
    vec4 r = vec4(roughness) * c0 + c1;
    float a004 = min(r.x * r.x, exp2(-9.28 * NdotV)) * r.x + r.y;
    return f0 * (-1.04 * a004 + r.z) + (1.04 * a004 + r.w);
}

/// Screen-space cotangent frame. Works identically for the skinned body and the
/// Catmull-Rom garments, neither of which carries an authored tangent.
mat3 cotangentFrame(vec3 N, vec3 dp1, vec3 dp2, vec2 duv1, vec2 duv2) {
    vec3 dp2perp = cross(dp2, N);
    vec3 dp1perp = cross(N, dp1);
    vec3 T = dp2perp * duv1.x + dp1perp * duv2.x;
    vec3 Bv = dp2perp * duv1.y + dp1perp * duv2.y;
    float invmax = inversesqrt(max(max(dot(T, T), dot(Bv, Bv)), 1e-12));
    return mat3(T * invmax, Bv * invmax, N);
}

void main() {
    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    // Garments are open sheets and the hood is a shell, so the camera sees both
    // sides of nearly everything. Rather than depend on winding — which for
    // procedurally lofted geometry is one sign error away from inside-out — the
    // normal is simply turned to face the viewer. For a surface this thin that
    // is also physically the right answer.
    vec3 N = normalize(vNormal);
    bool twoSided = dot(N, V) < 0.0;
    if (twoSided) { N = -N; }
    vec3 geoN = N;

    int slot = clamp(int(vAux.x + 0.5), 0, 7);
    vec4 alb4 = matAlbedo[slot];
    vec4 par = matParams[slot];
    vec3 albedo = alb4.rgb;
    float roughness = alb4.a;
    float sheenAmt = par.x;
    float aniso = par.y;
    float transmit = par.z;
    float weaveDepth = par.w;

    // ------------------------------------------------------------ weave detail
    vec2 wuv = vUV * weaveDensity;
    vec3 dp1 = dFdx(world);
    vec3 dp2 = dFdy(world);
    vec2 duv1 = dFdx(wuv);
    vec2 duv2 = dFdy(wuv);
    mat3 TBN = cotangentFrame(N, dp1, dp2, duv1, duv2);

    // Fade the weave out once a thread is under a pixel, or it aliases into a
    // crawling moire — the same footprint logic the snow's detail layers use.
    // At two hundred threads a metre this means the weave only exists in the
    // near field, which is exactly where a real one is visible.
    float uvFoot = max(length(duv1), length(duv2));
    float weaveFade = 1.0 - smoothstep(0.10, 0.45, uvFoot);
    float cavity = 1.0;
    if (weaveDepth > 0.001 && weaveFade > 0.001) {
        vec3 w = weave(wuv);
        N = normalize(N + (TBN[0] * w.x + TBN[1] * w.y) * weaveDepth * weaveFade * 0.5);
        cavity = mix(1.0, w.z, weaveFade * 0.8);
    }

    // Slub: real yarn is not uniform, and a little variation in the base tone
    // does more for "this is a woven thing" than another specular term. Runs at
    // centimetre scale, an order of magnitude coarser than the weave, so unlike
    // the weave it survives to the distance the figure is actually seen at.
    float slub = noise2(vUV * vec2(9.0, 26.0)) * 0.5 + 0.5;
    albedo *= 0.90 + 0.20 * slub;
    roughness = clamp(roughness * (0.94 + 0.12 * slub), 0.05, 1.0);

    // Baked at the vertex, times the weave cavity. No screen-space occlusion:
    // it is a two-metre silhouette against forty metres of snow, and the pass
    // does not pay for itself on this content.
    float ao = vAux.y * cavity;

    // ------------------------------------------------------------- lighting
    float NdotL = dot(N, L);
    float NdotV = clamp(dot(N, V), 1e-4, 1.0);
    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;

    float shadow = 1.0;
    if (NdotL > -0.4) {
        shadow = sunShadow(world, geoN, vViewDist, noiseRot);
    }

    vec3 sun = sunRadiance;

    // --- diffuse -----------------------------------------------------------
    // Wrapped a little: fabric is not opaque at fibre scale, and the terminator
    // on a sleeve is genuinely soft.
    float diff = wrapDiffuse(NdotL, 0.18);
    vec3 color = albedo * INV_PI * sun * diff * shadow;

    // --- transmission through thin cloth -----------------------------------
    if (transmit > 0.001) {
        float back = backScatter(N, L, V, 0.4, 4.0, 1.0);
        color += sun * albedo * back * transmit * sssStrength
               * mix(0.35, 1.0, shadow);
    }

    // --- specular: anisotropic weave ---------------------------------------
    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float NdotH = clamp(dot(N, H), 0.0, 1.0);
        float VdotH = clamp(dot(V, H), 0.0, 1.0);

        float ar = max(0.04, roughness * roughness);
        float ax = ar * (1.0 + aniso);
        float ay = ar / (1.0 + aniso);
        float D = dGGXAniso(dot(TBN[0], H), dot(TBN[1], H), NdotH, ax, ay);
        float Vis = visSmithGGXCorrelated(NdotV, max(NdotL, 1e-4), roughness);
        vec3 F = fresnelSchlick(VdotH, vec3(0.035));
        color += sun * D * Vis * F * NdotL * shadow;

        // --- sheen ---------------------------------------------------------
        // Tinted toward the albedo but desaturated: fibre scatter is closer to
        // white than the bulk colour, which is why a navy robe rims pale blue.
        //
        // Two corrections, both learned by looking at the render rather than at
        // the paper. First, the Ashikhmin visibility term runs away when both
        // cosines are small, so the lobe is clamped. Second — and this is the
        // one that mattered — Charlie is an *inverted* distribution: it is near
        // its peak everywhere except close to the mirror direction, so applied
        // flat it is not a rim, it is a uniform veil over the entire garment.
        // At full strength it lifted a navy robe to the same value as the snow
        // behind it and erased the silhouette completely.
        //
        // The grazing gate puts the energy back where fibre scatter actually
        // shows: the edge, where the line of sight passes along the pile rather
        // than into it.
        vec3 sheenTint = mix(vec3(1.0), normalize(albedo + 1e-4), 0.35);
        float ds = dCharlie(NdotH, 0.42);
        float graze = 0.16 + 0.84 * pow(1.0 - NdotV, 2.0);
        float sheenLobe = min(ds * vAshikhmin(NdotV, max(NdotL, 1e-4)) * NdotL, 0.25);
        color += sun * sheenTint * sheenLobe * graze * sheenAmt * shadow;
    }

    // --- ambient ------------------------------------------------------------
    vec3 irradiance = shIrradiance(N, shR) * ambientIntensity;
    // Bounce off the snow. A figure standing on an 85%-albedo field is lit from
    // below almost as much as from above, and leaving it out is what makes
    // characters composited into snow scenes look cut out.
    float up = clamp(-N.y * 0.5 + 0.5, 0.0, 1.0);
    irradiance += shIrradiance(vec3(0.0, 1.0, 0.0), shR)
                * ambientIntensity * 0.40 * up;

    color += albedo * INV_PI * irradiance * ao;

    // Ambient sheen: the sky wrapping around a fuzzy silhouette. Cheap, and it
    // is most of what reads as "fuzz" when the sun is behind the figure. Kept
    // deliberately small — this term is albedo-independent, so any generosity
    // here erases the difference between a dark robe and a light one.
    float rim = pow(1.0 - NdotV, 4.0);
    vec3 skyAmb = shIrradiance(N, shR) * ambientIntensity * INV_PI;
    color += skyAmb * rim * sheenAmt * 0.55 * ao;

    // Ambient specular from the sky at a roughness-selected mip.
    vec3 R = reflect(-V, N);
    float mip = sqrt(roughness) * 6.0;
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(R), mip).rgb;
    color += skyRefl * envBRDFApprox(vec3(0.035), roughness, NdotV)
           * ambientIntensity * ao;

    // --- spell light --------------------------------------------------------
    // The caster is standing inside the thing they are casting, so this is the
    // one material where the spell lights are almost always the *dominant*
    // source: a 13-degree sun is behind the figure for most of the framing this
    // demo uses, and a robe lit only by sky ambient is a silhouette. A ribbon of
    // water held at arm's length is what puts light back on the front of it.
    //
    // Wrapped harder than the sun's diffuse, because at half a metre the light
    // is a broad source rather than a point, and thin cloth over a bright
    // emitter genuinely does carry light around the fold.
    if (spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, albedo, vec3(0.035), roughness, 0.35,
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

    fragColor = vec4(color, 1.0);
}
