import { SCENARIOS, type ScenarioId } from '../../config/scenarios';
import { DEFAULT_MODEL } from '../../geometry/entranceModel';
import { DEFAULT_LAYOUT } from '../../geometry/coordinateSystem';
import type { ParcelPose, Placement } from '../../geometry/types';
import type { NormalizedRingEvent } from '../../integrations/ring/types';

export interface PlacementEstimate {
  readonly pose: ParcelPose;
  readonly placement: Placement;
  /** Plain-language provenance shown next to the parcel. */
  readonly provenance: string;
}

/**
 * Where should the parcel be assumed to be for this event?
 *  - Simulated scenario events use the scenario's simulated pose.
 *  - Real Ring events carry no parcel geometry, so the pose is ESTIMATED from the
 *    entrance's courier-drop prior, with its uncertainty radius, until a person
 *    confirms it. The estimate is never presented as a camera measurement.
 */
export function placementForEvent(event: NormalizedRingEvent | null, fallback: ScenarioId): PlacementEstimate {
  if (!event || (event.simulated && event.scenario)) {
    const s = SCENARIOS[(event?.scenario as ScenarioId | null) ?? fallback];
    return {
      pose: s.parcel,
      placement: s.placement,
      provenance:
        s.placement.source === 'estimated_prior'
          ? `Simulated event · position estimated from the courier-drop prior (±${s.placement.uncertaintyRadius.toFixed(2)} m)`
          : 'Simulated scenario position, not a camera measurement. Ring webhooks carry no parcel coordinates.',
    };
  }
  const prior = DEFAULT_MODEL.dropPrior;
  return {
    pose: { center: prior.center, yaw: prior.yaw, size: DEFAULT_LAYOUT.parcel.size },
    placement: { source: 'estimated_prior', uncertaintyRadius: prior.radius },
    provenance: `Estimated from this entrance’s courier-drop prior (±${prior.radius.toFixed(2)} m). Ring events include no parcel coordinates.`,
  };
}

export const PLACEMENT_LABEL: Record<Placement['source'], string> = {
  simulated: 'Simulated',
  estimated_prior: 'Estimated',
  user_adjusted: 'Adjusted on model',
  user_confirmed: 'Confirmed',
};
