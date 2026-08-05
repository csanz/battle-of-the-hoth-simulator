// -----------------------------------------------------------------------------
// snowShading — the BRDF, the subsurface term, the glints and the shadow filter.
//
// Snow is not a dielectric with a white albedo. It is a densely packed scatterer
// with a mean free path of a few millimetres, which means:
//
//   * light wraps well past the terminator, so shadow edges are soft in a way
//     no amount of shadow-map filtering reproduces;
//   * thin drift edges glow from behind;
//   * shadowed snow is lit almost entirely by the sky, so it goes *blue*, never
//     grey and never black;
//   * individual surface crystals catch the sun as discrete sparkles at grazing
//     angles, and only at grazing angles.
//
// The subsurface term below is doing most of the work of making this read as
// snow at all. If you disable exactly one thing in this file to see what it was
// worth, disable that.
//
// Needs `PI` from <snowNoise> — include that first.
// -----------------------------------------------------------------------------

// ---------------------------------------------------------------- microfacet

float distributionGGX(float NdotH, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float d = NdotH * NdotH * (a2 - 1.0) + 1.0;
    return a2 / max(1e-7, PI * d * d);
}

float visSmithGGXCorrelated(float NdotV, float NdotL, float roughness) {
    float a = roughness * roughness;
    float a2 = a * a;
    float gv = NdotL * sqrt(NdotV * NdotV * (1.0 - a2) + a2);
    float gl = NdotV * sqrt(NdotL * NdotL * (1.0 - a2) + a2);
    return 0.5 / max(1e-7, gv + gl);
}

vec3 fresnelSchlick(float u, vec3 f0) {
    float f = pow(1.0 - u, 5.0);
    return f0 + (vec3(1.0) - f0) * f;
}

vec3 fresnelSchlickRough(float u, vec3 f0, float roughness) {
    float f = pow(1.0 - u, 5.0);
    return f0 + (max(vec3(1.0 - roughness), f0) - f0) * f;
}

// ---------------------------------------------------------------- subsurface

/// Wrapped diffuse. `w` = 0 is Lambert; snow wants 0.5-0.7, which pushes the
/// terminator most of the way around the back of a drift.
float wrapDiffuse(float NdotL, float w) {
    float denom = (1.0 + w) * (1.0 + w);
    return max(0.0, (NdotL + w) / denom);
}

/// Back-scatter transmission — light that entered the surface, scattered, and
/// left toward the eye. Peaks looking into the light through a thin edge, which
/// is what lights up drift lips and the far walls of footprints.
///
/// `L` points from the surface *toward* the sun, which fixes the sign of the
/// transmission vector: it is `L + N*distortion`, and the lobe is measured
/// against its negation — the direction the scattered light continues in after
/// passing through. Building it from `-L` instead inverts the whole term, so it
/// peaks with the sun behind the camera and switches off looking into it, which
/// is the exact opposite of what translucency does. That reads as snow going
/// flat and dead in the one direction where it should be at its most alive.
float backScatter(vec3 N, vec3 L, vec3 V, float distortion, float power, float thickness) {
    vec3 H = normalize(L + N * distortion);
    float vh = pow(clamp(dot(V, -H), 0.0, 1.0), power);
    return vh * thickness;
}

