import { DEG, DEFAULT_LAYOUT, type EntranceLayout } from './coordinateSystem';
import { axisAlignedRectangle, ensureCCW } from './polygons';
import type { EntranceModel, Polygon, StaticObstacle, Vec2 } from './types';
import { v2 } from './vec2';

/** The walkway continues into the public sidewalk here: an open, non-physical edge. */
const STREET_EDGE = 'Street (open edge)';

/**
 * Build the analysis model from the calibrated layout. The walkable outline is
 * the union of foyer, doorway, landing, ramp and walkway; every edge carries a
 * label so the engine can explain *what* forms a pinch point.
 */
export function buildEntranceModel(layout: EntranceLayout = DEFAULT_LAYOUT): EntranceModel {
  const { landing: L, ramp: R, walkway: W, foyer: F, doorOpening: D, facade } = layout;
  const zf = facade.outerZ;
  const zi = facade.outerZ - facade.thickness;

  const outline: Array<[Vec2, string]> = [
    [v2(F.xMin, F.zMin), 'Foyer wall'],
    [v2(F.xMax, F.zMin), 'Foyer wall'],
    [v2(F.xMax, zi), 'Facade wall (interior)'],
    [v2(D.xMax, zi), 'Door jamb (latch side)'],
    [v2(D.xMax, zf), 'Facade wall'],
    [v2(L.xMax, zf), 'Planter wall (east)'],
    [v2(L.xMax, L.zMax), 'Landing guard rail'],
    [v2(R.xMax, L.zMax), 'Ramp handrail (east)'],
    [v2(R.xMax, R.zBottom), 'Walkway edge'],
    [v2(W.xMax, W.zMin), 'Walkway edge'],
    [v2(W.xMax, W.zMax), STREET_EDGE],
    [v2(W.xMin, W.zMax), 'Walkway edge'],
    [v2(W.xMin, W.zMin), 'Walkway edge'],
    [v2(R.xMin, R.zBottom), 'Ramp handrail (west)'],
    [v2(R.xMin, L.zMax), 'Landing guard rail'],
    [v2(L.xMin, L.zMax), 'Planter wall (west)'],
    [v2(L.xMin, zf), 'Facade wall'],
    [v2(D.xMin, zf), 'Door jamb (hinge side)'],
    [v2(D.xMin, zi), 'Facade wall (interior)'],
    [v2(F.xMin, zi), 'Foyer wall'],
  ];

  // Keep vertex order and labels aligned: label i belongs to edge i → i+1.
  let polygon: Vec2[] = outline.map(([p]) => p);
  let labels = outline.map(([, l]) => l);
  if (signedAreaOf(polygon) < 0) {
    polygon = [...polygon].reverse();
    // After reversing, edge i runs from reversed[i] to reversed[i+1], i.e. original edge (n-2-i).
    const n = labels.length;
    labels = polygon.map((_, i) => outline[(n - 2 - i + n) % n][1]);
  }

  const obstacles: StaticObstacle[] = layout.planters.map((p) => ({
    id: p.id,
    label: p.label,
    height: p.height,
    polygon: axisAlignedRectangle(
      p.center.x - p.size / 2,
      p.center.z - p.size / 2,
      p.center.x + p.size / 2,
      p.center.z + p.size / 2,
    ),
  }));

  const toPoly = (pts: Array<{ x: number; z: number }>): Polygon => ensureCCW(pts.map((p) => v2(p.x, p.z)));

  const openEdges = labels.flatMap((l, i) => (l === STREET_EDGE ? [i] : []));

  return {
    name: layout.name,
    walkable: { polygon, edgeLabels: labels, openEdges },
    obstacles,
    door: {
      label: layout.door.label,
      hinge: v2(layout.door.hinge.x, layout.door.hinge.z),
      width: layout.door.width,
      thickness: layout.door.thickness,
      height: layout.door.height,
      closedAngle: layout.door.closedDirectionDeg * DEG,
      openingSense: layout.door.openingSense,
      requiredOpening: layout.door.requiredOpeningDeg * DEG,
      undercut: layout.door.undercut,
    },
    route: {
      label: layout.route.label,
      corridor: toPoly(layout.route.corridor),
      start: v2(layout.route.start.x, layout.route.start.z),
      goal: v2(layout.route.goal.x, layout.route.goal.z),
    },
    safeDropZone: {
      label: layout.safeDropZone.label,
      polygon: toPoly(layout.safeDropZone.polygon),
      suggestedCenter: v2(layout.safeDropZone.suggestedParcelCenter.x, layout.safeDropZone.suggestedParcelCenter.z),
    },
    dropPrior: {
      center: v2(layout.dropPrior.center.x, layout.dropPrior.center.z),
      radius: layout.dropPrior.radius,
      yaw: layout.dropPrior.yawDeg * DEG,
    },
    defaultRequiredClearWidth: layout.requiredClearWidth,
    gridSpacing: layout.analysisGrid.spacing,
  };
}

function signedAreaOf(poly: Vec2[]): number {
  let s = 0;
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % poly.length];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

export const DEFAULT_MODEL: EntranceModel = buildEntranceModel(DEFAULT_LAYOUT);
