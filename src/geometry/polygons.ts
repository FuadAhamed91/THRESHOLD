import type { Polygon, Vec2 } from './types';
import { EPS, add, cross, distance, dot, lerp, rotateYaw, sub, v2 } from './vec2';

/** Signed area: positive when vertices run toward increasing plan angle ("CCW" in this frame). */
export function signedArea(poly: Polygon): number {
  let s = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const a = poly[i];
    const b = poly[(i + 1) % n];
    s += a.x * b.z - b.x * a.z;
  }
  return s / 2;
}

export const polygonArea = (poly: Polygon): number => Math.abs(signedArea(poly));

export function ensureCCW(poly: Polygon): Vec2[] {
  return signedArea(poly) >= 0 ? [...poly] : [...poly].reverse();
}

export function centroid(poly: Polygon): Vec2 {
  const a = signedArea(poly);
  if (Math.abs(a) < EPS) {
    const n = poly.length || 1;
    return v2(
      poly.reduce((s, p) => s + p.x, 0) / n,
      poly.reduce((s, p) => s + p.z, 0) / n,
    );
  }
  let cx = 0;
  let cz = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const p = poly[i];
    const q = poly[(i + 1) % n];
    const f = p.x * q.z - q.x * p.z;
    cx += (p.x + q.x) * f;
    cz += (p.z + q.z) * f;
  }
  return v2(cx / (6 * a), cz / (6 * a));
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export function bounds(poly: Polygon): Bounds {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const p of poly) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
  }
  return { minX, maxX, minZ, maxZ };
}

export function edges(poly: Polygon): Array<[Vec2, Vec2]> {
  return poly.map((p, i) => [p, poly[(i + 1) % poly.length]] as [Vec2, Vec2]);
}

/** Even-odd ray cast. Points exactly on an edge may report either side; use distances for tolerance. */
export function pointInPolygon(p: Vec2, poly: Polygon): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i];
    const b = poly[j];
    if (a.z > p.z !== b.z > p.z) {
      const xCross = a.x + ((p.z - a.z) * (b.x - a.x)) / (b.z - a.z);
      if (p.x < xCross) inside = !inside;
    }
  }
  return inside;
}

export function closestPointOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const len2 = dot(ab, ab);
  if (len2 < EPS * EPS) return a;
  let t = dot(sub(p, a), ab) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return v2(a.x + ab.x * t, a.z + ab.z * t);
}

export function pointSegmentDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const abx = b.x - a.x;
  const abz = b.z - a.z;
  const len2 = abx * abx + abz * abz;
  let t = len2 < EPS * EPS ? 0 : ((p.x - a.x) * abx + (p.z - a.z) * abz) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = p.x - (a.x + abx * t);
  const dz = p.z - (a.z + abz * t);
  return Math.sqrt(dx * dx + dz * dz);
}

function orientation(a: Vec2, b: Vec2, c: Vec2): number {
  const v = cross(sub(b, a), sub(c, a));
  return Math.abs(v) < 1e-12 ? 0 : v > 0 ? 1 : -1;
}

function onSegment(a: Vec2, b: Vec2, p: Vec2): boolean {
  return (
    Math.min(a.x, b.x) - 1e-12 <= p.x &&
    p.x <= Math.max(a.x, b.x) + 1e-12 &&
    Math.min(a.z, b.z) - 1e-12 <= p.z &&
    p.z <= Math.max(a.z, b.z) + 1e-12
  );
}

/** True when closed segments ab and cd share at least one point. */
export function segmentsIntersect(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  if (o1 !== o2 && o3 !== o4) return true;
  if (o1 === 0 && onSegment(a, b, c)) return true;
  if (o2 === 0 && onSegment(a, b, d)) return true;
  if (o3 === 0 && onSegment(c, d, a)) return true;
  if (o4 === 0 && onSegment(c, d, b)) return true;
  return false;
}

