// The walker: four-influence linear blend skinning out of the transform texture.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowWalkerSkin>

in vec3 position;   // bind-pose position, metres
in vec3 normal;     // bind-pose normal
in vec2 uv;         // the material's own 0-1 chart
in vec2 aux;        // (material slot, spare)
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 viewProjection;
uniform vec3 cameraPos;

/// First of this walker's four rows in the shared transform texture.
uniform float boneRow;

uniform sampler2D walkerTex;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out float vSlot;
out float vViewDist;

void main() {
    WalkerXform m = walkerXform(walkerTex, int(boneRow), boneIdx, boneWt);
    vec3 world = walkerPoint(m, position);

    vWorld = world;
    vNormal = walkerDir(m, normal);
    vUV = uv;
    // Every triangle is wholly inside one material, so all three corners carry
    // the same slot and the interpolation is a no-op. Rounded on the way out
    // regardless, because "a no-op in exact arithmetic" is not a guarantee.
    vSlot = aux.x;
    vViewDist = distance(world, cameraPos);
    gl_Position = viewProjection * vec4(world, 1.0);
}
