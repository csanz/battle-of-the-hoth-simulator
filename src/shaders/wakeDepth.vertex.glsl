// Shadow-pass vertex shader for the surf wake.
//
// Runs the identical `wakePoint` out of the shared include, so the surface in the
// depth map is the surface being drawn. The erosion has to travel with it — the
// fragment stage below discards the same texels — or the wake would cast the
// shadow of a solid wall it is not actually rendering, which on a crest that is
// half powder is the difference between a shadow and a stripe.

precision highp float;
precision highp int;

in vec3 position;   // (column, row, side)

uniform mat4 lightViewProjection;
uniform float wakeCount;
uniform float wakeCols;
uniform float wakeRows;
uniform float wakeTime;

uniform highp sampler2D wakeTex;

out float vQ;
out float vAlong;
out float vAge;
/// Carried through rather than declared again in the fragment stage, so the two
/// halves of the depth pass cannot end up eroding at different moments.
out float vTime;

#include<snowNoise>
#include<snowWake>

void main() {
    float side = position.z;
    float u = position.x / max(wakeCols - 1.0, 1.0);
    float q = position.y / max(wakeRows - 1.0, 1.0);

    vec3 P = wakePoint(wakeTex, wakeCount, u, q, side, wakeTime);
    vec4 sc = wakeScalars(wakeTex, wakeCount, u, side);

    vQ = q;
    vAlong = sc.z;
    vAge = sc.w;
    vTime = wakeTime;
    gl_Position = lightViewProjection * vec4(P, 1.0);
}