/** True only when the segments cross at a single interior point of both (no touching / collinear). */
export function segmentsCrossProperly(a: Vec2, b: Vec2, c: Vec2, d: Vec2): boolean {
  const o1 = orientation(a, b, c);
  const o2 = orientation(a, b, d);
  const o3 = orientation(c, d, a);
  const o4 = orientation(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

export interface SegmentPairClosest {
  distance: number;
  p: Vec2;
  q: Vec2;
}

/** Exact closest points between two closed segments. */
export function segmentSegmentClosest(a: Vec2, b: Vec2, c: Vec2, d: Vec2): SegmentPairClosest {
  if (segmentsIntersect(a, b, c, d)) {
    const p = segmentIntersectionPoint(a, b, c, d) ?? a;
    return { distance: 0, p, q: p };
  }
  const candidates: SegmentPairClosest[] = [
    { p: a, q: closestPointOnSegment(a, c, d), distance: 0 },
    { p: b, q: closestPointOnSegment(b, c, d), distance: 0 },
    { p: closestPointOnSegment(c, a, b), q: c, distance: 0 },
    { p: closestPointOnSegment(d, a, b), q: d, distance: 0 },
  ];
  let best = candidates[0];
  best.distance = distance(best.p, best.q);
  for (let i = 1; i < candidates.length; i++) {
    const c2 = candidates[i];
    c2.distance = distance(c2.p, c2.q);
    if (c2.distance < best.distance) best = c2;
  }
  return best;
}

export function segmentIntersectionPoint(a: Vec2, b: Vec2, c: Vec2, d: Vec2): Vec2 | null {
  const r = sub(b, a);
  const s = sub(d, c);
  const denom = cross(r, s);
  if (Math.abs(denom) < 1e-14) {
    // Collinear or parallel: return an endpoint that lies on the other segment, if any.
    for (const p of [a, b]) if (pointSegmentDistance(p, c, d) < 1e-9) return p;
    for (const p of [c, d]) if (pointSegmentDistance(p, a, b) < 1e-9) return p;
    return null;
  }
  const t = cross(sub(c, a), s) / denom;
  return lerp(a, b, Math.min(1, Math.max(0, t)));
}

/** Distance from a point to a polygon (0 when inside). */
export function pointPolygonDistance(p: Vec2, poly: Polygon): number {
  if (pointInPolygon(p, poly)) return 0;
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

/** Distance from a point to the polygon boundary (ignores inside/outside). */
export function pointBoundaryDistance(p: Vec2, poly: Polygon): number {
  let best = Infinity;
  for (let i = 0, n = poly.length; i < n; i++) {
    const d = pointSegmentDistance(p, poly[i], poly[(i + 1) % n]);
    if (d < best) best = d;
  }
  return best;
}

function lineIntersection(p1: Vec2, p2: Vec2, a: Vec2, b: Vec2): Vec2 {
  const ab = sub(b, a);
  const denom = cross(ab, sub(p2, p1));
  if (Math.abs(denom) < 1e-15) return p1;
  const t = cross(ab, sub(a, p1)) / denom;
  return lerp(p1, p2, t);
}

/**
 * Sutherland–Hodgman clipping. `clip` MUST be convex; `subject` may be concave
 * (the result can then contain zero-area bridges, but its area is exact).
 */
export function clipPolygon(subject: Polygon, clip: Polygon): Vec2[] {
  if (subject.length < 3 || clip.length < 3) return [];
  const c = ensureCCW(clip);
  let output: Vec2[] = [...subject];
  for (let i = 0; i < c.length && output.length > 0; i++) {
    const a = c[i];
    const b = c[(i + 1) % c.length];
    const edge = sub(b, a);
    const input = output;
    output = [];
    for (let j = 0; j < input.length; j++) {
      const cur = input[j];
      const prev = input[(j + input.length - 1) % input.length];
      const curIn = cross(edge, sub(cur, a)) >= -1e-12;
      const prevIn = cross(edge, sub(prev, a)) >= -1e-12;
      if (curIn) {
        if (!prevIn) output.push(lineIntersection(prev, cur, a, b));
        output.push(cur);
      } else if (prevIn) {
        output.push(lineIntersection(prev, cur, a, b));
      }
    }
  }
  return dedupe(output);
}

function dedupe(poly: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of poly) {
    const last = out[out.length - 1];
    if (!last || distance(last, p) > 1e-10) out.push(p);
  }
  if (out.length > 1 && distance(out[0], out[out.length - 1]) <= 1e-10) out.pop();
  return out;
}

/** Area of the intersection of any simple polygon with a convex polygon. */
export function intersectionArea(subject: Polygon, convexClip: Polygon): number {
  const clipped = clipPolygon(subject, convexClip);
  return clipped.length >= 3 ? polygonArea(clipped) : 0;
}

/**
 * Separating-axis test for two convex polygons. Touching (zero-depth contact)
 * is NOT an overlap: penetration must exceed `eps`.
 */
export function convexPolygonsOverlap(a: Polygon, b: Polygon, eps = 1e-9): boolean {
  for (const poly of [a, b]) {
    for (let i = 0, n = poly.length; i < n; i++) {
      const p = poly[i];
      const q = poly[(i + 1) % n];
      const axis = v2(-(q.z - p.z), q.x - p.x);
      let minA = Infinity;
      let maxA = -Infinity;
      let minB = Infinity;
      let maxB = -Infinity;
      for (const v of a) {
        const d = dot(v, axis);
        if (d < minA) minA = d;
        if (d > maxA) maxA = d;
      }
      for (const v of b) {
        const d = dot(v, axis);
        if (d < minB) minB = d;
        if (d > maxB) maxB = d;
      }
      const len = Math.hypot(axis.x, axis.z) || 1;
      if (maxA <= minB + eps * len || maxB <= minA + eps * len) return false;
    }
  }
  return true;
}

/** General simple-polygon intersection test (edges cross, or one contains the other). */
export function polygonsIntersect(a: Polygon, b: Polygon): boolean {
  for (let i = 0; i < a.length; i++) {
    const a1 = a[i];
    const a2 = a[(i + 1) % a.length];
    for (let j = 0; j < b.length; j++) {
      if (segmentsIntersect(a1, a2, b[j], b[(j + 1) % b.length])) return true;
    }
  }
  return pointInPolygon(a[0], b) || pointInPolygon(b[0], a);
}

/** Closest points between two polygon boundaries. */
export function polygonBoundaryClosest(a: Polygon, b: Polygon): SegmentPairClosest {
  let best: SegmentPairClosest = { distance: Infinity, p: a[0], q: b[0] };
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      const c = segmentSegmentClosest(a[i], a[(i + 1) % a.length], b[j], b[(j + 1) % b.length]);
      if (c.distance < best.distance) best = c;
    }
  }
  return best;
}

