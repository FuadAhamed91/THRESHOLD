import { useEffect } from 'react';
import { ActTimeline } from '../components/ActTimeline';
import { AnalysisPanel } from '../components/AnalysisPanel';
import { CameraDock } from '../components/CameraDock';
import { CaregiverPanel } from '../components/CaregiverPanel';
import { ActTitle, FinaleOverlay, IntroOverlay, LoadingScreen, Toasts } from '../components/Overlays';
import { ParcelInspector } from '../components/ParcelInspector';
import { RingEventCard } from '../components/RingEventCard';
import { ScenarioDrawer } from '../components/ScenarioDrawer';
import { SceneCanvas } from '../components/SceneCanvas';
import { TopBar } from '../components/TopBar';
import { WebGLFallback } from '../components/WebGLFallback';
import { useThreshold } from '../state/store';
import { ErrorBoundary } from './ErrorBoundary';
import { runtime } from './runtime';

function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest?.('input, textarea, select')) return;
      const d = runtime.director;
      const s = useThreshold.getState();
      if (!d || !s.sceneReady) return;
      if (e.code === 'Space' && s.tourActive) {
        e.preventDefault();
        if (s.paused) d.resume();
        else d.pause();
      } else if (e.key === 'Escape' && s.tourActive) {
        d.enterExplore();
      } else if ((e.key === 'r' || e.key === 'R') && !s.parcelSelected) {
        d.startTour();
      } else if ((e.key === 'c' || e.key === 'C') && s.phase === 'explore') {
        const v = !s.cutaway;
        useThreshold.setState({ cutaway: v });
        runtime.exp?.cutaway.animateTo(v ? 1 : 0, 1.6);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  useKeyboardShortcuts();
  const fallback = useThreshold((s) => s.fallbackScene);
  return (
    <ErrorBoundary>
      <main className="relative h-full w-full overflow-hidden bg-ink-950">
        <SceneCanvas />
        <TopBar />
        <IntroOverlay />
        <ActTitle />
        <FinaleOverlay />

        <div className="pointer-events-none absolute top-24 left-4 z-20 flex flex-col gap-3 md:left-5">
          <div className="pointer-events-auto">
            <RingEventCard />
          </div>
          <div className="pointer-events-auto">
            <CaregiverPanel />
          </div>
        </div>
        <div className="pointer-events-none absolute bottom-24 left-4 z-20 md:left-5">
          <div className="pointer-events-auto">
            <ParcelInspector />
          </div>
        </div>

        <div className="pointer-events-none absolute top-24 right-4 bottom-24 z-20 flex flex-col items-end gap-3 overflow-y-auto md:right-5 [scrollbar-width:none]">
          <div className="pointer-events-auto">
            <AnalysisPanel />
          </div>
        </div>

        <div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex flex-wrap items-end justify-center gap-3 px-4">
          <ActTimeline />
          <CameraDock />
        </div>
        <div className="absolute right-4 bottom-4 z-30 md:right-5">
          <ScenarioDrawer />
        </div>
        {fallback && (
          <div className="absolute bottom-20 left-4 z-30 rounded-lg bg-caution/15 px-3 py-1.5 text-[11px] text-caution">
            Blender model unavailable: showing a procedural massing model of the same calibrated layout.
          </div>
        )}
        <Toasts />
        <LoadingScreen />
        <WebGLFallback />
      </main>
    </ErrorBoundary>
  );
}
