// Depth-prepass vertex shader for the ice formations. Same `crystalPoint` and
// the same growth curve as the beauty pass.
//
// This is the one caster that writes a non-zero specular mask, and it is the
// reason the mask exists: ice is the only mirror in a field of matte snow, so
// the reflection pass can early-out on the mask and cost nothing at all on every
// frame where nobody has cast Crystallise.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowCrystal>

in vec3 position;   // (crystal, vertex, unused)

uniform mat4 viewProjection;

uniform sampler2D crystalTex;

out float vViewZ;
out float vMask;

void main() {
    int i = int(position.x);
    int v = int(position.y);
    vec3 P = crystalPoint(crystalTex, i, v);
    vec4 clip = viewProjection * vec4(P, 1.0);
    vViewZ = clip.w;
    vMask = 1.0;
    gl_Position = clip;
}
