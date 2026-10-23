import { describe, expect, it } from 'vitest';
import { analyzeEntrance } from '../../src/geometry/analyze';
import { DEFAULT_MODEL, buildEntranceModel } from '../../src/geometry/entranceModel';
import { DEFAULT_LAYOUT } from '../../src/geometry/coordinateSystem';
import { validateModel } from '../../src/geometry/validateConfig';
import { SCENARIOS } from '../../src/config/scenarios';
import { EXACT, corridorModel, parcelAt } from './helpers';

describe('(8) invalid or impossible configurations', () => {
  it('accepts the calibrated demo entrance', () => {
    expect(validateModel(DEFAULT_MODEL, 0.9)).toEqual([]);
  });

  it('rejects a non-positive door width', () => {
    const bad = { ...DEFAULT_MODEL, door: { ...DEFAULT_MODEL.door, width: -1 } };
    const r = analyzeEntrance({ model: bad, parcel: null, placement: EXACT, requiredClearWidth: 0.9 });
    expect(r.status).toBe('invalid');
    expect(r.configErrors.join(' ')).toMatch(/door\.width/);
    expect(r.clearance.pinch).toBeNull();
    expect(r.path.found).toBe(false);
  });

  it('rejects a route start outside the walkable surface', () => {
    const bad = { ...DEFAULT_MODEL, route: { ...DEFAULT_MODEL.route, start: { x: 5, z: 5 } } };
    expect(validateModel(bad, 0.9).map((i) => i.path)).toContain('route.start');
  });

  it('rejects a self-intersecting corridor and a non-positive required width', () => {
    const bad = {
      ...DEFAULT_MODEL,
      route: {
        ...DEFAULT_MODEL.route,
        corridor: [
          { x: 0, z: 0 },
          { x: 1, z: 1 },
          { x: 1, z: 0 },
          { x: 0, z: 1 },
        ],
      },
    };
    const paths = validateModel(bad, 0).map((i) => i.path);
    expect(paths).toContain('route.corridor');
    expect(paths).toContain('requiredClearWidth');
  });

  it('rejects a safe drop zone that overlaps an obstacle', () => {
    const layout = structuredClone(DEFAULT_LAYOUT);
    layout.planters[1].center = { x: -1.2, z: 0.6 };
    const model = buildEntranceModel(layout);
    expect(validateModel(model, 0.9).some((i) => i.path === 'safeDropZone.polygon')).toBe(true);
  });

  it('rejects non-finite parcel input instead of guessing', () => {
    const r = analyzeEntrance({
      model: corridorModel(),
      parcel: { center: { x: Number.NaN, z: 1 }, yaw: 0, size: { width: 0.4, depth: 0.3, height: 0.3 } },
      placement: EXACT,
      requiredClearWidth: 0.9,
    });
    expect(r.status).toBe('invalid');
    expect(r.clearance.width).toBe(0);
  });
});

describe('demonstration scenarios', () => {
  const run = (id: 'A' | 'B' | 'C') =>
    analyzeEntrance({
      model: DEFAULT_MODEL,
      parcel: SCENARIOS[id].parcel,
      placement: SCENARIOS[id].placement,
      requiredClearWidth: 0.9,
    });

  it('A — blocked entrance: door, route and clearance all fail for real geometric reasons', () => {
    const r = run('A');
    expect(r.status).toBe('obstructed');
    expect(r.door.physicallyBlocked).toBe(true);
    expect(r.route.intrudes).toBe(true);
    expect(r.clearance.meetsRequirement).toBe(false);
    expect(r.path.found).toBe(false);
    expect(r.safeZone.contained).toBe(false);
  });

  it('B — safe relocation: every constraint is satisfied after the move', () => {
    const r = run('B');
    expect(r.status).toBe('clear');
    expect(r.safeZone.contained).toBe(true);
    expect(r.door.maxOpening).toBeCloseTo(DEFAULT_MODEL.door.requiredOpening, 9);
    expect(r.clearance.width).toBeGreaterThanOrEqual(0.9);
    expect(r.path.found).toBe(true);
    expect(r.path.verifiedMinClearance! * 2).toBeGreaterThanOrEqual(0.9 - 0.04);
  });

  it('C — uncertain delivery: plausible placements disagree, so no definitive verdict', () => {
    const r = run('C');
    expect(r.placement.source).toBe('estimated_prior');
    expect(r.uncertainty.evaluated).toBe(true);
    expect(r.uncertainty.verdict).toBe('indeterminate');
    expect(r.status).toBe('indeterminate');
    expect(r.findings.some((f) => f.code === 'PLACEMENT_ESTIMATED')).toBe(true);
  });

  it('is deterministic', () => {
    const a = run('A');
    const b = run('A');
    expect(b.clearance.width).toBe(a.clearance.width);
    expect(b.door.maxOpening).toBe(a.door.maxOpening);
    expect(b.path.reachable).toEqual(a.path.reachable);
  });

  it('a confirmed placement is evaluated definitively', () => {
    const r = analyzeEntrance({
      model: DEFAULT_MODEL,
      parcel: parcelAt(0.3, 0.95),
      placement: { source: 'user_confirmed', uncertaintyRadius: 0.05 },
      requiredClearWidth: 0.9,
    });
    expect(r.uncertainty.verdict).toBe('definitive');
    expect(r.status).not.toBe('indeterminate');
  });
});