/// Combined snow subsurface response for one light.
/// Returns the RGB radiance contribution to add to the diffuse lobe.
vec3 snowSubsurface(
    vec3 N,
    vec3 L,
    vec3 V,
    vec3 lightColor,
    float thickness,   // 0 = thin edge, 1 = deep drift
    float strength,
    float radius
) {
    // Deeper snow scatters longer and comes back bluer, because red is absorbed
    // first over any appreciable path length. This is the entire reason snow
    // shadows are blue rather than merely dark.
    vec3 shallowTint = vec3(0.94, 0.965, 1.0);
    vec3 deepTint = vec3(0.55, 0.72, 1.0);
    vec3 tint = mix(shallowTint, deepTint, clamp(thickness * radius, 0.0, 1.0));

    // Lobe width and amplitude both key off thickness, and both run the
    // opposite way to how they read at first glance: a *thin* edge — a drift
    // lip, a berm crest, the far wall of a footprint — transmits brightly and
    // over a wide range of angles, because the path through it is short from
    // almost anywhere. Deep snow transmits little, and only close to
    // straight-through, because anything else is a longer path than the light
    // survives. Having deep snow carry the broader lobe lights the whole open
    // field evenly and reads as haze rather than as translucency.
    float back = backScatter(
        N, L, V, 0.28 * radius,
        mix(3.0, 9.0, thickness),
        mix(1.0, 0.30, thickness)
    );

    return lightColor * tint * back * strength;
}

// -------------------------------------------------------------------- glints

/// One octave of discrete surface sparkle.
///
/// Each cell owns a single jittered facet. The disc falloff makes the glint
/// round instead of square, and because both the position and the orientation
/// hash purely off the world-space cell index, a glint is nailed to the ground:
/// it does not crawl when the camera moves, which is what lets TAA keep it.
float glintOctave(
    vec2 p,
    float cell,
    vec3 N,
    vec3 H,
    vec3 T,
    vec3 B,
    float sharpness
) {
    vec2 id = floor(p / cell);
    vec2 r = hash22(id);
    vec2 r2 = hash22(id + vec2(19.73, 7.31));

    // Only a fraction of cells hold a crystal facet oriented to catch anything.
    if (r2.x > 0.62) { return 0.0; }

    vec2 centre = (id + 0.5 + (r - 0.5) * 0.72) * cell;
    float d = length(p - centre) / (cell * 0.17);
    float disc = clamp(1.0 - d * d, 0.0, 1.0);
    if (disc <= 0.0) { return 0.0; }

    // Tilt the facet off the surface normal by a random amount in the tangent
    // plane. Small tilts, or every facet fires at once and it reads as glitter.
    float ang = r.y * 6.28318530718;
    float tilt = 0.10 + r2.y * 0.26;
    vec3 facet = normalize(N + (T * cos(ang) + B * sin(ang)) * tilt);

    float nh = clamp(dot(facet, H), 0.0, 1.0);
    return disc * pow(nh, sharpness);
}

/// Full glint response.
///
/// Two world-space octaves, each faded out once its cell drops under a few
/// pixels — that keeps them from aliasing into a shimmering carpet in the
/// mid-distance while never resizing a cell (which would make them crawl).
///
/// Gated hard on grazing view angle: snow sparkles when you look *across* it
/// into the sun, and stays matte when you look down at it. Losing that gate is
/// what turns this effect into glitter.
float snowGlints(
    vec2 worldXZ,
    vec3 N,
    vec3 V,
    vec3 L,
    float pixelFootprint,
    float intensity,
    float grazeGate
) {
    if (intensity <= 0.0) { return 0.0; }

    vec3 H = normalize(V + L);

    // Any stable tangent frame will do — the facets are random anyway.
    vec3 up = (abs(N.y) > 0.95) ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 T = normalize(cross(up, N));
    vec3 B = cross(N, T);

    // Grazing gate: 1 looking along the surface, 0 looking straight down.
    float NdotV = clamp(dot(N, V), 0.0, 1.0);
    float graze = pow(1.0 - NdotV, mix(1.5, 5.0, grazeGate));

    // Sun must be low relative to the surface too, or a facet has nothing to
    // bounce toward the eye.
    float NdotL = clamp(dot(N, L), 0.0, 1.0);
    float lightGate = smoothstep(0.02, 0.35, NdotL) * (1.0 - smoothstep(0.55, 0.95, NdotL) * 0.55);

    float gate = graze * lightGate;
    if (gate <= 0.001) { return 0.0; }

    float sum = 0.0;

    float cellA = 0.052;
    float fadeA = smoothstep(cellA * 0.55, cellA * 2.2, pixelFootprint);
    if (fadeA < 1.0) {
        sum += glintOctave(worldXZ, cellA, N, H, T, B, 780.0) * (1.0 - fadeA);
    }

    float cellB = 0.185;
    float fadeB = smoothstep(cellB * 0.55, cellB * 2.2, pixelFootprint);
    if (fadeB < 1.0) {
        sum += glintOctave(worldXZ + vec2(53.1, 17.9), cellB, N, H, T, B, 1500.0) * (1.0 - fadeB) * 1.35;
    }

    return sum * gate * intensity;
}

