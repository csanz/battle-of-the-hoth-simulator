// Shadow-pass vertex shader for the garments.
//
// Same Catmull-Rom reconstruction as cloth.vertex.glsl, from the same include.
// A robe that casts the shape of its bind pose while drawing the shape of its
// simulation is worse than no shadow at all.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowCharSkin>

in vec3 position;   // (u, v, panel index)

uniform mat4 lightViewProjection;
uniform vec4 panelParams[6];

uniform sampler2D charTex;

void main() {
    vec4 pp = panelParams[clamp(int(position.z), 0, 5)];
    ClothSample s = sampleCloth(
        charTex, int(pp.x), int(pp.y), int(pp.z),
        position.x, position.y
    );
    gl_Position = lightViewProjection * vec4(s.pos, 1.0);
}
