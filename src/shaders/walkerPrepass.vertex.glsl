// Depth-prepass vertex shader for the walker. Same skinning path as
// walker.vertex.glsl and walkerDepth.vertex.glsl, from the same include.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowWalkerSkin>

in vec3 position;
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 viewProjection;

/// First of this walker's four rows in the shared transform texture.
uniform float boneRow;

uniform sampler2D walkerTex;

out float vViewZ;
out float vMask;

void main() {
    WalkerXform m = walkerXform(walkerTex, int(boneRow), boneIdx, boneWt);
    vec3 world = walkerPoint(m, position);
    vec4 clip = viewProjection * vec4(world, 1.0);
    vViewZ = clip.w;
    vMask = 0.0;
    gl_Position = clip;
}
