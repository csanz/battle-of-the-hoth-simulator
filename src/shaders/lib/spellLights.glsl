// -----------------------------------------------------------------------------
// snowSpellLights — the light a spell puts into the snow.
//
// A small pool of tight-radius dynamic lights with one behaviour an ordinary
// point light does not give you: a spell lights the snow *from inside* the drift
// it is touching. That is not a diffuse term with a falloff on it — it is the
// same transmission lobe the sun drives, fed by a light that is two metres away
// instead of 150 million kilometres.
//
// So every light here runs the identical `snowSubsurface` the sun runs. Stand a
// glowing ribbon of water on a berm and the near face goes bright while the
// *far* side of the crest glows through, because the light entered the snow and
// came back out. Dropping that
// term and keeping only the diffuse is the difference between a spell that lights
// the snow and a spell that has a decal of light under it.
//
// Contract — a material including this must declare:
//
//   uniform vec4 spellLightPos[4];    (xyz world, w radius in metres)
//   uniform vec4 spellLightCol[4];    (rgb colour, w intensity)
//   uniform float spellLightCount;
//
// and must include <snowShading> first, for `wrapDiffuse` and `snowSubsurface`.
//
// Four lights, not six. Only two spells are ever up at once in practice, and a
// loop the whole snow field pays for on every pixel is not the place to buy
// headroom that nothing spends. The `count` gate skips the loop outright on the
// overwhelming majority of frames, where nothing is cast at all.
// -----------------------------------------------------------------------------

const int SPELL_LIGHT_MAX = 4;

/// Windowed inverse square.
///
/// Pure 1/d² never reaches zero, so a light with any reach at all keeps writing
/// a faint wash across the entire clipmap — which reads as the fog density
/// changing whenever a spell is cast. The window forces it to exactly zero at
/// `radius`, and the fourth power keeps the falloff physical everywhere except
/// the last fifth of the way out.
///
/// The 0.25 in the denominator is a soft core: without it the term runs away at
/// the light's own position, and every spell that puts its emitter on the snow —
/// which is most of them — burns a clipped white disc into the ground.
float spellAttenuation(float dist2, float radius) {
    float t2 = dist2 / max(radius * radius, 1e-4);
    if (t2 >= 1.0) { return 0.0; }
    float win = 1.0 - t2 * t2;
    return win * win / (dist2 + 0.25);
}

/// Snow's full response to the spell lights: wrapped diffuse plus transmission.
///
/// `thickness` and `sssRadius` are the same numbers the sun's term uses, so a
/// compressed trench answers a spell exactly as it answers the sun — tighter,
/// darker, less scattering — without any of that being restated here.
vec3 spellLighting(
    vec3 world,
    vec3 N,
    vec3 V,
    vec3 albedo,
    float thickness,
    float sssStrength,
    float sssRadius,
    vec4 lightPos[4],
    vec4 lightCol[4],
    float count
) {
    vec3 acc = vec3(0.0);
    int n = int(count);

    for (int i = 0; i < SPELL_LIGHT_MAX; i++) {
        if (i >= n) { break; }

        vec4 p = lightPos[i];
        vec3 d = p.xyz - world;
        float dist2 = dot(d, d);
        float att = spellAttenuation(dist2, p.w);
        if (att <= 0.0) { continue; }

        vec3 L = d * inversesqrt(max(dist2, 1e-8));
        vec3 radiance = lightCol[i].rgb * lightCol[i].w * att;

        acc += albedo * (1.0 / PI) * wrapDiffuse(dot(N, L), 0.66) * radiance;
        acc += snowSubsurface(N, L, V, radiance, thickness, sssStrength, sssRadius) * albedo;
    }

    return acc;
}

/// The same lights, for a surface that is not snow — fabric, fur, water, ice.
///
/// Diffuse plus a GGX lobe, with a wrap term that the caller sizes: wool wraps a
/// long way, wet ice barely at all. No transmission, because the materials that
/// want it (the robe's thin under-layer, the water body itself) already have
/// their own and would double-count.
vec3 spellLightingSurface(
    vec3 world,
    vec3 N,
    vec3 V,
    vec3 albedo,
    vec3 f0,
    float roughness,
    float wrap,
    vec4 lightPos[4],
    vec4 lightCol[4],
    float count
) {
    vec3 acc = vec3(0.0);
    int n = int(count);
    float NdotV = clamp(dot(N, V), 1e-4, 1.0);

    for (int i = 0; i < SPELL_LIGHT_MAX; i++) {
        if (i >= n) { break; }

        vec4 p = lightPos[i];
        vec3 d = p.xyz - world;
        float dist2 = dot(d, d);
        float att = spellAttenuation(dist2, p.w);
        if (att <= 0.0) { continue; }

        vec3 L = d * inversesqrt(max(dist2, 1e-8));
        vec3 radiance = lightCol[i].rgb * lightCol[i].w * att;

        acc += albedo * (1.0 / PI) * wrapDiffuse(dot(N, L), wrap) * radiance;

        float NdotL = dot(N, L);
        if (NdotL > 0.0) {
            vec3 H = normalize(V + L);
            float D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), roughness);
            float Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
            vec3 F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), f0);
            acc += radiance * D * Vis * F * NdotL;
        }
    }

    return acc;
}

/// Lights on airborne snow: a billboarded grain has no thickness worth
/// modelling, so this is a single wide-wrap term. Cheap, because the spray is
/// the one system here that can have three thousand alpha-blended instances of
/// itself in flight.
vec3 spellLightingParticle(
    vec3 world,
    vec3 N,
    vec3 albedo,
    vec4 lightPos[4],
    vec4 lightCol[4],
    float count
) {
    vec3 acc = vec3(0.0);
    int n = int(count);

    for (int i = 0; i < SPELL_LIGHT_MAX; i++) {
        if (i >= n) { break; }

        vec4 p = lightPos[i];
        vec3 d = p.xyz - world;
        float dist2 = dot(d, d);
        float att = spellAttenuation(dist2, p.w);
        if (att <= 0.0) { continue; }

        vec3 L = d * inversesqrt(max(dist2, 1e-8));
        acc += albedo * (1.0 / PI) * wrapDiffuse(dot(N, L), 0.8)
             * lightCol[i].rgb * lightCol[i].w * att;
    }

    return acc;
}
