import { ArrowRight, Hand, Play, RotateCcw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { runtime } from '../app/runtime';
import { SCENARIOS } from '../config/scenarios';
import { useThreshold, type Phase } from '../state/store';
import { Wordmark } from './Wordmark';

export function LoadingScreen() {
  const progress = useThreshold((s) => s.loadProgress);
  const ready = useThreshold((s) => s.sceneReady);
  const error = useThreshold((s) => s.webglError);
  if (ready || error) return null;
  return (
    <div className="absolute inset-0 z-50 grid place-items-center bg-cream-100">
      <div className="flex flex-col items-center gap-6">
        <Wordmark size={30} />
        <div className="h-[3px] w-56 overflow-hidden rounded-full bg-black/10">
          <div className="h-full rounded-full bg-gradient-to-r from-route to-scan transition-[width] duration-300" style={{ width: `${Math.max(4, progress * 100)}%` }} />
        </div>
        <div className="text-[11px] tracking-[0.2em] text-text-3 uppercase">
          {progress < 0.9 ? 'Loading calibrated entrance model' : 'Preparing lighting and materials'}
        </div>
      </div>
    </div>
  );
}

/** Opening composition: title card over the hero view of the entrance. */
export function IntroOverlay() {
  const phase = useThreshold((s) => s.phase);
  const scenarioId = useThreshold((s) => s.scenarioId);
  if (phase !== 'intro') return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center">
      <div className="absolute inset-0 bg-gradient-to-r from-black/45 via-black/10 to-transparent" />
      <div className="glass-strong rise-in pointer-events-auto relative ml-6 max-w-[34rem] rounded-3xl px-9 py-9 md:ml-14">
        <Wordmark size={40} />
        <h1 className="mt-6 text-[28px] leading-tight font-light tracking-tight text-text-1 md:text-[34px]">
          When a delivery
          <br />
          becomes an obstacle.
        </h1>
        <p className="mt-4 text-[14px] leading-relaxed text-text-2">
          THRESHOLD turns a Ring package-delivery event into a spatial analysis of an accessible entrance: door swing, route obstruction, measured clearance
          and a verified wheelchair route, computed from a calibrated 3D model.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button className="btn btn-primary !px-5 !py-3 text-[14px]" onClick={() => runtime.director?.startTour()} autoFocus>
            <Play size={16} /> Begin the experience
          </button>
          <button className="btn btn-ghost !px-4 !py-3 text-[13px]" onClick={() => runtime.director?.enterExplore()}>
            <Hand size={15} /> Explore freely
          </button>
        </div>
        <div className="mt-6 border-t border-line pt-4 text-[11.5px] text-text-3">
          Scenario {scenarioId}: {SCENARIOS[scenarioId].title.toLowerCase()} · simulated unless a Ring integration is configured
        </div>
      </div>
    </div>
  );
}

const TITLES: Partial<Record<Phase, { n: string; title: string; line: string }>> = {
  delivery: { n: 'I', title: 'The delivery', line: 'A Ring package event arrives. The parcel is placed in the 3D scene.' },
  reveal: { n: 'II', title: 'Reveal the obstruction', line: 'Walls dissolve. Door swing, route and drop zone are analysed in plan.' },
  consequence: { n: 'III', title: 'Compute the consequence', line: 'A clearance-constrained search finds — or fails to find — a route.' },
  resolve: { n: 'IV', title: 'Resolve it', line: 'Move the parcel to the safe drop zone; everything is recomputed.' },
};

/** Cinematic lower-third that introduces each act. */
export function ActTitle() {
  const phase = useThreshold((s) => s.phase);
  const tourActive = useThreshold((s) => s.tourActive);
  const [shown, setShown] = useState<Phase | null>(null);
  useEffect(() => {
    if (!tourActive || !TITLES[phase]) {
      setShown(null);
      return;
    }
    setShown(phase);
    const t = setTimeout(() => setShown(null), 4200);
    return () => clearTimeout(t);
  }, [phase, tourActive]);
  const t = shown ? TITLES[shown] : null;
  if (!t) return null;
  return (
    <div key={shown} className="glass-strong rise-in pointer-events-none absolute top-6 left-1/2 z-20 -translate-x-1/2 rounded-2xl px-6 py-3 text-center">
      <div className="font-mono text-[10.5px] font-semibold tracking-[0.3em] text-route">ACT {t.n}</div>
      <div className="mt-0.5 text-[20px] font-light tracking-tight text-text-1">{t.title}</div>
      <div className="mt-0.5 text-[12px] text-text-2">{t.line}</div>
    </div>
  );
}

export function FinaleOverlay() {
  const phase = useThreshold((s) => s.phase);
  const analysis = useThreshold((s) => s.analysis);
  if (phase !== 'finale') return null;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center">
      <div className="glass-strong relative rounded-3xl px-12 py-10 text-center" style={{ animation: 'rise-in 1.2s var(--ease-cine) 1.6s both' }}>
        <Wordmark size={40} />
        <p className="mt-5 text-[22px] leading-snug font-light text-text-1 md:text-[26px]">
          More than a delivery.
          <br />A safer, more accessible home.
        </p>
        {analysis?.status === 'clear' && (
          <p className="mt-3 font-mono text-[12px] text-clear">
            route verified · {analysis.clearance.width.toFixed(2)} m clear · door opens {Math.round((analysis.door.maxOpening * 180) / Math.PI)}°
          </p>
        )}
        <div className="pointer-events-auto mt-7 flex justify-center gap-3">
          <button className="btn btn-primary !px-5 !py-2.5" onClick={() => runtime.director?.startTour()}>
            <RotateCcw size={15} /> Replay
          </button>
          <button className="btn btn-ghost !px-5 !py-2.5" onClick={() => runtime.director?.enterExplore()}>
            Explore the model <ArrowRight size={15} />
          </button>
        </div>
      </div>
    </div>
  );
}

export function Toasts() {
  const toasts = useThreshold((s) => s.toasts);
  return (
    <div className="pointer-events-none absolute top-20 left-1/2 z-40 flex -translate-x-1/2 flex-col items-center gap-2" aria-live="polite">
      {toasts.map((t) => (
        <div
          key={t.id}
          className={`glass-strong rise-in rounded-xl px-3.5 py-2 text-[12px] ${
            t.tone === 'success' ? 'text-clear' : t.tone === 'warning' ? 'text-caution' : t.tone === 'error' ? 'text-conflict' : 'text-text-1'
          }`}
        >
          {t.text}
        </div>
      ))}
    </div>
  );
}
