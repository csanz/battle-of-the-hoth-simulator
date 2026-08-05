// Crystallise — ice formation, vertex placement.
//
// `position` is (crystalIndex, vertexIndex, 0) and carries no geometry, exactly
// as every other data-driven mesh here. Ninety-six crystals are one draw and a
// 3 x 96 upload.
//
// No normal is emitted. The fragment shader takes it from the derivatives of the
// world position, which gives exact flat facets for free — and a facet is what an
// ice crystal is. Interpolated vertex normals would round the edges off and turn
// a crystal into a lumpy cone, which is the one thing it must not look like.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowCrystal>

in vec3 position;   // (crystal, vertex, unused)

uniform mat4 viewProjection;
uniform vec3 cameraPos;

uniform sampler2D crystalTex;

out vec3 vWorld;
out vec3 vBase;
out float vHeight01;
out float vSeed;
out float vGrowth;
out float vViewDist;

void main() {
    int i = int(position.x);
    int v = int(position.y);

    vec4 a = texelFetch(crystalTex, ivec2(i, 0), 0);
    vec4 c = texelFetch(crystalTex, ivec2(i, 2), 0);

    vec3 P = crystalPoint(crystalTex, i, v);

    vWorld = P;
    vBase = a.xyz;
    // Fraction of the way up the crystal, which is what the frost and the
    // absorption path are both keyed to: the base is buried in the drift and
    // milky, the tip is clear and lit through.
    vHeight01 = clamp((P.y - a.y) / max(a.w, 1e-3), 0.0, 1.0);
    vSeed = c.y;
    vGrowth = c.x;
    vViewDist = distance(P, cameraPos);
    gl_Position = viewProjection * vec4(P, 1.0);
}
