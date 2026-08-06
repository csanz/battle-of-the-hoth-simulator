// The fireball. A sphere-bounded raymarch of eroding fbm density, tuned
// against the Hoth plates rather than against a physics text:
//
//   shape    low-frequency, high-amplitude noise, so the silhouette is a few
//            big ragged lobes rather than a fuzzy sphere — and squashed
//            slightly wider than tall, the way a ground burst spreads;
//   colour   an orange-dominant film-stock ramp — deep red through saturated
//            orange to a yellow core, white only at the very peak;
//   soot     a second noise channel splits the volume into burning cells and
//            near-black smoke from the first frame. The dark lobes rolling
//            through the fire are most of the look; a fireball that is all
//            flame reads as gas, not ordnance.
//
// The emission runs an order of magnitude above the sunlit snow for the same
// reason the jet's throat does (see jet.fragment.glsl): AgX is deep into its
// shoulder by the snow's ~12, and a fire that does not out-run the field
// reads as a decal on it. The overshoot is what hands the bloom pass a halo.
//
// Output is premultiplied; the material blends ONE / ONE_MINUS_SRC_ALPHA, so
// the march's own front-to-back compositing carries straight into the frame.

precision highp float;
precision highp int;

#include<snowNoise>

in vec3 vWorld;
in vec3 vCenter;
in float vR;
in float vT;
in float vSeed;
in float vTime;

uniform vec3 cameraPos;
uniform vec3 sunDir;
/// Multiplier on the HDR push, 1 = the tuned look.
uniform float explosionGlow;

layout(location = 0) out vec4 fragColor;

const int STEPS = 40;
const vec3 SUNCOL = vec3(2.6, 2.25, 1.85);
const vec3 SKYAMB = vec3(0.34, 0.42, 0.56);

float fbm3(vec3 p, int oct) {
    float s = 0.0;
    float a = 0.5;
    for (int i = 0; i < 4; i++) {
        if (i >= oct) break;
        s += a * noise3(p);
        p = p * 2.07 + vec3(11.3);
        a *= 0.5;
    }
    return s;
}

float density(vec3 p, float tn) {
    vec3 q = (p - vCenter) / vR;
    q.y *= 1.12;                                     // wider than tall
    float r = length(q);
    if (r > 1.3) return 0.0;
    vec3 sp = q * 1.9 + vec3(0.0, -0.5 * vTime, 0.0) + vSeed;
    float n = fbm3(sp, 4);
    float den = (1.05 - r) + (n - 0.5) * 1.55;
    den -= smoothstep(0.45, 1.0, tn) * (0.35 + 0.85 * n);   // noise-led dissolve
    return clamp(den * 1.35, 0.0, 1.0);
}

vec3 fireRamp(float t) {
    vec3 c = mix(vec3(0.04, 0.02, 0.015), vec3(0.55, 0.08, 0.01),
                 smoothstep(0.02, 0.28, t));
    c = mix(c, vec3(1.0, 0.42, 0.05), smoothstep(0.28, 0.58, t));
    c = mix(c, vec3(1.0, 0.72, 0.22), smoothstep(0.58, 0.88, t));
    return mix(c, vec3(1.0, 0.9, 0.62), smoothstep(0.88, 1.0, t));
}

void main() {
    vec3 rd = normalize(vWorld - cameraPos);
    vec3 ro = cameraPos;

    // Ray / bounding-sphere.
    vec3 oc = ro - vCenter;
    float b = dot(oc, rd);
    float rad = vR * 1.3;
    float h = b * b - (dot(oc, oc) - rad * rad);
    if (h < 0.0) discard;
    h = sqrt(h);
    float t0 = max(-b - h, 0.0);
    float t1 = -b + h;
    if (t1 <= t0) discard;

    float span = t1 - t0;
    float jit = hash21(gl_FragCoord.xy + vTime * 61.0);
    float heat = exp(-vT * 2.4);
    vec4 acc = vec4(0.0);

    for (int i = 0; i < STEPS; i++) {
        if (acc.a > 0.985) break;
        float ft = t0 + span * (float(i) + jit) / float(STEPS);
        vec3 p = ro + rd * ft;
        float den = density(p, vT);
        if (den < 0.005) continue;

        vec3 q = (p - vCenter) / vR;
        float r = length(q);
        // Soot marbling: burning cells against black smoke, from frame one.
        float nS = fbm3(q * 2.6 + vSeed * 1.7 + vec3(0.0, -0.3 * vTime, 0.0), 3);
        float soot = smoothstep(0.30, 0.72, nS + 0.22 * vT);
        float core = pow(1.0 - clamp(r, 0.0, 1.0), 2.0);
        float tempv = den * heat * (0.30 + 0.70 * core) * (1.0 - 0.85 * soot);
        vec3 emis = fireRamp(tempv) * pow(tempv, 1.4) * 46.0 * explosionGlow;

        float facing = dot(normalize(p - vCenter), sunDir) * 0.5 + 0.5;
        vec3 alb = mix(vec3(0.050, 0.045, 0.042), vec3(0.30, 0.29, 0.28),
                       smoothstep(0.55, 1.0, vT));
        vec3 smoke = alb * (SUNCOL * 0.5 * facing + SKYAMB);

        float a = clamp(den * (5.2 / float(STEPS)), 0.0, 1.0);
        acc.rgb += (emis + smoke) * a * (1.0 - acc.a);
        acc.a += a * (1.0 - acc.a);
    }

    if (acc.a < 0.003) discard;
    fragColor = acc;
}
