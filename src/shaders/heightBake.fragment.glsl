// Bakes the macro landform (broad dunes + medium drifts + rock outcrops) into a
// single-channel float texture covering the whole playable field.
//
// Baked rather than evaluated live for one reason: the CPU needs the same
// heights for character grounding, footfall placement and spell hit points, and
// reading back a GPU bake is the only way to guarantee the two never disagree.
// Re-implementing the noise in JS would drift the moment f32 and f64 rounding
// diverged, and the character would float or sink by centimetres.

precision highp float;
precision highp int;

in vec2 vUV;

uniform vec2 worldOrigin;
uniform float worldSize;
uniform float windAngle;
uniform float heightAmp;

#include<snowNoise>
#include<snowTerrain>

layout(location = 0) out vec4 fragColor;

void main() {
    vec2 p = worldOrigin + vUV * worldSize;

    float h = terrainMacro(p, windAngle, heightAmp);

    // Rock displaces snow upward; snow then re-accumulates on the flatter faces,
    // which the snow material resolves from the mask in the aux bake.
    vec2 rock = rockField(p, windAngle);
    h += rock.x;

    fragColor = vec4(h, rock.y, 0.0, 1.0);
}
