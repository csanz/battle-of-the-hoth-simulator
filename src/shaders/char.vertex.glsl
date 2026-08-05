// The body: linear blend skinning straight out of the transform texture.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowCharSkin>

in vec3 position;   // bind-pose world position
in vec3 normal;     // bind-pose world normal
in vec2 uv;         // weave coordinates
in vec2 aux;        // (material id, baked occlusion)
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 viewProjection;
uniform vec3 cameraPos;

uniform sampler2D charTex;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec2 vAux;
out float vViewDist;

void main() {
    vec3 world = skinPoint(charTex, boneIdx, boneWt, position);
    vec3 n = skinNormal(charTex, boneIdx, boneWt, normal);

    vWorld = world;
    vNormal = n;
    vUV = uv;
    vAux = aux;
    vViewDist = distance(world, cameraPos);
    gl_Position = viewProjection * vec4(world, 1.0);
}
