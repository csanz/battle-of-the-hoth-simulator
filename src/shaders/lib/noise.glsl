// -----------------------------------------------------------------------------
// snowNoise — shared procedural noise library.
//
// Registered into the shader registry as <snowNoise>, so both the offline
// height bake and the runtime snow material evaluate byte-identical functions.
// Everything that shapes the surface lives here.
//
// The gradient noise carries analytic derivatives (Inigo Quilez's formulation).
// That matters twice over: derivative-damped fBm is what gives dunes their
// smooth crests and flat troughs instead of generic cloud-lumps, and exact
// surface derivatives mean the fine detail can be shaded without ever taking a
// finite difference.
// -----------------------------------------------------------------------------

const float PI = 3.14159265359;

// ------------------------------------------------------------------- hashing

float hash11(float n) {
    float p = fract(n * 0.1031);
    p *= p + 33.33;
    p *= p + p;
    return fract(p);
}

float hash21(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}

vec2 hash22(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.xx + p3.yz) * p3.zy);
}

vec3 hash33(vec3 p) {
    vec3 p3 = fract(p * vec3(0.1031, 0.1030, 0.0973));
    p3 += dot(p3, p3.yxz + 33.33);
    return fract((p3.xxy + p3.yxx) * p3.zyx);
}

/// Unit-length 2D gradient vector for a lattice point.
vec2 grad2(vec2 i) {
    float a = hash21(i) * 6.28318530718;
    return vec2(cos(a), sin(a));
}

// --------------------------------------------------- gradient noise + deriv

/// Perlin-style gradient noise. Returns vec3(value, d/dx, d/dy).
/// Value range is roughly [-1, 1].
vec3 noised(vec2 p) {
    vec2 i = floor(p);
    vec2 f = p - i;

    // Quintic fade: C2 continuous, so derivatives are smooth too.
    vec2 u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
    vec2 du = 30.0 * f * f * (f * (f - 2.0) + 1.0);

    vec2 ga = grad2(i + vec2(0.0, 0.0));
    vec2 gb = grad2(i + vec2(1.0, 0.0));
    vec2 gc = grad2(i + vec2(0.0, 1.0));
    vec2 gd = grad2(i + vec2(1.0, 1.0));

    float va = dot(ga, f - vec2(0.0, 0.0));
    float vb = dot(gb, f - vec2(1.0, 0.0));
    float vc = dot(gc, f - vec2(0.0, 1.0));
    float vd = dot(gd, f - vec2(1.0, 1.0));

    float k0 = va;
    float k1 = vb - va;
    float k2 = vc - va;
    float k3 = va - vb - vc + vd;

    float value = k0 + k1 * u.x + k2 * u.y + k3 * u.x * u.y;

    vec2 deriv = ga
        + u.x * (gb - ga)
        + u.y * (gc - ga)
        + u.x * u.y * (ga - gb - gc + gd)
        + du * (vec2(u.y, u.x) * k3 + vec2(k1, k2));

    return vec3(value, deriv);
}

/// Value-only gradient noise, for places that never need the slope.
float noise2(vec2 p) {
    return noised(p).x;
}

/// 3D value noise — used by volumetrics and particle jitter, not by the surface.
float noise3(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    vec3 u = f * f * (3.0 - 2.0 * f);

    float a = dot(hash33(i + vec3(0.0, 0.0, 0.0)), vec3(1.0)) / 3.0;
    float b = dot(hash33(i + vec3(1.0, 0.0, 0.0)), vec3(1.0)) / 3.0;
    float c = dot(hash33(i + vec3(0.0, 1.0, 0.0)), vec3(1.0)) / 3.0;
    float d = dot(hash33(i + vec3(1.0, 1.0, 0.0)), vec3(1.0)) / 3.0;
    float e = dot(hash33(i + vec3(0.0, 0.0, 1.0)), vec3(1.0)) / 3.0;
    float g = dot(hash33(i + vec3(1.0, 0.0, 1.0)), vec3(1.0)) / 3.0;
    float h = dot(hash33(i + vec3(0.0, 1.0, 1.0)), vec3(1.0)) / 3.0;
    float k = dot(hash33(i + vec3(1.0, 1.0, 1.0)), vec3(1.0)) / 3.0;

    return mix(
        mix(mix(a, b, u.x), mix(c, d, u.x), u.y),
        mix(mix(e, g, u.x), mix(h, k, u.x), u.y),
        u.z
    ) * 2.0 - 1.0;
}

