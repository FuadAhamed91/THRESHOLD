/**
 * Clearance field on a uniform grid.
 *
 * Every grid node on the walkable surface stores the EXACT Euclidean distance
 * (point-to-segment, not a raster approximation) to the nearest boundary edge
 * or obstacle. A node's value is the radius of the largest clear disc centred
 * there; a route that keeps every node ≥ w/2 keeps a passage of width w.
 * Static features are computed once per model; parcel and door leaf are layered
 * on top per analysis.
 */
import { bounds, pointInPolygon } from './polygons';
import type { EntranceModel, Feature, Polygon, Vec2 } from './types';
import { v2 } from './vec2';

export interface GridSpec {
  readonly x0: number;
  readonly z0: number;
  readonly nx: number;
  readonly nz: number;
  readonly h: number;
}

export interface DynamicObstacle {
  readonly polygon: Polygon;
  readonly label: string;
  readonly kind: 'parcel' | 'door' | 'obstacle';
  readonly owner: string;
}

interface EdgeArrays {
  ax: Float64Array;
  az: Float64Array;
  bx: Float64Array;
  bz: Float64Array;
}

function toEdgeArrays(features: readonly Feature[]): EdgeArrays {
  const n = features.length;
  const out = { ax: new Float64Array(n), az: new Float64Array(n), bx: new Float64Array(n), bz: new Float64Array(n) };
  features.forEach((f, i) => {
    out.ax[i] = f.a.x;
    out.az[i] = f.a.z;
    out.bx[i] = f.b.x;
    out.bz[i] = f.b.z;
  });
  return out;
}

function minEdgeDistance(px: number, pz: number, e: EdgeArrays, from = 0, to = e.ax.length): number {
  let best = Infinity;
  for (let k = from; k < to; k++) {
    const ax = e.ax[k];
    const az = e.az[k];
    const abx = e.bx[k] - ax;
    const abz = e.bz[k] - az;
    const len2 = abx * abx + abz * abz;
    let t = len2 > 0 ? ((px - ax) * abx + (pz - az) * abz) / len2 : 0;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (ax + abx * t);
    const dz = pz - (az + abz * t);
    const d2 = dx * dx + dz * dz;
    if (d2 < best) best = d2;
  }
  return Math.sqrt(best);
}

export function polygonFeatures(polygon: Polygon, label: string, kind: Feature['kind'], owner: string): Feature[] {
  return polygon.map((a, i) => ({ a, b: polygon[(i + 1) % polygon.length], label, kind, owner }));
}

export class ClearanceGrid {
  readonly spec: GridSpec;
  /** 1 when the node is on the walkable surface and outside every static obstacle. */
  readonly inside: Uint8Array;
  /** Exact distance to the nearest static feature (0 for nodes that are not `inside`). */
  readonly staticDist: Float32Array;
  readonly staticFeatures: readonly Feature[];
  readonly maxStaticDist: number;
  private readonly walkable: Polygon;
  private readonly obstaclePolys: readonly Polygon[];
  private readonly staticEdges: EdgeArrays;

  constructor(model: EntranceModel, spacing = model.gridSpacing) {
    const walk = model.walkable.polygon;
    this.walkable = walk;
    this.obstaclePolys = model.obstacles.map((o) => o.polygon);
    const b = bounds(walk);
    const h = spacing;
    const nx = Math.floor((b.maxX - b.minX) / h) + 1;
    const nz = Math.floor((b.maxZ - b.minZ) / h) + 1;
    this.spec = { x0: b.minX, z0: b.minZ, nx, nz, h };

    const open = new Set(model.walkable.openEdges ?? []);
    const features: Feature[] = walk
      .map((a, i) => ({
        a,
        b: walk[(i + 1) % walk.length],
        label: model.walkable.edgeLabels[i] ?? 'Boundary',
        kind: 'boundary' as const,
        owner: 'walkable',
        index: i,
      }))
      .filter((f) => !open.has(f.index))
      .map(({ index: _index, ...f }) => f);
    for (const o of model.obstacles) features.push(...polygonFeatures(o.polygon, o.label, 'obstacle', o.id));
    this.staticFeatures = features;
    this.staticEdges = toEdgeArrays(features);

    const count = nx * nz;
    this.inside = new Uint8Array(count);
    this.staticDist = new Float32Array(count);
    let maxD = 0;
    for (let j = 0; j < nz; j++) {
      const z = b.minZ + j * h;
      for (let i = 0; i < nx; i++) {
        const x = b.minX + i * h;
        const p = v2(x, z);
        if (!pointInPolygon(p, walk)) continue;
        if (this.obstaclePolys.some((poly) => pointInPolygon(p, poly))) continue;
        const k = j * nx + i;
        const d = minEdgeDistance(x, z, this.staticEdges);
        this.inside[k] = 1;
        this.staticDist[k] = d;
        if (d > maxD) maxD = d;
      }
    }
    this.maxStaticDist = maxD;
  }

