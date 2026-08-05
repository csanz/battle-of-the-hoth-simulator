// The garments: surface reconstructed from the simulated node grid.
//
// `position` carries no position at all — it is `(u, v, panelIndex)`. Everything
// spatial comes out of `sampleCloth`, which is why a twenty-by-twelve verlet
// solve can be drawn as a sixty-by-thirty surface with no visible faceting.
//
// Emits the same varyings as char.vertex.glsl so both share one fragment shader.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowCharSkin>

in vec3 position;   // (u, v, panel index)
in vec2 uv;         // weave coordinates
in vec2 aux;        // (material id, baked occlusion)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
/// Per panel: (first row in the transform texture, cols, rows, unused).
uniform vec4 panelParams[6];

uniform sampler2D charTex;

out vec3 vWorld;
out vec3 vNormal;
out vec2 vUV;
out vec2 vAux;
out float vViewDist;

void main() {
    vec4 pp = panelParams[clamp(int(position.z), 0, 5)];
    ClothSample s = sampleCloth(
        charTex, int(pp.x), int(pp.y), int(pp.z),
        position.x, position.y
    );

    vWorld = s.pos;
    vNormal = s.nrm;
    vUV = uv;
    vAux = aux;
    vViewDist = distance(s.pos, cameraPos);
    gl_Position = viewProjection * vec4(s.pos, 1.0);
}
