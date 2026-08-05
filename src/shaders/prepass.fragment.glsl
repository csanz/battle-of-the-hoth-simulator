// The depth prepass, shared by every caster that has nothing to discard.
//
// Linear view depth arrives as a varying rather than being reconstructed from
// the depth buffer: for a perspective projection the clip-space w *is* the
// view-space z, so carrying it costs one interpolant and is exact, where
// linearising the depth buffer would spend a divide to recover a number the
// vertex stage already had.
precision highp float;
precision highp int;

in float vViewZ;
/// 0 matte snow, 1 mirror ice. Only the reflection pass reads it.
in float vMask;

layout(location = 0) out vec4 fragColor;

void main() {
    fragColor = vec4(vViewZ, vMask, 0.0, 1.0);
}
