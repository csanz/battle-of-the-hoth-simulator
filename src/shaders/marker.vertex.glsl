// Muzzle-tuning markers: camera-facing rings placed from a data texture, one
// ring pinned to each point a cannon bolt is born at. Pure tooling — they draw
// only while the overlay's "Muzzle markers" toggle is on — but they go through
// the same registry/material path as everything else so the compile is honest.
//
// Same lattice trick as the bolts: the mesh carries only (markerIndex, u, v)
// and where a marker actually *is* lives in two texels rewritten per frame.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;   // (markerIndex, corner u -1|+1, corner v -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform sampler2D markerTex;

out vec2 vUV;
out vec3 vColor;

void main() {
    int id = int(position.x + 0.5);
    vec4 a = texelFetch(markerTex, ivec2(id, 0), 0); // centre xyz, radius (0 = dead)
    vec4 b = texelFetch(markerTex, ivec2(id, 1), 0); // ring colour

    bool dead = a.w <= 0.0;

    // Billboard basis from the line of sight. Straight above/below the marker
    // the up reference degenerates, so swap it — at that angle any perpendicular
    // pair reads the same.
    vec3 toEye = cameraPos - a.xyz;
    float d2 = dot(toEye, toEye);
    vec3 eye = d2 > 1e-8 ? toEye * inversesqrt(d2) : vec3(0.0, 0.0, 1.0);
    vec3 refUp = abs(eye.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(refUp, eye));
    vec3 up = cross(eye, right);

    // A touch of growth with distance, so a walker's gun head across the field
    // still shows a findable ring without the near ones dominating the view.
    float r = a.w * (1.0 + sqrt(d2) * 0.02);

    vec3 world = a.xyz + (right * position.y + up * position.z) * r;
    vUV = position.yz;
    vColor = b.rgb;

    vec4 clip = viewProjection * vec4(world, 1.0);
    gl_Position = dead ? vec4(0.0, 0.0, -2.0, 1.0) : clip;
}
