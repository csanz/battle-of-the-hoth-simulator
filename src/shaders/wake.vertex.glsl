// The snow-surf wake.
//
// The mesh carries no geometry: `position` is (column, row, side) and every
// vertex is placed here from the spine data texture, exactly as the spray
// billboards are. So a wake that is 19 m long one frame and 2 m long the next
// costs the same static vertex buffer and one 3 x 96 texture upload.
//
// Normals come from differencing the surface rather than from an analytic
// tangent frame. The surface is a sweep with a per-sample amplitude envelope, a
// backward shear and a lump field on top, and the analytic normal for all of
// that together is both long and easy to get subtly wrong. Three evaluations of
// `wakePoint` cost less than the vertex shader spends on the spine fetch, and
// they cannot disagree with the geometry because they *are* the geometry.

precision highp float;
precision highp int;

in vec3 position;   // (column, row, side)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform float wakeCount;
uniform float wakeCols;
uniform float wakeRows;
uniform float wakeTime;

uniform highp sampler2D wakeTex;

out vec3 vWorld;
out vec3 vNormal;
out float vQ;
out float vAlong;
out float vAge;
out float vAmp;
out float vCurl;
out float vViewDist;

#include<snowNoise>
#include<snowWake>

void main() {
    float side = position.z;
    float u = position.x / max(wakeCols - 1.0, 1.0);
    float q = position.y / max(wakeRows - 1.0, 1.0);

    float tm = wakeTime;
    vec3 P = wakePoint(wakeTex, wakeCount, u, q, side, tm);

    // Central-ish differences. The offset flips sign near either edge of the
    // patch so the pair never straddles a clamp, which would silently return a
    // zero-length tangent and a NaN normal on the boundary column.
    float du = 0.65 / max(wakeCols - 1.0, 1.0);
    float dq = 0.65 / max(wakeRows - 1.0, 1.0);
    float su = u > 0.5 ? -1.0 : 1.0;
    float sq = q > 0.5 ? -1.0 : 1.0;

    vec3 Pu = (wakePoint(wakeTex, wakeCount, u + du * su, q, side, tm) - P) * su;
    vec3 Pq = (wakePoint(wakeTex, wakeCount, u, q + dq * sq, side, tm) - P) * sq;

    // The `* side` is not cosmetic, and leaving it out is a bug that hides.
    //
    // The two walls are mirror images, and mirroring a parametric surface
    // reverses the handedness of its tangent pair — so `cross(Pq, Pu)` points to
    // the concave side of the right-hand wall and to the *convex* side of the
    // left-hand one. The fragment shader turns the normal toward the eye before
    // shading, so the lit result looked fine and the error was invisible in the
    // BRDF. What it was not invisible in was the one thing that asks the normal
    // which side of the sheet it is on: the barrel occlusion landed on the open
    // outer face of the left wall and left the inside of the curl unshaded. One
    // wall dark on the wrong side, the other correct — which is exactly how it
    // presented.
    vec3 N = cross(Pq, Pu) * side;
    float nl = length(N);
    // Degenerate where the amplitude envelope has collapsed the strip onto its
    // own spine — the tail, and the frames just after the player lets go.
    N = nl > 1e-7 ? N / max(nl, 1e-8) : vec3(0.0, 1.0, 0.0);

    vec4 sc = wakeScalars(wakeTex, wakeCount, u, side);

    vWorld = P;
    vNormal = N;
    vQ = q;
    vAlong = sc.z;
    vAge = sc.w;
    vAmp = sc.x;
    vCurl = sc.y;
    vViewDist = distance(P, cameraPos);
    gl_Position = viewProjection * vec4(P, 1.0);
}
