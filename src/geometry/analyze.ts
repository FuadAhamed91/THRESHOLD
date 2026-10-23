/**
 * Entrance analysis orchestrator — the single source of truth for every status,
 * measurement and route the UI and 3D scene display. Pure and deterministic:
 * the same model, parcel pose and configuration always give the same result.
 */
import { refinePinch, pinchIndex, widestPath } from './clearance';
import { DEG } from './coordinateSystem';
import { getClearanceGrid, type DynamicObstacle } from './distanceField';
import { analyzeDoorSwing, type DoorObstacle } from './doorSwing';
import { astar, pathLength, refineRoute } from './pathfinding';
import { orientedRectangle, polygonContainsPolygon, polygonsIntersect } from './polygons';
import { analyzeRouteIntrusion } from './routeObstruction';
import { analyzeSafeDropZone } from './safeDropZone';
import type {
  AnalysisResult,
  AnalysisStatus,
  ClearanceResult,
  DoorSwingResult,
  EntranceModel,
  FailureCode,
  Finding,
  ParcelPose,
  Placement,
  RouteIntrusionResult,
  RouteResult,
  SafeZoneResult,
  UncertaintyResult,
  UncertaintySample,
  Vec2,
} from './types';
import { validateModel, validateParcel } from './validateConfig';
import { add, direction } from './vec2';

export interface AnalysisInput {
  readonly model: EntranceModel;
  readonly parcel: ParcelPose | null;
  readonly placement: Placement;
  readonly requiredClearWidth: number;
  /** Evaluate plausible placements when the position is uncertain (default true). */
  readonly evaluateUncertainty?: boolean;
}

/** Uncertainty radius above which a single placement cannot support a definitive conclusion. */
export const DEFINITIVE_RADIUS = 0.08;

export function parcelFootprint(parcel: ParcelPose): Vec2[] {
  return orientedRectangle(parcel.center, parcel.yaw, parcel.size.width, parcel.size.depth);
}

interface CoreResult {
  door: DoorSwingResult;
  route: RouteIntrusionResult;
  safeZone: SafeZoneResult;
  clearance: ClearanceResult;
  path: RouteResult;
}

const fmt = (n: number, digits = 2) => n.toFixed(digits);

function staticDoorObstacles(model: EntranceModel): DoorObstacle[] {
  return model.obstacles.map((o) => ({ polygon: o.polygon, height: o.height, label: o.label }));
}

function dynamicObstacles(parcelPoly: Vec2[] | null, door: DoorSwingResult): DynamicObstacle[] {
  const out: DynamicObstacle[] = [];
  if (parcelPoly) out.push({ polygon: parcelPoly, label: 'Parcel', kind: 'parcel', owner: 'parcel' });
  const deg = Math.round(door.maxOpening / DEG);
  out.push({
    polygon: door.leafAtMaxOpening,
    label: door.physicallyBlocked ? `Door leaf (stopped at ${deg}°)` : `Door leaf (open ${deg}°)`,
    kind: 'door',
    owner: 'door',
  });
  return out;
}

