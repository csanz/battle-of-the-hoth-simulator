// -----------------------------------------------------------------------------
// snowPostCommon — the conventions every screen-space pass shares.
//
// One place for the coordinate agreement, because getting it wrong is silent:
// a vertically mirrored depth lookup still produces plausible-looking occlusion,
// it is just occlusion belonging to a different part of the frame, and that is
// exactly the class of bug that costs a day.
//
// The agreement, derived once for this WebGL2 build:
//
//   `vUV` comes off the fullscreen triangle with v = 0 at the BOTTOM (the GL
//   convention), and `gl_FragCoord.xy / renderSize` is the same number. NDC y in
//   the ordinary, unflipped sense is `vUV.y * 2 - 1`, and a world point projected
//   with the shared view-projection lands at `ndc * 0.5 + 0.5` — no flip
//   anywhere, as long as nothing in this file invents one.
//
// View space is left-handed with +z forward, matching the camera.
// -----------------------------------------------------------------------------

/// Cleared value of the depth prepass. Must match `DEPTH_FAR` in depthPass.js.
const float POST_FAR = 9000.0;

/// True where the prepass wrote nothing — sky, or a discarded fragment.
bool isBackground(float z) {
    return z > POST_FAR * 0.5;
}

/// View-space position of a pixel.
///
/// `projInfo` is `(tan(fovY/2) * aspect, tan(fovY/2))`, so the reconstruction is
/// one multiply and needs no matrix. `z` is the linear view depth the prepass
/// stored, which for a perspective projection is the clip-space w.
vec3 viewFromDepth(vec2 uv, float z, vec2 projInfo) {
    vec2 ndc = uv * 2.0 - 1.0;
    return vec3(ndc.x * projInfo.x, ndc.y * projInfo.y, 1.0) * z;
}

/// Screen UV of a view-space position. The inverse of `viewFromDepth`.
vec2 uvFromView(vec3 p, vec2 projInfo) {
    vec2 ndc = vec2(p.x / (projInfo.x * p.z), p.y / (projInfo.y * p.z));
    return ndc * 0.5 + 0.5;
}

/// Interleaved gradient noise — the cheapest per-pixel dither that TAA resolves
/// cleanly, because its spectrum is close to blue over a 3x3 neighbourhood.
float ignPost(vec2 p) {
    return fract(52.9829189 * fract(dot(p, vec2(0.06711056, 0.00583715))));
}

/// Rec.709 luminance.
float lumaPost(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

/// Karis' tonemap/inverse pair. Averaging HDR samples with a linear weight lets
/// one 200-nit firefly dominate sixteen taps of ordinary snow; averaging in this
/// compressed space and expanding afterwards keeps the mean where the eye expects
/// it. Used by the temporal resolve and the bloom prefilter.
vec3 tonemapWeight(vec3 c) {
    return c / (1.0 + lumaPost(c));
}

vec3 tonemapUnweight(vec3 c) {
    return c / max(1e-4, 1.0 - lumaPost(c));
}
