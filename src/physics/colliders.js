/**
 * Collider math.
 *
 * The whole collision system reduces to one question asked many times a frame:
 * a sphere (a craft) moved from here to there this frame — did it touch this
 * capsule (a walker leg, a body, a wreck), and if so, where, when, and which
 * way is out? This module answers that question and nothing else. No THREE, no
 * settings, no game state: plain numbers in, plain numbers out, so the tests
 * are the algebra and the algebra is checkable by reading.
 *
 * Two shapes cover every machine in the field. A **capsule** — a segment with a
 * radius — is a leg, a body slung between the legs, a head, a whole AT-ST, a
 * wreck on the ground. A **sphere** is a craft, and craft-vs-craft is the
 * sphere case of the same sweep. Both tests are *swept*: they take the motion
 * over the frame, not just the end position, so a craft at 40 m/s cannot step
 * through a 1.1 m leg between two frames however low the framerate drops.
 *
 * ------------------------------------------------------------------- the math
 *
 * Sweeping a sphere of radius r against a capsule of radius cr is the same as
 * sweeping a *point* against the capsule inflated to R = r + cr. The point
 * travels p + t·m for t in [0,1]; the inflated capsule is an infinite cylinder
 * of radius R about the axis, clipped to the axial span, plus a sphere of
 * radius R on each end. So the test is (Ericson, Real-Time Collision
 * Detection, 5.3.7, adapted):
 *
 *   cylinder  Project everything perpendicular to the axis d and the contact
 *             condition |perp(p + t·m − a)| = R becomes one quadratic in t.
 *             A root only counts if the axial coordinate at that t lands
 *             between the endpoints — otherwise the point is flying past the
 *             open end of the cylinder, and the caps decide.
 *   caps      Point-vs-sphere at each endpoint: another quadratic each. The
 *             earliest in-range root of the three candidates wins.
 *
 * Every degenerate input has a defined answer rather than a NaN:
 *
 *   already inside   Checked first, before any sweep. t = 0, and the normal is
 *                    the depenetration direction from the closest point on the
 *                    axis — exactly what a caller needs to push the craft back
 *                    out. A centre sitting *on* the axis (it happens, at spawn
 *                    or after a teleport) gets a fabricated perpendicular
 *                    instead of a divide by zero.
 *   zero motion      The sweep quadratics are skipped; only the overlap test
 *                    can fire. A parked craft touching nothing reports nothing.
 *   zero-length axis A capsule whose endpoints coincide is just a sphere, and
 *                    is routed to the sphere test.
 *
 * Allocation per call: none. Results go into a caller-supplied out object and
 * everything intermediate is scalar locals — this runs craft × capsules times
 * per frame and must leave no garbage behind.
 */

/** Below this squared length a vector is treated as zero. Metres in, so this
 *  is a tenth of a millimetre — far under anything the sim can express. */
const EPS2 = 1e-8;

/**
 * Build the capsule pool: n preallocated, reusable collider slots. The pass
 * rewrites these in place every frame (walkers move, sliders resize them) and
 * flags the tail of the pool dead with `live = false` — nothing is ever
 * created or freed after this call.
 */
export function makeCapsulePool(n) {
  const pool = new Array(n);
  for (let i = 0; i < n; i++) {
    pool[i] = {
      ax: 0, ay: 0, az: 0,   // segment bottom / tail, world metres
      bx: 0, by: 0, bz: 0,   // segment top / nose
      r: 1,                  // radius, metres
      kind: "",              // 'leg' | 'body' | 'head' | 'atst' | 'wreck'
      walker: null,          // back-ref for reactions (stumble, wreck slot)
      live: false,           // dead entries are skipped by every query
    };
  }
  return pool;
}

/**
 * Sphere centre p moving by m this frame, radius r, against capsule `cap`.
 * Writes the earliest contact into `out` and returns true, or returns false
 * untouched. `out` gets:
 *
 *   t           0..1 fraction along m at first contact (0 if already inside)
 *   nx,ny,nz    unit normal, pointing away from the capsule axis toward the
 *               sphere — the direction to depenetrate and reflect along
 *   px,py,pz    contact point on the capsule surface
 *   cap         the capsule hit
 */
