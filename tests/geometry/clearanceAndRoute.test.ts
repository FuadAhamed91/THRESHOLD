import { describe, expect, it } from 'vitest';
import { analyzeEntrance } from '../../src/geometry/analyze';
import { getClearanceGrid } from '../../src/geometry/distanceField';
import { DEFAULT_MODEL } from '../../src/geometry/entranceModel';
import { orientedRectangle, pointInPolygon } from '../../src/geometry/polygons';
import { lerp } from '../../src/geometry/vec2';
import { EXACT, PARCEL_SIZE, corridorModel, parcelAt } from './helpers';

describe('clearance measurement', () => {
  const model = corridorModel(1.2, 6);

  it('(9) reports clearance below the configured requirement', () => {
    // A 0.46 m parcel centred in a 1.20 m corridor leaves two 0.37 m gaps.
    const r = analyzeEntrance({ model, parcel: parcelAt(0, 3), placement: EXACT, requiredClearWidth: 0.9 });
    expect(r.clearance.width).toBeCloseTo(0.37, 3);
    expect(r.clearance.method).toBe('exact-pair');
    expect(r.clearance.meetsRequirement).toBe(false);
    expect(r.path.found).toBe(false);
    expect(r.status).toBe('obstructed');
  });

  it('(10) reports clearance meeting the configured requirement', () => {
    // Parcel pushed against the west wall leaves a 0.74 m gap.
    const r = analyzeEntrance({
      model,
      parcel: parcelAt(-0.6 + PARCEL_SIZE.width / 2 + 0.0001, 3),
      placement: EXACT,
      requiredClearWidth: 0.7,
    });
    expect(r.clearance.width).toBeCloseTo(0.74, 3);
    expect(r.clearance.meetsRequirement).toBe(true);
    expect(r.path.found).toBe(true);
  });

  it('the same geometry fails a stricter requirement (no hard-coded width)', () => {
    const parcel = parcelAt(-0.6 + PARCEL_SIZE.width / 2 + 0.0001, 3);
    const strict = analyzeEntrance({ model, parcel, placement: EXACT, requiredClearWidth: 0.9 });
    expect(strict.clearance.width).toBeCloseTo(0.74, 3);
    expect(strict.clearance.meetsRequirement).toBe(false);
    expect(strict.path.found).toBe(false);
  });

  it('without a parcel the clearance is the corridor width', () => {
    const r = analyzeEntrance({ model, parcel: null, placement: EXACT, requiredClearWidth: 0.9 });
    expect(r.clearance.width).toBeCloseTo(1.2, 3);
    expect(r.path.found).toBe(true);
  });

  it('names the two features forming the pinch and returns a dimension line of that length', () => {
    const r = analyzeEntrance({ model, parcel: parcelAt(0, 3), placement: EXACT, requiredClearWidth: 0.9 });
    const pinch = r.clearance.pinch!;
    expect([pinch.labelA, pinch.labelB]).toContain('Parcel');
    expect(Math.hypot(pinch.a.x - pinch.b.x, pinch.a.z - pinch.b.z)).toBeCloseTo(r.clearance.width, 6);
  });
});

describe('route validation and pathfinding', () => {
  it('(7) a blocked path becomes navigable after the parcel moves', () => {
    const blocked = analyzeEntrance({
      model: DEFAULT_MODEL,
      parcel: parcelAt(0.12, 0.55, -0.14),
      placement: EXACT,
      requiredClearWidth: 0.9,
    });
    expect(blocked.path.found).toBe(false);
    expect(blocked.path.failure?.code).toBe('PASSAGE_TOO_NARROW');
    expect(blocked.path.reachable.length).toBeGreaterThan(2);
    expect(blocked.path.stopPoint).not.toBeNull();

    const moved = analyzeEntrance({
      model: DEFAULT_MODEL,
      parcel: parcelAt(-1.22, 0.62, 0.07),
      placement: EXACT,
      requiredClearWidth: 0.9,
    });
    expect(moved.path.found).toBe(true);
    expect(moved.door.physicallyBlocked).toBe(false);
    expect(moved.status).toBe('clear');
  });

  it('never routes through the parcel, walls or obstacles, and keeps the required width', () => {
    const parcel = parcelAt(0.3, 3.6); // on the ramp, off-centre: leaves a 0.67 m gap on the west side
    const r = analyzeEntrance({ model: DEFAULT_MODEL, parcel, placement: EXACT, requiredClearWidth: 0.6 });
    expect(r.path.found).toBe(true);
    const grid = getClearanceGrid(DEFAULT_MODEL);
    const footprint = orientedRectangle(parcel.center, parcel.yaw, parcel.size.width, parcel.size.depth);
    const dyn = [
      { polygon: footprint, label: 'Parcel', kind: 'parcel' as const, owner: 'parcel' },
      { polygon: r.door.leafAtMaxOpening, label: 'Door', kind: 'door' as const, owner: 'door' },
    ];
    const pts = r.path.points;
    for (let i = 0; i < pts.length - 1; i++) {
      for (let s = 0; s <= 10; s++) {
        const p = lerp(pts[i], pts[i + 1], s / 10);
        expect(pointInPolygon(p, footprint)).toBe(false);
        for (const o of DEFAULT_MODEL.obstacles) expect(pointInPolygon(p, o.polygon)).toBe(false);
        expect(pointInPolygon(p, DEFAULT_MODEL.walkable.polygon)).toBe(true);
        // exact clearance radius ≥ r − half a grid cell of discretisation slack
        expect(grid.exactClearance(p, dyn)).toBeGreaterThan(0.3 - 0.75 * grid.spec.h);
      }
    }
  });

  it('recomputes a different route when the parcel moves', () => {
    const a = analyzeEntrance({ model: DEFAULT_MODEL, parcel: parcelAt(0.3, 3.6), placement: EXACT, requiredClearWidth: 0.6 });
    const b = analyzeEntrance({ model: DEFAULT_MODEL, parcel: parcelAt(-0.3, 3.6), placement: EXACT, requiredClearWidth: 0.6 });
    expect(a.path.found && b.path.found).toBe(true);
    const xAt = (pts: { x: number; z: number }[], z: number) => {
      for (let i = 0; i < pts.length - 1; i++) {
        const p = pts[i];
        const q = pts[i + 1];
        if ((p.z - z) * (q.z - z) <= 0) return p.x + ((z - p.z) / (q.z - p.z || 1)) * (q.x - p.x);
      }
      return NaN;
    };
    // The route passes on the opposite side of the parcel in each case.
    expect(xAt(a.path.points, 3.6)).toBeLessThan(0);
    expect(xAt(b.path.points, 3.6)).toBeGreaterThan(0);
  });

  it('route validity agrees with the clearance requirement', () => {
    for (const x of [-0.3, -0.1, 0.1, 0.3]) {
      const r = analyzeEntrance({ model: DEFAULT_MODEL, parcel: parcelAt(x, 3.6), placement: EXACT, requiredClearWidth: 0.6 });
      if (!r.marginal) expect(r.path.found).toBe(r.clearance.meetsRequirement);
    }
  });
});
