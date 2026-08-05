// Shadow-pass vertex shader for the terrain.
//
// Critically, this uses the *camera* position to place the clipmap, not the
// light — the geometry rendered into the shadow map must be the identical mesh
// the beauty pass draws, or the depths will not correspond and the terrain will
// acne against its own silhouette. Only the view-projection differs.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;

uniform mat4 lightViewProjection;
uniform vec3 cameraPos;
/// Clipmap ring centre — the character, matching snow.vertex.glsl exactly.
uniform vec2 lodCenter;

uniform float baseSpacing;
uniform float gridHalfN;

uniform vec2 worldOrigin;
uniform float worldSize;
uniform float heightRes;

uniform float windAngle;
uniform float sastrugiAmp;

uniform vec2 deformCenter;
uniform float deformSize;
uniform float deformDepthScale;

uniform sampler2D heightTex;
uniform sampler2D auxTex;
uniform sampler2D deformTex;

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowClipmap>

void main() {
    vec2 grid = vec2(position.x, position.z);
    float level = position.y;

    ClipmapVertex cv = placeClipmapVertex(
        grid, level, lodCenter,
        baseSpacing, gridHalfN
    );

    vec2 worldXZ = cv.worldXZ;
    vec2 hUV = worldToHeightUV(worldXZ, worldOrigin, worldSize);

    float h = sampleHeightBicubic(heightTex, hUV, heightRes);

    float exposure = textureLod(auxTex, hUV, 0.0).a;
    if (cv.spacing < 0.42) {
        float fade = 1.0 - smoothstep(0.16, 0.42, cv.spacing);
        h += terrainFine(worldXZ, windAngle, exposure, sastrugiAmp).x * fade;
    }

    // Carved snow must cast and receive its own shadow, so the depth pass has to
    // see the deformation too. A trail that does not self-shadow reads as a
    // decal painted on flat ground.
    //
    // This gate, the fade and the filter width have to match snow.vertex.glsl
    // exactly. If this pass displaced on a ring the beauty pass left flat — or
    // band-limited it differently — the terrain would shadow against a surface
    // that is not the one being drawn, and every berm would acne.
    if (cv.spacing < 1.0) {
        float dfade = 1.0 - smoothstep(0.5, 1.0, cv.spacing);
        h += deformHeight(
            deformTex, worldXZ,
            deformCenter, deformSize, deformDepthScale,
            cv.spacing
        ) * dfade;
    }

    gl_Position = lightViewProjection * vec4(worldXZ.x, h, worldXZ.y, 1.0);
}
