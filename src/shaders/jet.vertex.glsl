// Engine exhaust: a stack of camera-facing quads behind each nozzle.
//
// Same idea as the bolts and for the same reason — the mesh is a lattice
// carrying `(plumeIndex, t along the plume, side)` and nothing else, and where
// the plume is comes from a handful of uniforms rewritten each frame. Two
// engines and eight rungs is thirty-two triangles, so this costs a draw call and
// nothing else.

precision highp float;
precision highp int;

in vec3 position;   // (nozzleIndex, t 0..1, side -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
/// Nozzle origins in world space, one per engine.
uniform vec4 jetOrigin[2];
/// Direction the plume blows, and its length in w.
uniform vec4 jetDir;
/// (throttle 0..1, time, width, flare)
uniform vec4 jetParams;

out float vT;
out float vSide;
out float vThrottle;

void main() {
    int id = int(position.x + 0.5);
    float t = position.y;
    float side = position.z;

    float throttle = jetParams.x;
    float time = jetParams.y;
    vec3 dir = normalize(jetDir.xyz);
    vec3 origin = jetOrigin[id].xyz;

    // The plume lengthens with throttle and wanders: a slow sine on each axis,
    // offset per engine, so the two do not pulse together. This is most of what
    // reads as turbulence — the shape moving, not the colour.
    // A stub at idle and a full plume on the boost. The curve is deliberately
    // slow to start and fast to finish: most of the visible growth should happen
    // in the top third of the throttle, which is the part shift owns.
    float t2 = throttle * throttle;
    float len = jetDir.w * (0.14 + 0.86 * t2);
    float wobble = sin(time * 9.0 + t * 7.0 + float(id) * 2.3) * 0.06 * t
                 + sin(time * 13.7 + t * 4.0) * 0.04 * t;

    vec3 toEye = normalize(cameraPos - origin);
    vec3 wide = cross(dir, toEye);
    float wl = length(wide);
    wide = (wl > 1e-4) ? wide / max(wl, 1e-6) : vec3(0.0, 1.0, 0.0);
    vec3 up = normalize(cross(wide, dir));

    // Flares out along its length, tapering again at the very tip.
    float flare = jetParams.z
        * (0.55 + jetParams.w * t) * (1.0 - t * t * 0.55);

    vec3 along = origin + dir * (len * t);
    vec3 world = along + wide * (side * flare + wobble) + up * wobble * 0.6;

    vT = t;
    vSide = side;
    vThrottle = throttle;
    gl_Position = viewProjection * vec4(world, 1.0);
}
