// Writes window-space depth into the cascade target as R32F.
//
// Stored as a plain colour rather than sampled from a depth texture so PCSS can
// do its blocker search with ordinary filtered fetches — a comparison sampler
// would only ever hand back a pre-thresholded result, which is the one thing the
// blocker search cannot use.

precision highp float;
precision highp int;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(gl_FragCoord.z, 0.0, 0.0, 1.0);
}
