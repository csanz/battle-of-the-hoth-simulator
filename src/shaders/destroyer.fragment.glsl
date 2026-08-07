// The Star Destroyer's shading: bare-metal simple, because at three kilometres
// what sells a capital ship is silhouette, sun side vs shade side, and the
// same aerial perspective everything else in the frame breathes. No textures —
// imperial hulls are a grey the scene's own light is allowed to colour.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowAtmosphere>

in vec3 vWorld;

uniform vec3 cameraPos;
uniform vec3 sunDir;
uniform vec3 sunColor;
uniform vec3 ambientSky;
uniform sampler2D skyLUT;
uniform float fogDensity;
uniform float fogHeightFalloff;
uniform float fogStart;
uniform float aerialStrength;

layout(location = 0) out vec4 fragColor;

const vec3 HULL = vec3(0.30, 0.32, 0.36);
// Direct sun on the hull, muted hard: at three kilometres through this much
// air the beam has no business lighting panels like noon — the fleet should
// read as hazy silhouette from every bearing, not just the backlit one.
// Front-lit at full sunColor it blew out, and the bloom smeared the blowout
// into the "blurry, pixelated" fleet.
const float SUN_MUTE = 0.30;

void main() {
    // Flat facets from the surface itself. The cross's sign depends on
    // winding the bake did not preserve, so face the viewer — correct for
    // any opaque hull, and it costs one compare.
    vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    vec3 V = normalize(cameraPos - vWorld);
    if (dot(N, V) < 0.0) N = -N;

    float ndl = max(dot(N, sunDir), 0.0);
    // A touch of wrap so the terminator is not a hard line at this scale,
    // and a hemisphere weight on the ambient so the underside reads dark
    // against the bright sky behind it.
    float wrap = clamp((dot(N, sunDir) + 0.25) / 1.25, 0.0, 1.0);
    vec3 color = HULL * (sunColor * SUN_MUTE * mix(ndl, wrap, 0.35)
        + ambientSky * (0.35 + 0.65 * (N.y * 0.5 + 0.5)));

    color = applyAerial(
        color, cameraPos, vWorld, -V, sunDir,
        skyLUT, sunColor,
        fogDensity, fogHeightFalloff, fogStart,
        aerialStrength
    );

    fragColor = vec4(color, 1.0);
}
