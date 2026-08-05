// -----------------------------------------------------------------------------
// snowAtmosphere — sky model and aerial perspective.
//
// The sky is a Nishita single-scattering integration rather than an HDRI. The
// whole look hangs on a sun sitting 5-15 degrees above the horizon, and with an
// analytic model the sun angle is a slider that correctly drags the sky
// gradient, the horizon warmth and the ambient tint along with it. A captured
// HDRI locks all of that to whatever elevation the photographer had.
//
// It is expensive — 32 view steps by 8 light steps — so it is never evaluated
// per pixel per frame. It bakes into an equirect LUT at load, and again only
// when the sun actually moves.
//
// Aerial perspective at runtime is the cheap analytic half: height-falloff
// extinction plus an inscatter colour looked up from that same LUT, which
// keeps distant snow tied to the sky it is sitting under.
//
// Needs `PI` from <snowNoise> — include that first.
// -----------------------------------------------------------------------------

const float EARTH_R = 6360000.0;
const float ATMOS_R = 6420000.0;
const float H_RAYLEIGH = 8000.0;
const float H_MIE = 1200.0;

// Sea-level scattering coefficients, per metre.
const vec3 BETA_R = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const vec3 BETA_M = vec3(21e-6, 21e-6, 21e-6);
const float MIE_G = 0.76;

/// Strength of the isotropic multiple-scattering approximation, relative to
/// single-scattered Rayleigh. Tuned so the diffuse sky irradiance lands near
/// 15% of direct-normal solar, which is where a real clear sky sits.
const float MS_BOOST = 1.5;

/// Distance to the far intersection of a ray with a sphere centred on the
/// origin. Returns -1 when the ray misses.
float raySphereFar(vec3 origin, vec3 dir, float radius) {
    float b = dot(origin, dir);
    float c = dot(origin, origin) - radius * radius;
    float d = b * b - c;
    if (d < 0.0) { return -1.0; }
    return -b + sqrt(d);
}

float phaseRayleigh(float mu) {
    return (3.0 / (16.0 * PI)) * (1.0 + mu * mu);
}

float phaseMie(float mu, float g) {
    float g2 = g * g;
    float n = (1.0 - g2) * (1.0 + mu * mu);
    float d = (2.0 + g2) * pow(1.0 + g2 - 2.0 * g * mu, 1.5);
    return (3.0 / (8.0 * PI)) * n / d;
}

