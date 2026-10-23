import gsap from 'gsap';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '@fontsource-variable/jost';
import '@fontsource-variable/jetbrains-mono';
import './index.css';
import { App } from './app/App';
import { runtime } from './app/runtime';
import { useThreshold } from './state/store';

if (import.meta.env.DEV) {
  // Debug/QA hook for scripts/capture.mjs and scripts/tour-perf.mjs (dev builds only).
  (window as unknown as Record<string, unknown>).__THRESHOLD__ = { useThreshold, runtime };
}

// Keep the cinematic on wall-clock time: dropped frames skip ahead instead of
// slowing the whole sequence down. `?speed=2` speeds everything up (testing).
gsap.ticker.lagSmoothing(0);
const speed = Number(new URLSearchParams(window.location.search).get('speed'));
if (speed > 0) gsap.globalTimeline.timeScale(speed);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