/** True when every vertex of `inner` is inside `outer` and no edges properly cross. */
export function polygonContainsPolygon(outer: Polygon, inner: Polygon, tolerance = 1e-9): boolean {
  for (const p of inner) {
    if (!pointInPolygon(p, outer) && pointBoundaryDistance(p, outer) > tolerance) return false;
  }
  for (let i = 0; i < inner.length; i++) {
    const a = inner[i];
    const b = inner[(i + 1) % inner.length];
    for (let j = 0; j < outer.length; j++) {
      if (segmentsCrossProperly(a, b, outer[j], outer[(j + 1) % outer.length])) return false;
    }
  }
  return true;
}

export function isConvex(poly: Polygon): boolean {
  if (poly.length < 3) return false;
  let sign = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const c = cross(sub(poly[(i + 1) % n], poly[i]), sub(poly[(i + 2) % n], poly[(i + 1) % n]));
    if (Math.abs(c) < 1e-12) continue;
    const s = c > 0 ? 1 : -1;
    if (sign === 0) sign = s;
    else if (s !== sign) return false;
  }
  return sign !== 0;
}

/** No two non-adjacent edges intersect and area is non-degenerate. */
export function isSimplePolygon(poly: Polygon): boolean {
  const n = poly.length;
  if (n < 3 || polygonArea(poly) < 1e-9) return false;
  for (let i = 0; i < n; i++) {
    const a1 = poly[i];
    const a2 = poly[(i + 1) % n];
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue;
      if (segmentsIntersect(a1, a2, poly[j], poly[(j + 1) % n])) return false;
    }
  }
  return true;
}

/** Rectangle centered on `center`, rotated with the Three.js yaw convention. */
export function orientedRectangle(center: Vec2, yaw: number, width: number, depth: number): Vec2[] {
  const hw = width / 2;
  const hd = depth / 2;
  const local = [v2(-hw, -hd), v2(hw, -hd), v2(hw, hd), v2(-hw, hd)];
  return ensureCCW(local.map((p) => add(center, rotateYaw(p, yaw))));
}

export function axisAlignedRectangle(minX: number, minZ: number, maxX: number, maxZ: number): Vec2[] {
  return ensureCCW([v2(minX, minZ), v2(maxX, minZ), v2(maxX, maxZ), v2(minX, maxZ)]);
}

/**
 * Circular sector polygon: apex at `center`, from plan angle `start` sweeping
 * `sweep` radians (sign gives direction). Arc vertices lie exactly on the circle.
 */
export function sectorPolygon(center: Vec2, radius: number, start: number, sweep: number, segments = 48): Vec2[] {
  const pts: Vec2[] = [center];
  const n = Math.max(2, Math.ceil(segments * (Math.abs(sweep) / (Math.PI / 2))));
  for (let i = 0; i <= n; i++) {
    const t = start + (sweep * i) / n;
    pts.push(v2(center.x + Math.cos(t) * radius, center.z + Math.sin(t) * radius));
  }
  return ensureCCW(pts);
}

/** The part of a polygon inside the band zMin ≤ z ≤ zMax (used to split overlays at floor creases). */
export function clipByZRange(poly: Polygon, zMin: number, zMax: number): Vec2[] {
  const big = 1e4;
  return clipPolygon(poly, axisAlignedRectangle(-big, zMin, big, zMax));
}
