/**
 * What a hit does to a craft.
 *
 * The collider module says *where* and *when*; this module says *what
 * happens*. One pure function turns a contact into a new velocity, a yaw
 * kick, and a severity — and nothing here reads settings, the scene, or the
 * clock. The thresholds arrive in the params (the pass reads them off S and
 * passes them down), so the function stays a closed piece of algebra: same
 * inputs, same collision, forever.
 *
 * ---------------------------------------------------------------- the physics
 *
 * Everything happens in the horizontal plane, because craft velocity is
 * XZ-planar by contract (vertical is climb-eased elsewhere and never written
 * here). The contact gives a unit normal n pointing away from the obstacle.
 * Decompose the *relative* velocity — craft minus obstacle, because hitting a
 * walker striding toward you is worse than hitting one walking away — onto n:
 *
 *   normal part      This is the component that actually closes the gap, and
 *                    it is the only part a rigid contact can push back on.
 *                    It reflects with restitution e and a mass weight
 *                    w = M/(M + m): against something immovable (walker leg,
 *                    terrain, wreck — massRatio ∞) w = 1 and the craft takes
 *                    the full (1+e) reversal; against an equal craft
 *                    (massRatio 1) w = ½ and the two exchange, each side
 *                    computing its own half. Δv = −(1+e)·w·(v_rel·n)·n,
 *                    applied to the craft's own velocity.
 *   tangential part  Untouched. A glancing blow along a leg is a scrape that
 *                    slides past, not a wall — "no stop on contact" is the
 *                    difference between clipping a wing and hitting a net.
 *
 * The spin is the part rigid-body algebra alone would miss at this level of
 * model: a graze drags on whichever side made contact, so the nose swings
 * *toward* that side — clip a leg with your starboard edge and the nose pulls
 * starboard as the tail whips out. Magnitude is the tangential closing speed
 * (how hard the surfaces shear) times hitSide (the lateral lever arm, −1..1,
 * signed port/starboard by the caller), times a small constant the pass then
 * scales by S.impactSpin.
 *
 * Severity is read off the *normal* closing speed, not the craft's raw speed:
 * screaming past a leg at 40 m/s with a 2 m/s closure is a scrape, and that is
 * the correct verdict — the whole point of a swept, decomposed model is that
 * near misses stay near misses.
 *
 * Degenerates: a separating or exactly-tangent contact (v_rel·n ≥ 0) changes
 * nothing — velocity passes through, spin 0, severity 'scrape'. A zeroed
 * normal (should not happen; costs one multiply to be sure) does the same
 * rather than dividing by it. No allocation: results are written into the
 * caller's out object.
 */

/** Yaw kick per (m/s tangential closing × full lever arm), rad/s. Sized so a
 *  30 m/s broadside graze at the wingtip is a ~2 rad/s snap before the
 *  S.impactSpin scale — violent, recoverable. */
const SPIN_PER_SHEAR = 0.065;

/**
 * Resolve one contact. Params:
 *
 *   vx, vz, speed   craft world velocity and its magnitude
 *   nx, nz          horizontalised unit contact normal, away from the obstacle
 *   ovx, ovz        obstacle velocity (walker ground speed, other craft), 0 if static
 *   massRatio       other/self — Infinity for walkers/terrain/wrecks, 1 for craft
 *   hitSide         −1..1, contact's lateral offset in the craft frame / half-width
 *   restitution     bounce fraction of the normal closure (S.impactBounce)
 *   hitAt, crashAt  severity thresholds, m/s of normal closing (S.impactHit/Crash)
 *
 * Writes and returns out:
 *
 *   vx, vz          new craft velocity
 *   spin            signed yaw-rate kick, rad/s (pass scales by S.impactSpin)
 *   normalSpeed     closing speed along the normal, m/s — the severity input
 *   severity        'scrape' (< hitAt) | 'hit' | 'crash' (> crashAt)
 */
export function speederImpactResponse(out, params) {
  const { vx, vz, nx, nz, ovx, ovz, massRatio, hitSide, restitution, hitAt, crashAt } = params;

  // Relative velocity, and its projection on the normal. vn < 0 means the
  // craft is closing on the obstacle; vn ≥ 0 means this frame's sweep caught
  // a contact that is already resolving itself.
  const rvx = vx - ovx, rvz = vz - ovz;
  const vn = rvx * nx + rvz * nz;
  const closing = vn < 0 ? -vn : 0;

  out.normalSpeed = closing;
  out.severity = closing > crashAt ? "crash" : closing >= hitAt ? "hit" : "scrape";

  // Separating, tangent, or a degenerate normal: report severity (it is
  // 'scrape' by construction — closing is 0) and change nothing.
  if (vn >= 0 || nx * nx + nz * nz < 1e-12) {
    out.vx = vx; out.vz = vz; out.spin = 0;
    return out;
  }

  // Mass weight w = M_other / (M_other + M_self) = ratio / (1 + ratio).
  // ∞/(1+∞) is NaN in IEEE, so the immovable case is spelled out: w = 1,
  // full (1+e) reflection. Equal mass gives w = ½ — each craft's own call
  // takes half the reversal, which together is the exchange.
  const w = massRatio === Infinity ? 1 : massRatio / (1 + massRatio);

  // Reflect the normal component; the tangential component rides along
  // untouched because the impulse is purely along n.
  const dvn = -(1 + restitution) * vn * w;  // ≥ 0: always pushes away
  out.vx = vx + dvn * nx;
  out.vz = vz + dvn * nz;

  // Shear = the relative velocity with its normal part removed. Its magnitude
  // is how hard the surfaces rake past each other; hitSide turns that into a
  // signed yaw kick — nose toward the side that touched.
  const tx = rvx - vn * nx, tz = rvz - vn * nz;
  out.spin = SPIN_PER_SHEAR * Math.sqrt(tx * tx + tz * tz) * hitSide;

  return out;
}
