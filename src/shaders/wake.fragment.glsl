// -----------------------------------------------------------------------------
// The snow-surf wake — shading.
//
// This is snow that has just left the ground, and it is a different material from
// the field it came out of even though it is the same substance. Freshly broken
// snow is looser, brighter and rougher than the pack, and — the part that matters
// most here — it is *thin*. A wave crest is centimetres of powder held up in the
// air, so it transmits: with the sun low and behind it, the lip should light up
// from the inside rather than going to silhouette.
//
// So the subsurface term is driven off the section parameter rather than off a
// constant: thick and opaque at the base where the wall meets the trench, thin
// and glowing at the lip. That single gradient is most of what separates this
// from a white ribbon.
//
// Everything else — the cascades, the SH ambient, the glints, the aerial
// perspective — is the same code the snow field runs, out of the same includes.
// The wake has to sit in the frame as part of the same world.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;

in vec3 vWorld;
in vec3 vNormal;
in float vQ;
in float vAlong;
in float vAge;
in float vAmp;
in float vCurl;
in float vViewDist;

layout(location = 0) out vec4 fragColor;

uniform highp sampler2D skyLUT;
uniform highp sampler2D cascade0;
uniform highp sampler2D cascade1;
uniform highp sampler2D cascade2;

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
uniform float wakeTime;
/// Per-term diagnostic. See the switch at the bottom; `SNOWFLOW.wake.debug`.
uniform float wakeDebug;

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>
#include<snowWake>
#include<snowShadowLookup>

