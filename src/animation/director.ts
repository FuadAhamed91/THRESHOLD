import gsap from 'gsap';
import { SCENARIOS } from '../config/scenarios';
import { AnalysisService } from '../features/analysis/analysisService';
import { placementForEvent } from '../features/delivery/placement';
import { analyzeEntrance } from '../geometry/analyze';
import { DEFAULT_MODEL } from '../geometry/entranceModel';
import type { AnalysisResult, Vec2 } from '../geometry/types';
import { requestServerSimulation } from '../integrations/ring/client';
import type { NormalizedRingEvent } from '../integrations/ring/types';
import { createSimulatedEvent } from '../integrations/simulation/simulatedEvents';
import { overlayUniforms } from '../scene/overlays/materials';
import { SHOTS, type ShotId } from '../scene/camera/shots';
import type { Experience } from '../scene/Experience';
import { useThreshold, type Phase } from '../state/store';

class Cancelled extends Error {}

const S = () => useThreshold.getState();
const fmt = (n: number) => n.toFixed(2);

function samePose(a: AnalysisResult, s = S()): boolean {
  const p = a.parcel;
  const q = s.parcel;
  if (!p || !q) return !p && !q;
  return (
    Math.abs(p.center.x - q.center.x) < 1e-9 &&
    Math.abs(p.center.z - q.center.z) < 1e-9 &&
    Math.abs(p.yaw - q.yaw) < 1e-9 &&
    a.placement.source === s.placement.source &&
    Math.abs(a.clearance.required - s.requiredClearWidth) < 1e-9
  );
}

/**
 * Four-act cinematic state machine. Every visual beat is gated on the
 * geometry engine's actual result for the current parcel pose: the director
 * dramatises the analysis, it never invents it. All timing runs on GSAP, so
 * pausing the global timeline pauses the whole experience.
 */
export class Director {
  private token = 0;
  private running = false;

  constructor(private readonly exp: Experience) {}

  private get reduced(): boolean {
    return S().reducedMotion;
  }

  private d(seconds: number): number {
    return this.reduced ? Math.min(seconds, 0.35) : seconds;
  }

  private wait(seconds: number, token: number): Promise<void> {
    return new Promise((resolve, reject) => {
      gsap.delayedCall(this.d(seconds), () => (token === this.token ? resolve() : reject(new Cancelled())));
    });
  }

  private check(token: number): void {
    if (token !== this.token) throw new Cancelled();
  }

  private setPhase(p: Phase): void {
    this.trace(`phase ${p}`);
    S().setPhase(p);
  }

  private trace(msg: string): void {
    if (import.meta.env.DEV) console.debug(`[director] ${(performance.now() / 1000).toFixed(1)}s ${msg}`);
  }

