import { Bell, Check, Eye, MapPin, PackageCheck, X } from 'lucide-react';
import { runtime } from '../app/runtime';
import { useThreshold } from '../state/store';
import { Panel, Pill } from './ui';

const STEPS = ['Review', 'Inspect', 'Confirm or dismiss', 'Resolve'];

/**
 * Caregiver hand-off for a possible obstruction. LOCAL demo workflow: nothing is
 * sent by SMS, push or to a Ring device; each step is logged with a timestamp.
 */
export function CaregiverPanel() {
  const cg = useThreshold((s) => s.caregiver);
  const phase = useThreshold((s) => s.phase);
  const analysis = useThreshold((s) => s.analysis);
  const act = useThreshold((s) => s.caregiverAction);
  if (cg.status === 'idle' || (phase !== 'resolve' && phase !== 'explore')) return null;
  const step = { pending: 0, reviewing: 1, confirmed: 2, dismissed: 3, resolved: 3, idle: 0 }[cg.status];
  const uncertain = analysis?.status === 'indeterminate';
  const resolved = cg.status === 'resolved';
  const last = cg.log[cg.log.length - 1];

  return (
    <Panel className="rise-in w-[300px] overflow-hidden px-4 py-3.5" strong>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[13.5px] font-semibold">
          <span className={`grid h-7 w-7 place-items-center rounded-lg ${resolved ? 'bg-clear/15 text-clear' : 'bg-conflict/12 text-conflict'}`}>
            {resolved ? <PackageCheck size={15} /> : <Bell size={15} />}
          </span>
          {resolved ? 'Resolved' : 'Caregiver alert'}
        </div>
        <span title="Nothing is sent by SMS, push or to a Ring device.">
          <Pill tone="muted">Local demo</Pill>
        </span>
      </div>
      <p className="mt-2 line-clamp-3 text-[11.5px] leading-snug text-text-2">
        {resolved ? 'Re-analysed after the parcel moved: the entrance is clear.' : uncertain ? 'The parcel position is only estimated. Drag it to where it really is, then confirm.' : cg.reason}
      </p>

      <div className="mt-3 flex gap-1" aria-label={`Step ${step + 1} of ${STEPS.length}: ${STEPS[step]}`}>
        {STEPS.map((s, i) => (
          <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? (resolved ? 'bg-clear' : 'bg-route') : 'bg-black/10'}`} title={s} />
        ))}
      </div>
      <div className="mt-1 text-[10px] text-text-3">
        Step {step + 1}/{STEPS.length} · {STEPS[step]}
      </div>

      {!resolved && (
        <>
          {uncertain ? (
            <button
              className="btn btn-primary mt-3 w-full justify-center text-[12.5px]"
              onClick={() => {
                useThreshold.getState().confirmPlacement();
                act('confirm', 'Parcel position confirmed on the model.');
              }}
            >
              <MapPin size={14} /> Confirm parcel position
            </button>
          ) : (
            <button className="btn btn-clear mt-3 w-full justify-center text-[12.5px]" onClick={() => runtime.director?.moveParcelToSafeZone()}>
              <PackageCheck size={14} /> Move parcel to safe drop zone
            </button>
          )}
          <div className="mt-2 grid grid-cols-3 gap-1.5">
            <button
              className="btn btn-ghost justify-center !px-2 !py-1.5 text-[11.5px]"
              onClick={() => {
                act('review', 'Opened the analysis view.');
                runtime.exp?.flyTo('cutaway', 2);
                useThreshold.setState({ cameraMode: 'manual', shot: 'cutaway' });
              }}
            >
              <Eye size={12} /> Inspect
            </button>
            <button className="btn btn-ghost justify-center !px-2 !py-1.5 text-[11.5px]" onClick={() => act('confirm', 'Obstruction confirmed.')}>
              <Check size={12} /> Confirm
            </button>
            <button className="btn btn-ghost justify-center !px-2 !py-1.5 text-[11.5px]" onClick={() => act('dismiss', 'Dismissed.')}>
              <X size={12} /> Dismiss
            </button>
          </div>
        </>
      )}
      {last && (
        <div className="mt-3 truncate border-t border-line pt-2 text-[10.5px] text-text-3" title={`${last.action}${last.detail ? ' · ' + last.detail : ''}`}>
          <span className="font-mono">{new Date(last.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span> · {last.action}
        </div>
      )}
    </Panel>
  );
}
