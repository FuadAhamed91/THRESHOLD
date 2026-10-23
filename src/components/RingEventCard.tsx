import { BellRing, Camera, Package, ShieldCheck, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { PLACEMENT_LABEL } from '../features/delivery/placement';
import { describeSource } from '../integrations/ring/normalize';
import { requestRingSnapshot } from '../integrations/ring/client';
import { useThreshold } from '../state/store';
import { Panel, Pill } from './ui';

/**
 * The incoming Ring event as THRESHOLD received it. Source, verification and
 * position provenance are always explicit; a simulated event can never read
 * as a live one. After the delivery act the card condenses so the analysis and
 * caregiver workflow have room.
 */
export function RingEventCard() {
  const event = useThreshold((s) => s.activeEvent);
  const view = useThreshold((s) => s.cameraView);
  const viewKind = useThreshold((s) => s.cameraViewKind);
  const placement = useThreshold((s) => s.placement);
  const provenance = useThreshold((s) => s.provenance);
  const integration = useThreshold((s) => s.integration);
  const phase = useThreshold((s) => s.phase);
  const [snapState, setSnapState] = useState<string | null>(null);

  if (!event || phase === 'intro' || phase === 'loading' || phase === 'finale') return null;
  const compact = !['delivery', 'reveal'].includes(phase);
  const time = new Date(event.occurredAt);
  const canSnapshot = !event.simulated && !!event.deviceId && !!integration?.auth.configured;
  const viewLabel = viewKind === 'ring-snapshot' ? 'Ring snapshot' : 'Simulated view';

  const snapshot = async () => {
    if (!event.deviceId) return;
    setSnapState('Requesting snapshot from Ring…');
    try {
      const { url, origin } = await requestRingSnapshot(event.deviceId, time.getTime());
      useThreshold.setState({ cameraView: url, cameraViewKind: 'ring-snapshot' });
      setSnapState(`Ring snapshot received (${origin ?? 'origin unknown'})`);
    } catch (e) {
      setSnapState(`Snapshot unavailable: ${e instanceof Error ? e.message : 'error'}`);
    }
  };

  const header = (
    <div className="flex items-center justify-between px-4 pt-3.5">
      <div className="flex items-center gap-2">
        <span className="grid h-7 w-7 place-items-center rounded-lg bg-ring/15 text-ring">
          <BellRing size={15} />
        </span>
        <div className="leading-tight">
          <div className="text-[13px] font-semibold">Ring event</div>
          <div className="text-[10.5px] text-text-3">
            {event.ringEventType} · {event.ringSubType ?? '—'}
          </div>
        </div>
      </div>
      {event.simulated ? <Pill tone="warn">Simulated</Pill> : <Pill tone="ok">Live</Pill>}
    </div>
  );

  if (compact) {
    return (
      <Panel className="w-[300px] overflow-hidden" strong>
        {header}
        <div className="flex gap-3 px-4 pt-3 pb-3.5">
          <div className="relative h-[62px] w-[100px] shrink-0 overflow-hidden rounded-lg border border-line bg-ink-900">
            {view && <img src={view} alt={viewLabel} className="h-full w-full object-cover" />}
            <span className="absolute bottom-0.5 left-1 text-[8px] font-semibold tracking-wider text-white/80 uppercase">{viewLabel}</span>
          </div>
          <div className="min-w-0 text-[11px] leading-snug">
            <div className="font-semibold text-text-1">Package delivery detected</div>
            <div className="text-text-3">
              Front door · {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
            <div className={`mt-0.5 ${placement.source === 'estimated_prior' ? 'text-estimate' : 'text-text-2'}`}>
              Position: {PLACEMENT_LABEL[placement.source].toLowerCase()}
              {placement.source === 'estimated_prior' ? ` ±${placement.uncertaintyRadius.toFixed(2)} m` : ''}
            </div>
            {canSnapshot && (
              <button className="mt-1 flex items-center gap-1 text-[10.5px] text-scan hover:underline" onClick={snapshot}>
                <Camera size={11} /> Request fresh snapshot
              </button>
            )}
            {snapState && <div className="mt-0.5 text-[10px] text-text-3">{snapState}</div>}
          </div>
        </div>
      </Panel>
    );
  }

  return (
    <Panel className="rise-in w-[300px] overflow-hidden" strong>
      {header}
      <div className="relative mx-4 mt-3 overflow-hidden rounded-xl border border-line bg-ink-900" style={{ aspectRatio: '16 / 10' }}>
        {view ? (
          <img src={view} alt={viewKind === 'ring-snapshot' ? 'Ring camera snapshot' : 'Simulated front-door camera view rendered from the 3D model'} className="h-full w-full object-cover" />
        ) : (
          <div className="flex h-full items-center justify-center gap-2 text-[11px] text-text-3">
            <Camera size={14} /> waiting for view…
          </div>
        )}
        <div className="absolute top-2 left-2 rounded-md bg-black/55 px-1.5 py-0.5 text-[9.5px] font-semibold tracking-wider text-white/85 uppercase">{viewLabel}</div>
      </div>

      <div className="space-y-2.5 px-4 py-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-black/5 text-text-1">
            <Package size={16} />
          </span>
          <div className="min-w-0">
            <div className="text-[13.5px] font-semibold">Package delivery detected</div>
            <div className="text-[11.5px] text-text-2">
              Front door · {time.toLocaleDateString([], { weekday: 'short' })}, {time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
            </div>
          </div>
        </div>

        <dl className="grid grid-cols-[64px_1fr] gap-x-2 gap-y-1.5 text-[11px]">
          <dt className="text-text-3">Source</dt>
          <dd className="flex items-center gap-1 text-text-1" title={event.deviceId ?? undefined}>
            {event.signatureVerified && <ShieldCheck size={12} className="text-clear" />}
            {describeSource(event)}
          </dd>
          <dt className="text-text-3">Position</dt>
          <dd className={placement.source === 'estimated_prior' ? 'text-estimate' : placement.source === 'user_confirmed' ? 'text-clear' : 'text-text-1'}>
            {PLACEMENT_LABEL[placement.source]}
          </dd>
        </dl>
        <p className="flex gap-1.5 rounded-lg border border-estimate/20 bg-estimate/5 px-2.5 py-2 text-[10.5px] leading-snug text-text-2">
          <TriangleAlert size={12} className="mt-px shrink-0 text-estimate" />
          <span>{provenance}</span>
        </p>
        {canSnapshot && (
          <button className="btn btn-ghost w-full justify-center text-[12px]" onClick={snapshot}>
            <Camera size={13} /> Request fresh snapshot
          </button>
        )}
        {snapState && <div className="text-[10.5px] text-text-3">{snapState}</div>}
      </div>
    </Panel>
  );
}
