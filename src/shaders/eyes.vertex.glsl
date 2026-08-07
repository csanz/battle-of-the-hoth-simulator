// The walkers' viewport bands: one thin red bar per machine, pinned across
// the head's face and riding its look. Same lattice trick as the markers —
// the mesh carries only (bandIndex, u, v); where a band is, which way it
// runs, and how big it stands live in two texels rewritten per frame.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;   // (bandIndex, corner u -1|+1, corner v -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform sampler2D eyeTex;

out vec2 vUV;
out float vFade;
out float vSeed;

void main() {
    int id = int(position.x + 0.5);
    vec4 a = texelFetch(eyeTex, ivec2(id, 0), 0); // centre xyz, halfLen (0 = dead)
    vec4 b = texelFetch(eyeTex, ivec2(id, 1), 0); // band axis xyz, halfHeight

    bool dead = a.w <= 0.0;

    // Cylindrical billboard: the bar keeps its axis — the head's own right,
    // handed in — and only its height turns toward the camera, so the strip
    // stays a strip from any bearing and forshortens honestly edge-on.
    vec3 toEye = cameraPos - a.xyz;
    float d2 = dot(toEye, toEye);
    vec3 eye = d2 > 1e-8 ? toEye * inversesqrt(d2) : vec3(0.0, 0.0, 1.0);
    vec3 up = cross(eye, b.xyz);
    float ul = length(up);
    up = ul > 1e-5 ? up / ul : vec3(0.0, 1.0, 0.0);

    // True size, and a fade with range: the originals' viewports are dim —
    // a detail you earn by closing on the machine, not a beacon. By 300 m
    // the band has dissolved into the haze with the rest of the head.
    float dist = sqrt(d2);
    vFade = 1.0 - smoothstep(110.0, 300.0, dist);

    vec3 world = a.xyz
        + b.xyz * (position.y * a.w)
        + up * (position.z * b.w);
    vUV = position.yz;
    vSeed = float(id);

    vec4 clip = viewProjection * vec4(world, 1.0);
    gl_Position = dead ? vec4(0.0, 0.0, -2.0, 1.0) : clip;
}
