import { FlaskConical, Gauge, SlidersHorizontal, X } from 'lucide-react';
import { useState } from 'react';
import { runtime } from '../app/runtime';
import { SCENARIOS, SCENARIO_ORDER, type ScenarioId } from '../config/scenarios';
import { useThreshold } from '../state/store';

/**
 * Discreet developer / judging drawer: deterministic scenarios, the
 * configurable clear-width requirement, motion and quality settings.
 */
export function ScenarioDrawer() {
  const [open, setOpen] = useState(false);
  const scenarioId = useThreshold((s) => s.scenarioId);
  const required = useThreshold((s) => s.requiredClearWidth);
  const reduced = useThreshold((s) => s.reducedMotion);
  const autoplay = useThreshold((s) => s.autoplay);
  const phase = useThreshold((s) => s.phase);
  if (phase === 'loading') return null;

  const pick = (id: ScenarioId) => {
    useThreshold.getState().loadScenario(id);
    setOpen(false);
    if (phase !== 'intro') runtime.director?.startTour();
  };

  return (
    <div className="pointer-events-auto relative">
      {open && (
        <div className="glass-strong rise-in absolute right-0 bottom-12 w-[320px] rounded-2xl p-4">
          <div className="flex items-center justify-between">
            <div className="eyebrow flex items-center gap-1.5">
              <FlaskConical size={12} /> Deterministic scenarios
            </div>
            <button className="icon-btn !h-7 !w-7" onClick={() => setOpen(false)} aria-label="Close settings">
              <X size={13} />
            </button>
          </div>
          <div className="mt-2.5 space-y-1.5">
            {SCENARIO_ORDER.map((id) => (
              <button
                key={id}
                onClick={() => pick(id)}
                className={`w-full rounded-xl border px-3 py-2 text-left transition-colors ${scenarioId === id ? 'border-route/50 bg-route/10' : 'border-line bg-white/45 hover:bg-white/85'}`}
              >
                <div className="text-[12.5px] font-semibold">
                  <span className="mr-1.5 font-mono text-scan">{id}</span>
                  {SCENARIOS[id].title}
                </div>
                <div className="text-[10.5px] leading-snug text-text-3">{SCENARIOS[id].summary}</div>
              </button>
            ))}
          </div>
          <div className="mt-4">
            <label className="flex items-center justify-between text-[11.5px] text-text-2" htmlFor="req-width">
              <span className="flex items-center gap-1.5">
                <Gauge size={12} /> Required clear width
              </span>
              <span className="font-mono text-text-1">{required.toFixed(2)} m</span>
            </label>
            <input
              id="req-width"
              type="range"
              min={0.6}
              max={1.4}
              step={0.01}
              value={required}
              onChange={(e) => useThreshold.getState().setRequiredWidth(Number(e.target.value))}
              className="mt-2 w-full accent-[#38d6f5]"
            />
            <p className="mt-1 text-[10px] leading-snug text-text-3">
              Set per household. Wheelchairs, users and local codes differ; 0.90 m is this demo’s configured default, not a universal standard.
            </p>
          </div>
          <div className="mt-3 space-y-2 text-[11.5px] text-text-2">
            <label className="flex items-center justify-between">
              Auto-advance (performs the relocation)
              <input type="checkbox" checked={autoplay} onChange={(e) => useThreshold.setState({ autoplay: e.target.checked })} />
            </label>
            <label className="flex items-center justify-between">
              Reduced motion
              <input type="checkbox" checked={reduced} onChange={(e) => useThreshold.setState({ reducedMotion: e.target.checked })} />
            </label>
          </div>
        </div>
      )}
      <button
        className="glass-strong flex h-11 items-center gap-2 rounded-2xl px-3.5 text-[12px] font-medium text-text-1 transition-transform hover:-translate-y-px"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
      >
        <SlidersHorizontal size={15} /> Scenario {scenarioId}
      </button>
    </div>
  );
}
