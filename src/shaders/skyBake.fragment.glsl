// Bakes the atmospheric scattering integral into an equirectangular LUT.
// Re-run only when the sun moves, never per frame.
precision highp float;
precision highp int;

in vec2 vUV;

uniform vec3 sunDir;
uniform float sunIntensity;
uniform vec3 groundBounce;

layout(location = 0) out vec4 fragColor;

#include<snowNoise>
#include<snowAtmosphere>

void main() {
    vec3 dir = latLongToDir(vUV);
    vec3 col = nishitaSky(dir, sunDir, sunIntensity, groundBounce);

    // The solar disc itself is kept out of nishitaSky so the IBL projection can
    // use the same LUT without a 100,000x spike blowing out the SH fit.
    fragColor = vec4(col, 1.0);
}
