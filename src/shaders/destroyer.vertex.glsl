// Capital ships on the horizon. Position-only geometry — the fragment stage
// derives flat facet normals from screen derivatives, which is the right look
// for a hard-panelled hull and lets the baked mesh carry nothing but points.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;

uniform mat4 model;
uniform mat4 viewProjection;

out vec3 vWorld;

void main() {
    vec4 w = model * vec4(position, 1.0);
    vWorld = w.xyz;
    gl_Position = viewProjection * w;
}
