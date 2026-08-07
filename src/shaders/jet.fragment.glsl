// The plume's colour, and the shimmer.
//
// Three bands along its length rather than a single tint, because that is what a
// hot exhaust actually does and it is the whole read: the throat is white-yellow
// where the gas is hottest, it cools through orange as it expands, and the outer
// envelope where it meets cold air runs blue. Laid down as one ramp so the eye
// gets a continuous gradient rather than three stripes.
//
// The shimmer is not refraction — nothing here bends what is behind it. It is
// banded noise scrolling down the plume at high frequency, which at the size this
// is drawn does the same job to the eye: the edge boils rather than sitting
// still. Real heat haze would need the scene colour sampled and offset, which is
// a post-pass this does not have.

precision highp float;
precision highp int;

#include<snowNoise>

in float vT;
in float vSide;
in float vThrottle;

uniform vec4 jetParams;   // (throttle, time, width, flare)
uniform float jetGlow;    // multiplier on the HDR push, 1 = the tuned look
uniform float jetHaloBack; // fraction of the plume the throat ramps in over
uniform float jetDebug;   // 1 = flat magenta coverage view, for placement

layout(location = 0) out vec4 fragColor;

const vec3 THROAT = vec3(1.0, 0.94, 0.72);
const vec3 MID = vec3(1.0, 0.46, 0.10);
const vec3 OUTER = vec3(0.24, 0.52, 1.0);

void main() {
    float t = vT;
    float across = 1.0 - abs(vSide);
    if (across <= 0.001) { discard; }

    float time = jetParams.y;

    // Boiling edge. Two scrolling octaves down the plume, faster than the shape
    // wobbles, so the outline never settles.
    float n = noise2(vec2(vSide * 3.0 + t * 6.0, t * 9.0 - time * 7.0)) * 0.5
            + noise2(vec2(vSide * 7.0, t * 17.0 - time * 12.0)) * 0.25;
    float boil = 0.72 + 0.55 * n;

    // Along the plume: white-hot at the throat, orange through the body, blue at
    // the cold envelope. Squared so the throat stays tight.
    float heat = clamp(1.0 - t * 1.35, 0.0, 1.0);
    vec3 tint = mix(MID, THROAT, heat * heat);
    tint = mix(OUTER, tint, clamp(across * 1.5, 0.0, 1.0));

    // Across it: a hot core inside a broad envelope.
    float core = pow(across, 5.0);
    float body = across * across;

    // Fades out along the length, and switches off entirely at idle.
    float along = (1.0 - t) * (1.0 - t);
    // Ramp the throat in over the first stretch of the plume, so the peak the
    // bloom pass spreads sits *behind* the nozzle and the halo washes
    // rearward off the engines rather than forward over the hull.
    along *= smoothstep(0.0, max(jetHaloBack, 0.001), t);
    float amount = (0.18 + 0.82 * vThrottle) * along * boil;

    // Well over the snow, not over one.
    //
    // The first pass at this was invisible, and the reason is the exposure: this
    // scene's sunlit snow measures about 12 in linear and AgX is deep into its
    // shoulder by then, so an emitter at 2 adds a fraction of a stop to a value
    // the curve is already flattening. An exhaust has to *out-run* the snow to
    // read as hot against it, which puts the throat an order of magnitude above
    // anything else in the frame and hands the bloom pass something to spread.
    // `jetGlow` scales the whole HDR push: it is the one knob over how much
    // the plume out-runs the snow, and therefore how much halo the bloom pass
    // is handed to spread over the hull behind it.
    vec3 c = (tint * body * 16.0 + THROAT * core * 30.0 * heat) * jetGlow;
    // Debug: paint the whole footprint flat magenta at honest coverage — no
    // HDR push, no bloom halo, no colour ramp — so the overlay's jet sliders
    // can be dialled against exactly the space the plume occupies.
    if (jetDebug > 0.5) {
        float cover = step(0.02, across) * step(0.02, amount);
        fragColor = vec4(vec3(1.0, 0.0, 1.0) * (0.35 + 0.65 * body) * cover, 1.0);
        return;
    }
    fragColor = vec4(c * amount, 1.0);
}
