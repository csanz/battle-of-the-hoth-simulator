// -----------------------------------------------------------------------------
// Spell water — shading.
//
// The one material in the demo that is not snow. Four things have to be true at
// once or it reads as a blue plastic tube, and they pull against each other:
//
//   it is transparent      You see the field through it, displaced, and the
//                          displacement is what says "this is a lens" rather
//                          than "this is a coloured surface".
//   it is coloured by
//   what it absorbs        Not by an albedo. Water's colour is the *shortfall*
//                          of the light that made it through — red first, then
//                          green — so the tint follows the path length and a
//                          thin wisp comes out nearly clear while the belly of
//                          a metre-wide column goes deep teal.
//   it is mirror-bright    At 13 degrees a wet surface returns almost all of a
//                          grazing view. Fresnel does most of the work of making
//                          it look wet, and it is what keeps a body legible
//                          against a pale sky.
//   it scatters inside     A body of water thrown through the air is full of
//                          bubbles and entrained snow, and that internal
//                          scatter is what keeps the shadowed side of an arc
//                          alive.
//
// **Refraction without a scene copy.** The obvious implementation samples the
// framebuffer behind the surface, which means rendering the opaque pass twice or
// copying a bound render target mid-frame. Neither is necessary here, because of
// what is actually behind the water: sky, or snow, and nothing else. The sky LUT
// already stores both — the Nishita bake writes the iteratively-solved snow
// bounce into every direction below the horizon, precisely so that shadowed snow
// can be lit by the ground it sits on. So a single lookup along the refracted ray
// returns a physically-derived estimate of what is behind the water for *any*
// direction, up or down, at the cost of one texture fetch. Three fetches at three
// slightly different indices of refraction give the chromatic dispersion.
//
// What it cannot show is the specific dune or trail behind the water. At the
// distance and speed these effects are seen at, that is a trade worth making
// twice over: it is exact in hue and energy, it never breaks, it never has to be
// re-ordered against the transparent pass, and it costs three samples of a
// texture the shader is already binding.
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
in float vQ;
in float vU;
in float vRadius;
in float vFoam;
in float vMilk;
in float vAlpha;
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
uniform float waterTime;
/// Artistic scale on the absorption coefficients. One slider for "how deep does
/// this water read", which is the single most-tuned number in the material.
uniform float waterDepthTint;

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowShadowLookup>

/// Absorption per metre of path, exaggerated well past real water.
///
/// Clear water absorbs about 0.45/m in red and 0.05/m in blue, which over the
/// ten to forty centimetres a spell body is actually thick produces a tint of a
/// few percent — invisible. A bent body should be *strongly* coloured at arm's
/// length, because it is glacial melt full of entrained snow rather than a
/// swimming pool. These coefficients put the same tint at a tenth of the path
/// length.
const vec3 WATER_ABSORB = vec3(3.40, 0.72, 0.34);

layout(location = 0) out vec4 fragColor;

