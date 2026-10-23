import { Crosshair, MapPin, Move, PackageCheck, RotateCcw, RotateCw, Undo2, X } from 'lucide-react';
import { runtime } from '../app/runtime';
import { PLACEMENT_LABEL } from '../features/delivery/placement';
import { DEG } from '../geometry/coordinateSystem';
import { useThreshold } from '../state/store';
import { Panel, Pill, StatusIcon } from './ui';

const fmt = (n: number, d = 2) => n.toFixed(d);

/** Inspector for the selected parcel: pose, provenance and real relocation actions. */
export function ParcelInspector() {
  const selected = useThreshold((s) => s.parcelSelected);
  const parcel = useThreshold((s) => s.parcel);
  const placement = useThreshold((s) => s.placement);
  const analysis = useThreshold((s) => s.analysis);
  const phase = useThreshold((s) => s.phase);
  if (!selected || !['explore', 'resolve', 'finale'].includes(phase)) return null;
  const yawDeg = ((-parcel.yaw / DEG) % 360 + 360) % 360;

  return (
    <Panel className="rise-in w-[280px] px-4 py-3.5" strong>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 text-[13px] font-semibold">
          <Move size={14} className="text-scan" /> Parcel
        </div>
        <div className="flex items-center gap-1.5">
          <Pill tone={placement.source === 'estimated_prior' ? 'warn' : placement.source === 'user_confirmed' ? 'ok' : 'info'}>{PLACEMENT_LABEL[placement.source]}</Pill>
          <button className="icon-btn !h-7 !w-7" onClick={() => useThreshold.setState({ parcelSelected: false })} aria-label="Close parcel inspector">
            <X size={13} />
          </button>
        </div>
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center">
        {[
          ['X', `${fmt(parcel.center.x)} m`],
          ['Z', `${fmt(parcel.center.z)} m`],
          ['Rotation', `${fmt(yawDeg, 0)}°`],
        ].map(([k, v]) => (
          <div key={k} className="rounded-lg bg-black/[0.045] px-2 py-1.5">
            <dt className="text-[9.5px] tracking-wider text-text-3 uppercase">{k}</dt>
            <dd className="font-mono text-[12px] text-text-1">{v}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 text-[10.5px] text-text-3">
        Footprint {fmt(parcel.size.width)} × {fmt(parcel.size.depth)} m · height {fmt(parcel.size.height)} m
      </div>
      {analysis && (
        <div className="mt-2.5 space-y-1 text-[11px]">
          <div className="flex items-center gap-1.5">
            <StatusIcon tone={analysis.door.physicallyBlocked ? 'bad' : 'ok'} size={13} />
            Door {analysis.door.physicallyBlocked ? `stops at ${Math.round(analysis.door.maxOpening / DEG)}°` : 'opens fully'}
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIcon tone={analysis.route.intrudes ? 'bad' : 'ok'} size={13} />
            {analysis.route.intrudes ? 'Inside the accessible route' : 'Clear of the accessible route'}
          </div>
          <div className="flex items-center gap-1.5">
            <StatusIcon tone={analysis.safeZone.contained ? 'ok' : 'muted'} size={13} />
            {analysis.safeZone.contained ? 'Inside the safe drop zone' : 'Outside the safe drop zone'}
          </div>
        </div>
      )}
      <div className="mt-3 grid grid-cols-2 gap-2">
        <button className="btn btn-ghost justify-center text-[12px]" onClick={() => runtime.exp?.parcel.rotateBy(Math.PI / 12)} aria-label="Rotate parcel left">
          <RotateCcw size={13} /> Rotate
        </button>
        <button className="btn btn-ghost justify-center text-[12px]" onClick={() => runtime.exp?.parcel.rotateBy(-Math.PI / 12)} aria-label="Rotate parcel right">
          <RotateCw size={13} /> Rotate
        </button>
        <button className="btn btn-ghost justify-center text-[12px]" onClick={() => useThreshold.getState().resetParcel()}>
          <Undo2 size={13} /> Reset
        </button>
        <button
          className="btn btn-ghost justify-center text-[12px]"
          onClick={() => {
            useThreshold.getState().confirmPlacement();
            useThreshold.getState().toast('Position confirmed: the analysis is now treated as definitive.', 'success');
          }}
        >
          <MapPin size={13} /> Confirm
        </button>
        <button className="btn btn-clear col-span-2 justify-center text-[12.5px]" onClick={() => runtime.director?.moveParcelToSafeZone()}>
          <PackageCheck size={14} /> Move to safe drop zone
        </button>
      </div>
      <div className="mt-2.5 flex items-center gap-1.5 text-[10.5px] text-text-3">
        <Crosshair size={11} /> Drag to move · Q/E or wheel-while-dragging to rotate
      </div>
    </Panel>
  );
}
