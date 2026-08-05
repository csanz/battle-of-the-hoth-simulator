// -----------------------------------------------------------------------------
// Shell fur.
//
// Each shell is a copy of the trim's surface, pushed further out. This shader
// decides, per pixel per shell, whether a strand is still present there. Two
// hashed quantities per strand cell do all the work:
//
//   length   how far up the shell stack this strand survives. Uniform-length
//            fur reads as a sponge; the variation is what makes it fur.
//   radius   the strand's cross-section, tapering to nothing at its own tip, so
//            the silhouette is pointed rather than cut off flat.
//
// Lighting is deliberately not a surface BRDF. A strand is a fibre: it scatters
// forward strongly, wraps light most of the way round, and its roots are buried
// in shadow. Wrapped diffuse plus a strong transmission lobe plus depth-based
// occlusion gets all three, and white fur against a low sun then does the thing
// white fur does, which is glow around its edges.
// -----------------------------------------------------------------------------

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowShading>
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

uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;
uniform float ambientIntensity;

/// Strand cells per metre of surface. 260 is a 3.8 mm pitch.
uniform float furDensity;
uniform vec3 furColor;

#include<snowShadowLookup>

layout(location = 0) out vec4 fragColor;

#define INV_PI 0.31830988618

void main() {
    float t = vAux.x;

    // ---------------------------------------------------------- strand field
    vec2 g = vUV * furDensity;
    vec2 cell = floor(g);
    float h = hash21(cell);
    vec2 jitter = hash22(cell + vec2(11.3, 5.7)) - 0.5;

    // How far up this strand reaches. Cut early and often: a shell stack where
    // most strands survive to the top is a solid shell with holes in it.
    float strandLen = 0.30 + 0.70 * h;
    if (t > strandLen) { discard; }

    // Distance to the strand's own axis, in cell units.
    float d = length(fract(g) - 0.5 - jitter * 0.55);
    // Taper: full width at the root, a point at the tip.
    float taper = 1.0 - (t / strandLen);
    float radius = 0.46 * (0.55 + 0.45 * hash21(cell + vec2(3.1, 9.4))) * sqrt(max(taper, 0.0));
    if (d > radius) { discard; }

    // ------------------------------------------------------------- shading
    vec3 world = vWorld;
    vec3 V = normalize(cameraPos - world);
    vec3 L = sunDir;
    vec3 N = normalize(vNormal);
    if (dot(N, V) < 0.0) { N = -N; }

    float noiseRot = ign(gl_FragCoord.xy) * 6.28318530718;
    float shadow = sunShadow(world, N, vViewDist, noiseRot);

    // Self-occlusion down the stack. Roots see almost no sky, tips see all of
    // it — this gradient is what gives shell fur its depth, and without it the
    // trim reads as a flat white band.
    float depth = t / max(strandLen, 1e-3);
    float selfAO = 0.16 + 0.84 * depth * depth;

    vec3 sun = sunRadiance;
    float NdotL = dot(N, L);

    // Fibres wrap light almost all the way round.
    float diff = wrapDiffuse(NdotL, 0.65);
    vec3 color = furColor * INV_PI * sun * diff * shadow * selfAO;

    // Transmission — the term that makes a fur rim light up against a low sun.
    float back = backScatter(N, L, V, 0.5, 3.0, 1.0);
    color += sun * furColor * back * 0.85 * mix(0.4, 1.0, shadow) * selfAO;

    // A dim, wide specular. Fur is not glossy, but a completely matte white
    // reads as paper.
    if (NdotL > 0.0) {
        vec3 H = normalize(V + L);
        float ds = distributionGGX(clamp(dot(N, H), 0.0, 1.0), 0.75);
        color += sun * ds * 0.05 * NdotL * shadow * selfAO;
    }

    vec3 irradiance = shIrradiance(N, shR) * ambientIntensity;
    color += furColor * INV_PI * irradiance * selfAO * vAux.y * 1.4;

    color = applyAerial(
        color, cameraPos, world, -V, L,
        skyLUT, sun,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    fragColor = vec4(color, 1.0);
}
