import { useEffect, useRef } from 'react';
import { Director } from '../animation/director';
import { runtime } from '../app/runtime';
import { AnalysisService, SupersededError } from '../features/analysis/analysisService';
import { connectRingStream } from '../integrations/ring/client';
import { describeSource } from '../integrations/ring/normalize';
import { Experience } from '../scene/Experience';
import { useThreshold } from '../state/store';

function webglAvailable(): boolean {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    // Release the probe context immediately; browsers cap live contexts.
    gl?.getExtension('WEBGL_lose_context')?.loseContext();
    return !!gl;
  } catch {
    return false;
  }
}

const INTERACTIVE_PHASES = new Set(['explore', 'resolve', 'finale']);

/**
 * Mounts the Three.js experience and connects it to application state:
 * parcel pose → geometry engine (worker) → overlays, plus Ring events.
 */
export function SceneCanvas() {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const container = ref.current;
    if (!container) return;
    const store = useThreshold;
    if (!webglAvailable()) {
      store.setState({ webglError: 'WebGL 2 is not available in this browser.' });
      return;
    }

    const service = new AnalysisService();
    runtime.analysis = service;
    let exp: Experience;
    try {
      exp = new Experience(
        container,
        {
          onProgress: (p) => store.setState({ loadProgress: p }),
          onParcelPose: (pose, phase) => {
            if (phase === 'start') store.setState({ dragging: true });
            store.getState().setParcel(pose, 'user_adjusted');
            if (phase === 'end') store.setState({ dragging: false });
          },
          onParcelSelect: (selected) => store.setState({ parcelSelected: selected }),
          onUserCamera: () => store.setState({ cameraMode: 'manual', shot: null }),
          canInteract: () => INTERACTIVE_PHASES.has(store.getState().phase),
          onContextLost: (lost) =>
            store.getState().toast(lost ? 'The graphics context was reset by the GPU. Restoring…' : 'Graphics restored.', lost ? 'warning' : 'success'),
        },
        store.getState().reducedMotion ? 'balanced' : 'high',
      );
    } catch (err) {
      store.setState({ webglError: err instanceof Error ? err.message : 'Could not create a WebGL renderer.' });
      return;
    }
    runtime.exp = exp;
    const director = new Director(exp);
    runtime.director = director;

    // Geometry engine: recompute whenever an input changes (latest wins).
    const requestAnalysis = () => {
      const s = store.getState();
      service
        .analyze({ parcel: s.parcel, placement: s.placement, requiredClearWidth: s.requiredClearWidth })
        .then((a) => store.getState().setAnalysis(a))
        .catch((e) => {
          if (!(e instanceof SupersededError)) console.error('[analysis]', e);
        });
    };
    const unsubs = [
      store.subscribe((s) => [s.parcel, s.placement, s.requiredClearWidth] as const, requestAnalysis, {
        equalityFn: (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2],
      }),
      store.subscribe(
        (s) => s.analysis,
        (a) => {
          if (a && runtime.exp?.overlays) runtime.exp.applyAnalysis(a);
        },
      ),
      store.subscribe(
        (s) => s.parcel,
        (pose) => {
          const p = runtime.exp?.parcel;
          if (!p || p.isDragging) return;
          const c = p.current;
          if (c.center.x !== pose.center.x || c.center.z !== pose.center.z || c.yaw !== pose.yaw) p.setPose(pose);
        },
      ),
      store.subscribe(
        (s) => s.parcelSelected,
        (sel) => runtime.exp?.parcel?.setSelected(sel),
      ),
      store.subscribe(
        (s) => s.layers,
        () => {
          if (store.getState().phase === 'explore') director.applyLayers();
        },
      ),
    ];

    let alive = true;
    exp
      .init(store.getState().parcel)
      .then(() => {
        if (!alive) return;
        store.setState({ sceneReady: true, phase: 'intro', fallbackScene: exp.assets.fallback });
        exp.rig.driftAmount = store.getState().reducedMotion ? 0 : 0.8;
        requestAnalysis();
        if (new URLSearchParams(window.location.search).get('autostart') === '1') director.startTour();
      })
      .catch((err) => {
        if (!alive) return;
        console.error(err);
        store.setState({ webglError: 'The 3D scene failed to initialise. ' + (err instanceof Error ? err.message : '') });
      });

    const disconnect = connectRingStream({
      onConnection: (connection) => store.setState({ connection }),
      onStatus: (integration) => store.setState({ integration }),
      onEvent: (event) => {
        store.getState().receiveEvent(event);
        if (event.simulated) return; // simulations are started by the director itself
        store.getState().toast(`Ring event received: ${event.ringSubType ?? event.ringEventType} · ${describeSource(event)}`, 'info');
        if (event.kind === 'package_delivery' && store.getState().sceneReady && !director.isRunning) director.startTour(event);
      },
    });

    return () => {
      alive = false;
      disconnect();
      unsubs.forEach((u) => u());
      exp.dispose();
      service.dispose();
      runtime.exp = null;
      runtime.director = null;
      runtime.analysis = null;
    };
  }, []);

  return <div ref={ref} className="absolute inset-0" aria-label="Interactive 3D model of the front entrance" role="application" />;
}
