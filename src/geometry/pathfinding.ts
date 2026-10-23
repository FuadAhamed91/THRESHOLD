/**
 * Route validation and pathfinding.
 *
 * Grid A* over the clearance field. A node is traversable only if its exact
 * clearance radius is ≥ r = requiredClearWidth / 2 — equivalent to inflating every
 * obstacle and wall by r, so the returned route keeps the configured clear width
 * everywhere. Diagonal moves may not cut past a blocked orthogonal neighbour.
 * The cost adds a mild penalty for hugging walls so routes stay centred when the
 * passage allows. The final route is string-pulled, corner-smoothed and verified
 * against exact clearance; if smoothing would violate the constraint the
 * unsmoothed route is returned.
 */
import { MinHeap } from './heap';
import { NEIGHBORS, stepValue } from './clearance';
import type { ClearanceGrid, DynamicObstacle } from './distanceField';
import type { FailureCode, Vec2 } from './types';
import { distance, lerp } from './vec2';

export interface AStarResult {
  readonly found: boolean;
  readonly nodes: number[];
  readonly explored: number[];
  readonly failure: FailureCode | null;
}

const MAX_EXPLORED_RECORD = 30000;

export function astar(
  grid: ClearanceGrid,
  field: Float32Array,
  start: number,
  goal: number,
  radius: number,
  preferredExtra = 0.3,
  wallPenalty = 0.6,
): AStarResult {
  const { nx, h } = grid.spec;
  const explored: number[] = [];
  if (!grid.inside[start] || field[start] < radius) return { found: false, nodes: [], explored, failure: 'START_BLOCKED' };
  if (!grid.inside[goal] || field[goal] < radius) return { found: false, nodes: [], explored, failure: 'GOAL_BLOCKED' };

  const n = grid.size;
  const g = new Float64Array(n).fill(Infinity);
  const parent = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const gi = goal % nx;
  const gj = (goal - gi) / nx;
  const heuristic = (k: number) => {
    const i = k % nx;
    const j = (k - i) / nx;
    const dx = Math.abs(i - gi);
    const dz = Math.abs(j - gj);
    return h * (Math.max(dx, dz) + (Math.SQRT2 - 1) * Math.min(dx, dz));
  };
  const pref = radius + preferredExtra;
  const heap = new MinHeap(4096);
  g[start] = 0;
  heap.push(start, heuristic(start));
  while (heap.size > 0) {
    const u = heap.pop();
    if (closed[u]) continue;
    closed[u] = 1;
    if (explored.length < MAX_EXPLORED_RECORD) explored.push(u);
    if (u === goal) break;
    const i = u % nx;
    const j = (u - i) / nx;
    for (const step of NEIGHBORS) {
      const val = stepValue(grid, field, i, j, step);
      if (val < radius) continue;
      const v = (j + step.dj) * nx + (i + step.di);
      if (closed[v]) continue;
      const penalty = val < pref ? (wallPenalty * (pref - val)) / pref : 0;
      const cost = g[u] + step.len * h * (1 + penalty);
      if (cost < g[v]) {
        g[v] = cost;
        parent[v] = u;
        heap.push(v, cost + heuristic(v));
      }
    }
  }
  if (!closed[goal]) return { found: false, nodes: [], explored, failure: 'PASSAGE_TOO_NARROW' };
  const nodes: number[] = [];
  for (let k = goal; k !== -1; k = parent[k]) nodes.push(k);
  nodes.reverse();
  return { found: true, nodes, explored, failure: null };
}

/** Bilinear sample of the clearance field (conservative near walls: off-surface nodes count as 0). */
export function sampleField(grid: ClearanceGrid, field: Float32Array, p: Vec2): number {
  const { x0, z0, nx, nz, h } = grid.spec;
  const fx = (p.x - x0) / h;
  const fz = (p.z - z0) / h;
  const i = Math.floor(fx);
  const j = Math.floor(fz);
  if (i < 0 || j < 0 || i >= nx - 1 || j >= nz - 1) return 0;
  const tx = fx - i;
  const tz = fz - j;
  const k = j * nx + i;
  const v00 = grid.inside[k] ? field[k] : 0;
  const v10 = grid.inside[k + 1] ? field[k + 1] : 0;
  const v01 = grid.inside[k + nx] ? field[k + nx] : 0;
  const v11 = grid.inside[k + nx + 1] ? field[k + nx + 1] : 0;
  return (v00 * (1 - tx) + v10 * tx) * (1 - tz) + (v01 * (1 - tx) + v11 * tx) * tz;
}

