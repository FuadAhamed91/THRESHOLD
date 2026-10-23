import type { ScenarioId } from '../../config/scenarios';
import type { NormalizedRingEvent } from '../ring/types';

/**
 * Deterministic in-browser simulation, used when the backend is not running.
 * Events follow the same normalized shape as real webhooks but are always
 * labelled `source: 'simulation'` and can never pass as live.
 */
export function createSimulatedEvent(scenario: ScenarioId, now = new Date()): NormalizedRingEvent {
  const iso = now.toISOString();
  return {
    id: `sim_${scenario}_${now.getTime()}`,
    kind: 'package_delivery',
    ringEventType: 'motion_detected',
    ringSubType: 'package_delivery',
    deviceId: 'sim-front-door-cam',
    accountId: null,
    occurredAt: iso,
    receivedAt: iso,
    source: 'simulation',
    signatureVerified: false,
    componentIds: null,
    requestId: null,
    envelopeVersion: '1.1',
    simulated: true,
    scenario,
    positionData: null,
  };
}
