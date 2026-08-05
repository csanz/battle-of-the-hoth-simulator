// Depth for the surf wake — the same erosion the beauty pass applies, so the
// depth map holds the eroded crest rather than the solid sheet underneath it.
//
// Writes window-space depth (`gl_FragCoord.z`, 0..1) into the R channel of the
// R32F cascade color target — the port's cascade convention (CONTRACTS §1.5).

precision highp float;
precision highp int;

in float vQ;
in float vAlong;
in float vAge;
in float vTime;

layout(location = 0) out vec4 fragColor;

#include<snowNoise>
#include<snowWake>

void main() {
    if (wakeEroded(vAlong, vQ, vAge, vTime)) { discard; }
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
