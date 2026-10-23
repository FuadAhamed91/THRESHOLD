/**
 * Event and status shapes exchanged with the THRESHOLD backend
 * (server/threshold_server). Mirrors the backend's NormalizedEvent exactly.
 *
 * Ring's documented webhook (envelope v1.1) carries NO parcel position, size,
 * bounding box or image, so `positionData` is always null.
 */
export type RingEventKind = 'package_delivery' | 'motion' | 'doorbell' | 'device' | 'other';
export type EventSource = 'ring_webhook' | 'simulation';

export interface NormalizedRingEvent {
  readonly id: string;
  readonly kind: RingEventKind;
  readonly ringEventType: string;
  readonly ringSubType: string | null;
  readonly deviceId: string | null;
  readonly accountId: string | null;
  readonly occurredAt: string;
  readonly receivedAt: string;
  readonly source: EventSource;
  readonly signatureVerified: boolean;
  readonly componentIds: string[] | null;
  readonly requestId: string | null;
  readonly envelopeVersion: string | null;
  readonly simulated: boolean;
  readonly scenario: 'A' | 'B' | 'C' | null;
  readonly positionData: null;
}

export interface IntegrationStatus {
  readonly mode: 'live' | 'simulation';
  readonly webhook: { readonly path: string; readonly signingKeyConfigured: boolean; readonly allowUnsigned: boolean };
  readonly auth: { readonly mode: 'access_token' | 'refresh_token' | null; readonly configured: boolean; readonly error: string | null };
  readonly device: { readonly id: string; readonly name: string; readonly online: boolean } | null;
  readonly lastEvent: NormalizedRingEvent | null;
  readonly eventsReceived: number;
  readonly notes: string[];
}

/** Backend reachability, independent of whether Ring credentials are configured. */
export type BackendConnection = 'connecting' | 'online' | 'offline';