export function sweptSphereVsCapsule(px, py, pz, mx, my, mz, cap, r, out) {
  // Axis d = b − a. A degenerate capsule (both endpoints in one place) is a
  // sphere; hand it to the sphere test rather than dividing by |d|².
  const dx = cap.bx - cap.ax, dy = cap.by - cap.ay, dz = cap.bz - cap.az;
  const dd = dx * dx + dy * dy + dz * dz;
  if (dd < EPS2) {
    if (!sweptSphereVsSphere(px, py, pz, mx, my, mz, cap.ax, cap.ay, cap.az, cap.r, r, out)) return false;
    out.cap = cap;
    return true;
  }

  const R = r + cap.r;      // inflated radius: point-vs-capsule from here on
  const R2 = R * R;

  // f = p − a, the start point in the capsule's frame.
  const fx = px - cap.ax, fy = py - cap.ay, fz = pz - cap.az;
  const fd = fx * dx + fy * dy + fz * dz;   // axial coordinate of p, times |d|

  // --- already overlapping? Closest point on the segment to p, then compare
  // squared distance against R². This must come first: the sweep quadratics
  // below assume a clean start and would report the *exit*, not the fix.
  {
    let s = fd / dd;
    if (s < 0) s = 0; else if (s > 1) s = 1;
    const qx = cap.ax + s * dx, qy = cap.ay + s * dy, qz = cap.az + s * dz;
    let ex = px - qx, ey = py - qy, ez = pz - qz;
    const e2 = ex * ex + ey * ey + ez * ez;
    if (e2 < R2) {
      if (e2 > EPS2) {
        const inv = 1 / Math.sqrt(e2);
        ex *= inv; ey *= inv; ez *= inv;
      } else {
        // Centre on the axis: fabricate a perpendicular. (−dz, 0, dx) is
        // d × up — horizontal and perpendicular to d — which is the useful
        // answer, because craft velocity is XZ-planar and a horizontal shove
        // is one it can act on. That cross vanishes exactly when the axis is
        // vertical (every leg), where *any* horizontal direction is
        // perpendicular; +x will do.
        ex = -dz; ey = 0; ez = dx;
        const h2 = ex * ex + ez * ez;
        if (h2 > EPS2) {
          const inv = 1 / Math.sqrt(h2);
          ex *= inv; ez *= inv;
        } else { ex = 1; ey = 0; ez = 0; }
      }
      out.t = 0;
      out.nx = ex; out.ny = ey; out.nz = ez;
      out.px = qx + ex * cap.r; out.py = qy + ey * cap.r; out.pz = qz + ez * cap.r;
      out.cap = cap;
      return true;
    }
  }

  // --- no overlap and no motion: nothing can happen this frame.
  const mm = mx * mx + my * my + mz * mz;
  if (mm < EPS2) return false;

  // --- cylinder side. With everything projected perpendicular to d, the
  // contact condition |perp(f + t·m)|² = R² expands (multiplying through by
  // dd to avoid a division) to A·t² + 2B·t + C = 0 with:
  const nd = mx * dx + my * dy + mz * dz;
  const A = dd * mm - nd * nd;              // |perp(m)|² · dd ≥ 0
  const B = dd * (fx * mx + fy * my + fz * mz) - nd * fd;
  const C = dd * (fx * fx + fy * fy + fz * fz - R2) - fd * fd;

  let best = -1;
  if (A > EPS2) {                           // not parallel to the axis
    const disc = B * B - A * C;
    if (disc >= 0) {
      const t = (-B - Math.sqrt(disc)) / A; // earlier root: first touch
      if (t >= 0 && t <= 1) {
        const axial = fd + t * nd;          // axial coord at contact, × |d|
        if (axial >= 0 && axial <= dd) best = t;
        // else: past an open end at that instant — the caps decide.
      }
    }
    // disc < 0: the line misses the infinite cylinder, but can still clip an
    // end sphere's polar region, so fall through to the caps regardless.
  }
  // A ≈ 0: motion parallel to the axis; only the caps can be hit first.

  // --- end caps: point vs sphere of radius R at each endpoint. Same quadratic
  // with d gone: mm·t² + 2(f·m)t + (f·f − R²) = 0, earliest root in [0,1].
  {
    const b0 = fx * mx + fy * my + fz * mz;
    const c0 = fx * fx + fy * fy + fz * fz - R2;
    if (b0 < 0 && c0 >= 0) {                // approaching, and not inside
      const disc = b0 * b0 - mm * c0;
      if (disc >= 0) {
        const t = (-b0 - Math.sqrt(disc)) / mm;
        if (t >= 0 && t <= 1 && (best < 0 || t < best)) best = t;
      }
    }
    const gx = px - cap.bx, gy = py - cap.by, gz = pz - cap.bz;
    const b1 = gx * mx + gy * my + gz * mz;
    const c1 = gx * gx + gy * gy + gz * gz - R2;
    if (b1 < 0 && c1 >= 0) {
      const disc = b1 * b1 - mm * c1;
      if (disc >= 0) {
        const t = (-b1 - Math.sqrt(disc)) / mm;
        if (t >= 0 && t <= 1 && (best < 0 || t < best)) best = t;
      }
    }
  }

  if (best < 0) return false;

  // --- reconstruct the contact from t: sphere centre at contact, closest
  // point on the axis, normal from axis point to centre (length is R by
  // construction; guard the divide anyway — floating point owes us nothing).
  const cx = px + best * mx, cy = py + best * my, cz = pz + best * mz;
  let s = ((cx - cap.ax) * dx + (cy - cap.ay) * dy + (cz - cap.az) * dz) / dd;
  if (s < 0) s = 0; else if (s > 1) s = 1;
  const qx = cap.ax + s * dx, qy = cap.ay + s * dy, qz = cap.az + s * dz;
  let ex = cx - qx, ey = cy - qy, ez = cz - qz;
  const e2 = ex * ex + ey * ey + ez * ez;
  if (e2 > EPS2) {
    const inv = 1 / Math.sqrt(e2);
    ex *= inv; ey *= inv; ez *= inv;
  } else { ex = 0; ey = 1; ez = 0; }

  out.t = best;
  out.nx = ex; out.ny = ey; out.nz = ez;
  out.px = qx + ex * cap.r; out.py = qy + ey * cap.r; out.pz = qz + ez * cap.r;
  out.cap = cap;
  return true;
}

