// Shadow-pass vertex shader for the ice formations.
//
// Runs the identical `crystalPoint` out of the shared include, so the shape in
// the depth map is the shape being drawn — including the growth curve, which
// matters because the shadow has to grow with the crystal rather than snapping
// to full size on the frame it is planted.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowCrystal>

in vec3 position;   // (crystal, vertex, unused)

uniform mat4 lightViewProjection;

uniform sampler2D crystalTex;

void main() {
    int i = int(position.x);
    int v = int(position.y);
    vec3 P = crystalPoint(crystalTex, i, v);
    gl_Position = lightViewProjection * vec4(P, 1.0);
}
