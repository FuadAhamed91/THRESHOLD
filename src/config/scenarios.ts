import { DEFAULT_LAYOUT } from '../geometry/coordinateSystem';
import type { ParcelPose, Placement } from '../geometry/types';

export type ScenarioId = 'A' | 'B' | 'C';

export interface Scenario {
  readonly id: ScenarioId;
  readonly title: string;
  readonly summary: string;
  /** Parcel pose the scenario starts from. */
  readonly parcel: ParcelPose;
  readonly placement: Placement;
}

const size = DEFAULT_LAYOUT.parcel.size;
const DEG = Math.PI / 180;

/**
 * Deterministic demonstration scenarios. Positions here are SIMULATED inputs,
 * not camera measurements; every outcome is computed by the geometry engine.
 */
export const SCENARIOS: Record<ScenarioId, Scenario> = {
  A: {
    id: 'A',
    title: 'The blocked entrance',
    summary: 'A parcel is left on the landing in front of the out-swinging door.',
    parcel: { center: { x: 0.12, z: 0.55 }, yaw: -8 * DEG, size },
    placement: { source: 'simulated', uncertaintyRadius: 0 },
  },
  B: {
    id: 'B',
    title: 'The safe relocation',
    summary: 'The parcel sits in the configured safe drop zone beside the door.',
    parcel: {
      center: { ...DEFAULT_LAYOUT.safeDropZone.suggestedParcelCenter },
      yaw: 4 * DEG,
      size,
    },
    placement: { source: 'simulated', uncertaintyRadius: 0 },
  },
  C: {
    id: 'C',
    title: 'The uncertain delivery',
    summary: 'A delivery event arrives without a reliable position: the parcel location is only estimated.',
    parcel: {
      center: { ...DEFAULT_LAYOUT.dropPrior.center },
      yaw: DEFAULT_LAYOUT.dropPrior.yawDeg * DEG,
      size,
    },
    placement: { source: 'estimated_prior', uncertaintyRadius: DEFAULT_LAYOUT.dropPrior.radius },
  },
};

export const SCENARIO_ORDER: ScenarioId[] = ['A', 'B', 'C'];