  get size(): number {
    return this.spec.nx * this.spec.nz;
  }

  point(k: number): Vec2 {
    const { nx, x0, z0, h } = this.spec;
    return v2(x0 + (k % nx) * h, z0 + Math.floor(k / nx) * h);
  }

  /** Nearest node to `p` (clamped to the grid). */
  nodeAt(p: Vec2): number {
    const { nx, nz, x0, z0, h } = this.spec;
    const i = Math.min(nx - 1, Math.max(0, Math.round((p.x - x0) / h)));
    const j = Math.min(nz - 1, Math.max(0, Math.round((p.z - z0) / h)));
    return j * nx + i;
  }

  /** Clearance field with dynamic obstacles (parcel, door leaf) layered on the static field. */
  withObstacles(dynamic: readonly DynamicObstacle[]): Float32Array {
    const field = this.staticDist.slice();
    const { nx, nz, x0, z0, h } = this.spec;
    for (const obs of dynamic) {
      const poly = obs.polygon;
      if (poly.length < 3) continue;
      const edgesArr = toEdgeArrays(polygonFeatures(poly, obs.label, obs.kind, obs.owner));
      const bb = bounds(poly);
      const pad = this.maxStaticDist + h;
      const i0 = Math.max(0, Math.floor((bb.minX - pad - x0) / h));
      const i1 = Math.min(nx - 1, Math.ceil((bb.maxX + pad - x0) / h));
      const j0 = Math.max(0, Math.floor((bb.minZ - pad - z0) / h));
      const j1 = Math.min(nz - 1, Math.ceil((bb.maxZ + pad - z0) / h));
      for (let j = j0; j <= j1; j++) {
        const z = z0 + j * h;
        for (let i = i0; i <= i1; i++) {
          const k = j * nx + i;
          if (!this.inside[k]) continue;
          const x = x0 + i * h;
          if (x >= bb.minX && x <= bb.maxX && z >= bb.minZ && z <= bb.maxZ && pointInPolygon(v2(x, z), poly)) {
            field[k] = 0;
            continue;
          }
          const d = minEdgeDistance(x, z, edgesArr);
          if (d < field[k]) field[k] = d;
        }
      }
    }
    return field;
  }

  /** Exact clearance radius at an arbitrary point (0 off the walkable surface or inside an obstacle). */
  exactClearance(p: Vec2, dynamic: readonly DynamicObstacle[]): number {
    if (!pointInPolygon(p, this.walkable)) return 0;
    for (const poly of this.obstaclePolys) if (pointInPolygon(p, poly)) return 0;
    let d = minEdgeDistance(p.x, p.z, this.staticEdges);
    for (const obs of dynamic) {
      if (pointInPolygon(p, obs.polygon)) return 0;
      const e = toEdgeArrays(polygonFeatures(obs.polygon, obs.label, obs.kind, obs.owner));
      d = Math.min(d, minEdgeDistance(p.x, p.z, e));
    }
    return d;
  }

  /** All features (static + dynamic) for pinch identification. */
  allFeatures(dynamic: readonly DynamicObstacle[]): Feature[] {
    const out = [...this.staticFeatures];
    for (const obs of dynamic) out.push(...polygonFeatures(obs.polygon, obs.label, obs.kind, obs.owner));
    return out;
  }
}

const gridCache = new WeakMap<EntranceModel, Map<number, ClearanceGrid>>();

/** Static fields are deterministic per (model, spacing); cache them. */
export function getClearanceGrid(model: EntranceModel, spacing = model.gridSpacing): ClearanceGrid {
  let bySpacing = gridCache.get(model);
  if (!bySpacing) {
    bySpacing = new Map();
    gridCache.set(model, bySpacing);
  }
  let grid = bySpacing.get(spacing);
  if (!grid) {
    grid = new ClearanceGrid(model, spacing);
    bySpacing.set(spacing, grid);
  }
  return grid;
}
