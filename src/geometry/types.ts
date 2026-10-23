/**
 * Shared types for the THRESHOLD geometry engine.
 *
 * All values are meters / radians in the entrance-local plan frame:
 * a point is (x, z) on the ground plane, identical to Three.js world X/Z
 * (Y is up and is not part of the plan analysis). See coordinateSystem.ts.
 */

export interface Vec2 {
  readonly x: number;
  readonly z: number;
}

/** Simple polygon (no self-intersections). Orientation is normalized internally. */
export type Polygon = readonly Vec2[];

/** A labeled boundary segment the clearance and pinch analysis can name. */
export interface Feature {
  readonly a: Vec2;
  readonly b: Vec2;
  readonly label: string;
  readonly kind: 'boundary' | 'obstacle' | 'parcel' | 'door';
  /** Identifier of the polygon the edge belongs to. */
  readonly owner: string;
}

export interface StaticObstacle {
  readonly id: string;
  readonly label: string;
  /** Convex footprint polygon. */
  readonly polygon: Polygon;
  /** Height above the walking surface, meters. */
  readonly height: number;
}

export interface DoorModel {
  readonly label: string;
  /** Hinge axis in plan. */
  readonly hinge: Vec2;
  /** Leaf width from hinge axis to latch edge. */
  readonly width: number;
  readonly thickness: number;
  readonly height: number;
  /** Plan angle (from +X toward +Z) of the leaf when closed. */
  readonly closedAngle: number;
  /** +1 opens toward increasing plan angle (toward +Z for this door), -1 the other way. */
  readonly openingSense: 1 | -1;
  /** Opening the household needs for a wheelchair to pass, radians. */
  readonly requiredOpening: number;
  /** Gap under the leaf. Objects no taller than this pass beneath it. */
  readonly undercut: number;
}

export interface ParcelSize {
  /** Along the parcel's local X axis. */
  readonly width: number;
  /** Along the parcel's local Z axis. */
  readonly depth: number;
  readonly height: number;
}

/** Parcel pose on the ground plane. `yaw` uses the Three.js `rotation.y` convention. */
export interface ParcelPose {
  readonly center: Vec2;
  readonly yaw: number;
  readonly size: ParcelSize;
}

/** Where the parcel position came from. Confidence never replaces geometry. */
export type PlacementSource =
  | 'simulated' // scenario-defined position in simulation mode
  | 'estimated_prior' // estimated from the entrance's courier-drop prior (no camera geometry)
  | 'user_adjusted' // moved on the model by the user, not yet confirmed
  | 'user_confirmed'; // confirmed by a person against a real observation

export interface Placement {
  readonly source: PlacementSource;
  /** Radius (m) of the region the parcel could plausibly occupy. 0 = treated as exact. */
  readonly uncertaintyRadius: number;
}

export interface EntranceModel {
  readonly name: string;
  /**
   * Walkable surface the route may use, with one label per edge (edge i = vertex i → i+1).
   * `openEdges` lists edges that are not physical (e.g. where the public sidewalk
   * continues); they bound the search area but do not reduce clearance.
   */
  readonly walkable: { readonly polygon: Polygon; readonly edgeLabels: readonly string[]; readonly openEdges?: readonly number[] };
  readonly obstacles: readonly StaticObstacle[];
  readonly door: DoorModel;
  readonly route: {
    readonly label: string;
    /** Configured accessible-route corridor (policy region, may be concave). */
    readonly corridor: Polygon;
    readonly start: Vec2;
    readonly goal: Vec2;
  };
  readonly safeDropZone: { readonly label: string; readonly polygon: Polygon; readonly suggestedCenter: Vec2 };
  readonly dropPrior: { readonly center: Vec2; readonly radius: number; readonly yaw: number };
  readonly defaultRequiredClearWidth: number;
  readonly gridSpacing: number;
}

export interface DoorSwingResult {
  /** Plan-view swing region (sector of radius = leaf width through the required opening). */
  readonly swingRegion: Vec2[];
  /** Parcel footprint overlaps the swing region. */
  readonly intersectsSwingRegion: boolean;
  readonly overlapArea: number;
  readonly overlapPolygon: Vec2[];
  /** Largest opening angle the leaf reaches before touching an obstacle (radians). */
  readonly maxOpening: number;
  readonly requiredOpening: number;
  /** The leaf physically cannot reach the required opening. */
  readonly physicallyBlocked: boolean;
  /** The parcel is inside the swing region but low enough to pass under the leaf. */
  readonly passesUnderLeaf: boolean;
  readonly blockedBy: string | null;
  readonly contactPoint: Vec2 | null;
  /** Leaf footprint at `maxOpening`. */
  readonly leafAtMaxOpening: Vec2[];
}

