/**
 * Builds the nested-ring clipmap as a single static mesh.
 *
 * One vertex buffer, one index buffer, one draw call, built once and never
 * touched again. Vertices carry no position — only `(gridI, ringLevel, gridJ)`.
 * The vertex shader turns that into a world position each frame from the camera
 * location, so the terrain follows the player with zero CPU work and zero
 * uploads.
 *
 * Ring geometry:
 *   level 0      a solid square, the finest spacing
 *   level 1..N   square annuli, spacing doubling each step
 *
 * Each annulus's hole is cut a few cells *smaller* than the ring it surrounds,
 * so consecutive rings always overlap slightly and can never open a gap when
 * their independently-snapped origins drift apart. Within the overlap band the
 * inner ring's vertices are fully morphed onto the outer ring's lattice, so both
 * rings describe the identical surface there and the overlap is invisible.
 */

import * as THREE from "three";

/** Quads per side, per ring. Must be divisible by 4. */
export const GRID_N = 160;
/** Number of rings. */
export const LEVELS = 8;
/** Vertex spacing of the innermost ring, metres. */
export const BASE_SPACING = 0.085;

/** How many cells to shrink each hole by, to guarantee overlap. */
const HOLE_SHRINK = 3;

const HALF = GRID_N / 2;

/**
 * @param {import("../core/gfx.js").Gfx} gfx
 * @returns {THREE.Mesh}
 */
export function buildClipmapMesh(gfx) {
    const side = GRID_N + 1;
    const vertsPerLevel = side * side;

    const positions = new Float32Array(vertsPerLevel * LEVELS * 3);

    // Count indices exactly so the buffer is allocated once.
    let quadCount = GRID_N * GRID_N;
    const holeHalf = HALF / 2 - HOLE_SHRINK;
    const holeQuads = (holeHalf * 2) * (holeHalf * 2);
    quadCount += (LEVELS - 1) * (GRID_N * GRID_N - holeQuads);

    const indices = new Uint32Array(quadCount * 6);

    let vi = 0;
    let ii = 0;

    for (let level = 0; level < LEVELS; level++) {
        const vBase = level * vertsPerLevel;

        // ---- vertices ----------------------------------------------------
        // Every level emits the full lattice; the annulus is expressed purely
        // through which quads get indices. The unreferenced interior vertices
        // cost 12 bytes each and are never shaded.
        for (let j = 0; j <= GRID_N; j++) {
            const gj = j - HALF;
            for (let i = 0; i <= GRID_N; i++) {
                positions[vi++] = i - HALF;
                positions[vi++] = level;
                positions[vi++] = gj;
            }
        }

        // ---- indices -----------------------------------------------------
        for (let j = 0; j < GRID_N; j++) {
            const gj = j - HALF;
            for (let i = 0; i < GRID_N; i++) {
                const gi = i - HALF;

                if (level > 0) {
                    // Skip quads entirely inside the hole.
                    const maxAbs = Math.max(
                        Math.abs(gi), Math.abs(gi + 1),
                        Math.abs(gj), Math.abs(gj + 1)
                    );
                    if (maxAbs <= holeHalf) continue;
                }

                const a = vBase + j * side + i;
                const b = a + 1;
                const c = a + side;
                const d = c + 1;

                // Winding: copied verbatim from the Babylon build. Babylon's LH
                // default is CCW front + cull back (the source's "clockwise
                // front" comment was stale lore). The LH view/projection keeps
                // screen-space winding identical, so materials that culled there
                // use THREE.FrontSide here — never re-derive the order.
                //
                // The diagonal alternates per quad. A uniform diagonal leaves a
                // faint corduroy of shading seams all running the same way.
                if (((i + j) & 1) === 0) {
                    indices[ii++] = a; indices[ii++] = b; indices[ii++] = c;
                    indices[ii++] = b; indices[ii++] = d; indices[ii++] = c;
                } else {
                    indices[ii++] = a; indices[ii++] = d; indices[ii++] = c;
                    indices[ii++] = a; indices[ii++] = b; indices[ii++] = d;
                }
            }
        }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(
        ii === indices.length ? indices : indices.subarray(0, ii), 1
    ));

    const mesh = new THREE.Mesh(geometry);
    mesh.name = "terrain";

    // The mesh never moves and its real extent is decided in the vertex shader,
    // so both culling and the world matrix are meaningless here.
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;

    mesh.metadata = {
        triangles: ii / 3,
        vertices: vertsPerLevel * LEVELS,
    };

    return mesh;
}

/** Half-extent of the finest ring, metres — used to size the deformation area. */
export const INNER_EXTENT = HALF * BASE_SPACING;
/** Half-extent of the whole clipmap, metres. */
export const OUTER_EXTENT = HALF * BASE_SPACING * Math.pow(2, LEVELS - 1);
export const GRID_HALF_N = HALF;
