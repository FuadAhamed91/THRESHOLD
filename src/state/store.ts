import { create } from 'zustand';
import { subscribeWithSelector } from 'zustand/middleware';
import { SCENARIOS, type ScenarioId } from '../config/scenarios';
import { placementForEvent } from '../features/delivery/placement';
import { INITIAL_CAREGIVER, raise, transition, type CaregiverState } from '../features/notifications/caregiver';
import { DEFAULT_LAYOUT } from '../geometry/coordinateSystem';
import type { AnalysisResult, ParcelPose, Placement, PlacementSource } from '../geometry/types';
import type { BackendConnection, IntegrationStatus, NormalizedRingEvent } from '../integrations/ring/types';
import type { ShotId } from '../scene/camera/shots';

export type Phase = 'loading' | 'intro' | 'delivery' | 'reveal' | 'consequence' | 'resolve' | 'finale' | 'explore';

export const ACT_OF: Record<Phase, number> = {
  loading: 0,
  intro: 0,
  delivery: 1,
  reveal: 2,
  consequence: 3,
  resolve: 4,
  finale: 4,
  explore: 0,
};

export interface Layers {
  overlays: boolean;
  grid: boolean;
  search: boolean;
  labels: boolean;
}

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'warning' | 'error';
}

interface ThresholdState {
  // world (inputs to the geometry engine)
  scenarioId: ScenarioId;
  parcel: ParcelPose;
  placement: Placement;
  provenance: string;
  requiredClearWidth: number;
  parcelVisible: boolean;
  analysis: AnalysisResult | null;

  // experience
  phase: Phase;
  tourActive: boolean;
  paused: boolean;
  cameraMode: 'cinematic' | 'manual';
  shot: ShotId | null;
  layers: Layers;
  cutaway: boolean;
  parcelSelected: boolean;
  dragging: boolean;
  reducedMotion: boolean;
  autoplay: boolean;
  loadProgress: number;
  sceneReady: boolean;
  webglError: string | null;
  fallbackScene: boolean;

  // integration
  connection: BackendConnection;
  integration: IntegrationStatus | null;
  activeEvent: NormalizedRingEvent | null;
  eventLog: NormalizedRingEvent[];
  cameraView: string | null;
  cameraViewKind: 'simulated-render' | 'ring-snapshot' | null;

  // caregiver
  caregiver: CaregiverState;
  toasts: Toast[];

  // actions
  setParcel(pose: ParcelPose, source?: PlacementSource): void;
  resetParcel(): void;
  confirmPlacement(): void;
  loadScenario(id: ScenarioId): void;
  setRequiredWidth(w: number): void;
  setAnalysis(a: AnalysisResult): void;
  setPhase(p: Phase): void;
  set<K extends keyof ThresholdState>(key: K, value: ThresholdState[K]): void;
  toggleLayer(k: keyof Layers): void;
  receiveEvent(e: NormalizedRingEvent): void;
  raiseCaregiver(reason: string): void;
  caregiverAction(a: 'review' | 'confirm' | 'dismiss' | 'resolve', detail?: string): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
}

const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
const params = typeof window !== 'undefined' ? new URLSearchParams(window.location.search) : new URLSearchParams();
const initialScenario = (['A', 'B', 'C'].includes(params.get('scenario') ?? '') ? params.get('scenario') : 'A') as ScenarioId;

let toastId = 1;

export const useThreshold = create<ThresholdState>()(
  subscribeWithSelector((set, get) => ({
    scenarioId: initialScenario,
    parcel: SCENARIOS[initialScenario].parcel,
    placement: SCENARIOS[initialScenario].placement,
    provenance: placementForEvent(null, initialScenario).provenance,
    requiredClearWidth: DEFAULT_LAYOUT.requiredClearWidth,
    parcelVisible: false,
    analysis: null,

    phase: 'loading',
    tourActive: false,
    paused: false,
    cameraMode: 'cinematic',
    shot: 'hero',
    layers: { overlays: true, grid: true, search: false, labels: true },
    cutaway: false,
    parcelSelected: false,
    dragging: false,
    reducedMotion: !!prefersReducedMotion,
    autoplay: params.get('autoplay') !== '0',
    loadProgress: 0,
    sceneReady: false,
    webglError: null,
    fallbackScene: false,

    connection: 'connecting',
    integration: null,
    activeEvent: null,
    eventLog: [],
    cameraView: null,
    cameraViewKind: null,

    caregiver: INITIAL_CAREGIVER,
    toasts: [],

    setParcel(pose, source) {
      const placement: Placement = source
        ? { source, uncertaintyRadius: source === 'user_confirmed' ? 0.05 : source === 'user_adjusted' ? 0.05 : get().placement.uncertaintyRadius }
        : get().placement;
      set({ parcel: pose, placement, provenance: source ? describePlacement(placement) : get().provenance });
    },
    resetParcel() {
      const { activeEvent, scenarioId } = get();
      const est = placementForEvent(activeEvent, scenarioId);
      set({ parcel: est.pose, placement: est.placement, provenance: est.provenance });
    },
    confirmPlacement() {
      const placement: Placement = { source: 'user_confirmed', uncertaintyRadius: 0.05 };
      set({ placement, provenance: describePlacement(placement) });
    },
    loadScenario(id) {
      const s = SCENARIOS[id];
      set({
        scenarioId: id,
        parcel: s.parcel,
        placement: s.placement,
        provenance: placementForEvent(null, id).provenance,
        caregiver: INITIAL_CAREGIVER,
      });
    },
    setRequiredWidth(w) {
      set({ requiredClearWidth: Math.round(w * 100) / 100 });
    },
    setAnalysis(a) {
      set({ analysis: a });
    },
    setPhase(p) {
      set({ phase: p });
    },
    set(key, value) {
      set({ [key]: value } as Partial<ThresholdState>);
    },
    toggleLayer(k) {
      set({ layers: { ...get().layers, [k]: !get().layers[k] } });
    },
    receiveEvent(e) {
      set({ eventLog: [e, ...get().eventLog.filter((x) => x.id !== e.id)].slice(0, 30) });
    },
    raiseCaregiver(reason) {
      set({ caregiver: raise(get().caregiver, reason) });
    },
    caregiverAction(a, detail = '') {
      set({ caregiver: transition(get().caregiver, a, detail) });
    },
    toast(text, tone = 'info') {
      const id = toastId++;
      set({ toasts: [...get().toasts.slice(-3), { id, text, tone }] });
      setTimeout(() => get().dismissToast(id), 4200);
    },
    dismissToast(id) {
      set({ toasts: get().toasts.filter((t) => t.id !== id) });
    },
  })),
);

function describePlacement(p: Placement): string {
  switch (p.source) {
    case 'user_confirmed':
      return 'Position confirmed by a person on the 3D model.';
    case 'user_adjusted':
      return 'Position adjusted on the model (not yet confirmed against the real entrance).';
    case 'estimated_prior':
      return `Estimated from the courier-drop prior (±${p.uncertaintyRadius.toFixed(2)} m).`;
    default:
      return 'Simulated scenario position · not a camera measurement.';
  }
}