function analyzeCore(model: EntranceModel, parcel: ParcelPose | null, required: number): CoreResult {
  const footprint = parcel ? parcelFootprint(parcel) : null;
  const door = analyzeDoorSwing(
    model.door,
    parcel && footprint ? { footprint, height: parcel.size.height } : null,
    staticDoorObstacles(model),
  );
  const route = analyzeRouteIntrusion(model.route.corridor, footprint);
  const safeZone = analyzeSafeDropZone(model.safeDropZone.polygon, footprint);

  const grid = getClearanceGrid(model);
  const dynamic = dynamicObstacles(footprint, door);
  const field = grid.withObstacles(dynamic);
  const startK = grid.nodeAt(model.route.start);
  const goalK = grid.nodeAt(model.route.goal);
  const radius = required / 2;

  // ── Clearance: widest route and its narrowest point ──────────────────────
  const wide = widestPath(grid, field, startK, goalK);
  let clearance: ClearanceResult;
  if (!wide.reached || wide.nodes.length === 0) {
    clearance = {
      width: 0,
      required,
      meetsRequirement: false,
      method: 'grid',
      tolerance: Math.SQRT2 * grid.spec.h,
      pinch: null,
      gridBottleneck: 0,
    };
  } else {
    const gridWidth = 2 * wide.bottleneck;
    const idx = pinchIndex(field, wide.nodes);
    const center = grid.point(wide.nodes[Math.max(0, idx)]);
    const refined = refinePinch(center, gridWidth, grid.allFeatures(dynamic), grid.spec.h);
    clearance = {
      width: refined.width,
      required,
      meetsRequirement: refined.width >= required - 1e-9,
      method: refined.method,
      tolerance: refined.tolerance,
      pinch: refined.pinch,
      gridBottleneck: wide.bottleneck,
    };
  }

  // ── Route: A* with obstacles inflated by the required half-width ──────────
  const search = astar(grid, field, startK, goalK, radius);
  const explored = new Float32Array(search.explored.length * 2);
  search.explored.forEach((k, i) => {
    const p = grid.point(k);
    explored[i * 2] = p.x;
    explored[i * 2 + 1] = p.z;
  });

  let path: RouteResult;
  if (search.found) {
    const margin = Math.min(0.1, Math.max(0, wide.bottleneck - radius));
    const refinedRoute = refineRoute(grid, field, dynamic, search.nodes, radius, margin);
    path = {
      found: true,
      points: refinedRoute.points,
      length: pathLength(refinedRoute.points),
      reachable: [],
      blockedContinuation: [],
      stopPoint: null,
      failure: null,
      verifiedMinClearance: refinedRoute.minClearance,
      explored,
    };
  } else {
    let reachable: Vec2[] = [];
    let continuation: Vec2[] = [];
    let stopPoint: Vec2 | null = null;
    let code: FailureCode;
    if (search.failure === 'START_BLOCKED' || search.failure === 'GOAL_BLOCKED') code = search.failure;
    else if (!wide.reached || wide.bottleneck <= 1e-6) code = 'NO_CONNECTION';
    else code = 'PASSAGE_TOO_NARROW';
    if (search.failure !== 'START_BLOCKED' && wide.nodes.length > 0) {
      let firstBad = wide.nodes.findIndex((k) => field[k] < radius);
      if (firstBad < 0) firstBad = wide.nodes.length - 1;
      const stopIdx = Math.max(0, firstBad - 1);
      const stopNode = wide.nodes[stopIdx];
      const partial = astar(grid, field, startK, stopNode, radius);
      if (partial.found) {
        reachable = refineRoute(grid, field, dynamic, partial.nodes, radius, 0.05).points;
      } else {
        reachable = wide.nodes.slice(0, stopIdx + 1).map((k) => grid.point(k));
      }
      stopPoint = reachable[reachable.length - 1] ?? grid.point(stopNode);
      const rest = wide.nodes.slice(stopIdx);
      continuation = rest.filter((_, i) => i % 4 === 0 || i === rest.length - 1).map((k) => grid.point(k));
    } else {
      stopPoint = model.route.start;
    }
    const pinch = clearance.pinch;
    const where = pinch ? ` between ${pinch.labelA.toLowerCase()} and ${pinch.labelB.toLowerCase()}` : '';
    const messages: Record<string, string> = {
      START_BLOCKED: `The start of the route has less than ${fmt(required)} m of clear width.`,
      GOAL_BLOCKED: `The destination has less than ${fmt(required)} m of clear width.`,
      PASSAGE_TOO_NARROW: `No route keeps ${fmt(required)} m clear: the passage narrows to ${fmt(clearance.width)} m${where}.`,
      NO_CONNECTION: 'The route is fully closed: no connected passage reaches the door.',
    };
    path = {
      found: false,
      points: [],
      length: 0,
      reachable,
      blockedContinuation: continuation,
      stopPoint,
      failure: { code, message: messages[code] },
      verifiedMinClearance: null,
      explored,
    };
  }

  return { door, route, safeZone, clearance, path };
}

