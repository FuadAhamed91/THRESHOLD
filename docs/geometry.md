# Geometry engine: methods and assumptions

The engine lives in `src/geometry/`. It is pure TypeScript with no Three.js dependency, and the UI and the 3D scene only ever display its output. `analyzeEntrance({ model, parcel, placement, requiredClearWidth })` is deterministic: the same inputs always give the same result.

## Frame and units

Everything is in **meters** and **radians**, in the entrance-local frame:

| Axis | Meaning |
| --- | --- |
| +X | right, when facing the door from the street |
| +Y | up (presentation only: the analysis is a plan analysis) |
| +Z | away from the facade, toward the street |

The origin is the outside face of the facade on the door centerline, at grade. Plan points are `{x, z}`. Plan angles run from +X toward +Z. Object yaw uses the Three.js `rotation.y` convention (`rotateYaw(p, yaw) === rotate(p, −yaw)`), and a test checks this against Three.js directly.

The calibrated model is built from `src/config/entrance-layout.json`:

- **Walkable surface:** one simple polygon (foyer, doorway, landing, 1:12 ramp, walkway) with a label on every edge. The street edge is marked *open*: the sidewalk continues there, so it bounds the search but does not reduce clearance.
- **Fixed obstacles:** two planters, convex.
- **Door:** hinge at (−0.55, 0), leaf 1.10 m × 0.05 m, opening outward 90°, undercut 12 mm.
- **Accessible-route corridor:** the configured policy region, covering the ramp and landing between handrails plus the door's pull-side maneuvering clearance.
- **Safe drop zone:** convex polygon.
- **Courier-drop prior:** used only for estimates.

`validateModel` rejects impossible configurations before anything is computed. Rejected inputs produce no clearance number and no route. The checks are:

- non-finite values and non-positive dimensions;
- self-intersecting or degenerate polygons, and non-convex zones or obstacles;
- a start or goal off the walkable surface or inside an obstacle;
- a safe zone that is off the surface or overlaps an obstacle;
- an implausible required width or grid spacing.

## Door

- **Swing region.** A sector at the hinge, with radius equal to the leaf width, from closed to the required opening. This is the architectural plan convention. The parcel ∩ sector overlap area is computed with Sutherland–Hodgman clipping.
- **Physical sweep.** The real leaf rectangle (width × thickness) rotates about the hinge. At each 0.25° step a separating-axis test checks it against the parcel and the planters, and the first contact is refined by 24 bisection steps (well under 0.01°). The result is `maxOpening`. `physicallyBlocked = maxOpening < required`.
- **Undercut.** Obstacles no taller than the undercut are ignored by the sweep. They can still lie inside the swing region, which is reported as `passesUnderLeaf`.
- **Assumption:** the leaf is a full-height slab, so a plan overlap with anything taller than the undercut implies contact. No 3D physics is simulated.

## Route intrusion

The overlap is the corridor (which may be concave) clipped by the parcel footprint (convex). Intrusion requires an overlap larger than 1 cm². A parcel that only touches the corridor edge, or sits near it, does not intrude.

## Safe drop zone

The parcel is *contained* only if every footprint vertex is inside the zone and no edges cross. The overlap fraction is reported too. Containment never implies access by itself: door, route and clearance are always recomputed.

## Clearance

1. **Field.** Grid spacing h = 2.5 cm over the walkable bounding box. Each node inside the surface stores its *exact* distance to the nearest feature: boundary edges (open edges excluded), planters, the parcel, and the door leaf at its achievable opening. The door is analysed open as far as it can actually go, so a blocked door narrows the doorway.
2. **Widest path.** A max–min Dijkstra from the walkway start to the foyer goal finds B, the largest value such that some route keeps every node ≥ B. Diagonal steps take the minimum of the target and both orthogonal neighbours, so a route cannot squeeze past a corner. 2B is the widest passage available.
3. **Exact refinement.** At the node where that route is narrowest, the nearest feature and the nearest feature on the opposite side are found. Their closed-form segment–segment distance is reported as the clearance (`method: exact-pair`, tolerance 1 mm), with the two closest points drawn as the dimension line. This value is accepted only if it agrees with 2B within the grid error bound √2·h ≈ 3.5 cm. Otherwise the grid value 2B is reported with that tolerance (`method: grid`).

Grid bound: every point of a continuous route is within h/√2 of a node, and distance is 1-Lipschitz, so |2B − w\*| ≤ √2·h.

## Route

- **Search.** A* runs over nodes with clearance ≥ r = requiredWidth / 2, which is equivalent to inflating every wall and obstacle by r. Corner rules match the widest-path search, so *a route exists ⇔ 2B ≥ required* holds on the grid.
- **Cost.** Euclidean length, plus a mild penalty within 0.3 m of the inflated boundary to keep routes centred. The octile heuristic stays admissible.
- **Post-processing.** The path is string-pulled, Chaikin-smoothed and then re-verified with exact distances every 2 cm. If smoothing breaks the constraint, the unsmoothed path is used. `verifiedMinClearance` reports the minimum exact clearance along the final route.
- **Blocked case.** The *reachable prefix* (an A* path to the last node on the widest route that still has clearance ≥ r) and the blocked continuation are returned, so the avatar stops before the pinch.
- **Marginal case.** If the exact clearance and the grid route disagree (only possible within the tolerance band), the result is marked *marginal / indeterminate* rather than picking a side.

## Uncertainty

For an estimated placement (radius > 8 cm), the parcel is evaluated at its centre and at 8 points on the uncertainty circle with ±20° yaw. Physically impossible placements, through walls or into planters, are discarded. If the samples disagree on the door or on route validity, the verdict is **indeterminate**: the UI asks for confirmation or a fresh observation, and the avatar is not sent. Confidence is never mixed into the geometric tests.

## Status

The status is resolved in this order:

| Status | Condition |
| --- | --- |
| `invalid` | the configuration failed validation |
| `indeterminate` | uncertain or marginal |
| `obstructed` | the door is physically blocked, or no valid route exists |
| `caution` | the parcel intrudes on the corridor or swing region, but access still works |
| `clear` | none of the above |

`findings[]` explains each conclusion in plain language.
