// Derives everything the snow material needs to know about the macro landform
// that isn't the height itself, by differentiating the *baked* height texture
// rather than the analytic function.
//
// Differentiating the bake (instead of re-evaluating terrainMacroD) guarantees
// the normals describe the exact surface the vertex shader displaces to. If the
// two were derived independently, lighting would disagree with silhouette and
// smooth dunes would show phantom shading seams.
//
// Output channels:
//   R,G  dH/dx, dH/dz in metres per metre
//   B    rock mask, 0 = snow, 1 = bare rock
//   A    exposure: 1 on scoured crests, 0 in sheltered hollows

precision highp float;
precision highp int;
precision highp sampler2D;

in vec2 vUV;

uniform sampler2D heightTex;

uniform float texelWorld; // world metres per height texel
uniform float invHeightRes;

layout(location = 0) out vec4 fragColor;

void main() {
    vec2 uv = vUV;
    float t = invHeightRes;
    float d = texelWorld;

    vec4 hL = texture(heightTex, uv - vec2(t, 0.0));
    vec4 hR = texture(heightTex, uv + vec2(t, 0.0));
    vec4 hD = texture(heightTex, uv - vec2(0.0, t));
    vec4 hU = texture(heightTex, uv + vec2(0.0, t));
    vec4 hC = texture(heightTex, uv);

    // Central difference — second-order accurate, and symmetric so flat ground
    // produces exactly zero slope instead of a bias.
    float dHdx = (hR.x - hL.x) / (2.0 * d);
    float dHdz = (hU.x - hD.x) / (2.0 * d);

    // --- exposure ----------------------------------------------------------
    // Wide-stencil Laplacian: positive on convex crests (which the wind scours
    // and packs into sastrugi), negative in concave hollows (where loose drift
    // collects). Sampling wide deliberately ignores the fine corrugation and
    // answers only "is this a crest or a pocket".
    float w = t * 6.0;
    float wd = d * 6.0;
    float lL = texture(heightTex, uv - vec2(w, 0.0)).x;
    float lR = texture(heightTex, uv + vec2(w, 0.0)).x;
    float lD = texture(heightTex, uv - vec2(0.0, w)).x;
    float lU = texture(heightTex, uv + vec2(0.0, w)).x;
    float lap = (lL + lR + lD + lU - 4.0 * hC.x) / (wd * wd);

    // -lap so crests come out positive. The scale is set against the actual
    // curvature of the dune field: 15 m of relief at a ~58 m wavelength gives a
    // second derivative around 0.18 m^-1, so this has to be near 1/0.18 to
    // produce a usable gradient. Anything larger saturates to a hard 0/1 mask
    // and the sastrugi cross-fade it drives stops being a cross-fade at all.
    float exposure = clamp(0.5 - lap * 2.2, 0.0, 1.0);

    fragColor = vec4(dHdx, dHdz, hC.y, exposure);
}