/** Evaluate plausible placements around an uncertain estimate. */
function evaluateUncertainty(
  model: EntranceModel,
  parcel: ParcelPose,
  placement: Placement,
  required: number,
): UncertaintyResult {
  const radius = placement.uncertaintyRadius;
  const grid = getClearanceGrid(model);
  const candidates: Array<{ center: Vec2; yaw: number }> = [{ center: parcel.center, yaw: parcel.yaw }];
  for (let i = 0; i < 8; i++) {
    const c = add(parcel.center, { x: direction((i * Math.PI) / 4).x * radius, z: direction((i * Math.PI) / 4).z * radius });
    candidates.push({ center: c, yaw: parcel.yaw + (i % 2 === 0 ? 0.35 : -0.35) });
  }
  const samples: UncertaintySample[] = [];
  for (const cand of candidates) {
    const pose: ParcelPose = { center: cand.center, yaw: cand.yaw, size: parcel.size };
    const fp = parcelFootprint(pose);
    // Skip physically impossible placements (through walls or into planters).
    if (!polygonContainsPolygon(model.walkable.polygon, fp, 1e-6)) continue;
    if (model.obstacles.some((o) => polygonsIntersect(o.polygon, fp))) continue;
    const door = analyzeDoorSwing(model.door, { footprint: fp, height: parcel.size.height }, staticDoorObstacles(model));
    const field = grid.withObstacles(dynamicObstacles(fp, door));
    const wide = widestPath(grid, field, grid.nodeAt(model.route.start), grid.nodeAt(model.route.goal));
    samples.push({
      center: cand.center,
      yaw: cand.yaw,
      doorBlocked: door.physicallyBlocked,
      routeFound: wide.reached && 2 * wide.bottleneck >= required - 1e-9,
      clearanceWidth: 2 * wide.bottleneck,
    });
  }
  const blockedDoors = samples.filter((s) => s.doorBlocked).length;
  const validRoutes = samples.filter((s) => s.routeFound).length;
  const doorAgreement = blockedDoors === samples.length ? 'all-blocked' : blockedDoors === 0 ? 'all-clear' : 'mixed';
  const routeAgreement = validRoutes === samples.length ? 'all-valid' : validRoutes === 0 ? 'all-blocked' : 'mixed';
  return {
    evaluated: true,
    radius,
    samples,
    doorAgreement,
    routeAgreement,
    verdict: doorAgreement === 'mixed' || routeAgreement === 'mixed' ? 'indeterminate' : 'robust',
  };
}

const NOT_EVALUATED: UncertaintyResult = {
  evaluated: false,
  radius: 0,
  samples: [],
  doorAgreement: 'all-clear',
  routeAgreement: 'all-valid',
  verdict: 'definitive',
};

function buildFindings(core: CoreResult, parcel: ParcelPose | null, placement: Placement, uncertainty: UncertaintyResult, marginal: boolean): Finding[] {
  const f: Finding[] = [];
  const { door, route, clearance, path, safeZone } = core;
  const req = Math.round(door.requiredOpening / DEG);
  if (door.physicallyBlocked) {
    f.push({
      code: 'DOOR_BLOCKED',
      severity: 'critical',
      title: `Door opens only ${Math.round(door.maxOpening / DEG)}° of ${req}°`,
      detail: `The leaf contacts the ${(door.blockedBy ?? 'obstacle').toLowerCase()} inside its swing region.`,
    });
  } else if (door.intersectsSwingRegion) {
    f.push({
      code: door.passesUnderLeaf ? 'DOOR_PASSES_UNDER' : 'DOOR_REGION',
      severity: 'warning',
      title: 'Parcel inside door swing region',
      detail: door.passesUnderLeaf
        ? 'The parcel is lower than the door undercut, so the leaf passes over it.'
        : 'The parcel overlaps the swing region but the leaf still reaches the required opening.',
    });
  }
  if (route.intrudes) {
    f.push({
      code: 'ROUTE_INTRUSION',
      severity: path.found ? 'warning' : 'critical',
      title: 'Parcel inside the accessible route',
      detail: `${fmt(route.overlapArea, 3)} m² of the configured route is covered (${Math.round(route.footprintShare * 100)}% of the footprint).`,
    });
  }
  if (clearance.pinch) {
    f.push({
      code: clearance.meetsRequirement ? 'CLEARANCE_OK' : 'CLEARANCE_BELOW',
      severity: clearance.meetsRequirement ? 'ok' : 'critical',
      title: `Narrowest passage ${fmt(clearance.width)} m (${fmt(clearance.required)} m required)`,
      detail: `Between ${clearance.pinch.labelA.toLowerCase()} and ${clearance.pinch.labelB.toLowerCase()}.`,
    });
  }
  if (path.found) {
    f.push({
      code: 'ROUTE_OK',
      severity: 'ok',
      title: `Route to the door is navigable (${fmt(path.length, 1)} m)`,
      detail: `Keeps ≥ ${fmt(2 * (path.verifiedMinClearance ?? 0))} m clear width along its length.`,
    });
  } else if (path.failure) {
    f.push({ code: path.failure.code, severity: 'critical', title: 'No valid route', detail: path.failure.message });
  }
  if (parcel) {
    f.push(
      safeZone.contained
        ? { code: 'SAFE_ZONE_INSIDE', severity: 'ok', title: 'Parcel inside the safe drop zone', detail: 'Zone containment alone does not prove access; route and door were re-checked.' }
        : { code: 'SAFE_ZONE_OUTSIDE', severity: 'info', title: 'Parcel outside the safe drop zone', detail: `${Math.round(safeZone.overlapFraction * 100)}% of the footprint is inside the zone.` },
    );
  }
  if (placement.source === 'estimated_prior') {
    f.push({
      code: 'PLACEMENT_ESTIMATED',
      severity: 'warning',
      title: `Position estimated (±${fmt(placement.uncertaintyRadius)} m)`,
      detail: 'Ring events carry no parcel coordinates. This estimate comes from the entrance’s courier-drop prior, not a camera measurement.',
    });
  }
  if (uncertainty.verdict === 'indeterminate') {
    const blocking = uncertainty.samples.filter((s) => !s.routeFound || s.doorBlocked).length;
    f.push({
      code: 'UNCERTAIN_OUTCOME',
      severity: 'warning',
      title: 'Outcome depends on the exact placement',
      detail: `${blocking} of ${uncertainty.samples.length} plausible placements obstruct the entrance. Confirm the position or request a fresh observation.`,
    });
  }
  if (marginal) {
    f.push({
      code: 'MARGINAL',
      severity: 'warning',
      title: 'Within measurement tolerance',
      detail: `Clearance is within ±${fmt(clearance.tolerance, 3)} m of the requirement; verify on site.`,
    });
  }
  return f;
}