// ------------------------------------------------------------------- shadows

/// Poisson-ish disc, precomputed. Rotated per pixel so 12 taps look like far
/// more than 12.
const vec2 POISSON[12] = vec2[12](
    vec2(-0.326, -0.406), vec2(-0.840, -0.074), vec2(-0.696,  0.457),
    vec2(-0.203,  0.621), vec2( 0.962, -0.195), vec2( 0.473, -0.480),
    vec2( 0.519,  0.767), vec2( 0.185, -0.893), vec2( 0.507,  0.064),
    vec2( 0.896,  0.412), vec2(-0.322, -0.933), vec2(-0.792, -0.598)
);

/// Percentage-closer *soft* shadows, worked entirely in *world* units.
///
/// Two stages: search a small neighbourhood for occluders and estimate how far
/// in front of the receiver they sit, then size the PCF kernel by that distance.
/// Contact stays crisp, and a dune's shadow softens correctly as it runs out
/// across the field — which is the behaviour the low raking sun makes obvious.
///
/// The usual formulation estimates the penumbra as a ratio of raw depth-buffer
/// values. That silently fails here: the cascades are orthographic over a range
/// of hundreds of metres, so a two-metre step between blocker and receiver is a
/// few thousandths in NDC, the estimate rounds to nothing, and the filter
/// collapses to one texel — pin-sharp shadows regardless of how far the occluder
/// actually is. Converting to metres first is what makes the softening real.
///
/// `depthRange` is the cascade's far-minus-near in metres; `orthoWidth` its
/// world extent, which turns a distance in metres into a distance in UV.
/// The maps hold `gl_FragCoord.z` — window depth 0..1 — sampled with a regular
/// sampler and compared manually (a comparison sampler cannot feed the blocker
/// search).
float pcssShadow(
    sampler2D shadowMap,
    vec2 uv,
    float receiverDepth,
    float texelSize,      // one shadow texel, in UV
    float depthRange,     // metres spanned by stored depth 0..1
    float orthoWidth,     // metres spanned by UV 0..1
    float softness,       // multiplier on the sun's angular size
    float noiseRot,
    float biasWorld,      // depth bias, metres
    vec2 planeNdcPerUV    // receiver's own depth slope, stored-depth per unit UV
) {
    float bias = biasWorld / depthRange;

    // ---- receiver-plane depth bias ---------------------------------------
    // Both loops below sample the map *away* from the shading point, and then
    // have to decide whether what they found is an occluder. Comparing against
    // the shading point's own depth is only valid if the surface is flat in
    // light space, and under a 13-degree sun it is nothing of the sort: the
    // light meets level snow at 77 degrees from the normal, so the surface's own
    // depth falls 1.8 * tan(77) = 7.8 m across the 1.8 m blocker search radius,
    // against a bias measured in centimetres. Every offset sample then reports
    // the snow as its own occluder and the cascade floods solid black.
    //
    // So the comparison depth is extrapolated along the receiver's own plane to
    // wherever the sample was taken. `planeNdcPerUV` is that plane's gradient,
    // built from the surface normal in the light's basis, so it is exact for a
    // locally planar receiver — which at texel scale a heightfield is.
    vec2 planeAt = planeNdcPerUV;

    // Widest penumbra we will ever produce, in UV — also the search radius,
    // since an occluder further away than this cannot soften anything more.
    float maxPenumbraUV = min(24.0 * texelSize, 1.8 / orthoWidth);

    float cs = cos(noiseRot);
    float sn = sin(noiseRot);
    mat2 rot = mat2(cs, -sn, sn, cs);

    // ---- blocker search --------------------------------------------------
    // Accumulates how far in front of the *plane* each blocker sits, rather than
    // its raw depth, so the penumbra estimate below inherits the same correction.
    float blockerDepthSum = 0.0;
    float blockerCount = 0.0;

    for (int i = 0; i < 8; i++) {
        vec2 off = rot * POISSON[i] * maxPenumbraUV;
        vec2 s = clamp(uv + off, vec2(0.0), vec2(1.0));
        float d = textureLod(shadowMap, s, 0.0).r;
        float cmp = receiverDepth + dot(off, planeAt) - bias;
        if (d < cmp) {
            blockerDepthSum += cmp - d;
            blockerCount += 1.0;
        }
    }

    // Nothing in front of the receiver: fully lit, and we skip the filter.
    if (blockerCount < 0.5) { return 1.0; }

    // ---- penumbra estimate ------------------------------------------------
    // Similar triangles, in metres. The sun subtends about half a degree, so a
    // blocker d metres in front of the receiver casts a penumbra of roughly
    // 0.0093*d — `softness` opens that up, because pure geometric penumbra is
    // tighter than snow actually looks once sky light fills the shadow.
    float blockerDist = (blockerDepthSum / blockerCount) * depthRange;
    float penumbraWorld = blockerDist * 0.0093 * softness;
    float filterR = clamp(penumbraWorld / orthoWidth, texelSize, maxPenumbraUV);

    // ---- filter -----------------------------------------------------------
    float lit = 0.0;
    for (int i = 0; i < 12; i++) {
        vec2 off = rot * POISSON[i] * filterR;
        vec2 s = clamp(uv + off, vec2(0.0), vec2(1.0));
        float d = textureLod(shadowMap, s, 0.0).r;
        float cmp = receiverDepth + dot(off, planeAt) - bias;
        lit += (d < cmp) ? 0.0 : 1.0;
    }

    return lit / 12.0;
}

