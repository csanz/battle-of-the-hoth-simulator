// Depth-prepass vertex shader for the skinned body. Same skinning path as
// char.vertex.glsl and charDepth.vertex.glsl, from the same include.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowCharSkin>

in vec3 position;
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 viewProjection;

uniform sampler2D charTex;

out float vViewZ;
out float vMask;

void main() {
    vec3 world = skinPoint(charTex, boneIdx, boneWt, position);
    vec4 clip = viewProjection * vec4(world, 1.0);
    vViewZ = clip.w;
    vMask = 0.0;
    gl_Position = clip;
}
