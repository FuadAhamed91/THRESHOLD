import { BufferGeometry, Float32BufferAttribute, ShapeUtils, Vector2 } from 'three';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { DEFAULT_LAYOUT, floorCreases, floorHeightAt } from '../../geometry/coordinateSystem';
import { clipByZRange, ensureCCW } from '../../geometry/polygons';
import type { Vec2 } from '../../geometry/types';
import { distance, lerp } from '../../geometry/vec2';

const LAYOUT = DEFAULT_LAYOUT;
const CREASES = floorCreases(LAYOUT);

export const floorY = (x: number, z: number): number => floorHeightAt(LAYOUT, x, z);

/**
 * Triangulated polygon draped on the walking surface. The polygon is split at
 * the slope creases (top and bottom of the ramp) so every triangle lies on a
 * single planar patch and never cuts into, or floats above, the floor.
 */
export function drapePolygon(poly: readonly Vec2[], lift = 0.006): BufferGeometry {
  const bands: Array<[number, number]> = [
    [-1e4, CREASES[0]],
    [CREASES[0], CREASES[1]],
    [CREASES[1], 1e4],
  ];
  const positions: number[] = [];
  for (const [z0, z1] of bands) {
    const piece = clipByZRange(poly, z0, z1);
    if (piece.length < 3) continue;
    const contour = ensureCCW(piece).map((p) => new Vector2(p.x, p.z));
    const tris = ShapeUtils.triangulateShape(contour, []);
    for (const [a, b, c] of tris) {
      for (const idx of [a, b, c]) {
        const p = contour[idx];
        positions.push(p.x, floorY(p.x, p.y) + lift, p.y);
      }
    }
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  return geo;
}

/** Resample a plan polyline so it follows slope changes, with extra points at creases. */
export function drapePoints(pts: readonly Vec2[], lift = 0.01, closed = false, step = 0.2): number[] {
  const src = closed && pts.length > 2 ? [...pts, pts[0]] : [...pts];
  const out: number[] = [];
  const push = (p: Vec2) => out.push(p.x, floorY(p.x, p.z) + lift, p.z);
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i];
    const b = src[i + 1];
    const ts = new Set<number>([0]);
    const n = Math.max(1, Math.ceil(distance(a, b) / step));
    for (let k = 1; k < n; k++) ts.add(k / n);
    for (const zc of CREASES) {
      if ((a.z - zc) * (b.z - zc) < 0) ts.add((zc - a.z) / (b.z - a.z));
    }
    for (const t of [...ts].sort((p, q) => p - q)) push(lerp(a, b, t));
  }
  if (src.length) push(src[src.length - 1]);
  return out;
}

export function drapeLine(pts: readonly Vec2[], lift = 0.01, closed = false, step = 0.2): LineGeometry {
  const geo = new LineGeometry();
  const positions = drapePoints(pts, lift, closed, step);
  if (positions.length < 6) positions.push(...positions.slice(0, 3));
  geo.setPositions(positions);
  return geo;
}

/** Ribbon of constant width centred on a plan polyline (the required clear width). */
export function ribbonPolygon(pts: readonly Vec2[], halfWidth: number): Vec2[] {
  if (pts.length < 2) return [];
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i < pts.length; i++) {
    const prev = pts[Math.max(0, i - 1)];
    const next = pts[Math.min(pts.length - 1, i + 1)];
    let dx = next.x - prev.x;
    let dz = next.z - prev.z;
    const l = Math.hypot(dx, dz) || 1;
    dx /= l;
    dz /= l;
    left.push({ x: pts[i].x - dz * halfWidth, z: pts[i].z + dx * halfWidth });
    right.push({ x: pts[i].x + dz * halfWidth, z: pts[i].z - dx * halfWidth });
  }
  return [...left, ...right.reverse()];
}

/** Triangle-strip ribbon geometry draped on the floor (avoids polygon self-overlap on tight turns). */
export function drapeRibbon(pts: readonly Vec2[], halfWidth: number, lift = 0.008): BufferGeometry {
  const positions: number[] = [];
  const dense: Vec2[] = [];
  for (let i = 0; i < pts.length - 1; i++) {
    const n = Math.max(1, Math.ceil(distance(pts[i], pts[i + 1]) / 0.15));
    for (let k = 0; k < n; k++) dense.push(lerp(pts[i], pts[i + 1], k / n));
  }
  if (pts.length) dense.push(pts[pts.length - 1]);
  const ribbon = ribbonPolygon(dense, halfWidth);
  const n = dense.length;
  for (let i = 0; i < n - 1; i++) {
    const l0 = ribbon[i];
    const l1 = ribbon[i + 1];
    const r0 = ribbon[2 * n - 1 - i];
    const r1 = ribbon[2 * n - 2 - i];
    for (const p of [l0, r0, l1, l1, r0, r1]) positions.push(p.x, floorY(p.x, p.z) + lift, p.z);
  }
  const geo = new BufferGeometry();
  geo.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geo.computeBoundingSphere();
  return geo;
}

export function circlePoints(center: Vec2, radius: number, segments = 64): Vec2[] {
  const out: Vec2[] = [];
  for (let i = 0; i < segments; i++) {
    const a = (i / segments) * Math.PI * 2;
    out.push({ x: center.x + Math.cos(a) * radius, z: center.z + Math.sin(a) * radius });
  }
  return out;
}
