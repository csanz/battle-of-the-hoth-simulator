// Shadow-pass vertex shader for the walker.
//
// The identical skinning path as walker.vertex.glsl, from the same include, so
// the surface in the depth map is the surface being drawn. Only the matrix it is
// projected by differs.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowWalkerSkin>

in vec3 position;
in vec4 boneIdx;
in vec4 boneWt;

uniform mat4 lightViewProjection;

/// First of this walker's four rows in the shared transform texture.
uniform float boneRow;

uniform sampler2D walkerTex;

void main() {
    WalkerXform m = walkerXform(walkerTex, int(boneRow), boneIdx, boneWt);
    vec3 world = walkerPoint(m, position);
    gl_Position = lightViewProjection * vec4(world, 1.0);
}
