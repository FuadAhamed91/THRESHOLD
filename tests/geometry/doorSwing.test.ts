import { describe, expect, it } from 'vitest';
import { analyzeDoorSwing, leafPolygon, maxOpeningAngle } from '../../src/geometry/doorSwing';
import { DEFAULT_MODEL } from '../../src/geometry/entranceModel';
import { orientedRectangle } from '../../src/geometry/polygons';
import type { DoorModel } from '../../src/geometry/types';
import { PARCEL_SIZE } from './helpers';

const DEG = Math.PI / 180;
const door: DoorModel = DEFAULT_MODEL.door; // hinge (−0.55, 0), 1.10 m leaf, opens out toward +Z
const box = (x: number, z: number, yaw = 0, size = PARCEL_SIZE) => ({
  footprint: orientedRectangle({ x, z }, yaw, size.width, size.depth),
  height: size.height,
});

describe('door swing', () => {
  it('(3) detects a parcel intersecting the swing and stops the leaf before 90°', () => {
    const r = analyzeDoorSwing(door, box(0.12, 0.55), []);
    expect(r.intersectsSwingRegion).toBe(true);
    expect(r.overlapArea).toBeGreaterThan(0.05);
    expect(r.physicallyBlocked).toBe(true);
    expect(r.blockedBy).toBe('Parcel');
    expect(r.maxOpening / DEG).toBeGreaterThan(10);
    expect(r.maxOpening / DEG).toBeLessThan(40);
    expect(r.contactPoint).not.toBeNull();
  });

  it('(4) reports a parcel clear of the swing region as no conflict', () => {
    const r = analyzeDoorSwing(door, box(-1.22, 0.62), []);
    expect(r.intersectsSwingRegion).toBe(false);
    expect(r.overlapArea).toBe(0);
    expect(r.physicallyBlocked).toBe(false);
    expect(r.maxOpening).toBeCloseTo(door.requiredOpening, 12);
  });

  it('finds the analytic contact angle for a small obstacle', () => {
    // A 2 cm post centred 0.8 m from the hinge at 30°. The leaf face touches its
    // near corner slightly before 30°; the result must bracket that geometry.
    const c = { x: -0.55 + 0.8 * Math.cos(30 * DEG), z: 0.8 * Math.sin(30 * DEG) };
    const post = orientedRectangle(c, 0, 0.02, 0.02);
    const { angle } = maxOpeningAngle(door, [{ polygon: post, height: 1, label: 'Post' }]);
    const nearest = Math.min(
      ...post.map((p) => Math.atan2(p.z - door.hinge.z, p.x - door.hinge.x)),
    );
    expect(angle).toBeGreaterThan(nearest - 0.5 * DEG);
    expect(angle).toBeLessThanOrEqual(30 * DEG);
  });

  it('boundary: a parcel just beyond the leaf radius does not block; just inside does', () => {
    // Parcel edge placed along the 45° line at radius 1.10 + 2 mm, then 1.10 − 20 mm.
    const dir = { x: Math.cos(45 * DEG), z: Math.sin(45 * DEG) };
    const place = (radius: number) => {
      const halfDiag = 0.05;
      const centre = { x: door.hinge.x + dir.x * (radius + halfDiag), z: door.hinge.z + dir.z * (radius + halfDiag) };
      return box(centre.x, centre.z, -45 * DEG, { width: 0.1, depth: 0.1, height: 0.3 });
    };
    const outside = analyzeDoorSwing(door, place(1.1 + 0.052), []);
    expect(outside.physicallyBlocked).toBe(false);
    const inside = analyzeDoorSwing(door, place(1.1 - 0.02), []);
    expect(inside.physicallyBlocked).toBe(true);
  });

  it('boundary: a parcel lower than the undercut passes beneath the leaf', () => {
    const flat = analyzeDoorSwing(door, { ...box(0.12, 0.55), height: 0.01 }, []);
    expect(flat.intersectsSwingRegion).toBe(true);
    expect(flat.physicallyBlocked).toBe(false);
    expect(flat.passesUnderLeaf).toBe(true);
  });

  it('places the fully open leaf along +Z on the hinge side', () => {
    const leaf = leafPolygon(door, 90 * DEG);
    const xs = leaf.map((p) => p.x);
    const zs = leaf.map((p) => p.z);
    expect(Math.min(...xs)).toBeCloseTo(-0.55, 9);
    expect(Math.max(...xs)).toBeCloseTo(-0.5, 9);
    expect(Math.max(...zs)).toBeCloseTo(1.1, 9);
  });
});
