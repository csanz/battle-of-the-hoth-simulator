// Shellburst fireballs: a tiny pool of camera-facing billboards, each one the
// bounding quad of a raymarched volume. The vertex program's whole job is to
// hold a square of the right size at the right place and hand the fragment
// stage a world-space ray; everything the explosion *looks* like happens there.
//
// Same conventions as the bolts: a dead slot collapses behind the near plane,
// which the rasteriser discards for free.

precision highp float;
precision highp int;

in vec3 position;   // (slot, cornerX -1|+1, cornerY -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
/// (centre xyz, max radius R) per slot.
uniform vec4 expPos[3];
/// (life 0..1, seed, seconds since detonation, unused) per slot.
uniform vec4 expAnim[3];

out vec3 vWorld;
out vec3 vCenter;
out float vR;
out float vT;
out float vSeed;
out float vTime;
out float vSteps;

void main() {
    int slot = int(position.x + 0.5);
    vec4 p = expPos[slot];
    vec4 a = expAnim[slot];

    if (a.x <= 0.0 || a.x >= 1.0) {
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        return;
    }

    vCenter = p.xyz;
    vR = p.w;
    vT = a.x;
    vSeed = a.y;
    vTime = a.z;

    // March budget by distance. The fragment cost is steps x pixels, and the
    // pixel count explodes as the burst nears the camera — a point-blank
    // fireball covers the frame. Fewer, coarser steps up close cost nothing
    // the eye would keep (the volume is sweeping past too fast to study) and
    // halve the worst-case frame; at range the full count carries the detail
    // the small quad actually shows.
    float camD = distance(cameraPos, p.xyz);
    vSteps = clamp(mix(18.0, 40.0, (camD - 12.0) / 60.0), 18.0, 40.0);

    // A camera-facing square generously past the volume bound (1.3 R), so the
    // lobes the density noise pushes outside the unit sphere never clip.
    vec3 toEye = normalize(cameraPos - p.xyz);
    vec3 right = normalize(cross(vec3(0.0, 1.0, 0.0), toEye));
    vec3 up = cross(toEye, right);
    float half_ = p.w * 1.45;
    vWorld = p.xyz + right * position.y * half_ + up * position.z * half_;

    gl_Position = viewProjection * vec4(vWorld, 1.0);
}
