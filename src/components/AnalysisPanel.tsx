import { Accessibility, ChevronDown, DoorOpen, Package, Route, Ruler, ScanLine, Target } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { DEG } from '../geometry/coordinateSystem';
import type { AnalysisResult } from '../geometry/types';
import { useThreshold } from '../state/store';
import { PlanView } from './PlanView';
import { Divider, Panel, Pill, StatusIcon, type Tone } from './ui';

const fmt = (n: number, d = 2) => n.toFixed(d);

function Row({ icon, label, value, sub, tone }: { icon: ReactNode; label: string; value: string; sub?: string; tone: Tone }) {
  return (
    <div className="flex items-center gap-3 py-2">
      <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-black/[0.045] text-text-2">{icon}</span>
      <div className="min-w-0 flex-1">
        <div className="text-[11.5px] text-text-3">{label}</div>
        {sub && <div className="truncate text-[10.5px] text-text-3/80">{sub}</div>}
      </div>
      <div className="flex items-center gap-1.5 text-right">
        <span className={`text-[12.5px] font-semibold ${tone === 'bad' ? 'text-conflict' : tone === 'ok' ? 'text-clear' : tone === 'warn' ? 'text-caution' : 'text-text-1'}`}>{value}</span>
        <StatusIcon tone={tone} size={15} />
      </div>
    </div>
  );
}

function ClearanceGauge({ r }: { r: AnalysisResult }) {
  const { width, required, meetsRequirement } = r.clearance;
  const max = Math.max(1.4, required * 1.35, width * 1.1);
  return (
    <div className="rounded-xl border border-line bg-white/55 px-3.5 py-3">
      <div className="flex items-end justify-between">
        <div>
          <div className="eyebrow">Remaining clearance</div>
          <div className={`font-mono text-[30px] leading-none font-semibold tabular ${meetsRequirement ? 'text-clear' : 'text-conflict'}`}>
            {fmt(width)}
            <span className="ml-1 text-[14px] font-medium text-text-2">m</span>
          </div>
        </div>
        <div className="text-right text-[11px] text-text-3">
          min <span className="font-mono text-text-1">{fmt(required)} m</span> required
          <div className="mt-0.5">{r.clearance.method === 'exact-pair' ? 'exact gap' : `grid ±${fmt(r.clearance.tolerance, 3)} m`}</div>
        </div>
      </div>
      <div className="relative mt-3 h-2 rounded-full bg-black/[0.07]">
        <div
          className={`absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ${meetsRequirement ? 'bg-gradient-to-r from-clear/60 to-clear' : 'bg-gradient-to-r from-conflict/60 to-conflict'}`}
          style={{ width: `${Math.min(100, (width / max) * 100)}%` }}
        />
        <div className="absolute -top-1 -bottom-1 w-0.5 rounded bg-text-1" style={{ left: `${(required / max) * 100}%` }} title="Required width" />
      </div>
      {r.clearance.pinch && (
        <div className="mt-2 text-[10.5px] leading-snug text-text-3">
          Narrowest point: {r.clearance.pinch.labelA.toLowerCase()} ↔ {r.clearance.pinch.labelB.toLowerCase()}
        </div>
      )}
    </div>
  );
}

const LEGEND: Array<{ label: string; swatch: ReactNode }> = [
  { label: 'Door swing arc', swatch: <span className="h-3 w-3 rounded-tr-full border-t-2 border-r-2 border-[#ff4d61]" /> },
  { label: 'Parcel footprint', swatch: <span className="h-2.5 w-3.5 rounded-sm bg-[#ff4d61]/70 ring-1 ring-[#ff4d61]" /> },
  { label: 'Configured accessible route', swatch: <span className="h-2.5 w-3.5 rounded-sm bg-route/30 ring-1 ring-route" /> },
  { label: 'Computed route', swatch: <span className="h-0.5 w-3.5 rounded bg-scan shadow-[0_0_6px_#38d6f5]" /> },
  { label: 'Safe drop zone', swatch: <span className="h-2.5 w-3.5 rounded-sm border border-dashed border-clear" /> },
  { label: 'Wall (cutaway)', swatch: <span className="h-2.5 w-3.5 rounded-sm border border-[#8fd3ff]/70 bg-[#2b6fd8]/20" /> },
];

export function Legend() {
  return (
    <ul className="grid grid-cols-2 gap-x-3 gap-y-1.5">
      {LEGEND.map((l) => (
        <li key={l.label} className="flex items-center gap-2 text-[10.5px] text-text-2">
          <span className="grid w-4 place-items-center">{l.swatch}</span>
          {l.label}
        </li>
      ))}
    </ul>
  );
}

const STATUS: Record<AnalysisResult['status'], { label: string; tone: Tone; line: string }> = {
  clear: { label: 'Entrance accessible', tone: 'ok', line: 'Every configured constraint is satisfied.' },
  caution: { label: 'Passable, with intrusion', tone: 'warn', line: 'A route exists but the parcel intrudes on the designated route.' },
  obstructed: { label: 'Entrance obstructed', tone: 'bad', line: 'The modelled geometry violates a configured constraint.' },
  indeterminate: { label: 'Needs confirmation', tone: 'warn', line: 'The outcome depends on where the parcel actually is.' },
  invalid: { label: 'Configuration invalid', tone: 'bad', line: 'The entrance model failed validation.' },
};