// ---------------------------------------------------------------- SH ambient

/// Irradiance from 9 spherical-harmonic coefficients, the standard Ramamoorthi
/// & Hanrahan convolution. Cheap, and for a sky this smooth it is exact enough
/// that a cubemap lookup would only cost bandwidth.
vec3 shIrradiance(vec3 n, vec4 sh[9]) {
    float c1 = 0.429043;
    float c2 = 0.511664;
    float c3 = 0.743125;
    float c4 = 0.886227;
    float c5 = 0.247708;

    return
        sh[0].rgb * c4
        + sh[1].rgb * 2.0 * c2 * n.y
        + sh[2].rgb * 2.0 * c2 * n.z
        + sh[3].rgb * 2.0 * c2 * n.x
        + sh[4].rgb * 2.0 * c1 * n.x * n.y
        + sh[5].rgb * 2.0 * c1 * n.y * n.z
        + sh[6].rgb * (c3 * n.z * n.z - c5)
        + sh[7].rgb * 2.0 * c1 * n.x * n.z
        + sh[8].rgb * c1 * (n.x * n.x - n.y * n.y);
}

// ------------------------------------------------------------------- helpers

/// Reoriented normal mapping — blends a detail normal onto a base normal
/// without the base's tilt being lost, unlike a naive add-and-normalise.
vec3 blendNormalRNM(vec3 base, vec3 detail) {
    vec3 t = base + vec3(0.0, 0.0, 1.0);
    vec3 u = detail * vec3(-1.0, -1.0, 1.0);
    return normalize(t * dot(t, u) - u * t.z);
}

/// Build a world normal from a heightfield gradient. `d` is (dH/dx, dH/dz).
vec3 normalFromGradient(vec2 d) {
    return normalize(vec3(-d.x, 1.0, -d.y));
}

/// Luminance, Rec.709.
float luma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
