/**
 * Door-swing analysis.
 *
 * Two distinct questions, answered separately:
 *  1. Region test — does the parcel footprint overlap the plan-view swing region
 *     (circular sector of radius = leaf width, from closed to the required opening)?
 *  2. Physical test — sweeping the actual leaf rectangle (width × thickness) about
 *     the hinge, what is the largest opening angle reached before the leaf
 *     penetrates an obstacle? A parcel inside the region but no taller than the
 *     door undercut passes beneath the leaf and does not stop it.
 *
 * The leaf is modelled as a full-height vertical slab, so a plan-view overlap with a
 * parcel taller than the undercut implies physical contact (no 3D physics needed).
 */
import { clipPolygon, convexPolygonsOverlap, ensureCCW, polygonArea, polygonBoundaryClosest, sectorPolygon } from './polygons';
import type { DoorModel, DoorSwingResult, Polygon, Vec2 } from './types';
import { add, direction, midpoint, rotate, scale, v2 } from './vec2';

const SWEEP_STEP = (0.25 * Math.PI) / 180;
const BISECTION_STEPS = 24;

export interface DoorObstacle {
  readonly polygon: Polygon;
  readonly height: number;
  readonly label: string;
}

/** Leaf footprint at opening angle θ (0 = closed). */
export function leafPolygon(door: DoorModel, theta: number): Vec2[] {
  const phi = door.closedAngle + door.openingSense * theta;
  const u = direction(phi);
  // Thickness sits on the side opposite the opening direction when closed.
  const n = rotate(v2(0, -door.openingSense), phi);
  const tip = add(door.hinge, scale(u, door.width));
  const t = scale(n, door.thickness);
  return ensureCCW([door.hinge, tip, add(tip, t), add(door.hinge, t)]);
}

/** Plan-view swing region (architectural convention: radius = leaf width). */
export function swingRegion(door: DoorModel, segments = 48): Vec2[] {
  return sectorPolygon(door.hinge, door.width, door.closedAngle, door.openingSense * door.requiredOpening, segments);
}

/** Largest opening angle (≤ required) the leaf reaches without penetrating an obstacle. */
export function maxOpeningAngle(
  door: DoorModel,
  obstacles: readonly DoorObstacle[],
): { angle: number; blockedBy: DoorObstacle | null } {
  const blocking = obstacles.filter((o) => o.height > door.undercut);
  const hit = (theta: number): DoorObstacle | null => {
    const leaf = leafPolygon(door, theta);
    for (const o of blocking) if (convexPolygonsOverlap(leaf, o.polygon, 1e-9)) return o;
    return null;
  };

  const at0 = hit(0);
  if (at0) return { angle: 0, blockedBy: at0 };

  const req = door.requiredOpening;
  let free = 0;
  for (let theta = SWEEP_STEP; ; theta += SWEEP_STEP) {
    const th = Math.min(theta, req);
    const h = hit(th);
    if (h) {
      let lo = free;
      let hi = th;
      for (let i = 0; i < BISECTION_STEPS; i++) {
        const mid = (lo + hi) / 2;
        if (hit(mid)) hi = mid;
        else lo = mid;
      }
      return { angle: lo, blockedBy: h };
    }
    free = th;
    if (th >= req) break;
  }
  return { angle: req, blockedBy: null };
}

export function analyzeDoorSwing(
  door: DoorModel,
  parcel: { footprint: Polygon; height: number } | null,
  staticObstacles: readonly DoorObstacle[],
): DoorSwingResult {
  const region = swingRegion(door);
  let overlapPolygon: Vec2[] = [];
  let overlapArea = 0;
  if (parcel) {
    overlapPolygon = clipPolygon(parcel.footprint, region);
    overlapArea = overlapPolygon.length >= 3 ? polygonArea(overlapPolygon) : 0;
    if (overlapArea <= 1e-6) overlapPolygon = [];
  }
  const intersects = overlapArea > 1e-6;

  const obstacles: DoorObstacle[] = [...staticObstacles];
  if (parcel) obstacles.push({ polygon: parcel.footprint, height: parcel.height, label: 'Parcel' });
  const { angle, blockedBy } = maxOpeningAngle(door, obstacles);
  const physicallyBlocked = angle < door.requiredOpening - 1e-9;
  const leaf = leafPolygon(door, angle);

  let contactPoint: Vec2 | null = null;
  if (blockedBy) {
    const c = polygonBoundaryClosest(leaf, blockedBy.polygon);
    contactPoint = midpoint(c.p, c.q);
  }

  return {
    swingRegion: region,
    intersectsSwingRegion: intersects,
    overlapArea,
    overlapPolygon,
    maxOpening: angle,
    requiredOpening: door.requiredOpening,
    physicallyBlocked,
    passesUnderLeaf: intersects && !!parcel && parcel.height <= door.undercut,
    blockedBy: blockedBy?.label ?? null,
    contactPoint,
    leafAtMaxOpening: leaf,
  };
}
