import { axisAlignedRectangle, ensureCCW } from '../../src/geometry/polygons';
import type { EntranceModel, ParcelPose, Placement, Vec2 } from '../../src/geometry/types';

export const EXACT: Placement = { source: 'simulated', uncertaintyRadius: 0 };
export const PARCEL_SIZE = { width: 0.46, depth: 0.36, height: 0.32 };

export const parcelAt = (x: number, z: number, yaw = 0, size = PARCEL_SIZE): ParcelPose => ({
  center: { x, z },
  yaw,
  size,
});

/**
 * Straight corridor `width` wide from z = 0 to z = length, with the door parked far
 * away (its leaf never touches the corridor) so tests isolate a single mechanism.
 */
export function corridorModel(width = 1.2, length = 6, extra: Partial<EntranceModel> = {}): EntranceModel {
  const hw = width / 2;
  const walk = ensureCCW([
    { x: -hw, z: 0 },
    { x: hw, z: 0 },
    { x: hw, z: length },
    { x: -hw, z: length },
  ]);
  return {
    name: 'Test corridor',
    walkable: { polygon: walk, edgeLabels: ['Door end', 'East wall', 'Street end', 'West wall'], openEdges: [0, 2] },
    obstacles: [],
    door: {
      label: 'Test door',
      hinge: { x: 20, z: 20 },
      width: 0.9,
      thickness: 0.05,
      height: 2.1,
      closedAngle: 0,
      openingSense: 1,
      requiredOpening: Math.PI / 2,
      undercut: 0.01,
    },
    route: {
      label: 'Corridor',
      corridor: axisAlignedRectangle(-hw, 0, hw, length),
      start: { x: 0, z: length - 0.5 },
      goal: { x: 0, z: 0.5 },
    },
    safeDropZone: {
      label: 'Zone',
      polygon: axisAlignedRectangle(-hw, length - 1.2, 0, length - 0.6),
      suggestedCenter: { x: -hw / 2, z: length - 0.9 },
    },
    dropPrior: { center: { x: 0, z: length / 2 }, radius: 0.4, yaw: 0 },
    defaultRequiredClearWidth: 0.9,
    gridSpacing: 0.025,
    ...extra,
  };
}

export const pts = (...xy: Array<[number, number]>): Vec2[] => xy.map(([x, z]) => ({ x, z }));
