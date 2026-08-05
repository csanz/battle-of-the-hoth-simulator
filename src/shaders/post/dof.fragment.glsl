// -----------------------------------------------------------------------------
// Depth of field — very restrained.
//
// The focal plane tracks the character, because the character is what the player
// is looking at and the spring arm already knows how far away it is. Everything
// nearer than about half that distance and everything past roughly twice it
// picks up a circle of confusion, capped at a few pixels.
//
// Sample weighting is by the *sample's own* circle of confusion, so a blurred
// background cannot bleed onto a sharp foreground — the artefact that makes cheap
// depth of field look like a smeared decal around every silhouette.
// -----------------------------------------------------------------------------
precision highp float;
precision highp int;

in vec2 vUV;

/// The resolved scene at full resolution, bound explicitly — the chain's own
/// input at this point is the bottom of the bloom pyramid.
uniform sampler2D sceneTex;
uniform sampler2D depthTex;

uniform vec2 invRes;
uniform float enabled;
/// Distance to the focal plane, metres.
uniform float focusDist;
/// Largest circle of confusion, in pixels.
uniform float maxCoc;

layout(location = 0) out vec4 fragColor;

#include<snowPostCommon>

const int TAPS = 16;
const float GOLDEN = 2.39996323;

/// Where the far defocus starts and where it saturates, in **metres**.
///
/// Absolute, not a multiple of the focal distance, and that distinction is the
/// whole of a bug this pass shipped with. Keying the far ramp to `focus * 14`
/// sounds distant and is not: the focal plane is the spring arm, about six
/// metres, so the ramp saturated at eighty-seven metres — the near-middle of a
/// field that runs to eight hundred and seventy. The scene does not rescale when
/// the player zooms the camera in, so neither can this.
const float FAR_START = 130.0;
const float FAR_FULL = 620.0;

/// Signed circle of confusion, -1 (near) .. +1 (far), before the pixel scale.
float cocOf(float z, float focus) {
    if (isBackground(z)) { return 1.0; }
    float far = smoothstep(FAR_START, FAR_FULL, z);
    // Near side stays keyed to the focal distance, because that *is* the right
    // anchor for it: the near limit is a property of the subject distance, and it
    // is the one place this effect earns its keep — a berm the camera is almost
    // sitting on has no business being as crisp as a ridge two hundred metres
    // away.
    float near = smoothstep(focus * 0.55, focus * 0.16, z);
    return far - near;
}

/// The gather. Weighted by each tap's *own* circle of confusion, so a blurred
/// background cannot bleed onto a sharp foreground.
vec3 gather(vec2 uv, vec2 pix, float r, vec3 centre) {
    float rot = ignPost(pix) * 6.28318530718;

    vec3 acc = centre;
    float wsum = 1.0;
    for (int i = 0; i < TAPS; i++) {
        float fi = float(i) + 0.5;
        float a = rot + fi * GOLDEN;
        float rr = r * sqrt(fi / float(TAPS));
        vec2 sUV = uv + vec2(cos(a), sin(a)) * rr * invRes;

        float sz = textureLod(depthTex, sUV, 0.0).r;
        float sCoc = cocOf(sz, focusDist);
        // A tap only contributes if its own blur circle is wide enough to reach
        // this pixel. That is the whole foreground-bleed fix, in one line.
        float w = clamp(abs(sCoc) * maxCoc - rr + 1.0, 0.0, 1.0);
        acc += textureLod(sceneTex, sUV, 0.0).rgb * w;
        wsum += w;
    }
    return acc / wsum;
}

void main() {
    vec2 uv = vUV;
    vec4 centre = textureLod(sceneTex, uv, 0.0);

    vec3 outCol = centre.rgb;
    if (enabled > 0.5) {
        float z = textureLod(depthTex, uv, 0.0).r;
        float r = abs(cocOf(z, focusDist)) * maxCoc;
        // Under a pixel and a half there is nothing a gather can do that the
        // display transform will not throw away, and this is the branch almost
        // the whole frame takes.
        if (r >= 1.5) { outCol = gather(uv, gl_FragCoord.xy, r, centre.rgb); }
    }

    fragColor = vec4(outCol, centre.a);
}