void main() {
    float q = vQ;

    if (wakeEroded(vAlong, q, vAge, wakeTime)) { discard; }

    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    // The wake is an open sheet with a curl in it, so both faces are visible and
    // winding says nothing useful. Turning the normal toward the eye is right for
    // a sheet of powder a few centimetres thick — light gets through it either
    // way, and the alternative is a black inside face on the barrel.
    vec3 Ng = normalize(vNormal);
    float facing = dot(Ng, V) >= 0.0 ? 1.0 : -1.0;
    vec3 N = Ng * facing;
    vec3 geoN = N;

    // `Ng` is built by the sweep pointing to the *concave* side, so this is true
    // exactly when the eye is inside the curl. That is the one thing the shading
    // needs to know that the normal alone cannot say: the inside of a barrel of
    // snow is a cave, and it has to go dark and blue or the whole wall reads as a
    // cut-out lit from nowhere.
    bool inside = facing > 0.0;

    // Broken snow grain. Cheap, and without it the wall is the one surface in
    // frame with no detail on it, which is instantly legible next to a snow
    // field carrying three scales of it.
    vec3 ddxW = dFdx(world);
    vec3 ddyW = dFdy(world);
    float footprint = max(length(vec2(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    // Two oblique projections of the world position rather than the XZ plane.
    // The wave face is close to vertical over most of its height, so a planar XZ
    // lookup barely moves across it and the grain comes out as horizontal
    // banding — the one pattern that reads as a rendering error rather than as
    // snow. Slicing 2D noise along two non-axis-aligned directions gives a field
    // that varies at the same rate whichever way the surface is facing, for the
    // cost of two dot products.
    vec2 gp = vec2(
        dot(world, vec3(0.91, 0.23, -0.35)),
        dot(world, vec3(0.28, 0.84, 0.46))
    );
    // Two scales, each faded out by pixel footprint, mirroring what the snow
    // material does over three. One scale alone gives the wall a single
    // characteristic grain size, which is exactly how it reads as a different
    // substance from the field it was thrown out of.
    vec3 up = abs(N.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);

    float fineFade = 1.0 - smoothstep(0.012, 0.09, footprint);
    if (fineFade > 0.002) {
        vec3 g = noised(gp * 26.0);
        N = normalize(N + (T * g.y + B * g.z) * 0.15 * fineFade);
    }
    float coarseFade = 1.0 - smoothstep(0.09, 0.55, footprint);
    if (coarseFade > 0.002) {
        vec3 g = noised(gp * 5.5);
        N = normalize(N + (T * g.y + B * g.z) * 0.10 * coarseFade);
    }

    // ------------------------------------------------------------- material
    // Freshly displaced snow: brighter and rougher than the pack it came out of.
    vec3 albedo = vec3(0.895, 0.920, 0.965);
    float roughness = 0.80;
    vec3 f0 = vec3(0.026);

    // Thin at the lip, deep at the base. This is the gradient the whole read
    // rests on — see the note at the top.
    //
    // The lip end does not go to zero. A wall of thrown powder is ten to thirty
    // centimetres through, not tissue: at 0.04 the transmission lobe runs at
    // near full amplitude with a nearly white tint, and since it is multiplied by
    // a 13-degree sun whose beam is roughly 17:13:6, the result was several times
    // brighter than the direct diffuse and unmistakably *warm*. On white snow
    // that reads as dirt — the outer face of the wall came out brown.
    float thickness = mix(0.92, 0.32, smoothstep(0.15, 0.95, q));

    // ------------------------------------------------------------- lighting
    float NdotL = dot(N, L);
    float NdotV = clamp(dot(N, V), 1e-4, 1.0);
    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;
    float shadow = sunShadow(world, geoN, vViewDist, noiseRot);

    vec3 sun = sunRadiance;
    const float INV_PI = 0.31830988618;

    // ---- occlusion ---------------------------------------------------------
    // Analytic, because the shadow map cannot supply it. The wake is a
    // zero-thickness sheet, so a point on it sits at exactly the depth its own
    // caster wrote and can never self-occlude; and under a 13-degree sun the
    // lip's cast shadow lands metres away rather than on the face beneath it.
    // Every bit of the "inside the curl is dark" read therefore has to come from
    // here, and its absence is what made the first version look like a white
    // cut-out pasted over the snow.
    //
    //   base      the foot of the wall stands in the trench it came out of
    //   barrel    the concave side is enclosed by the overhang above it, and the
    //             harder the curl the less sky it sees
    // Only the inside of the curl, and nothing else.
    //
    // Every open face has to render at *exactly* the brightness of the snow it
    // was thrown out of, and the reason is the tonemapper rather than the
    // lighting. AgX desaturates hard as it approaches its shoulder, which is what
    // makes sunlit snow read as white despite being lit by a beam that is roughly
    // 17:13:6. Half a stop below that, the curve stops rolling the saturation off
    // and the same warm beam on the same white albedo comes back as tan. So a
    // broad, gentle darkening of the wall — which is what an ambient-occlusion
    // term looks like, and what two earlier passes here applied — does not read
    // as "slightly shaded snow". It reads as brown snow, next to white snow.
    //
    // The wall is therefore left at full brightness everywhere it is genuinely
    // open, and darkened only where it is genuinely enclosed.
    float barrel = inside ? smoothstep(0.05, 0.75, q) * (0.45 + 0.55 * vCurl) : 0.0;
    float occ = mix(1.0, 0.30, barrel);

    float diff = wrapDiffuse(NdotL, 0.66);
    vec3 directTerm = albedo * INV_PI * sun * diff * shadow;
    vec3 color = directTerm;

    // Transmission, coupled much harder to the shadow term than the snow field's
    // is. On the ground a shadowed drift is still fed by light scattering in from
    // the lit snow a few centimetres away; a wall of powder standing in its own
    // shadow with air on both sides has no such neighbour, and leaving it at half
    // strength was most of why the shadowed side stayed white.
    // Strength well under the terrain's, and a wider scattering radius so the
    // tint reaches the blue end at a lower thickness. Together those keep the
    // backlit glow reading as light coming *through snow* rather than as the sun
    // reflecting off something tan.
    vec3 sss = snowSubsurface(N, L, V, sun, thickness, sssStrength * 0.45, 1.5);
    vec3 sssTerm = sss * albedo * mix(0.18, 1.0, shadow);
    color += sssTerm;

    vec3 specTerm = vec3(0.0);
    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), roughness);
        float Vis = visSmithGGXCorrelated(NdotV, NdotL, roughness);
        vec3 F = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), f0);
        specTerm = sun * D * Vis * F * NdotL * shadow;
    }
    color += specTerm;

    // Ambient, plus the bounce off the enormous white surface underneath it.
    vec3 irradiance = shIrradiance(N, shR) * ambientIntensity;
    irradiance += shIrradiance(vec3(0.0, 1.0, 0.0), shR)
                * ambientIntensity * 0.30 * clamp(-N.y * 0.5 + 0.5, 0.0, 1.0) * albedo;
    vec3 ambientTerm = albedo * INV_PI * irradiance;
    color += ambientTerm;

    vec3 R = reflect(-V, N);
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(R), sqrt(roughness) * 6.0).rgb;
    vec3 skyTerm = skyRefl * fresnelSchlickRough(NdotV, f0, roughness) * ambientIntensity;
    color += skyTerm;

    // Spell light, above the occlusion so the barrel darkens it along with
    // everything else — a spell cast into the inside of a curl should light the
    // cave, not shine through the wall of it.
    if (spellLightCount > 0.5) {
        color += spellLighting(
            world, N, V, albedo, thickness,
            sssStrength * 0.45, 1.5,
            spellLightPos, spellLightCol, spellLightCount
        );
    }

    // ---- occlusion, applied last and to everything ------------------------
    //
    // Two rules, both learned the hard way, and both about hue rather than
    // brightness:
    //
    //  1. It scales the *finished radiance*, not the ambient. The textbook AO
    //     scales ambient and leaves direct light alone, but in this scene the
    //     ambient is where all the blue lives — the sky is strongly blue-shifted
    //     by construction and the sun is a 13-degree beam at roughly 17:13:6.
    //     Attenuating one and not the other does not darken a surface, it
    //     re-weights a warm source against a cool one.
    //
    //  2. Wherever it *does* darken, it goes blue in proportion. A surface that
    //     dims without shifting hue drops below the tonemapper's desaturating
    //     shoulder still carrying the sun's warmth, and lands on tan. Snow does
    //     not do that: light reaching into a fold of snow has scattered through
    //     snow to get there, and snow absorbs red over any appreciable path,
    //     which is why a real snow cave is blue and not grey. Tying the tint to
    //     the darkening rather than to `barrel` directly means the two can never
    //     drift apart.
    vec3 caveTint = mix(vec3(1.0), vec3(0.55, 0.72, 1.0), (1.0 - occ) * 0.95);
    color *= occ * caveTint;

    if (glintIntensity > 0.001) {
        float g = snowGlints(
            world.xz, N, V, L, footprint,
            glintIntensity, glintGrazing
        );
        color += sun * g * shadow * 0.5;
    }

    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    // ------------------------------------------------------------------ debug
    //
    // Per-term, because "the wall is the wrong colour" is not a question any
    // amount of staring at the composite can answer. Each mode returns one term
    // in the same radiance units the beauty pass works in, so the tonemapper
    // shows them at the exposure they actually contribute at, and two of them
    // side by side say immediately which one is carrying the hue.
    //
    //   1 direct  2 subsurface  3 ambient  4 sky spec  5 sun spec
    //   6 occlusion (grey)      7 shadow (grey)        8 |N.L| (grey)
    float dbg = wakeDebug;
    if (dbg > 0.5) {
        if (dbg < 1.5) { color = directTerm; }
        else if (dbg < 2.5) { color = sssTerm; }
        else if (dbg < 3.5) { color = ambientTerm; }
        else if (dbg < 4.5) { color = skyTerm; }
        else if (dbg < 5.5) { color = specTerm; }
        else if (dbg < 6.5) { color = vec3(occ * 12.0); }
        else if (dbg < 7.5) { color = vec3(shadow * 12.0); }
        else if (dbg < 8.5) { color = vec3(max(NdotL, 0.0) * 12.0); }
        // Unscaled, to line up with the snow material's own `ndotl` view — the
        // only way to compare the two surfaces is on one screen at one scale.
        else if (dbg < 9.5) { color = vec3(max(NdotL, 0.0)); }
        // 10: which side of the sheet the eye is on. Red = inside the curl,
        // green = the open outer face. The two walls are mirror images, so this
        // is the view that says whether they agree.
        else { color = inside ? vec3(9.0, 0.0, 0.0) : vec3(0.0, 9.0, 0.0); }
    }

    fragColor = vec4(color, 1.0);
}
