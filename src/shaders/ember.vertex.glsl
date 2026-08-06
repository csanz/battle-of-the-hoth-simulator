// Ember streaks off a shellburst: each ember is a camera-facing quad stretched
// along its own velocity — the motion-blur read that makes fast glowing debris
// look thrown rather than sprinkled. The quad shortens as the ember slows and
// collapses when it dies, same discard-by-clip trick as the bolts.

precision highp float;
precision highp int;

in vec3 position;   // head position, world — duplicated across the 4 corners
in vec3 aVel;       // world velocity, ditto
in vec3 aData;      // (life 0..1, size, seed)
in vec2 aCorner;    // (0 head | 1 tail, -1 | +1 across)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform float emberTime;

out vec2 vC;
out float vLife;
out float vFlick;

void main() {
    vLife = aData.x;
    vC = aCorner;
    if (vLife <= 0.0) {
        gl_Position = vec4(0.0, 0.0, -2.0, 1.0);
        return;
    }
    float vl = length(aVel);
    vec3 axis = vl > 0.001 ? aVel / vl : vec3(0.0, 1.0, 0.0);
    float len = clamp(vl * 0.1, 0.05, 1.7);
    vec3 viewDir = normalize(cameraPos - position);
    vec3 side = normalize(cross(axis, viewDir));
    float w = 0.017 * aData.y * (0.55 + 0.45 * vLife);
    vec3 p = position - axis * len * aCorner.x + side * w * aCorner.y;
    // Each ember burns at its own frequency — uniformity is what reads as fake.
    vFlick = 0.72 + 0.5 * sin(emberTime * (22.0 + aData.z * 26.0) + aData.z * 43.0);
    gl_Position = viewProjection * vec4(p, 1.0);
}
