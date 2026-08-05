// Depth prepass for the surf wake — the same erosion the beauty pass applies.
// R = linear view depth in metres, G = specular mask left 0 (CONTRACTS §7.9).

precision highp float;
precision highp int;

in float vQ;
in float vAlong;
in float vAge;
in float vTime;
in float vViewZ;

layout(location = 0) out vec4 fragColor;

#include<snowNoise>
#include<snowWake>

void main() {
    if (wakeEroded(vAlong, vQ, vAge, vTime)) { discard; }
    fragColor = vec4(vViewZ, 0.0, 0.0, 1.0);
}