/// Full single-scattering sky radiance for a view direction.
/// `sunDir` points *toward* the sun. Result is linear, unnormalised radiance.
vec3 nishitaSky(vec3 rayDir, vec3 sunDir, float sunIntensity, vec3 groundBounce) {
    // Stand just above the surface so the horizon resolves cleanly.
    vec3 origin = vec3(0.0, EARTH_R + 800.0, 0.0);

    float atmosDist = raySphereFar(origin, rayDir, ATMOS_R);
    if (atmosDist < 0.0) { return vec3(0.0); }

    // Rays heading into the planet are clipped at the surface, which is what
    // produces the dark, dense band right below the horizon.
    float groundDist = raySphereFar(origin, rayDir, EARTH_R);
    float bIn = dot(origin, rayDir);
    float cIn = dot(origin, origin) - EARTH_R * EARTH_R;
    float discr = bIn * bIn - cIn;
    float march = atmosDist;
    if (discr > 0.0) {
        float near = -bIn - sqrt(discr);
        if (near > 0.0) { march = near; }
    }

    const int STEPS = 32;
    const int LIGHT_STEPS = 8;

    // View samples are distributed by a power law, not uniformly, and this is the
    // single most important line in the integral.
    //
    // Density falls off exponentially with height, so almost all of the
    // scattering along any ray happens in the first few kilometres. A uniform
    // march does not know that, and near the horizon it fails outright: a ray at
    // zero elevation travels roughly 450 km before it leaves the atmosphere, so
    // sixteen even steps put the *first* sample 14 km out and 15 km up — past
    // essentially all of the air that matters. The model then under-integrates
    // exactly the direction it is sampled hardest in, and the LUT dives by more
    // than a stop in the last three degrees before the horizon and jumps back up
    // below it, where the snow bounce takes over. A one-stop dark notch, one to
    // two degrees wide, wrapped around the whole horizon.
    //
    // `t^2.5` puts the first of thirty-two samples 60 m out on that same grazing
    // ray and still reaches the top of the atmosphere. Steps are integrated over
    // their true width rather than a constant, so the quadrature stays correct.
    const float DIST_POWER = 2.5;

    float mu = dot(rayDir, sunDir);
    float pr = phaseRayleigh(mu);
    float pm = phaseMie(mu, MIE_G);

    vec3 sumR = vec3(0.0);
    vec3 sumM = vec3(0.0);
    // The same two sums, over the samples that have no *direct* view of the sun.
    // See the note where they are spent, below the loop.
    vec3 shadR = vec3(0.0);
    vec3 shadM = vec3(0.0);
    float odR = 0.0; // accumulated optical depth along the view ray
    float odM = 0.0;

    float tPrev = 0.0;
    for (int i = 0; i < STEPS; i++) {
        float tNext = march * pow(float(i + 1) / float(STEPS), DIST_POWER);
        float stepLen = tNext - tPrev;
        vec3 p = origin + rayDir * (tPrev + stepLen * 0.5);
        tPrev = tNext;
        float h = length(p) - EARTH_R;

        float dR = exp(-h / H_RAYLEIGH) * stepLen;
        float dM = exp(-h / H_MIE) * stepLen;
        odR += dR;
        odM += dM;

        // Optical depth from this sample toward the sun.
        float lightDist = raySphereFar(p, sunDir, ATMOS_R);
        float lStep = lightDist / float(LIGHT_STEPS);
        float lR = 0.0;
        float lM = 0.0;
        bool occluded = false;

        for (int j = 0; j < LIGHT_STEPS; j++) {
            vec3 lp = p + sunDir * (lStep * (float(j) + 0.5));
            float lh = length(lp) - EARTH_R;
            if (lh < 0.0) { occluded = true; break; }
            lR += exp(-lh / H_RAYLEIGH) * lStep;
            lM += exp(-lh / H_MIE) * lStep;
        }

        if (occluded) {
            // Not thrown away. This sample sits in the planet's own shadow, so
            // it receives no direct sun — but it is still inside a lit
            // atmosphere, and multiply-scattered light reaches it. Attenuate
            // along the *view* path only and keep it for the isotropic pass.
            vec3 attenV = exp(-(BETA_R * odR + BETA_M * 1.1 * odM));
            shadR += attenV * dR;
            shadM += attenV * dM;
            continue;
        }

        vec3 tau = BETA_R * (odR + lR) + BETA_M * 1.1 * (odM + lM);
        vec3 atten = exp(-tau);
        sumR += atten * dR;
        sumM += atten * dM;
    }

    vec3 col = sunIntensity * (sumR * BETA_R * pr + sumM * BETA_M * pm);

    // --- multiple scattering ------------------------------------------------
    // Single scattering alone underestimates a clear sky by roughly a factor of
    // three, and it underestimates blue the most, because a blue photon is the
    // one most likely to scatter again rather than to be absorbed. Left
    // uncorrected the sky is too dim to fill shadows, the warm ground bounce
    // wins the ambient, and snow shadows come out beige instead of blue — which
    // is the opposite of the whole look.
    //
    // Approximated as an extra isotropic pass over the same optical depths.
    // Cheap, stable, and it puts the sun/sky ratio in the right place.
    //
    // The shadowed samples enter *here* and nowhere else, at half weight: it is
    // scattered light arriving indirectly, not a second sun. Leaving them out
    // entirely is what drew a dark band across the sky a degree or two above the
    // horizon on the anti-sun side.
    const float SHADOW_FILL = 0.5;
    float msPhase = 1.0 / (4.0 * PI);
    col += sunIntensity * (
              (sumR + shadR * SHADOW_FILL) * BETA_R * MS_BOOST
            + (sumM + shadM * SHADOW_FILL) * BETA_M * 0.4
          ) * msPhase;

    // Below the horizon the "sky" is snow. `groundBounce` is the radiance
    // leaving that snow, computed on the CPU by iterating the bounce against
    // this very LUT until it converges.
    //
    // This is not a detail. Snow reflects ~85% of what lands on it, so in a
    // snow field the ground is one of the brightest sources in the scene, and
    // it is what fills shadows with bright blue-white light instead of leaving
    // them black.
    //
    // The handover has to be *fast* — one and a half degrees either side of
    // where the clip actually begins.
    if (discr > 0.0 && groundDist > 0.0) {
        // Ascending edges: smoothstep is undefined when edge0 > edge1.
        float downT = 1.0 - smoothstep(-0.030, -0.005, rayDir.y);
        col = mix(col, groundBounce, downT);
    }

    // --- the optically thick horizon ---------------------------------------
    // A horizontal path through the atmosphere is hundreds of kilometres long,
    // and single scattering treats that as a coloured filter: blue is
    // extinguished outright, green mostly, and what is left is a saturated olive
    // band sitting between the blue dome and the warm sun. No real sky does that.
    // So the last dozen degrees are pulled toward their own luminance — the
    // cheapest possible stand-in for high-order scattering. The sun's own
    // warmth is untouched: the solar disc, the aureole and the forward-scatter
    // lobe are all added *after* this LUT.
    float grazing = 1.0 - smoothstep(0.0, 0.26, abs(rayDir.y));
    float pale = dot(col, vec3(0.30, 0.42, 0.28));
    col = mix(col, vec3(pale) * vec3(0.97, 1.0, 1.06), grazing * 0.82);

    return col;
}

// ------------------------------------------------------- lat-long projection

// The sky is stored as an equirectangular 2D LUT rather than a cubemap. A cube
// would be six render targets, six readbacks and seam handling, to buy accuracy
// at the poles that a sky gradient does not have and cannot use.

