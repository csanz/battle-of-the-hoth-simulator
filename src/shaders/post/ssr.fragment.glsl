// -----------------------------------------------------------------------------
// Screen-space reflections, on ice only.
//
// Reflections on wet and ice surfaces only, and on this content that qualifier
// is doing all the work. A snow field is a rough dielectric with a
// 0.028 F0 — there is nothing to reflect off it that the sky lookup in the
// material does not already give exactly. The one genuinely specular surface here
// is what Crystallise leaves behind: hexagonal prisms at roughness 0.07, and the
// glaze they write into the terrain state buffer's ice channel.
//
// So this pass is gated on the prepass mask, and the mask is non-zero on
// precisely those pixels. On every frame where nobody has cast Crystallise it
// costs one texture fetch and a branch, which is why it can afford to march at
// full resolution when it does fire.
// -----------------------------------------------------------------------------
precision highp float;
precision highp int;

in vec2 vUV;

uniform sampler2D textureSampler;
uniform sampler2D depthTex;

uniform vec2 projInfo;
uniform vec2 invRes;
uniform float enabled;
uniform float strength;

layout(location = 0) out vec4 fragColor;

#include<snowPostCommon>

/// Coarse steps along the ray, then a short binary refine on the hit.
const int STEPS = 28;
const int REFINE = 5;
/// Thickness the depth buffer is assumed to have, in metres. A screen-space ray
/// can only see the front surface of anything, so a hit is accepted when it lands
/// behind the buffer by less than this — too small and reflections dropped by
/// grazing rays flicker, too large and the ray "hits" the sky behind a dune.
const float THICKNESS = 0.55;

/// The reflection, or a negative weight when the march found nothing.
vec4 reflectionAt(vec2 uv, vec2 pix, float z, float mask) {
    vec4 miss = vec4(0.0, 0.0, 0.0, -1.0);

    vec3 P = viewFromDepth(uv, z, projInfo);

    // Facet normal from the depth buffer. On a hexagonal prism that is exactly
    // right — the facets are flat by construction, and the crystal material
    // builds its own shading normal the same way, from screen-space derivatives.
    vec2 e = invRes;
    float zr = textureLod(depthTex, uv + vec2(e.x, 0.0), 0.0).r;
    float zu = textureLod(depthTex, uv + vec2(0.0, e.y), 0.0).r;
    if (isBackground(zr) || isBackground(zu)) { return miss; }

    vec3 dx = viewFromDepth(uv + vec2(e.x, 0.0), zr, projInfo) - P;
    vec3 dy = viewFromDepth(uv + vec2(0.0, e.y), zu, projInfo) - P;
    vec3 N = normalize(cross(dx, dy));

    vec3 V = normalize(P);           // the camera sits at the view-space origin
    vec3 R = reflect(V, N);
    // A ray heading back toward the eye has nothing on screen to find.
    if (R.z < 0.02) { return miss; }

    // Step length set so the ray crosses roughly one pixel per step near the
    // surface, jittered to break the banding a fixed step leaves on a flat facet.
    float stride = max(0.06, z * 0.035);
    float t = stride * (0.5 + ignPost(pix));
    float prevT = 0.0;
    float hitT = -1.0;

    for (int i = 0; i < STEPS; i++) {
        vec3 Q = P + R * t;
        vec2 sUV = uvFromView(Q, projInfo);
        if (any(lessThan(sUV, vec2(0.0))) || any(greaterThan(sUV, vec2(1.0)))) { break; }

        float sz = textureLod(depthTex, sUV, 0.0).r;
        float diff = Q.z - sz;
        if (diff > 0.0 && diff < THICKNESS) {
            // Binary refine between the last miss and this hit.
            float lo = prevT;
            float hi = t;
            for (int k = 0; k < REFINE; k++) {
                float mid = (lo + hi) * 0.5;
                vec3 M = P + R * mid;
                float mz = textureLod(
                    depthTex, uvFromView(M, projInfo), 0.0
                ).r;
                if (M.z - mz > 0.0) { hi = mid; } else { lo = mid; }
            }
            hitT = hi;
            break;
        }
        prevT = t;
        // Geometric growth: the near field needs fine steps, and the far field is
        // where the ray runs out of screen anyway.
        t += stride * (1.0 + float(i) * 0.16);
    }

    if (hitT < 0.0) { return miss; }

    vec2 hitUV = uvFromView(P + R * hitT, projInfo);

    // Fade at the screen edge, or the reflection ends in a hard line wherever the
    // ray ran out of buffer.
    float edge = min(min(hitUV.x, 1.0 - hitUV.x), min(hitUV.y, 1.0 - hitUV.y));
    float edgeFade = smoothstep(0.0, 0.10, edge);

    // Schlick against ice's F0. At the grazing angles a low sun and a flat glaze
    // produce, this is most of the surface response — which is why replacing the
    // sky estimate with the real dune behind it is worth a pass at all.
    float f = 0.045 + 0.955 * pow(1.0 - clamp(dot(-V, N), 0.0, 1.0), 5.0);

    vec3 refl = textureLod(textureSampler, hitUV, 0.0).rgb;
    return vec4(refl, clamp(mask * f * edgeFade * strength, 0.0, 1.0));
}

void main() {
    vec2 uv = vUV;
    vec4 src = textureLod(textureSampler, uv, 0.0);
    vec4 g = textureLod(depthTex, uv, 0.0);

    vec3 outCol = src.rgb;
    if (enabled > 0.5 && g.g >= 0.02 && !isBackground(g.r)) {
        vec4 r = reflectionAt(uv, gl_FragCoord.xy, g.r, g.g);
        if (r.w > 0.0) { outCol = mix(src.rgb, r.rgb, r.w); }
    }

    fragColor = vec4(outCol, src.a);
}