/**
 * Sphere centre p moving by m this frame, radius r, against a static sphere at
 * c with radius cr. For craft-vs-craft — where both spheres move — pass the
 * *relative* motion (self minus other) as m and the other craft's position as
 * c; the earliest-contact t is identical either way.
 *
 * Same out shape as the capsule test, except `cap` is set to null: the caller
 * knows which craft it asked about. Same guarantees: already-overlapping
 * yields t = 0 with a depenetration normal (a fabricated horizontal one if the
 * centres coincide exactly), zero motion yields overlap-or-nothing, no NaNs,
 * no allocation.
 */
export function sweptSphereVsSphere(px, py, pz, mx, my, mz, cx, cy, cz, cr, r, out) {
  const R = r + cr;
  const R2 = R * R;
  let fx = px - cx, fy = py - cy, fz = pz - cz;
  const f2 = fx * fx + fy * fy + fz * fz;

  // Already overlapping: t = 0, push straight out from the centre. Coincident
  // centres get an arbitrary horizontal normal — arbitrary is fine, NaN isn't.
  if (f2 < R2) {
    if (f2 > EPS2) {
      const inv = 1 / Math.sqrt(f2);
      fx *= inv; fy *= inv; fz *= inv;
    } else { fx = 1; fy = 0; fz = 0; }
    out.t = 0;
    out.nx = fx; out.ny = fy; out.nz = fz;
    out.px = cx + fx * cr; out.py = cy + fy * cr; out.pz = cz + fz * cr;
    out.cap = null;
    return true;
  }

  const mm = mx * mx + my * my + mz * mz;
  if (mm < EPS2) return false;

  // |f + t·m|² = R²: one quadratic, earliest root, only while approaching
  // (f·m < 0 — moving apart can graze the maths but never the machines).
  const b = fx * mx + fy * my + fz * mz;
  if (b >= 0) return false;
  const disc = b * b - mm * (f2 - R2);
  if (disc < 0) return false;
  const t = (-b - Math.sqrt(disc)) / mm;
  if (t < 0 || t > 1) return false;

  const hx = px + t * mx - cx, hy = py + t * my - cy, hz = pz + t * mz - cz;
  const inv = 1 / R;                        // |h| = R at contact by construction
  const nx = hx * inv, ny = hy * inv, nz = hz * inv;
  out.t = t;
  out.nx = nx; out.ny = ny; out.nz = nz;
  out.px = cx + nx * cr; out.py = cy + ny * cr; out.pz = cz + nz * cr;
  out.cap = null;
  return true;
}
