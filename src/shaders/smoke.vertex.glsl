// Damage smoke and fire: soft billboarded puffs off a wounded craft. The
// same data-texture lattice as the markers — the mesh carries only
// (puffIndex, u, v); position, size and colour live in two texels each,
// rewritten per frame by the CPU sim.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;   // (puffIndex, corner u -1|+1, corner v -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform sampler2D puffTex;

out vec2 vUV;
out vec4 vColor;

void main() {
    int id = int(position.x + 0.5);
    vec4 a = texelFetch(puffTex, ivec2(id, 0), 0); // centre xyz, radius (0 = dead)
    vec4 b = texelFetch(puffTex, ivec2(id, 1), 0); // premultiplied-ish rgb, alpha

    bool dead = a.w <= 0.0;

    vec3 toEye = cameraPos - a.xyz;
    float d2 = dot(toEye, toEye);
    vec3 eye = d2 > 1e-8 ? toEye * inversesqrt(d2) : vec3(0.0, 0.0, 1.0);
    vec3 refUp = abs(eye.y) > 0.94 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
    vec3 right = normalize(cross(refUp, eye));
    vec3 up = cross(eye, right);

    vec3 world = a.xyz + (right * position.y + up * position.z) * a.w;
    vUV = position.yz;
    vColor = b;

    vec4 clip = viewProjection * vec4(world, 1.0);
    gl_Position = dead ? vec4(0.0, 0.0, -2.0, 1.0) : clip;
}