// ----------------------------------------------------------------- rotation

mat2 rot2(float a) {
    float c = cos(a);
    float s = sin(a);
    return mat2(c, -s, s, c);
}

// ---------------------------------------------------------------------- fBm

/// Plain fBm. Returns vec3(value, d/dx, d/dy), derivatives chain-ruled through
/// the per-octave rotation so they stay exact.
vec3 fbmd(vec2 p0, int octaves, float lacunarity, float gain) {
    vec2 p = p0;
    float amp = 0.5;
    float freq = 1.0;
    float sum = 0.0;
    vec2 deriv = vec2(0.0);

    // Per-octave rotation kills the axis-aligned grid signature of raw Perlin.
    mat2 m = rot2(0.517);
    mat2 xform = mat2(1.0, 0.0, 0.0, 1.0);

    for (int i = 0; i < octaves; i++) {
        vec3 n = noised(p * freq);
        sum += amp * n.x;
        // d/dp0 = amp * freq * (dn/dp * accumulated rotation)
        deriv += amp * freq * (n.yz * xform);
        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3(sum, deriv);
}

/// Derivative-damped fBm. Each octave is attenuated by the slope accumulated so
/// far, so detail collects in flat areas and thins out on steep faces. This is
/// the single biggest reason the dunes read as wind-packed drifts rather than
/// as a generic noise field.
vec3 fbmDamped(vec2 p0, int octaves, float lacunarity, float gain, float damp) {
    vec2 p = p0;
    float amp = 0.5;
    float freq = 1.0;
    float sum = 0.0;
    vec2 deriv = vec2(0.0);

    mat2 m = rot2(0.517);
    mat2 xform = mat2(1.0, 0.0, 0.0, 1.0);

    for (int i = 0; i < octaves; i++) {
        vec3 n = noised(p * freq);
        float w = 1.0 / (1.0 + damp * dot(deriv, deriv));
        sum += amp * w * n.x;
        deriv += amp * w * freq * (n.yz * xform);
        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3(sum, deriv);
}

/// Ridged noise with derivatives — sharp crests, smooth valleys. Sastrugi.
/// Built as 1 - |n|, whose derivative is -sign(n) * dn.
vec3 ridgedd(vec2 p0, int octaves, float lacunarity, float gain) {
    vec2 p = p0;
    float amp = 0.5;
    float freq = 1.0;
    float sum = 0.0;
    vec2 deriv = vec2(0.0);
    float prev = 1.0;

    mat2 m = rot2(0.717);
    mat2 xform = mat2(1.0, 0.0, 0.0, 1.0);

    for (int i = 0; i < octaves; i++) {
        vec3 n = noised(p * freq);
        float s = sign(n.x);
        float r = 1.0 - abs(n.x);
        // Squaring sharpens the crest; `prev` couples octaves so ridges align.
        float r2 = r * r;
        float dr2 = -2.0 * r * s;

        sum += amp * r2 * prev;
        deriv += amp * prev * freq * (dr2 * n.yz * xform);
        prev = mix(1.0, r2, 0.65);

        amp *= gain;
        freq *= lacunarity;
        p = m * p;
        xform = m * xform;
    }
    return vec3(sum, deriv);
}

// ------------------------------------------------------------------ shaping

/// Smooth absolute value — avoids the derivative discontinuity of abs().
float sabs(float x, float k) {
    return sqrt(x * x + k * k) - k;
}

float smoothMin(float a, float b, float k) {
    float h = clamp(0.5 + 0.5 * (b - a) / k, 0.0, 1.0);
    return mix(b, a, h) - k * h * (1.0 - h);
}

float smoothMax(float a, float b, float k) {
    return -smoothMin(-a, -b, k);
}

float remap(float v, float a, float b, float c, float d) {
    return c + (d - c) * clamp((v - a) / (b - a), 0.0, 1.0);
}

/// Interleaved gradient noise — the stable per-pixel dither TAA tolerates.
float ign(vec2 pix) {
    return fract(52.9829189 * fract(dot(pix, vec2(0.06711056, 0.00583715))));
}
