import { isConvex, isSimplePolygon, pointInPolygon, pointPolygonDistance, polygonContainsPolygon, polygonsIntersect } from './polygons';
import type { EntranceModel, ParcelPose, Polygon, Vec2 } from './types';
import { isFiniteVec } from './vec2';

export interface ValidationIssue {
  readonly path: string;
  readonly message: string;
}

const finite = (n: number): boolean => typeof n === 'number' && Number.isFinite(n);

function checkPolygon(issues: ValidationIssue[], path: string, poly: Polygon, mustBeConvex = false): void {
  if (!Array.isArray(poly) || poly.length < 3) {
    issues.push({ path, message: 'needs at least 3 vertices' });
    return;
  }
  if (!poly.every(isFiniteVec)) {
    issues.push({ path, message: 'contains a non-finite vertex' });
    return;
  }
  if (!isSimplePolygon(poly)) issues.push({ path, message: 'is self-intersecting or has zero area' });
  if (mustBeConvex && !isConvex(poly)) issues.push({ path, message: 'must be convex' });
}

/**
 * Reject impossible or inconsistent configurations before any analysis runs.
 * An invalid model never produces a clearance number or a route.
 */
export function validateModel(model: EntranceModel, requiredClearWidth: number): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const walk = model.walkable.polygon;
  checkPolygon(issues, 'walkable.polygon', walk);
  if (model.walkable.edgeLabels.length !== walk.length) {
    issues.push({ path: 'walkable.edgeLabels', message: 'must have one label per edge' });
  }
  checkPolygon(issues, 'route.corridor', model.route.corridor);
  checkPolygon(issues, 'safeDropZone.polygon', model.safeDropZone.polygon, true);
  model.obstacles.forEach((o, i) => {
    checkPolygon(issues, `obstacles[${i}].polygon`, o.polygon, true);
    if (!finite(o.height) || o.height <= 0) issues.push({ path: `obstacles[${i}].height`, message: 'must be > 0' });
  });

  const d = model.door;
  if (!isFiniteVec(d.hinge)) issues.push({ path: 'door.hinge', message: 'must be a finite point' });
  if (!finite(d.width) || d.width <= 0.3 || d.width > 3) issues.push({ path: 'door.width', message: 'must be between 0.3 m and 3 m' });
  if (!finite(d.thickness) || d.thickness <= 0 || d.thickness > 0.2) issues.push({ path: 'door.thickness', message: 'must be between 0 and 0.2 m' });
  if (!finite(d.requiredOpening) || d.requiredOpening <= 0 || d.requiredOpening > Math.PI) {
    issues.push({ path: 'door.requiredOpening', message: 'must be within (0°, 180°]' });
  }
  if (d.openingSense !== 1 && d.openingSense !== -1) issues.push({ path: 'door.openingSense', message: 'must be +1 or −1' });
  if (!finite(d.undercut) || d.undercut < 0) issues.push({ path: 'door.undercut', message: 'must be ≥ 0' });

  if (!finite(requiredClearWidth) || requiredClearWidth <= 0) {
    issues.push({ path: 'requiredClearWidth', message: 'must be a positive width in meters' });
  } else if (requiredClearWidth > 3) {
    issues.push({ path: 'requiredClearWidth', message: 'is implausibly large (> 3 m)' });
  }
  if (!finite(model.gridSpacing) || model.gridSpacing < 0.005 || model.gridSpacing > 0.2) {
    issues.push({ path: 'gridSpacing', message: 'must be between 0.005 m and 0.2 m' });
  }

  if (issues.length > 0) return issues; // later checks rely on valid polygons

  const insideWalkable = (p: Vec2) => pointInPolygon(p, walk);
  if (!insideWalkable(model.route.start)) issues.push({ path: 'route.start', message: 'is outside the walkable surface' });
  if (!insideWalkable(model.route.goal)) issues.push({ path: 'route.goal', message: 'is outside the walkable surface' });
  for (const o of model.obstacles) {
    if (pointPolygonDistance(model.route.start, o.polygon) === 0) issues.push({ path: 'route.start', message: `is inside ${o.label}` });
    if (pointPolygonDistance(model.route.goal, o.polygon) === 0) issues.push({ path: 'route.goal', message: `is inside ${o.label}` });
  }
  if (!polygonContainsPolygon(walk, model.safeDropZone.polygon, 1e-6)) {
    issues.push({ path: 'safeDropZone.polygon', message: 'must lie on the walkable surface' });
  }
  for (const o of model.obstacles) {
    if (polygonsIntersect(o.polygon, model.safeDropZone.polygon)) {
      issues.push({ path: 'safeDropZone.polygon', message: `overlaps ${o.label}` });
    }
  }
  return issues;
}

export function validateParcel(parcel: ParcelPose | null): ValidationIssue[] {
  if (!parcel) return [];
  const issues: ValidationIssue[] = [];
  if (!isFiniteVec(parcel.center)) issues.push({ path: 'parcel.center', message: 'must be a finite point' });
  if (!finite(parcel.yaw)) issues.push({ path: 'parcel.yaw', message: 'must be finite' });
  const s = parcel.size;
  for (const k of ['width', 'depth', 'height'] as const) {
    if (!finite(s[k]) || s[k] <= 0) issues.push({ path: `parcel.size.${k}`, message: 'must be > 0' });
    else if (s[k] > 3) issues.push({ path: `parcel.size.${k}`, message: 'is implausibly large (> 3 m)' });
  }
  return issues;
}
