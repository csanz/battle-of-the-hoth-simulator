// Spell water — vertex placement.
//
// The mesh carries no geometry. `position` is (column, ring, strand) and every
// vertex is placed here from the strand table, exactly as the wake and the spray
// billboards are. Eight strands share one static buffer and one draw.
//
// Normals are differenced out of `waterPoint` rather than derived analytically.
// The surface is a sweep with a per-sample radius, a transported frame, a
// vertical squash and three octaves of relief on top; the analytic normal for
// all of that is long and easy to get subtly wrong, and three extra evaluations
// cannot disagree with the geometry because they *are* the geometry.
//
// A strand that is not in use is switched off by having its table zeroed rather
// than by a branch: radius 0 puts every vertex of it on one point, every triangle
// then has zero area, and the rasteriser produces no fragments. That is cheaper
// than any test, and — more usefully — it means "how many spells are up" never
// changes which pipeline runs or how many draws there are.

precision highp float;
precision highp int;
precision highp sampler2D;

#include<snowNoise>
#include<snowWake>
#include<snowWater>

in vec3 position;   // (column, ring, strand)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform float waterCols;
uniform float waterRings;
uniform float waterTime;
/// Per strand: (profile, milkiness, alpha, column count).
uniform vec4 strandParams[8];

uniform sampler2D waterTex;

out vec3 vWorld;
out vec3 vNormal;
out float vQ;
out float vU;
out float vRadius;
out float vFoam;
out float vMilk;
out float vAlpha;
out float vViewDist;

void main() {
    int strand = int(position.z);
    vec4 sp = strandParams[strand];
    float count = max(sp.w, 2.0);
    int base = strand * 3;

    float u = position.x / max(waterCols - 1.0, 1.0);
    float q = position.y / max(waterRings - 1.0, 1.0);

    float tm = waterTime;

    // A dead strand does none of the work below.
    //
    // Every vertex of the lattice runs this shader whether or not its strand is
    // in use, and the eight strands together are thirty-four thousand vertices
    // each evaluating a swept surface four times. Leaving the dead ones to fall
    // out of the maths — radius zero collapses them anyway — cost 1.4 ms a frame
    // for eight strands' worth of spline fetches to produce nothing. The branch
    // is perfectly wavefront-coherent, since a strand is thousands of contiguous
    // vertices, and the common case in this demo is one strand live out of eight.
    bool alive = sp.z > 0.001 && sp.w >= 2.0;

    vec3 P = vec3(0.0);
    vec3 N = vec3(0.0, 1.0, 0.0);
    float radius = 0.0;
    float foam = 0.0;

    if (alive) {
        P = waterPoint(waterTex, base, count, sp.x, u, q, tm);

        // Central-ish differences, with the offset flipped near either edge of
        // the patch so the pair never straddles a clamp — which would silently
        // return a zero-length tangent and a NaN normal on the boundary column.
        float du = 0.65 / max(waterCols - 1.0, 1.0);
        float dq = 0.65 / max(waterRings - 1.0, 1.0);
        float su = u > 0.5 ? -1.0 : 1.0;
        float sq = q > 0.5 ? -1.0 : 1.0;

        vec3 Pu = (waterPoint(waterTex, base, count, sp.x, u + du * su, q, tm) - P) * su;
        vec3 Pq = (waterPoint(waterTex, base, count, sp.x, u, q + dq * sq, tm) - P) * sq;

        vec3 Nn = cross(Pq, Pu);
        float nl = length(Nn);
        Nn = nl > 1e-7 ? Nn / max(nl, 1e-8) : vec3(0.0, 1.0, 0.0);

        // Orient outward. The tube is a closed surface, and the sign of a
        // differenced cross product on it depends on which way the transported
        // frame happens to wind — so it is resolved against the one thing that
        // cannot be ambiguous: the vector from the spine to the surface. The same
        // test on a sheet is meaningless, and the fragment shader turns that
        // normal toward the eye instead, exactly as the wake does.
        vec3 axis = P - waterSpine(waterTex, base, count, u);
        vec3 outward = dot(Nn, axis) < 0.0 ? -Nn : Nn;
        N = sp.x < 0.5 ? outward : Nn;

        radius = waterRow(waterTex, base, count, u).w;
        foam = waterRow(waterTex, base + 2, count, u).z;
    }

    vWorld = P;
    vNormal = N;
    vQ = q;
    vU = u;
    vRadius = radius;
    vFoam = foam;
    vMilk = sp.y;
    vAlpha = alive ? sp.z : 0.0;
    vViewDist = distance(P, cameraPos);
    gl_Position = viewProjection * vec4(P, 1.0);
}
