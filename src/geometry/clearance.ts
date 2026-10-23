/**
 * Remaining clear passage width.
 *
 * Method (documented in docs/geometry.md):
 *  1. Clearance field: exact distance from each grid node to the nearest boundary,
 *     static obstacle, parcel or door-leaf edge (distanceField.ts).
 *  2. Widest path: a max–min ("bottleneck") Dijkstra from start to goal finds the
 *     route whose narrowest point is as wide as possible. Its bottleneck B means a
 *     disc of diameter 2B can travel the whole route, i.e. a 2B-wide passage exists.
 *  3. Exact refinement: at the pinch node, the two nearest features on opposite
 *     sides are identified and their closed-form segment distance is taken as the
 *     width — when it agrees with the grid estimate within the grid's error bound
 *     (√2·h). Otherwise the grid estimate is reported with that tolerance.
 * The reported width is never invented: without a pinch there is no number.
 */
import { MinHeap } from './heap';
import type { ClearanceGrid } from './distanceField';
import { closestPointOnSegment, segmentSegmentClosest } from './polygons';
import type { Feature, PinchInfo, Vec2 } from './types';
import { add, distance, dot, scale, sub } from './vec2';

const SQRT2 = Math.SQRT2;

export interface NeighborStep {
  di: number;
  dj: number;
  len: number;
  diagonal: boolean;
}

export const NEIGHBORS: readonly NeighborStep[] = [
  { di: 1, dj: 0, len: 1, diagonal: false },
  { di: -1, dj: 0, len: 1, diagonal: false },
  { di: 0, dj: 1, len: 1, diagonal: false },
  { di: 0, dj: -1, len: 1, diagonal: false },
  { di: 1, dj: 1, len: SQRT2, diagonal: true },
  { di: 1, dj: -1, len: SQRT2, diagonal: true },
  { di: -1, dj: 1, len: SQRT2, diagonal: true },
  { di: -1, dj: -1, len: SQRT2, diagonal: true },
];

/**
 * Value of moving from node (i, j) by `step`: the target's clearance, and for
 * diagonal moves also both orthogonal neighbours (no squeezing past corners).
 * Shared by the widest-path search and A*, so "a path exists with clearance ≥ r"
 * means exactly the same thing in both.
 */
export function stepValue(grid: ClearanceGrid, field: Float32Array, i: number, j: number, step: NeighborStep): number {
  const { nx, nz } = grid.spec;
  const ti = i + step.di;
  const tj = j + step.dj;
  if (ti < 0 || tj < 0 || ti >= nx || tj >= nz) return -1;
  const k = tj * nx + ti;
  if (!grid.inside[k]) return -1;
  let v = field[k];
  if (step.diagonal) {
    const o1 = j * nx + ti;
    const o2 = tj * nx + i;
    if (!grid.inside[o1] || !grid.inside[o2]) return -1;
    v = Math.min(v, field[o1], field[o2]);
  }
  return v;
}

export interface WidestPathResult {
  /** Bottleneck clearance radius of the best route (m); 0 if unreachable. */
  readonly bottleneck: number;
  readonly reached: boolean;
  /** Node indices from start to goal along the widest route. */
  readonly nodes: number[];
}

export function widestPath(grid: ClearanceGrid, field: Float32Array, start: number, goal: number): WidestPathResult {
  const n = grid.size;
  const { nx } = grid.spec;
  const best = new Float32Array(n).fill(-1);
  const parent = new Int32Array(n).fill(-1);
  const done = new Uint8Array(n);
  const heap = new MinHeap(4096);
  if (!grid.inside[start] || !grid.inside[goal]) return { bottleneck: 0, reached: false, nodes: [] };
  best[start] = field[start];
  heap.push(start, -best[start]);
  while (heap.size > 0) {
    const u = heap.pop();
    if (done[u]) continue;
    done[u] = 1;
    if (u === goal) break;
    const bu = best[u];
    const i = u % nx;
    const j = (u - i) / nx;
    for (const step of NEIGHBORS) {
      const val = stepValue(grid, field, i, j, step);
      if (val < 0) continue;
      const v = (j + step.dj) * nx + (i + step.di);
      if (done[v]) continue;
      const cand = Math.min(bu, val);
      if (cand > best[v]) {
        best[v] = cand;
        parent[v] = u;
        heap.push(v, -cand);
      }
    }
  }
  if (best[goal] < 0) return { bottleneck: 0, reached: false, nodes: [] };
  const nodes: number[] = [];
  for (let k = goal; k !== -1; k = parent[k]) nodes.push(k);
  nodes.reverse();
  return { bottleneck: Math.max(0, best[goal]), reached: true, nodes };
}

/** First node along `nodes` whose clearance equals the path minimum. */
export function pinchIndex(field: Float32Array, nodes: readonly number[]): number {
  let bestIdx = -1;
  let bestVal = Infinity;
  for (let idx = 0; idx < nodes.length; idx++) {
    const val = field[nodes[idx]];
    if (val < bestVal - 1e-7) {
      bestVal = val;
      bestIdx = idx;
    }
  }
  return bestIdx;
}

export interface RefinedWidth {
  readonly width: number;
  readonly method: 'exact-pair' | 'grid';
  readonly tolerance: number;
  readonly pinch: PinchInfo;
}

/**
 * Resolve the gap at a pinch node to the two features that form it and measure
 * their exact separation. Falls back to the grid estimate when the features do
 * not explain the grid bottleneck (e.g. a pinch formed by a concave corner).
 */
export function refinePinch(
  center: Vec2,
  gridWidth: number,
  features: readonly Feature[],
  spacing: number,
): RefinedWidth {
  const gridTol = SQRT2 * spacing;
  const measured = features.map((f) => {
    const q = closestPointOnSegment(center, f.a, f.b);
    return { f, q, d: distance(center, q) };
  });
  measured.sort((a, b) => a.d - b.d);
  const first = measured[0];
  const fallback = (): RefinedWidth => {
    const p1 = first ? first.q : center;
    const mirror = add(center, sub(center, p1));
    return {
      width: gridWidth,
      method: 'grid',
      tolerance: gridTol,
      pinch: { point: center, a: p1, b: mirror, labelA: first?.f.label ?? 'Boundary', labelB: 'Opposite side' },
    };
  };
  if (!first || first.d < 1e-9) return fallback();

  const u1 = sub(first.q, center);
  const searchLimit = first.d + 4 * spacing + gridWidth;
  const second = measured.find(
    (m) =>
      m !== first &&
      m.d <= searchLimit &&
      dot(sub(m.q, center), u1) < -0.25 * m.d * first.d && // on the opposite side (angle > ~105°)
      !(m.f.owner === first.f.owner && sharesVertex(m.f, first.f)),
  );
  if (!second) return fallback();

  const pair = segmentSegmentClosest(first.f.a, first.f.b, second.f.a, second.f.b);
  if (Math.abs(pair.distance - gridWidth) > gridTol + 1e-6) return fallback();
  return {
    width: pair.distance,
    method: 'exact-pair',
    tolerance: 0.001,
    pinch: { point: center, a: pair.p, b: pair.q, labelA: first.f.label, labelB: second.f.label },
  };
}

function sharesVertex(a: Feature, b: Feature): boolean {
  const near = (p: Vec2, q: Vec2) => distance(p, q) < 1e-9;
  return near(a.a, b.a) || near(a.a, b.b) || near(a.b, b.a) || near(a.b, b.b);
}

/** Point on segment a→b at fraction t (exported for tests / overlays). */
export const along = (a: Vec2, b: Vec2, t: number): Vec2 => add(a, scale(sub(b, a), t));