export function AnalysisPanel() {
  const r = useThreshold((s) => s.analysis);
  const phase = useThreshold((s) => s.phase);
  const [open, setOpen] = useState(false);
  const visible = ['consequence', 'resolve', 'explore'].includes(phase);
  if (!visible) {
    if (phase === 'reveal') {
      return (
        <Panel className="rise-in w-[320px] px-4 py-3.5">
          <div className="flex items-center gap-2 text-[12.5px] font-semibold">
            <ScanLine size={15} className="text-scan" /> Analysing entrance geometry…
          </div>
          <div className="scan-bar mt-3 h-1 rounded-full bg-black/5" />
          <div className="mt-2 text-[10.5px] text-text-3">Door swing · route corridor · clearance field · pathfinding</div>
          <div className="mt-3 border-t border-line pt-3">
            <Legend />
          </div>
        </Panel>
      );
    }
    return null;
  }
  if (!r) return null;
  const st = STATUS[r.status];
  const d = r.door;
  const doorTone: Tone = d.physicallyBlocked ? 'bad' : d.intersectsSwingRegion ? 'warn' : 'ok';
  const doorValue = d.physicallyBlocked ? `Yes · ${Math.round(d.maxOpening / DEG)}°/${Math.round(d.requiredOpening / DEG)}°` : d.intersectsSwingRegion ? 'In region' : 'No';
  const posTone: Tone = r.placement.source === 'estimated_prior' ? 'warn' : r.placement.source === 'user_confirmed' ? 'ok' : 'info';
  const posValue =
    r.placement.source === 'estimated_prior'
      ? `Estimated ±${fmt(r.placement.uncertaintyRadius)} m`
      : r.placement.source === 'user_confirmed'
        ? 'Confirmed'
        : r.placement.source === 'user_adjusted'
          ? 'Adjusted'
          : 'Simulated';

  return (
    <Panel className="rise-in w-[320px] overflow-hidden" strong>
      <div className="px-4 pt-3.5 pb-3">
        <div className="flex items-center justify-between">
          <div className="eyebrow">Spatial analysis</div>
          <Pill tone={st.tone}>
            <StatusIcon tone={st.tone} size={11} />
            {r.status}
          </Pill>
        </div>
        <div className="mt-1.5 text-[16px] font-semibold tracking-tight">{st.label}</div>
        <div className="text-[11.5px] text-text-2">{st.line}</div>
      </div>
      <Divider />
      <div className="px-4 pt-3">
        <ClearanceGauge r={r} />
      </div>
      <div className="px-4 py-1.5">
        <Row icon={<DoorOpen size={15} />} label="Door collision" sub={d.physicallyBlocked ? `blocked by ${d.blockedBy?.toLowerCase()}` : undefined} value={doorValue} tone={doorTone} />
        <Row
          icon={<Route size={15} />}
          label="Route obstruction"
          sub={r.route.intrudes ? `${fmt(r.route.overlapArea, 3)} m² of corridor covered` : undefined}
          value={r.route.intrudes ? 'Yes' : 'No'}
          tone={r.route.intrudes ? (r.path.found ? 'warn' : 'bad') : 'ok'}
        />
        <Row
          icon={<Accessibility size={15} />}
          label="Valid route"
          sub={r.path.found ? `${fmt(r.path.length, 1)} m, verified ≥ ${fmt(2 * (r.path.verifiedMinClearance ?? 0))} m` : r.path.failure?.code.replaceAll('_', ' ').toLowerCase()}
          value={r.path.found ? 'Yes' : 'No'}
          tone={r.path.found ? 'ok' : 'bad'}
        />
        <Row icon={<Package size={15} />} label="Safe drop zone" value={r.safeZone.contained ? 'Inside' : 'Outside'} tone={r.safeZone.contained ? 'ok' : 'muted'} />
        <Row
          icon={<Target size={15} />}
          label="Position certainty"
          sub={r.uncertainty.evaluated ? `${r.uncertainty.samples.filter((s) => !s.routeFound || s.doorBlocked).length}/${r.uncertainty.samples.length} plausible placements obstruct` : undefined}
          value={posValue}
          tone={r.uncertainty.verdict === 'indeterminate' ? 'warn' : posTone}
        />
      </div>
      <Divider />
      <button className="flex w-full items-center justify-between px-4 py-2.5 text-[11.5px] text-text-2 hover:text-text-1" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="flex items-center gap-1.5">
          <Ruler size={13} /> Plan view & reasoning
        </span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <div className="px-4 pb-3.5">
          <div className="overflow-hidden rounded-xl border border-line">
            <PlanView result={r} />
          </div>
          <div className="mt-3">
            <Legend />
          </div>
          <ul className="mt-3 space-y-2">
            {r.findings.map((f) => (
              <li key={f.code + f.title} className="flex gap-2 text-[11px] leading-snug">
                <StatusIcon tone={f.severity === 'critical' ? 'bad' : f.severity === 'warning' ? 'warn' : f.severity === 'ok' ? 'ok' : 'info'} size={13} />
                <span>
                  <span className="font-semibold text-text-1">{f.title}.</span> <span className="text-text-2">{f.detail}</span>
                </span>
              </li>
            ))}
          </ul>
          <div className="mt-3 font-mono text-[10px] text-text-3">
            computed in {fmt(r.computeMs, 0)} ms · exact distances on a 2.5 cm grid · {r.path.explored.length / 2} nodes searched
          </div>
        </div>
      )}
    </Panel>
  );
}