function segmentClear(grid: ClearanceGrid, field: Float32Array, a: Vec2, b: Vec2, minRadius: number): boolean {
  const len = distance(a, b);
  const steps = Math.max(1, Math.ceil(len / (grid.spec.h * 0.5)));
  for (let s = 0; s <= steps; s++) {
    if (sampleField(grid, field, lerp(a, b, s / steps)) < minRadius) return false;
  }
  return true;
}

/** Greedy line-of-sight simplification. Keeps endpoints. */
export function stringPull(
  grid: ClearanceGrid,
  field: Float32Array,
  pts: readonly Vec2[],
  minRadius: number,
): Vec2[] {
  if (pts.length <= 2) return [...pts];
  const out: Vec2[] = [pts[0]];
  let anchor = 0;
  while (anchor < pts.length - 1) {
    let next = anchor + 1;
    for (let j = anchor + 2; j < pts.length; j++) {
      if (segmentClear(grid, field, pts[anchor], pts[j], minRadius)) next = j;
      else break;
    }
    out.push(pts[next]);
    anchor = next;
  }
  return out;
}

/** Chaikin corner cutting (keeps endpoints). */
export function chaikin(pts: readonly Vec2[], iterations = 2): Vec2[] {
  let cur = [...pts];
  for (let it = 0; it < iterations; it++) {
    if (cur.length < 3) return cur;
    const next: Vec2[] = [cur[0]];
    for (let i = 0; i < cur.length - 1; i++) {
      const a = cur[i];
      const b = cur[i + 1];
      if (i > 0) next.push(lerp(a, b, 0.25));
      if (i < cur.length - 2) next.push(lerp(a, b, 0.75));
    }
    next.push(cur[cur.length - 1]);
    cur = next;
  }
  return cur;
}

export function pathLength(pts: readonly Vec2[]): number {
  let s = 0;
  for (let i = 1; i < pts.length; i++) s += distance(pts[i - 1], pts[i]);
  return s;
}

/** Minimum exact clearance radius along a polyline, sampled every `step` meters. */
export function minExactClearance(
  grid: ClearanceGrid,
  dynamic: readonly DynamicObstacle[],
  pts: readonly Vec2[],
  step = 0.02,
): number {
  let min = Infinity;
  for (let i = 0; i < pts.length; i++) {
    if (i === 0) min = Math.min(min, grid.exactClearance(pts[0], dynamic));
    if (i === pts.length - 1) break;
    const a = pts[i];
    const b = pts[i + 1];
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let s = 1; s <= n; s++) min = Math.min(min, grid.exactClearance(lerp(a, b, s / n), dynamic));
  }
  return min === Infinity ? 0 : min;
}

/**
 * Turn a node path into a smooth, verified polyline. The route must keep at
 * least `radius` (minus half a cell of discretisation slack) of exact clearance.
 */
export function refineRoute(
  grid: ClearanceGrid,
  field: Float32Array,
  dynamic: readonly DynamicObstacle[],
  nodes: readonly number[],
  radius: number,
  margin: number,
): { points: Vec2[]; minClearance: number } {
  const raw = nodes.map((k) => grid.point(k));
  const slack = grid.spec.h * 0.75;
  const rawMin = minExactClearance(grid, dynamic, raw);
  const pulled = stringPull(grid, field, raw, radius + margin);
  const smooth = chaikin(pulled, 3);
  const smoothMin = minExactClearance(grid, dynamic, smooth);
  if (smoothMin >= radius - slack) return { points: smooth, minClearance: smoothMin };
  const pulledMin = minExactClearance(grid, dynamic, pulled);
  if (pulledMin >= radius - slack) return { points: pulled, minClearance: pulledMin };
  return { points: raw, minClearance: rawMin };
}