  /** Await the analysis that matches the current inputs (worker), with a synchronous fallback. */
  async currentAnalysis(timeoutMs = 1500): Promise<AnalysisResult> {
    const existing = S().analysis;
    if (existing && samePose(existing)) return existing;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsub();
        const s = S();
        const r = AnalysisService.analyzeNow(s.parcel, s.placement, s.requiredClearWidth);
        s.setAnalysis(r);
        resolve(r);
      }, timeoutMs);
      const unsub = useThreshold.subscribe(
        (st) => st.analysis,
        (a) => {
          if (a && samePose(a)) {
            clearTimeout(timer);
            unsub();
            resolve(a);
          }
        },
      );
    });
  }

  /** Camera beats are skipped once the user has taken manual control. */
  private flyTo(id: ShotId, duration: number, token: number): Promise<void> {
    if (S().cameraMode === 'manual') return Promise.resolve();
    S().set('shot', id);
    return this.exp.flyTo(id, this.d(duration)).then(() => this.check(token));
  }

  private follow(): void {
    if (S().cameraMode === 'manual') return;
    this.exp.followAvatar();
    S().set('shot', null);
  }

  /** Give the camera back to the cinematic director. */
  resumeCinematicCamera(): void {
    S().set('cameraMode', 'cinematic');
    if (this.running && S().phase !== 'explore') this.exp.flyTo('analysis', this.d(2));
  }

  // ── public controls ─────────────────────────────────────────────────────

  get isRunning(): boolean {
    return this.running;
  }

  async startTour(event?: NormalizedRingEvent): Promise<void> {
    const token = ++this.token;
    this.running = true;
    gsap.globalTimeline.resume();
    S().set('paused', false);
    S().set('tourActive', true);
    try {
      this.resetStage();
      await this.actDelivery(token, event);
      await this.actReveal(token);
      const arrived = await this.actConsequence(token);
      if (!arrived) await this.actResolve(token);
    } catch (err) {
      if (!(err instanceof Cancelled)) {
        console.error('[director]', err);
        S().toast('The cinematic sequence stopped unexpectedly. Explore mode is still available.', 'warning');
        this.enterExplore();
      }
    } finally {
      if (token === this.token) {
        this.running = false;
        S().set('tourActive', false);
      }
    }
  }

  pause(): void {
    gsap.globalTimeline.pause();
    S().set('paused', true);
  }

  resume(): void {
    gsap.globalTimeline.resume();
    S().set('paused', false);
  }

  /** Stop the cinematic and hand the user full control with the analysis visible. */
  enterExplore(): void {
    this.token++;
    this.running = false;
    gsap.globalTimeline.resume();
    const { exp } = this;
    exp.rig.stop();
    exp.rig.driftAmount = 0;
    S().set('paused', false);
    S().set('tourActive', false);
    S().set('parcelVisible', true);
    S().set('cameraMode', 'manual');
    this.setPhase('explore');
    exp.overlays.showLabels(['parcel', 'door', 'pinch', 'safe', 'unc']);
    exp.parcel.setVisible(true);
    exp.parcel.setPose(S().parcel);
    exp.observation.fadeTo(0, 0.4);
    if (exp.avatar.fade > 0.5 && !S().analysis?.path.found) exp.avatar.fadeTo(0, 0.6);
    exp.door.close(0.8);
    exp.overlays.setPathProgress(1);
    exp.overlays.setSearchProgress(1);
    this.applyLayers();
    if (!S().cutaway) {
      S().set('cutaway', true);
      exp.cutaway.animateTo(1, this.d(1.6));
      exp.lights.setArchitecturalLevel(0.8);
    }
  }

  replay(): void {
    this.startTour();
  }

  /** Overlay visibility in explore mode follows the layer toggles. */
  applyLayers(): void {
    const { layers, analysis, placement } = S();
    const o = this.exp.overlays;
    const on = layers.overlays ? 1 : 0;
    o.fadeTo('corridor', on, 0.5);
    o.fadeTo('safe', on, 0.5);
    o.fadeTo('door', on, 0.5);
    o.fadeTo('parcel', on, 0.5);
    o.fadeTo('intrusion', on, 0.5);
    o.fadeTo('route', on, 0.5);
    o.fadeTo('clearance', on, 0.5);
    o.fadeTo('markers', on * 0.9, 0.5);
    o.fadeTo('grid', layers.grid && layers.overlays ? 0.7 : 0, 0.5);
    o.fadeTo('search', layers.search && layers.overlays ? 0.6 : 0, 0.5);
    o.fadeTo('uncertainty', on && placement.uncertaintyRadius > 0.08 && analysis?.uncertainty.evaluated ? 1 : 0, 0.5);
    o.setLabelsVisible(layers.labels);
  }

  private resetStage(): void {
    const { exp } = this;
    gsap.killTweensOf(overlayUniforms.uScanZ);
    exp.rig.stop();
    exp.overlays.setAll(0);
    exp.overlays.setPathProgress(0);
    exp.overlays.setSearchProgress(0);
    exp.cutaway.set(0);
    exp.lights.setArchitecturalLevel(1);
    exp.door.set(0);
    exp.avatar.setFade(0);
    exp.avatar.setTone('neutral', 0);
    exp.observation.set(0);
    exp.overlays.showLabels(['parcel', 'unc']);
    exp.parcel.setVisible(false);
    exp.parcel.setSelected(false);
    S().set('parcelSelected', false);
    S().set('cutaway', false);
    S().set('parcelVisible', false);
    S().set('cameraView', null);
    S().set('cameraViewKind', null);
    S().set('caregiver', { status: 'idle', raisedAt: null, reason: null, log: [] });
    exp.rig.jumpTo(SHOTS.hero);
  }

  // ── ACT I · The delivery ────────────────────────────────────────────────

  private async obtainEvent(given?: NormalizedRingEvent): Promise<NormalizedRingEvent> {
    if (given) return given;
    const { scenarioId, connection } = S();
    if (connection === 'online') {
      try {
        const e = await requestServerSimulation(scenarioId);
        if (e) return e;
      } catch {
        /* fall back to the local simulation */
      }
    }
    return createSimulatedEvent(scenarioId);
  }

  private async actDelivery(token: number, given?: NormalizedRingEvent): Promise<void> {
    const { exp } = this;
    this.setPhase('delivery');
    exp.rig.driftAmount = 0.6;
    await this.wait(0.8, token);
    const event = await this.obtainEvent(given);
    this.check(token);
    const est = placementForEvent(event, S().scenarioId);
    useThreshold.setState({ activeEvent: event, parcel: est.pose, placement: est.placement, provenance: est.provenance });
    S().receiveEvent(event);
    exp.parcel.setPose(est.pose);
    await this.wait(1.1, token);

    S().set('parcelVisible', true);
    await new Promise<void>((res) => exp.parcel.dropIn(this.d(0.9)).eventCallback('onComplete', () => res()));
    this.check(token);
    const time = new Date(event.occurredAt);
    const view = await exp.renderCameraView({
      title: 'FRONT DOOR',
      time: time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      footer: event.simulated ? 'SIMULATED VIEW · RENDERED FROM 3D MODEL' : 'RENDERED FROM 3D MODEL · NOT A CAMERA FRAME',
    });
    useThreshold.setState({ cameraView: view, cameraViewKind: 'simulated-render' });

    const result = await this.currentAnalysis();
    this.check(token);
    exp.applyAnalysis(result);
    exp.observation.setTarget(result.parcelFootprint);
    exp.observation.fadeTo(1, this.d(0.9));
    exp.overlays.fadeTo('parcel', 1, this.d(0.8), this.d(0.5));
    if (result.placement.uncertaintyRadius > 0.08) exp.overlays.fadeTo('uncertainty', 1, this.d(0.8), this.d(0.9));
    exp.rig.driftAmount = 0;
    await this.flyTo('delivery', 3.4, token);
    await this.wait(1.4, token);
  }

  // ── ACT II · Reveal the obstruction ─────────────────────────────────────

  private async actReveal(token: number): Promise<void> {
    const { exp } = this;
    this.setPhase('reveal');
    exp.overlays.showLabels(['parcel', 'unc', 'door']);
    exp.observation.fadeTo(0, this.d(1.2));
    S().set('cutaway', true);
    exp.cutaway.animateTo(1, this.d(3));
    const level = { v: 1 };
    gsap.to(level, { v: 0.72, duration: this.d(2.5), onUpdate: () => exp.lights.setArchitecturalLevel(level.v) });
    const fly = this.flyTo('analysis', 3.4, token);
    exp.overlays.fadeTo('grid', 0.75, this.d(1.2), this.d(1.0));
    overlayUniforms.uScanZ.value = 8.5;
    gsap.to(overlayUniforms.uScanZ, { value: -2, duration: this.d(3.2), delay: this.d(1.2), ease: 'power1.inOut' });
    exp.overlays.fadeTo('markers', 0.85, this.d(0.8), this.d(1.6));
    exp.overlays.fadeTo('corridor', 1, this.d(1.2), this.d(1.8));
    await fly;
    const result = await this.currentAnalysis();
    this.check(token);
    exp.applyAnalysis(result);
    exp.overlays.fadeTo('door', 1, this.d(0.8));
    await this.wait(0.7, token);
    // the real leaf sweeps to the opening the geometry engine computed
    await new Promise<void>((res) =>
      exp.door.swingTo(result.door.maxOpening, this.d(1.8), result.door.physicallyBlocked).eventCallback('onComplete', () => res()),
    );
    this.check(token);
    exp.overlays.fadeTo('intrusion', 1, this.d(0.6));
    exp.overlays.fadeTo('safe', 1, this.d(0.8), this.d(0.4));
    await this.wait(2.2, token);
  }

  // ── ACT III · Compute the consequence ───────────────────────────────────

  /** Returns true when the avatar already reached the door (nothing left to resolve). */
  private async actConsequence(token: number): Promise<boolean> {
    const { exp } = this;
    this.setPhase('consequence');
    exp.overlays.showLabels(['door', 'pinch', 'stop', 'unc']);
    const result = await this.currentAnalysis();
    this.check(token);
    exp.applyAnalysis(result);
    exp.overlays.setSearchProgress(0);
    exp.overlays.fadeTo('search', 0.9, this.d(0.4));
    const prog = { v: 0 };
    await new Promise<void>((res) =>
      gsap.to(prog, { v: 1, duration: this.d(2.8), ease: 'power1.in', onUpdate: () => exp.overlays.setSearchProgress(prog.v), onComplete: res }),
    );
    this.check(token);
    this.trace('search animated');
    exp.overlays.fadeTo('route', 1, this.d(0.3));
    exp.overlays.setPathProgress(0);
    const pp = { v: 0 };
    await new Promise<void>((res) =>
      gsap.to(pp, { v: 1, duration: this.d(1.8), ease: 'power2.inOut', onUpdate: () => exp.overlays.setPathProgress(pp.v), onComplete: res }),
    );
    this.check(token);
    exp.overlays.fadeTo('search', 0.25, this.d(1.2));
    exp.overlays.fadeTo('clearance', 1, this.d(0.8));
    await this.wait(1.2, token);

    if (result.uncertainty.verdict === 'indeterminate') {
      // No definitive conclusion: do not send the avatar on a provisional route.
      await this.flyTo('cutaway', 3, token);
      return false;
    }

    const pts = result.path.found ? result.path.points : result.path.reachable;
    if (pts.length < 2) {
      await this.flyTo('cutaway', 3, token);
      return false;
    }
    this.trace(`route drawn, avatar path ${pts.length} pts`);
    exp.avatar.setPath(pts);
    exp.avatar.setTone(result.path.found ? 'clear' : 'neutral', 0);
    exp.avatar.fadeTo(1, this.d(0.8));
    exp.overlays.fadeTo('search', 0, this.d(0.6));
    this.follow();
    await this.wait(0.9, token);
    if (result.path.found) {
      await this.driveIntoHouse(token, result, 0);
      return true;
    }
    this.trace(`driving ${exp.avatar.length.toFixed(1)} m`);
    await new Promise<void>((res) => exp.avatar.drive(0.8).eventCallback('onComplete', () => res()));
    this.check(token);
    this.trace('avatar stopped');
    exp.avatar.setTone('blocked');
    await new Promise<void>((res) => exp.avatar.bump().eventCallback('onComplete', () => res()));
    this.check(token);
    await this.wait(1.0, token);
    await this.flyTo('cutaway', 3.2, token);
    await this.wait(1.6, token);
    return false;
  }

  // ── ACT IV · Resolve it ─────────────────────────────────────────────────

  private async actResolve(token: number): Promise<void> {
    const { exp } = this;
    let result = await this.currentAnalysis();
    this.check(token);
    if (result.status === 'clear') return this.finale(token);
    this.setPhase('resolve');
    exp.overlays.showLabels(['pinch', 'safe', 'door', 'unc']);
    const reason =
      result.status === 'indeterminate'
        ? 'Parcel position is uncertain: the entrance may be obstructed.'
        : result.path.failure?.message ?? 'The accessible route may be obstructed.';
    S().raiseCaregiver(reason);
    exp.door.close(this.d(1));
    exp.overlays.fadeTo('safe', 1, 0.4);
    await this.flyTo('cutaway', 2.4, token);

    if (result.status === 'indeterminate') {
      // A real-world fact cannot be auto-confirmed: wait for a person.
      await this.waitFor(token, () => S().placement.source === 'user_confirmed' || S().placement.source === 'user_adjusted');
      result = await this.currentAnalysis();
      this.check(token);
      exp.overlays.fadeTo('uncertainty', 0, 0.6);
      if (result.status === 'clear') return this.finale(token);
    }

    if (S().autoplay) {
      const moved = this.waitFor(token, () => S().dragging || S().analysis?.status === 'clear');
      await Promise.race([moved, this.wait(5, token)]);
      if (!S().dragging && S().analysis?.status !== 'clear') await this.moveParcelToSafeZone();
    }
    await this.waitFor(token, () => !S().dragging && S().analysis?.status === 'clear' && samePose(S().analysis!));
    this.check(token);
    result = await this.currentAnalysis();
    S().caregiverAction('resolve', `Route verified clear: ${fmt(result.clearance.width)} m ≥ ${fmt(result.clearance.required)} m, door opens ${Math.round((result.door.maxOpening * 180) / Math.PI)}°.`);
    await this.wait(0.8, token);
    await this.success(token, result);
  }

  private waitFor(token: number, pred: () => boolean): Promise<void> {
    return new Promise((resolve, reject) => {
      if (pred()) return resolve();
      const unsub = useThreshold.subscribe(() => {
        if (token !== this.token) {
          unsub();
          reject(new Cancelled());
        } else if (pred()) {
          unsub();
          resolve();
        }
      });
    });
  }

  /** Real relocation to the configured safe-drop position, recomputed continuously. */
  async moveParcelToSafeZone(): Promise<void> {
    const { exp } = this;
    const target = { center: DEFAULT_MODEL.safeDropZone.suggestedCenter, yaw: SCENARIOS.B.parcel.yaw };
    S().set('parcelVisible', true);
    exp.parcel.setVisible(true);
    S().caregiverAction('review', 'Relocation to the safe drop zone started on the model.');
    await new Promise<void>((res) => exp.parcel.moveTo(target, this.d(2.6)).eventCallback('onComplete', () => res()));
  }

  private async success(token: number, result: AnalysisResult): Promise<void> {
    const { exp } = this;
    this.setPhase('resolve');
    exp.applyAnalysis(result);
    exp.overlays.setPathProgress(0);
    exp.overlays.fadeTo('route', 1, 0.3);
    const pp = { v: 0 };
    await new Promise<void>((res) =>
      gsap.to(pp, { v: 1, duration: this.d(1.6), ease: 'power2.inOut', onUpdate: () => exp.overlays.setPathProgress(pp.v), onComplete: res }),
    );
    this.check(token);
    exp.avatar.setTone('clear');
    // Continue from where the avatar stopped, along a route the engine computes from there.
    let from: Vec2 = DEFAULT_MODEL.route.start;
    if (exp.avatar.fade > 0.5) {
      const p = exp.avatar.position;
      from = { x: p.x, z: p.z };
    }
    const cont = this.routeFrom(from);
    if (!cont.path.found) {
      S().toast('The continuation route could not be verified; replaying from the walkway.', 'warning');
    }
    const pts = cont.path.found ? cont.path.points : result.path.points;
    exp.avatar.setPath(pts);
    if (exp.avatar.fade < 0.5) exp.avatar.fadeTo(1, 0.6);
    this.follow();
    await this.driveIntoHouse(token, result, 0);
  }

  private routeFrom(start: Vec2): AnalysisResult {
    const s = S();
    const model = { ...DEFAULT_MODEL, route: { ...DEFAULT_MODEL.route, start } };
    return analyzeEntrance({ model, parcel: s.parcel, placement: s.placement, requiredClearWidth: s.requiredClearWidth, evaluateUncertainty: false });
  }

  private async driveIntoHouse(token: number, result: AnalysisResult, from: number): Promise<void> {
    const { exp } = this;
    const total = exp.avatar.length;
    const doorZ = 1.9;
    let opened = false;
    // The door opens as the avatar approaches — only because the engine found it can.
    const drive = exp.avatar.drive(0.9, from, total, () => {
      if (!opened && exp.avatar.position.z < doorZ) {
        opened = true;
        exp.door.swingTo(result.door.maxOpening, this.d(1.4));
      }
    });
    await new Promise<void>((res) => drive.eventCallback('onComplete', () => res()));
    this.check(token);
    await this.finale(token);
  }

  private async finale(token: number): Promise<void> {
    const { exp } = this;
    this.setPhase('finale');
    exp.overlays.showLabels([]);
    exp.rig.stop();
    S().set('cutaway', false);
    exp.cutaway.animateTo(0, this.d(2.6));
    const level = { v: 0.72 };
    gsap.to(level, { v: 1, duration: this.d(2.4), onUpdate: () => exp.lights.setArchitecturalLevel(level.v) });
    for (const id of ['grid', 'search', 'corridor', 'door', 'intrusion', 'clearance', 'markers', 'uncertainty'] as const) exp.overlays.fadeTo(id, 0, this.d(1.4));
    exp.overlays.fadeTo('route', 0.55, this.d(1.4));
    exp.overlays.fadeTo('parcel', 0.6, this.d(1.4));
    exp.avatar.fadeTo(0, this.d(2));
    await this.flyTo('resolution', 4, token);
    exp.door.close(this.d(2));
    exp.rig.driftAmount = 0.5;
  }
}
