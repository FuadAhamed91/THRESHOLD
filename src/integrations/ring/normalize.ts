import type { IntegrationStatus, NormalizedRingEvent, RingEventKind } from './types';

const KINDS: readonly RingEventKind[] = ['package_delivery', 'motion', 'doorbell', 'device', 'other'];

const isStr = (v: unknown): v is string => typeof v === 'string';
const isStrOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

/**
 * Validate an event received from the backend before it can drive the
 * experience. Anything malformed is rejected rather than guessed at, and the
 * simulated/live labels must be mutually consistent.
 */
export function parseRingEvent(input: unknown): NormalizedRingEvent | null {
  if (!input || typeof input !== 'object') return null;
  const e = input as Record<string, unknown>;
  if (!isStr(e.id) || !isStr(e.ringEventType) || !isStr(e.occurredAt) || !isStr(e.receivedAt)) return null;
  if (!KINDS.includes(e.kind as RingEventKind)) return null;
  if (e.source !== 'ring_webhook' && e.source !== 'simulation') return null;
  if (typeof e.simulated !== 'boolean' || typeof e.signatureVerified !== 'boolean') return null;
  if (e.simulated !== (e.source === 'simulation')) return null; // never present simulation as live
  if (e.simulated && e.signatureVerified) return null;
  if (!isStrOrNull(e.ringSubType) || !isStrOrNull(e.deviceId) || !isStrOrNull(e.accountId)) return null;
  if (!isStrOrNull(e.requestId) || !isStrOrNull(e.envelopeVersion)) return null;
  if (Number.isNaN(Date.parse(e.occurredAt))) return null;
  const scenario = e.scenario === 'A' || e.scenario === 'B' || e.scenario === 'C' ? e.scenario : null;
  const componentIds = Array.isArray(e.componentIds) && e.componentIds.every(isStr) ? (e.componentIds as string[]) : null;
  return {
    id: e.id,
    kind: e.kind as RingEventKind,
    ringEventType: e.ringEventType,
    ringSubType: e.ringSubType,
    deviceId: e.deviceId,
    accountId: e.accountId,
    occurredAt: e.occurredAt,
    receivedAt: e.receivedAt,
    source: e.source,
    signatureVerified: e.signatureVerified,
    componentIds,
    requestId: e.requestId,
    envelopeVersion: e.envelopeVersion,
    simulated: e.simulated,
    scenario,
    positionData: null,
  };
}

export const isPackageDelivery = (e: NormalizedRingEvent): boolean => e.kind === 'package_delivery';

export function parseStatus(input: unknown): IntegrationStatus | null {
  if (!input || typeof input !== 'object') return null;
  const s = input as Record<string, unknown>;
  if (s.mode !== 'live' && s.mode !== 'simulation') return null;
  const status = input as IntegrationStatus;
  return {
    ...status,
    lastEvent: status.lastEvent ? parseRingEvent(status.lastEvent) : null,
    notes: Array.isArray(status.notes) ? status.notes.filter(isStr) : [],
  };
}

/** Human description of where an event came from (never claims more than is true). */
export function describeSource(e: NormalizedRingEvent): string {
  if (e.simulated) return 'Simulation · Ring webhook schema v1.1';
  if (e.signatureVerified) return 'Ring webhook · signature verified';
  return 'Ring webhook · unsigned (local dev mode)';
}
