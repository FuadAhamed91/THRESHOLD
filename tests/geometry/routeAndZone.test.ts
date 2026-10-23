import { describe, expect, it } from 'vitest';
import { DEFAULT_MODEL } from '../../src/geometry/entranceModel';
import { orientedRectangle } from '../../src/geometry/polygons';
import { analyzeRouteIntrusion } from '../../src/geometry/routeObstruction';
import { analyzeSafeDropZone } from '../../src/geometry/safeDropZone';
import { PARCEL_SIZE } from './helpers';

const fp = (x: number, z: number, yaw = 0) => orientedRectangle({ x, z }, yaw, PARCEL_SIZE.width, PARCEL_SIZE.depth);
const corridor = DEFAULT_MODEL.route.corridor; // x ∈ [−0.6, 0.6] (+ maneuvering zone to x = 1.01 near the door)
const zone = DEFAULT_MODEL.safeDropZone.polygon; // x ∈ [−1.62, −0.82], z ∈ [0.12, 1.12]

describe('accessible-route intrusion', () => {
  it('(1) a parcel entirely outside the route does not intrude', () => {
    const r = analyzeRouteIntrusion(corridor, fp(-1.22, 0.62));
    expect(r.intrudes).toBe(false);
    expect(r.overlapArea).toBe(0);
  });

  it('(2) a parcel inside the route intrudes with its overlap measured', () => {
    const r = analyzeRouteIntrusion(corridor, fp(0, 3.5));
    expect(r.intrudes).toBe(true);
    expect(r.overlapArea).toBeCloseTo(PARCEL_SIZE.width * PARCEL_SIZE.depth, 9);
    expect(r.footprintShare).toBeCloseTo(1, 9);
  });

  it('measures partial intrusion exactly', () => {
    // Parcel centred on the west corridor edge at x = −0.6 on the ramp: half its width is inside.
    const r = analyzeRouteIntrusion(corridor, fp(-0.6, 3.5));
    expect(r.overlapArea).toBeCloseTo((PARCEL_SIZE.width / 2) * PARCEL_SIZE.depth, 9);
    expect(r.footprintShare).toBeCloseTo(0.5, 9);
  });

  it('boundary: touching the corridor edge is not an intrusion; 1 cm inside is', () => {
    const touching = analyzeRouteIntrusion(corridor, fp(-0.6 - PARCEL_SIZE.width / 2, 3.5));
    expect(touching.intrudes).toBe(false);
    const oneCm = analyzeRouteIntrusion(corridor, fp(-0.6 - PARCEL_SIZE.width / 2 + 0.01, 3.5));
    expect(oneCm.intrudes).toBe(true);
    expect(oneCm.overlapArea).toBeCloseTo(0.01 * PARCEL_SIZE.depth, 9);
  });

  it('is not triggered by mere proximity', () => {
    const near = analyzeRouteIntrusion(corridor, fp(-0.6 - PARCEL_SIZE.width / 2 - 0.005, 3.5));
    expect(near.intrudes).toBe(false);
  });
});

describe('safe drop zone', () => {
  it('(5) a parcel fully inside the zone is contained', () => {
    const r = analyzeSafeDropZone(zone, fp(-1.22, 0.62, 0.07));
    expect(r.contained).toBe(true);
    expect(r.overlapFraction).toBeCloseTo(1, 9);
  });

  it('(6) a parcel outside the zone is not contained', () => {
    const r = analyzeSafeDropZone(zone, fp(0.12, 0.55));
    expect(r.contained).toBe(false);
    expect(r.overlapFraction).toBe(0);
  });

  it('boundary: a parcel straddling the zone edge is not contained', () => {
    const r = analyzeSafeDropZone(zone, fp(-0.82, 0.62));
    expect(r.contained).toBe(false);
    expect(r.overlapFraction).toBeCloseTo(0.5, 6);
  });
});