export function analyzeEntrance(input: AnalysisInput): AnalysisResult {
  const t0 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  const { model, parcel, placement, requiredClearWidth } = input;
  const issues = [...validateModel(model, requiredClearWidth), ...validateParcel(parcel)].map(
    (i) => `${i.path} ${i.message}`,
  );
  if (issues.length > 0) return invalidResult(issues, parcel, placement, requiredClearWidth, model);

  const core = analyzeCore(model, parcel, requiredClearWidth);
  const uncertainty =
    parcel && input.evaluateUncertainty !== false && placement.uncertaintyRadius > DEFINITIVE_RADIUS
      ? evaluateUncertainty(model, parcel, placement, requiredClearWidth)
      : NOT_EVALUATED;

  const marginal = core.clearance.meetsRequirement !== core.path.found;
  const obstructed = core.door.physicallyBlocked || !core.path.found;
  let status: AnalysisStatus;
  if (uncertainty.verdict === 'indeterminate' || marginal) status = 'indeterminate';
  else if (obstructed) status = 'obstructed';
  else if (core.route.intrudes || core.door.intersectsSwingRegion) status = 'caution';
  else status = 'clear';

  const t1 = typeof performance !== 'undefined' ? performance.now() : Date.now();
  return {
    status,
    configErrors: [],
    parcel,
    parcelFootprint: parcel ? parcelFootprint(parcel) : [],
    placement,
    ...core,
    uncertainty,
    marginal,
    findings: buildFindings(core, parcel, placement, uncertainty, marginal),
    computeMs: t1 - t0,
  };
}

function invalidResult(
  issues: string[],
  parcel: ParcelPose | null,
  placement: Placement,
  required: number,
  model: EntranceModel,
): AnalysisResult {
  const empty: Vec2[] = [];
  return {
    status: 'invalid',
    configErrors: issues,
    parcel,
    parcelFootprint: empty,
    placement,
    door: {
      swingRegion: empty,
      intersectsSwingRegion: false,
      overlapArea: 0,
      overlapPolygon: empty,
      maxOpening: 0,
      requiredOpening: model.door?.requiredOpening ?? 0,
      physicallyBlocked: false,
      passesUnderLeaf: false,
      blockedBy: null,
      contactPoint: null,
      leafAtMaxOpening: empty,
    },
    route: { intrudes: false, overlapArea: 0, overlapPolygon: empty, footprintShare: 0 },
    safeZone: { contained: false, overlapFraction: 0 },
    clearance: { width: 0, required, meetsRequirement: false, method: 'grid', tolerance: 0, pinch: null, gridBottleneck: 0 },
    path: {
      found: false,
      points: empty,
      length: 0,
      reachable: empty,
      blockedContinuation: empty,
      stopPoint: null,
      failure: null,
      verifiedMinClearance: null,
      explored: new Float32Array(0),
    },
    uncertainty: NOT_EVALUATED,
    marginal: false,
    findings: issues.map((detail) => ({ code: 'INVALID_CONFIG', severity: 'critical', title: 'Invalid configuration', detail })),
    computeMs: 0,
  };
}
