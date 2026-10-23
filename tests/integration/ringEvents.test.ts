import { describe, expect, it } from 'vitest';
import { placementForEvent } from '../../src/features/delivery/placement';
import { describeSource, isPackageDelivery, parseRingEvent } from '../../src/integrations/ring/normalize';
import { createSimulatedEvent } from '../../src/integrations/simulation/simulatedEvents';

const live = {
  id: 'dev123_motion_1786715596787',
  kind: 'package_delivery',
  ringEventType: 'motion_detected',
  ringSubType: 'package_delivery',
  deviceId: 'ava1.ring.device.XXX',
  accountId: 'ava1.ring.account.YYY',
  occurredAt: '2026-08-14T08:53:16.787Z',
  receivedAt: '2026-08-14T08:53:17.010Z',
  source: 'ring_webhook',
  signatureVerified: true,
  componentIds: ['0'],
  requestId: '2ad45ade-1818-4154-813b-afdd8bcd8085',
  envelopeVersion: '1.1',
  simulated: false,
  scenario: null,
  positionData: null,
};

describe('Ring event intake (frontend)', () => {
  it('accepts a verified package-delivery webhook event', () => {
    const e = parseRingEvent(live);
    expect(e).not.toBeNull();
    expect(isPackageDelivery(e!)).toBe(true);
    expect(describeSource(e!)).toMatch(/signature verified/);
  });

  it('rejects a simulated event that claims to be a live webhook', () => {
    expect(parseRingEvent({ ...live, simulated: true })).toBeNull();
    expect(parseRingEvent({ ...live, source: 'simulation' })).toBeNull();
  });

  it('rejects a simulated event marked as signature-verified', () => {
    expect(parseRingEvent({ ...live, source: 'simulation', simulated: true, signatureVerified: true })).toBeNull();
  });

  it('rejects malformed payloads instead of guessing', () => {
    expect(parseRingEvent(null)).toBeNull();
    expect(parseRingEvent({ ...live, kind: 'parcel_teleported' })).toBeNull();
    expect(parseRingEvent({ ...live, occurredAt: 'yesterday-ish' })).toBeNull();
  });

  it('labels in-browser simulations as simulations', () => {
    const e = createSimulatedEvent('A', new Date('2026-10-23T18:42:00Z'));
    expect(parseRingEvent(e)).toEqual(e);
    expect(describeSource(e)).toMatch(/^Simulation/);
    expect(e.positionData).toBeNull();
  });
});

describe('placement provenance', () => {
  it('a real Ring event yields an ESTIMATED position from the drop prior, never a measured one', () => {
    const est = placementForEvent(parseRingEvent(live), 'A');
    expect(est.placement.source).toBe('estimated_prior');
    expect(est.placement.uncertaintyRadius).toBeGreaterThan(0.1);
    expect(est.provenance).toMatch(/no parcel coordinates/i);
  });

  it('a simulated scenario event uses the scenario pose and says so', () => {
    const est = placementForEvent(createSimulatedEvent('A'), 'B');
    expect(est.placement.source).toBe('simulated');
    expect(est.provenance).toMatch(/not a camera measurement/i);
  });

  it('scenario C simulates an uncertain estimate', () => {
    const est = placementForEvent(createSimulatedEvent('C'), 'A');
    expect(est.placement.source).toBe('estimated_prior');
  });
});