void main() {
    if (vAlpha <= 0.003 || vRadius <= 0.0005) { discard; }

    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;

    // Both faces of the body are visible — it is transparent, and the sheet
    // profile is genuinely open — so winding says nothing. Turn the normal
    // toward the eye, exactly as the wake and the garments do.
    vec3 Ng = normalize(vNormal);
    vec3 N = dot(Ng, V) >= 0.0 ? Ng : -Ng;
    vec3 geoN = N;

    // Flow-map ripple. Two counter-drifting octaves sliced along two oblique
    // world directions rather than the XZ plane: the body is as often vertical
    // as horizontal, and a planar lookup bands it into horizontal stripes on the
    // vertical parts — the one pattern that reads as a rendering error.
    vec3 ddxW = dFdx(world);
    vec3 ddyW = dFdy(world);
    float footprint = max(length(vec2(length(ddxW.xz), length(ddyW.xz))), 1e-4);
    vec2 fp = vec2(
        dot(world, vec3(0.88, 0.31, -0.36)),
        dot(world, vec3(0.24, 0.79, 0.56))
    );

    vec3 up = abs(N.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);

    //
    // This is where *all* of the fine surface detail lives, and it has to be:
    // the mesh is 64 columns by 12 rings whatever the strand is doing, so
    // anything finer than that in the geometry is not detail, it is aliasing.
    // See the note on `waterRelief`. Here the sampling rate is the pixel, so
    // three octaves are affordable and the footprint fade keeps each of them
    // switched off before it can shimmer.
    float t = waterTime;
    float rippleFade = 1.0 - smoothstep(0.03, 0.22, footprint);
    if (rippleFade > 0.002) {
        vec3 g1 = noised(fp * 8.5 + vec2(t * 0.7, -t * 0.5));
        vec3 g2 = noised(fp * 21.0 + vec2(-t * 1.6, t * 1.1));
        N = normalize(N + (T * (g1.y * 0.085 + g2.y * 0.055)
                         + B * (g1.z * 0.085 + g2.z * 0.055)) * rippleFade);
    }
    float fineFade = 1.0 - smoothstep(0.006, 0.045, footprint);
    if (fineFade > 0.002) {
        vec3 g3 = noised(fp * 62.0 + vec2(t * 3.1, t * 2.2));
        N = normalize(N + (T * g3.y + B * g3.z) * 0.030 * fineFade);
    }

    float NdotV = clamp(dot(N, V), 1e-4, 1.0);
    float NdotL = dot(N, L);
    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;
    float shadow = sunShadow(world, geoN, vViewDist, noiseRot);

    vec3 sun = sunRadiance;
    const float INV_PI = 0.31830988618;

    // ---- how far the light travelled through the body ---------------------
    // Grazing views cut a long chord, head-on views a short one. That single
    // relationship is most of what makes a tube of water look like a volume
    // rather than like a shell: the silhouette is always the deepest part of it.
    //
    // The constant term matters as much as the grazing one. Keying the path
    // purely off view angle puts *all* of the colour at the silhouette — which
    // is also exactly where Fresnel is strongest, so the reflection replaces the
    // tint precisely where it exists and the body comes out white. Giving the
    // path a floor proportional to the radius means a fat body is coloured all
    // the way across it, which is what a 30 cm rope of glacial melt looks like.
    float path = clamp(
        vRadius * (1.25 + 1.9 * (1.0 - NdotV)) * waterDepthTint,
        0.01, 3.0
    );
    vec3 transmit = exp(-WATER_ABSORB * path);

    // ---- refraction, with dispersion --------------------------------------
    // Three indices, one per channel. The spread is small — real dispersion in
    // water is about half a percent across the visible band — but on a surface
    // this curved the ray fans far enough to put a visible fringe on the rim,
    // which is exactly where the eye looks for it.
    vec3 rr = refract(-V, N, 1.0 / 1.3300);
    vec3 rg = refract(-V, N, 1.0 / 1.3330);
    vec3 rb = refract(-V, N, 1.0 / 1.3400);
    // Total internal reflection returns a zero vector; fall back to the mirror
    // direction there, which is what actually happens.
    vec3 mirror = reflect(-V, N);
    vec3 dr = dot(rr, rr) > 0.5 ? rr : mirror;
    vec3 dg = dot(rg, rg) > 0.5 ? rg : mirror;
    vec3 db = dot(rb, rb) > 0.5 ? rb : mirror;

    // A mid mip: the body is rippled, so a mirror-sharp background through it
    // would alias, and a little blur is what a centimetre of moving water does
    // to what is behind it anyway.
    vec3 behind = vec3(
        textureLod(skyLUT, dirToLatLong(dr), 1.6).r,
        textureLod(skyLUT, dirToLatLong(dg), 1.6).g,
        textureLod(skyLUT, dirToLatLong(db), 1.6).b
    );
    vec3 color = behind * transmit;

    // ---- internal scatter --------------------------------------------------
    // Light that entered the body, bounced off entrained air and snow, and came
    // back out toward the eye. Peaks looking into the sun through the thin
    // parts, so the arc lights up from the inside where the sun is behind it.
    //
    // Tinted by what the water did *not* absorb on the way in and out, so the
    // glow is teal at depth and near-white at the edges, for free.
    //
    // The 1/PI is not decoration. A scattering lobe is a *distribution*, and
    // multiplying radiance by one without the 1/PI that belongs in front of it
    // overstates the peak by a factor of three — which on a term already fed by
    // a 17:13:6 sun put this several times brighter than sunlit snow. The body
    // clipped to flat white along its whole length and no amount of tinting
    // underneath could show through it. Exactly the failure the spray's forward
    // scatter had, for exactly the same reason.
    float inScatter = backScatter(N, L, V, 0.55, 2.6, 1.0);
    vec3 scatterTint = mix(vec3(0.40, 0.80, 1.0), vec3(0.72, 0.94, 1.0), exp(-path * 1.6));
    color += sun * INV_PI * scatterTint * inScatter
           * (0.55 + 1.3 * vMilk) * sssStrength
           * mix(0.30, 1.0, shadow);

    // Sky filling the body from above. Without this the shadowed side of an arc
    // has nothing in it but the refraction, and goes dead.
    color += shIrradiance(N, shR) * ambientIntensity * INV_PI
           * scatterTint * (0.35 + 0.5 * vMilk);

    // ---- slush -------------------------------------------------------------
    // `milkiness` is what a spell dials to move between clear bent water and the
    // snow it tore out of the ground on the way up. It is not a colour: it is an
    // opaque diffuse population *inside* the body, so it fills in behind the
    // transparency rather than tinting it, and the two coexist the way real
    // slush does.
    if (vMilk > 0.002) {
        vec3 slushAlbedo = vec3(0.86, 0.90, 0.96);
        float d = wrapDiffuse(NdotL, 0.62);
        vec3 slush = slushAlbedo * INV_PI * sun * d * shadow;
        slush += slushAlbedo * INV_PI * shIrradiance(N, shR)
               * ambientIntensity;
        slush += snowSubsurface(N, L, V, sun, 0.45, sssStrength * 0.8, 1.2)
               * slushAlbedo * mix(0.35, 1.0, shadow);
        color = mix(color, slush, vMilk * 0.85);
    }

    // ---- foam --------------------------------------------------------------
    // The leading edge, where the body is tearing itself apart against the air
    // and the snow. Opaque, white, and broken up by a drifting noise so it is a
    // froth rather than a painted band.
    float foam = vFoam;
    if (foam > 0.002) {
        float fn2 = noise2(fp * 22.0 + vec2(t * 1.7, -t * 1.1)) * 0.5 + 0.5;
        float fn3 = noise2(fp * 61.0 - vec2(t * 3.3, t * 2.1)) * 0.5 + 0.5;
        foam = clamp(foam * (0.35 + 1.5 * fn2 * (0.5 + 0.7 * fn3)), 0.0, 1.0);
        vec3 foamAlbedo = vec3(0.93, 0.955, 0.99);
        vec3 fc = foamAlbedo * INV_PI * sun * wrapDiffuse(NdotL, 0.72) * shadow;
        fc += foamAlbedo * INV_PI * shIrradiance(N, shR) * ambientIntensity;
        fc += snowSubsurface(N, L, V, sun, 0.25, sssStrength, 1.4)
            * foamAlbedo * mix(0.4, 1.0, shadow);
        color = mix(color, fc, foam);
    }

    // ---- reflection --------------------------------------------------------
    // Fresnel on water is the whole reason it looks wet, and at a 13-degree sun
    // over a bright sky it is the strongest single term in the frame. Applied
    // after the body terms because it sits *on* the surface: what it returns
    // never went through the water and is therefore never tinted by it.
    //
    // Capped at 0.72 rather than run to the full Schlick 1.0 at grazing. A flat
    // sea does go to a perfect mirror at the horizon, but that limit assumes a
    // surface you cannot see the far side of. This body is a decimetre through
    // and lit from inside it, so letting the reflection reach unity deletes the
    // volume exactly at the silhouette — the one place the eye reads the
    // material from.
    //
    // `milkiness` has to take the *surface* out as well as filling the body in.
    // A vortex of lifted snow at 0.88 milk was still returning a third of the
    // sky at grazing and running a 0.27 roughness lobe, and it came out looking
    // like moulded plastic: opaque, which was right, and polished, which was not.
    // A mass of ice crystals in air has no specular surface at all.
    vec3 F = min(fresnelSchlick(NdotV, vec3(0.02)), vec3(0.72));
    vec3 skyRefl = textureLod(skyLUT, dirToLatLong(mirror), 0.7).rgb;
    color = mix(color, skyRefl, F * (1.0 - foam * 0.7) * (1.0 - vMilk * 0.88));

    // Sun glint. A tight lobe, because water is smooth: this is the highlight
    // that runs along the top of an arc and sells its curvature.
    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float rough = mix(0.055, 0.68, max(foam * 0.55, vMilk));
        float D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        float Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        vec3 Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3(0.02));
        color += sun * D * Vis * Fs * NdotL * shadow;
    }

    // Shed droplets on the outer skin catch the sun as points. The snow's own
    // glint field, at a much finer cell and gated the same way, so the sparkle
    // on the water and the sparkle on the field are the same effect.
    if (glintIntensity > 0.001) {
        float g = snowGlints(
            fp, N, V, L, footprint,
            glintIntensity * (0.6 + 0.8 * max(foam, vMilk)),
            glintGrazing
        );
        color += sun * g * shadow * 0.7;
    }

    // ---- spell light -------------------------------------------------------
    // A spell body lit by its own emitter. This is why a Bloom's column glows
    // from inside instead of being a dark shape against a lit crater.
    if (spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, mix(vec3(0.35, 0.62, 0.78), vec3(0.9), vMilk),
            vec3(0.02), 0.12, 0.55,
            spellLightPos, spellLightCol, spellLightCount
        );
    }

    // ---- opacity -----------------------------------------------------------
    //
    // Nearly opaque, which is the opposite of the obvious answer and is the
    // single change that made this read as water rather than as frosted glass.
    //
    // Running the alpha off Fresnel — transparent face-on, mirror at grazing,
    // which is what clear water does — comes out pale and washed, because the
    // background is then counted *twice*: once through the refracted sky lookup,
    // which is the physically-placed, dispersed, absorbed version of it, and
    // again through the blend, which is the undistorted version at full
    // brightness. Over a snow field the second one is white and it wins. A high
    // alpha deletes the duplicate and leaves the refraction as the only path the
    // background takes through the body.
    //
    // What is left for the alpha to do is the ends. The radius tapers to nothing
    // there, so keying opacity to the radius closes the tube on a soft point
    // rather than on a ring of visible section. That is also why nothing fades
    // in `u`: `u` means "along the spine" and cannot tell a ribbon's trailing
    // wisp from the symmetric horn of a crescent wave.
    float taper = clamp(vRadius / 0.055, 0.0, 1.0);
    float clearAlpha = taper * mix(0.74, 0.97, 1.0 - NdotV);
    float alpha = mix(clearAlpha, taper, max(foam, vMilk * 0.9)) * vAlpha;
    if (alpha < 0.004) { discard; }

    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    fragColor = vec4(color, alpha);
}
