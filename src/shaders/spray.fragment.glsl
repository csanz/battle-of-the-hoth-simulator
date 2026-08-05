// -----------------------------------------------------------------------------
// Snow spray.
//
// Airborne snow is not a fogged sprite. It is a cloud of ice crystals, and the
// two things that make it read are the two things a plain alpha billboard
// leaves out:
//
//   forward scatter   Looking toward the sun through a puff, it is *brighter*
//                     than the snow behind it and it is warm. Looking down-sun
//                     it is a dim blue-grey. That swing is enormous — well over
//                     a stop — and it is the entire difference between "spray
//                     catching the light" and "grey smoke".
//   shadowing         Spray thrown inside the figure's own shadow must go dark,
//                     or every footfall looks self-illuminated. It reads the
//                     same cascades everything else does.
//
// The billboard is shaded as a sphere: the normal is reconstructed from the
// quad's own coordinates, so a puff has a lit side and a dark side instead of
// being a flat disc.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;

in vec3 vWorld;
in vec2 vCorner;
in vec4 vState;
in float vViewDist;

layout(location = 0) out vec4 fragColor;

uniform highp sampler2D skyLUT;
uniform highp sampler2D cascade0;
uniform highp sampler2D cascade1;
uniform highp sampler2D cascade2;

uniform vec3 cameraPos;
uniform vec3 camRight;
uniform vec3 camUp;
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

uniform vec4 spellLightPos[4];
uniform vec4 spellLightCol[4];
uniform float spellLightCount;

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>
#include<snowShadowLookup>

void main() {
    float r2 = dot(vCorner, vCorner);
    if (r2 > 1.0) { discard; }

    vec4 state = vState;
    float kind = state.z;

    // Break the disc's edge. A perfectly circular puff is the tell that gives
    // billboards away; a hashed radial wobble costs one noise fetch.
    float ang = atan(vCorner.y, vCorner.x);
    float wob = 1.0 + 0.34 * noise2(vec2(cos(ang), sin(ang)) * 2.4 + state.y * 37.0);
    float r = sqrt(r2) / wob;
    if (r > 1.0) { discard; }

    // Soft-edged for powder, harder for a clod of thrown snow.
    float edge = mix(
        pow(clamp(1.0 - r * r, 0.0, 1.0), 1.6),
        smoothstep(1.0, 0.65, r),
        kind
    );
    // Powder is close to transparent on its own; density has to come from many
    // grains overlapping, or a single one turns into a decal. 0.26 was low enough
    // that even fifteen hundred live grains read as haze rather than as spray.
    float alpha = state.w * edge * mix(0.36, 0.55, kind);
    if (alpha < 0.004) { discard; }

    // Spherical normal from the billboard's own coordinates.
    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;
    float nz = sqrt(max(0.0, 1.0 - r2));
    vec3 N = normalize(camRight * vCorner.x + camUp * vCorner.y + V * nz);

    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;
    float shadow = sunShadow(world, N, vViewDist, noiseRot);

    vec3 sun = sunRadiance;
    const float INV_PI = 0.31830988618;

    // Snow crystals in air scatter almost isotropically at the surface and very
    // strongly forward through the volume, so both terms are needed.
    vec3 albedo = vec3(0.92, 0.94, 0.98);
    float diff = wrapDiffuse(dot(N, L), 0.75);
    vec3 color = albedo * INV_PI * sun * diff * shadow;

    // Forward scatter through the puff. `mu` is 1 looking straight into the sun.
    //
    // The coefficient is small and has to be. A phase function is normalised
    // over the sphere, so using it as a direct multiplier on radiance — without
    // the optical depth and scattering albedo that belong in front of it —
    // overstates the peak by more than an order of magnitude: at 4.2 a footfall
    // puff comes out four times brighter than sunlit snow and clips to flat
    // white.
    float mu = dot(-V, L);
    float fwd = phaseMie(mu, 0.55) * 0.85;
    color += sun * albedo * fwd * mix(0.25, 1.0, shadow) * (1.0 - kind * 0.5);

    // Sky, which is what fills the shadowed side and keeps it blue.
    color += albedo * INV_PI * shIrradiance(N, shR) * ambientIntensity;

    // Spell light. Airborne snow inside a spell is the most legible thing the
    // dynamic lights do — a mist of crystals a metre from a bright emitter picks
    // up far more of it than the ground does, which is why a Bloom's fallout
    // curtain reads as lit from within rather than as grey powder over a glow.
    if (spellLightCount > 0.5) {
        color += spellLightingParticle(
            world, N, albedo,
            spellLightPos, spellLightCol, spellLightCount
        );
    }

    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    fragColor = vec4(color, alpha);
}
