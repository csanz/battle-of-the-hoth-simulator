// Cannon bolts: a pool of camera-facing ribbons, placed entirely from a data
// texture.
//
// The mesh is a fixed lattice of quads carrying nothing but `(boltIndex, t,
// side)` — where along the bolt and which edge — exactly as the wake and the
// spray are. Where a bolt actually *is* lives in two texels, rewritten on the
// frames one is fired, so a shot costs no buffer upload and no allocation.
//
// The source's "no early return" note was Babylon-WGSL-specific; the structure
// is kept regardless, and so are the two guards that matter: a dead slot's
// direction is substituted *before* normalize (a zero vector's NaN spreads to
// the whole primitive), and a dead bolt's clip position is collapsed behind the
// near plane, which the rasteriser discards for free.

precision highp float;
precision highp int;
precision highp sampler2D;

in vec3 position;   // (boltIndex, t along the bolt 0..1, side -1|+1)

uniform mat4 viewProjection;
uniform vec3 cameraPos;
/// Metres. Bolt half-width at the core, before the taper.
uniform float boltWidth;
/// Metres the bolt covers over its whole life.
uniform float boltReach;

uniform sampler2D boltTex;

out float vT;
out float vSide;
out float vLife;

void main() {
    int id = int(position.x + 0.5);
    float t = position.y;
    float side = position.z;

    vec4 a = texelFetch(boltTex, ivec2(id, 0), 0); // origin, life 0..1
    vec4 b = texelFetch(boltTex, ivec2(id, 1), 0); // direction, ribbon length

    float life = a.w;
    bool dead = life <= 0.0;

    // An empty slot holds zeroes, and normalising a zero vector is a NaN that
    // spreads to the whole primitive — so the direction is substituted before it
    // is used rather than after.
    vec3 raw = (dead || dot(b.xyz, b.xyz) < 1e-8) ? vec3(0.0, 0.0, 1.0) : b.xyz;
    vec3 dir = normalize(raw);

    // Down the barrel and away. `life` runs 1 -> 0, so `1 - life` is how far
    // through the flight it is. The *tip* rides the travel point and the
    // ribbon trails behind it, clipped at the muzzle — so a fresh bolt grows
    // out of the barrel instead of materialising a ribbon-length ahead of it,
    // and the crater fires exactly as the tip touches the snow.
    float travel = boltReach * clamp(1.0 - life, 0.0, 1.0);
    float headD = travel;
    float tailD = max(travel - max(b.w, 1.0), 0.0);
    vec3 tail = a.xyz + dir * tailD;
    vec3 head = a.xyz + dir * headD;
    vec3 world = mix(tail, head, t);

    // Face the camera: the ribbon's width axis is perpendicular to both the bolt
    // and the line of sight, which is the one orientation that never shows the
    // quad edge-on.
    vec3 toEye = normalize(cameraPos - world);
    vec3 cw = cross(dir, toEye);
    float len = length(cw);
    // Looking straight down the barrel there is no such axis; any perpendicular
    // will do, and at that angle the bolt is a dot regardless.
    vec3 fallback = normalize(vec3(-dir.z, 0.0, dir.x) + vec3(1e-4, 0.0, 0.0));
    vec3 wide = (len > 1e-4) ? (cw / max(len, 1e-6)) : fallback;

    // Tapered at both ends, fattest a third of the way along.
    float taper = sin(clamp(t, 0.0, 1.0) * 3.14159265) * 0.55 + 0.45;
    float w = boltWidth * taper * (0.35 + 0.65 * life);

    vT = t;
    vSide = side;
    vLife = dead ? 0.0 : life;

    vec4 clip = viewProjection * vec4(world + wide * side * w, 1.0);
    gl_Position = dead ? vec4(0.0, 0.0, -2.0, 1.0) : clip;
}