export interface RouteIntrusionResult {
  readonly intrudes: boolean;
  readonly overlapArea: number;
  readonly overlapPolygon: Vec2[];
  /** Share of the parcel footprint that lies inside the corridor (0..1). */
  readonly footprintShare: number;
}

export interface SafeZoneResult {
  readonly contained: boolean;
  /** Share of the parcel footprint inside the zone (0..1). */
  readonly overlapFraction: number;
}

export interface PinchInfo {
  /** Grid node where the widest route is narrowest. */
  readonly point: Vec2;
  /** Dimension-line endpoints across the narrowest gap. */
  readonly a: Vec2;
  readonly b: Vec2;
  readonly labelA: string;
  readonly labelB: string;
}

export interface ClearanceResult {
  /** Widest clear passage width available along the best route (m). */
  readonly width: number;
  readonly required: number;
  readonly meetsRequirement: boolean;
  /** 'exact-pair' = closed-form gap between the two pinching features; 'grid' = grid estimate. */
  readonly method: 'exact-pair' | 'grid';
  /** Absolute measurement tolerance of `width` (m). */
  readonly tolerance: number;
  readonly pinch: PinchInfo | null;
  /** Grid-level maximin bottleneck half-width (m), used for consistency checks. */
  readonly gridBottleneck: number;
}

export type FailureCode =
  | 'START_BLOCKED'
  | 'GOAL_BLOCKED'
  | 'PASSAGE_TOO_NARROW'
  | 'NO_CONNECTION';

export interface RouteResult {
  readonly found: boolean;
  /** Smoothed, verified route (start → goal) when found. */
  readonly points: Vec2[];
  readonly length: number;
  /** When blocked: the traversable part of the widest attempt (start → stop point). */
  readonly reachable: Vec2[];
  /** When blocked: the continuation past the stop point to the goal along the widest attempt. */
  readonly blockedContinuation: Vec2[];
  readonly stopPoint: Vec2 | null;
  readonly failure: { readonly code: FailureCode; readonly message: string } | null;
  /** Minimum exact clearance radius measured along the returned route (m). */
  readonly verifiedMinClearance: number | null;
  /** Grid nodes in A* expansion order (plan coordinates, interleaved x,z), for visualization. */
  readonly explored: Float32Array;
}

export type FindingSeverity = 'critical' | 'warning' | 'info' | 'ok';

export interface Finding {
  readonly code: string;
  readonly severity: FindingSeverity;
  readonly title: string;
  readonly detail: string;
}

export type AnalysisStatus = 'clear' | 'caution' | 'obstructed' | 'indeterminate' | 'invalid';

export interface UncertaintySample {
  readonly center: Vec2;
  readonly yaw: number;
  readonly doorBlocked: boolean;
  readonly routeFound: boolean;
  readonly clearanceWidth: number;
}

export interface UncertaintyResult {
  readonly evaluated: boolean;
  readonly radius: number;
  readonly samples: UncertaintySample[];
  readonly doorAgreement: 'all-blocked' | 'all-clear' | 'mixed';
  readonly routeAgreement: 'all-valid' | 'all-blocked' | 'mixed';
  readonly verdict: 'definitive' | 'robust' | 'indeterminate';
}

export interface AnalysisResult {
  readonly status: AnalysisStatus;
  readonly configErrors: string[];
  readonly parcel: ParcelPose | null;
  readonly parcelFootprint: Vec2[];
  readonly placement: Placement;
  readonly door: DoorSwingResult;
  readonly route: RouteIntrusionResult;
  readonly safeZone: SafeZoneResult;
  readonly clearance: ClearanceResult;
  readonly path: RouteResult;
  readonly uncertainty: UncertaintyResult;
  /** Clearance and route validity disagree within measurement tolerance. */
  readonly marginal: boolean;
  readonly findings: Finding[];
  readonly computeMs: number;
}
