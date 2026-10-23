import { describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import {
  clipPolygon,
  convexPolygonsOverlap,
  isSimplePolygon,
  orientedRectangle,
  pointInPolygon,
  polygonArea,
  polygonContainsPolygon,
  sectorPolygon,
  segmentSegmentClosest,
} from '../../src/geometry/polygons';
import { rotateYaw } from '../../src/geometry/vec2';
import { pts } from './helpers';

describe('polygon primitives', () => {
  it('computes areas independent of orientation', () => {
    const sq = pts([0, 0], [2, 0], [2, 1], [0, 1]);
    expect(polygonArea(sq)).toBeCloseTo(2, 12);
    expect(polygonArea([...sq].reverse())).toBeCloseTo(2, 12);
  });

  it('clips a concave subject by a convex polygon with exact area', () => {
    // L-shaped corridor (area 3) clipped by a unit square straddling its inner corner.
    const L = pts([0, 0], [2, 0], [2, 1], [1, 1], [1, 2], [0, 2]);
    const box = pts([0.5, 0.5], [1.5, 0.5], [1.5, 1.5], [0.5, 1.5]);
    const clipped = clipPolygon(L, box);
    expect(polygonArea(clipped)).toBeCloseTo(0.75, 10);
  });

  it('treats touching convex polygons as non-overlapping', () => {
    const a = pts([0, 0], [1, 0], [1, 1], [0, 1]);
    const touching = pts([1, 0], [2, 0], [2, 1], [1, 1]);
    const overlapping = pts([0.999, 0], [2, 0], [2, 1], [0.999, 1]);
    expect(convexPolygonsOverlap(a, touching)).toBe(false);
    expect(convexPolygonsOverlap(a, overlapping)).toBe(true);
  });

  it('measures exact segment–segment distance', () => {
    const r = segmentSegmentClosest({ x: 0, z: 0 }, { x: 1, z: 0 }, { x: 0.5, z: 0.4 }, { x: 0.5, z: 2 });
    expect(r.distance).toBeCloseTo(0.4, 12);
    expect(r.p.x).toBeCloseTo(0.5, 12);
  });

  it('builds sectors whose arc vertices lie exactly on the circle', () => {
    const s = sectorPolygon({ x: 1, z: 1 }, 2, 0, Math.PI / 2, 32);
    for (const p of s.slice(1)) {
      const d = Math.hypot(p.x - 1, p.z - 1);
      if (d > 1e-9) expect(d).toBeCloseTo(2, 12);
    }
    expect(polygonArea(s)).toBeLessThan(Math.PI); // inscribed polygon under-approximates πr²/4
    expect(polygonArea(s)).toBeGreaterThan(Math.PI - 0.01);
  });

  it('detects containment and self-intersection', () => {
    const outer = pts([0, 0], [4, 0], [4, 4], [0, 4]);
    expect(polygonContainsPolygon(outer, pts([1, 1], [2, 1], [2, 2], [1, 2]))).toBe(true);
    expect(polygonContainsPolygon(outer, pts([3, 3], [5, 3], [5, 5], [3, 5]))).toBe(false);
    expect(isSimplePolygon(pts([0, 0], [1, 1], [1, 0], [0, 1]))).toBe(false); // bow-tie
    expect(pointInPolygon({ x: 2, z: 2 }, outer)).toBe(true);
  });

  it('matches the Three.js rotation.y convention exactly', () => {
    const obj = new Object3D();
    for (const yaw of [0.3, -1.2, 2.5]) {
      obj.rotation.set(0, yaw, 0);
      obj.updateMatrixWorld();
      const local = new Vector3(0.23, 0, -0.18);
      const world = local.clone().applyMatrix4(obj.matrixWorld);
      const ours = rotateYaw({ x: 0.23, z: -0.18 }, yaw);
      expect(ours.x).toBeCloseTo(world.x, 12);
      expect(ours.z).toBeCloseTo(world.z, 12);
    }
  });

  it('places oriented parcel footprints consistently with their size', () => {
    const r = orientedRectangle({ x: 1, z: 2 }, 0.7, 0.46, 0.36);
    expect(polygonArea(r)).toBeCloseTo(0.46 * 0.36, 12);
  });
});
