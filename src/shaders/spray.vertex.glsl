// Snow spray billboards.
//
// The mesh carries no geometry: `position` is (particle index, cornerX, cornerY)
// and every corner is placed here from the particle data texture. That keeps the
// vertex buffer static and the per-frame traffic down to eight floats per live
// grain.

precision highp float;
precision highp int;

in vec3 position;

uniform mat4 viewProjection;
uniform vec3 cameraPos;
uniform vec3 camRight;
uniform vec3 camUp;

uniform highp sampler2D sprayTex;

out vec3 vWorld;
out vec2 vCorner;
out vec4 vState;   // (age01, seed, kind, alpha)
out float vViewDist;

void main() {
    int i = int(position.x);
    vec2 corner = position.yz;

    vec4 a = texelFetch(sprayTex, ivec2(i, 0), 0);
    vec4 b = texelFetch(sprayTex, ivec2(i, 1), 0);

    // A dead grain has size zero, which collapses all four corners onto one
    // point. The rasteriser then produces no fragments at all, which is a
    // cheaper way to skip a particle than any branch would be.
    float radius = a.w;

    // Spin, hashed off the seed, so a burst is not four hundred identical
    // discs. Rotating the *corner* rather than the texture keeps the billboard
    // square-free.
    float ang = b.y * 6.28318530718 + b.x * (b.y - 0.5) * 3.0;
    float cs = cos(ang);
    float sn = sin(ang);
    vec2 rc = vec2(corner.x * cs - corner.y * sn, corner.x * sn + corner.y * cs);

    vec3 world = a.xyz + (camRight * rc.x + camUp * rc.y) * radius;

    vWorld = world;
    vCorner = corner;
    vState = b;
    vViewDist = distance(world, cameraPos);
    gl_Position = viewProjection * vec4(world, 1.0);
}
