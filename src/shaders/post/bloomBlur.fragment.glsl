// Nine-tap tent blur, at the bottom of the bloom chain.
//
// Widens the coarsest level into the broad halo that reads as atmosphere around
// the sun rather than as a ring around it. A tent rather than a box because the
// composite samples this bilinearly at sixteen times the resolution, and a box's
// flat top makes the upsample's own linear interpolation visible as facets.
precision highp float;
precision highp int;

in vec2 vUV;

uniform sampler2D textureSampler;

/// One texel of the source, in UV, times the desired spread.
uniform vec2 srcTexel;

layout(location = 0) out vec4 fragColor;

vec3 tap(vec2 uv) {
    return textureLod(textureSampler, uv, 0.0).rgb;
}

void main() {
    vec2 uv = vUV;
    vec2 t = srcTexel;

    vec3 c = tap(uv + vec2(-t.x,  t.y)) * 1.0;
    c += tap(uv + vec2( 0.0,   t.y)) * 2.0;
    c += tap(uv + vec2( t.x,   t.y)) * 1.0;
    c += tap(uv + vec2(-t.x,   0.0)) * 2.0;
    c += tap(uv)                     * 4.0;
    c += tap(uv + vec2( t.x,   0.0)) * 2.0;
    c += tap(uv + vec2(-t.x,  -t.y)) * 1.0;
    c += tap(uv + vec2( 0.0,  -t.y)) * 2.0;
    c += tap(uv + vec2( t.x,  -t.y)) * 1.0;

    fragColor = vec4(c * (1.0 / 16.0), 1.0);
}