vec2 dirToLatLong(vec3 d) {
    float u = atan(d.x, d.z) / (2.0 * PI) + 0.5;
    float v = acos(clamp(d.y, -1.0, 1.0)) / PI;
    return vec2(u, v);
}

vec3 latLongToDir(vec2 uv) {
    float phi = (uv.x - 0.5) * 2.0 * PI;
    float theta = uv.y * PI;
    float st = sin(theta);
    return vec3(st * sin(phi), cos(theta), st * cos(phi));
}

// ------------------------------------------------------------------- runtime

/// Height-falloff extinction. Returns transmittance 0..1.
/// Integrates exp(-k*y) analytically along the segment, so fog thins with
/// altitude the way real haze does instead of sitting in a flat slab.
float aerialTransmittance(
    vec3 camPos,
    vec3 worldPos,
    float density,
    float heightFalloff,
    float fogStart
) {
    vec3 d = worldPos - camPos;
    float dist = max(0.0, length(d) - fogStart);
    if (dist <= 0.0) { return 1.0; }

    float dy = d.y;
    float integral;
    if (abs(dy) < 0.01) {
        integral = exp(-heightFalloff * camPos.y) * dist;
    } else {
        // ∫ exp(-k*y(t)) dt along the ray, closed form.
        float k = heightFalloff;
        integral = (exp(-k * camPos.y) - exp(-k * worldPos.y)) / (k * dy) * length(d);
        integral = integral * (dist / max(1e-4, length(d)));
    }

    return exp(-density * max(0.0, integral));
}

/// The colour that fills a *short*, ground-level path.
///
/// Not the sky's radiance in the view direction. The horizon band of this sky is
/// the colour of a hundred-kilometre path — by the time light has travelled that
/// far the blue end is gone entirely. Borrowing it as the inscatter colour for
/// three hundred metres of haze paints the middle distance with a sunset it is
/// three orders of magnitude too short to have earned, and the whole far field
/// goes yellow.
///
/// What actually fills a short path is the whole sky hemisphere, and that is
/// dominated by the bright cool dome overhead rather than by the band at eye
/// level. So the lookup is tilted upward and read from a blurred mip. The sun's
/// forward lobe is added separately by `applyAerial`, which is what keeps haze
/// warm where you are looking toward the sun — the one place it should be.
vec3 aerialNearSky(sampler2D tex, vec3 viewDir) {
    vec3 d = normalize(viewDir + vec3(0.0, 0.42, 0.0));
    return textureLod(tex, dirToLatLong(d), 3.0).rgb;
}

/// The inscatter colour for a path of a given total extinction.
///
/// The short-path answer above is right up close and wrong in the limit. A
/// surface at total extinction is *invisible*: by definition what reaches the eye
/// from it is the sky in that exact direction — the sky that would be there if
/// the surface were not. Converge on anything else and the ground never dissolves
/// however much haze is piled on it.
///
/// So the whole inscatter — lobe included — is crossfaded onto the exact sky
/// sample, at the exact mip the sky material itself draws with. At full
/// extinction a hazed surface and the sky pixel beside it are then the same
/// number, and there is nothing left to draw an edge.
vec3 aerialInscatterSky(
    sampler2D tex, vec3 viewDir,
    vec3 sunDir, vec3 sunColor, float ext
) {
    // Mip 0 and no tilt: this has to match `sky.fragment.glsl`'s own lookup
    // exactly, or "fully hazed" and "sky" are two different colours again.
    vec3 exact = textureLod(tex, dirToLatLong(normalize(viewDir)), 0.0).rgb;

    float mu = dot(viewDir, sunDir);
    float fwd = phaseMie(mu, 0.62) * 5.5;
    vec3 near = aerialNearSky(tex, viewDir) + sunColor * fwd * 0.16;

    // Ramps across roughly 100 m to 700 m on the current fog settings: the near
    // field keeps the cool dome and the warm sun-facing haze it is tuned for, and
    // everything past the middle distance is already on its way to the sky.
    return mix(near, exact, smoothstep(0.55, 0.995, ext));
}

/// Fold aerial perspective into a shaded colour.
///
/// Distance does three things at once in the references, and all three matter:
/// contrast compresses, hue pulls toward the sky, and the sun direction picks up
/// a forward-scatter bloom. Extinction alone only does the first.
///
/// The sky LUT is passed in rather than a pre-sampled colour, because the right
/// inscatter colour depends on the extinction this function computes — see
/// `aerialInscatterSky`. Seven materials call this, and the previous signature
/// let every one of them decide for itself what "the sky here" meant.
vec3 applyAerial(
    vec3 color,
    vec3 camPos,
    vec3 worldPos,
    vec3 viewDir,
    vec3 sunDir,
    sampler2D skyTex,
    vec3 sunColor,
    float density,
    float heightFalloff,
    float fogStart,
    float strength
) {
    float t = aerialTransmittance(camPos, worldPos, density, heightFalloff, fogStart);
    float ext = clamp(1.0 - pow(t, strength), 0.0, 1.0);
    vec3 inscatter = aerialInscatterSky(skyTex, viewDir, sunDir, sunColor, ext);
    return mix(color, inscatter, ext);
}
