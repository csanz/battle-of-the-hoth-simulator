precision highp float;
precision highp int;
precision highp sampler2D;

// position packs the clipmap addressing: (gridI, ringLevel, gridJ).
in vec3 position;

uniform mat4 viewProjection;
uniform vec3 cameraPos;

/// Where the clipmap rings are centred — the *character*, not the camera.
///
/// This is the whole reason carved snow holds still while you orbit. Ring 0 is
/// 6.8 m of half-extent and the spring arm sits 3-11 m behind the character, so
/// centring on the camera put the snow directly under the player right on the
/// ring 0 / ring 1 boundary: swinging the camera round re-sampled it between
/// 0.085 m and 0.17 m spacing and the trail visibly changed shape. Centring on
/// the character makes vertex placement a function of world position and player
/// position only, so no camera motion can alter the geometry.
///
/// The cost is that the ground under a fully zoomed-out camera is one ring
/// coarser than it would otherwise be. The camera never leaves ring 1, and it is
/// looking away from that ground anyway.
uniform vec2 lodCenter;

uniform float baseSpacing;
uniform float gridHalfN;

uniform vec2 worldOrigin;
uniform float worldSize;
uniform float heightRes;

uniform float windAngle;
uniform float macroAmp;
uniform float sastrugiAmp;

uniform vec2 deformCenter;
uniform float deformSize;
uniform float deformDepthScale;

uniform sampler2D heightTex;
uniform sampler2D auxTex;
uniform sampler2D deformTex;

out vec3 vWorld;
out vec2 vHeightUV;
out float vViewDist;
out float vSpacing;

#include<snowNoise>
#include<snowTerrain>
#include<snowDeform>
#include<snowClipmap>

void main() {
    vec2 grid = vec2(position.x, position.z);
    float level = position.y;

    ClipmapVertex cv = placeClipmapVertex(
        grid,
        level,
        lodCenter,
        baseSpacing,
        gridHalfN
    );

    vec2 worldXZ = cv.worldXZ;
    vec2 hUV = worldToHeightUV(worldXZ, worldOrigin, worldSize);

    // --- macro height ------------------------------------------------------
    float h = sampleHeightBicubic(heightTex, hUV, heightRes);

    // --- fine height -------------------------------------------------------
    // Displaced only where the ring is fine enough to resolve it. Past roughly
    // 40 cm spacing the sastrugi is smaller than a triangle, and displacing it
    // there would just alias — the fragment shader keeps carrying it in the
    // normal, which is where it still reads.
    float exposure = textureLod(auxTex, hUV, 0.0).a;
    if (cv.spacing < 0.42) {
        float fade = 1.0 - smoothstep(0.16, 0.42, cv.spacing);
        h += terrainFine(worldXZ, windAngle, exposure, sastrugiAmp).x * fade;
    }

    // --- deformation -------------------------------------------------------
    // Real displacement, not a normal-map trick: a trench the player can see the
    // far wall of, and berms that break the silhouette against the sky. The
    // fragment shader carries the sub-vertex detail on top.
    //
    // Reaches much further out than the fine layer above, and deliberately so.
    // Sastrugi is a 2 m wavelength at +/-12 cm, so past 0.42 m spacing it is
    // smaller than a triangle and there is nothing to be done but drop it. A
    // trail is the opposite shape of problem — half a metre wide but up to half a
    // metre deep — so it is worth displacing well past the point where the
    // lattice resolves its walls, provided it is band-limited on the way in.
    //
    // `deformHeight` does that filtering from `cv.spacing`, which is what keeps
    // the groove smooth instead of faceted when a ring boundary sweeps across it.
    // The remaining fade only cleans up the tail, where the filter has flattened
    // the trench to nearly nothing anyway.
    //
    // This gate and the filter argument must be mirrored exactly in
    // terrainDepth.vertex.glsl, or the terrain will shadow against a surface it
    // is not drawing.
    if (cv.spacing < 1.0) {
        float dfade = 1.0 - smoothstep(0.5, 1.0, cv.spacing);
        h += deformHeight(
            deformTex, worldXZ,
            deformCenter, deformSize, deformDepthScale,
            cv.spacing
        ) * dfade;
    }

    vec3 world = vec3(worldXZ.x, h, worldXZ.y);

    vWorld = world;
    vHeightUV = hUV;
    vViewDist = distance(world, cameraPos);
    vSpacing = cv.spacing;

    gl_Position = viewProjection * vec4(world, 1.0);
}
