import { Clapperboard, Hand, Pause, Play, RotateCcw, SkipForward } from 'lucide-react';
import { runtime } from '../app/runtime';
import { ACT_OF, useThreshold } from '../state/store';

const ACTS = [
  { n: 'I', title: 'The delivery' },
  { n: 'II', title: 'Reveal the obstruction' },
  { n: 'III', title: 'Compute the consequence' },
  { n: 'IV', title: 'Resolve it' },
];

/** Act progress plus play / pause / skip / replay. */
export function ActTimeline() {
  const phase = useThreshold((s) => s.phase);
  const tourActive = useThreshold((s) => s.tourActive);
  const paused = useThreshold((s) => s.paused);
  const cameraMode = useThreshold((s) => s.cameraMode);
  if (phase === 'loading' || phase === 'intro') return null;
  const act = ACT_OF[phase];
  const d = runtime.director;

  if (phase === 'explore') {
    return (
      <button className="glass-strong pointer-events-auto flex h-[52px] items-center gap-2 rounded-2xl px-4 text-[12.5px] font-medium text-text-1" onClick={() => d?.startTour()} title="Replay (R)">
        <RotateCcw size={15} /> Replay the cinematic
      </button>
    );
  }

  return (
    <div className="glass-strong pointer-events-auto flex items-center gap-3 rounded-2xl px-3 py-2.5">
      <div className="hidden items-center gap-1 sm:flex">
        {ACTS.map((a, i) => {
          const idx = i + 1;
          const state = idx < act || phase === 'finale' ? 'done' : idx === act ? 'active' : 'todo';
          return (
            <div key={a.n} className="flex items-center gap-1">
              <div
                className={`flex items-center gap-2 rounded-xl px-2.5 py-1.5 transition-colors ${state === 'active' ? 'bg-route/10 text-text-1' : state === 'done' ? 'text-text-2' : 'text-text-3'}`}
                aria-current={state === 'active' ? 'step' : undefined}
              >
                <span
                  className={`grid h-5 min-w-5 place-items-center rounded-md px-1 font-mono text-[10px] font-semibold ${
                    state === 'active' ? 'bg-route text-white' : state === 'done' ? 'bg-black/10 text-text-1' : 'bg-black/5'
                  }`}
                >
                  {a.n}
                </span>
                <span className="hidden text-[11.5px] font-medium lg:inline">{a.title}</span>
              </div>
              {i < ACTS.length - 1 && <span className="h-px w-3 bg-black/10" />}
            </div>
          );
        })}
      </div>
      <div className="h-6 w-px bg-black/10" />
      <div className="flex items-center gap-1.5">
        {tourActive ? (
          <button className="icon-btn" onClick={() => (paused ? d?.resume() : d?.pause())} aria-label={paused ? 'Resume' : 'Pause'} title={paused ? 'Resume (Space)' : 'Pause (Space)'}>
            {paused ? <Play size={15} /> : <Pause size={15} />}
          </button>
        ) : (
          <button className="icon-btn" onClick={() => d?.startTour()} aria-label="Replay the experience" title="Replay (R)">
            <RotateCcw size={15} />
          </button>
        )}
        {tourActive && (
          <button className="icon-btn" onClick={() => d?.enterExplore()} aria-label="Skip to interactive mode" title="Skip to explore (Esc)">
            <SkipForward size={15} />
          </button>
        )}
        {tourActive && cameraMode === 'manual' && (
          <button className="btn btn-ghost !px-2.5 !py-1.5 text-[11px]" onClick={() => d?.resumeCinematicCamera()} title="Hand the camera back to the director">
            <Clapperboard size={13} /> Cinematic camera
          </button>
        )}
        {!tourActive && (
          <button className="btn btn-ghost !px-2.5 !py-1.5 text-[11px]" onClick={() => d?.enterExplore()}>
            <Hand size={13} /> Explore
          </button>
        )}
      </div>
    </div>
  );
}
