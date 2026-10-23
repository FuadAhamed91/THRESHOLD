import {
  ACESFilmicToneMapping,
  PCFShadowMap,
  PerspectiveCamera,
  SRGBColorSpace,
  Scene,
  Timer,
  Vector3,
  WebGLRenderer,
} from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { CSS2DRenderer } from 'three/addons/renderers/CSS2DRenderer.js';
import { SCENARIOS } from '../config/scenarios';
import { analyzeEntrance } from '../geometry/analyze';
import { DEFAULT_LAYOUT } from '../geometry/coordinateSystem';
import { DEFAULT_MODEL } from '../geometry/entranceModel';
import type { AnalysisResult, ParcelPose } from '../geometry/types';
import { CameraRig } from './camera/CameraRig';
import { SHOTS, type ShotId } from './camera/shots';
import { renderDoorbellView } from './doorbellView';
import { CutawayController } from './effects/Cutaway';
import { PostFX } from './effects/PostFX';
import { loadAssets, type EntranceAssets } from './environment/assets';
import { createEnvironment, createFog, createLights, createSky, type EntranceLights } from './environment/atmosphere';
import { AvatarController } from './objects/Avatar';
import { DoorController } from './objects/Door';
import { ObservationCone } from './objects/ObservationCone';
import { ParcelController, type DragPhase } from './objects/Parcel';
import { AnalysisOverlays } from './overlays/AnalysisOverlays';
import { setLineResolution } from './overlays/materials';

export interface ExperienceCallbacks {
  onProgress(p: number): void;
  onParcelPose(pose: ParcelPose, phase: DragPhase): void;
  onParcelSelect(selected: boolean): void;
  onUserCamera(): void;
  canInteract(): boolean;
  onContextLost?(lost: boolean): void;
}

export type Quality = 'high' | 'balanced';

/**
 * The THRESHOLD 3D experience: one Three.js renderer, the Blender entrance,
 * analytical overlays driven by the geometry engine, and the controllers the
 * cinematic director choreographs.
 */
export class Experience {
  readonly renderer: WebGLRenderer;
  readonly scene = new Scene();
  readonly camera = new PerspectiveCamera(36, 1, 0.05, 200);
  readonly controls: OrbitControls;
  readonly rig: CameraRig;
  readonly labels: CSS2DRenderer;
  assets!: EntranceAssets;
  overlays!: AnalysisOverlays;
  cutaway!: CutawayController;
  door!: DoorController;
  parcel!: ParcelController;
  avatar!: AvatarController;
  observation!: ObservationCone;
  lights!: EntranceLights;
  private post!: PostFX;
  private timer = new Timer();
  private raf = 0;
  private running = false;
  private disposed = false;
  private resizeObserver: ResizeObserver;
  private quality: Quality;
  readonly lens: Vector3;
  readonly lensTarget: Vector3;
  private frameTimes: number[] = [];
  private frameCount = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly callbacks: ExperienceCallbacks,
    quality: Quality = 'high',
  ) {
    this.quality = quality;
    this.renderer = new WebGLRenderer({ antialias: false, powerPreference: 'high-performance', stencil: false });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = PCFShadowMap;
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);

    this.labels = new CSS2DRenderer();
    this.labels.domElement.className = 'label-layer';
    container.appendChild(this.labels.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 22;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.target.set(0, 0.8, 1.2);
    this.controls.addEventListener('start', () => {
      if (this.rig.busy) {
        this.rig.stop();
        this.callbacks.onUserCamera();
      }
      this.rig.driftAmount = 0;
    });
    this.rig = new CameraRig(this.camera, this.controls);

    const rb = DEFAULT_LAYOUT.ringDoorbell;
    this.lens = new Vector3(rb.position.x, rb.position.y, rb.position.z);
    this.lensTarget = new Vector3(rb.lookAt.x, rb.lookAt.y, rb.lookAt.z);

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);

    // Survive GPU resets: let the browser restore the context, then resume.
    this.renderer.domElement.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
      this.fences = [];
      this.stop();
      this.callbacks.onContextLost?.(true);
    });
    this.renderer.domElement.addEventListener('webglcontextrestored', () => {
      this.callbacks.onContextLost?.(false);
      this.start();
    });
  }

  async init(initialParcel: ParcelPose): Promise<void> {
    this.assets = await loadAssets((p) => this.callbacks.onProgress(p * 0.9));
    if (this.disposed) return;
    const { scene } = this;
    scene.add(this.assets.root);
    scene.add(createSky());
    scene.fog = createFog();
    const env = createEnvironment(this.renderer);
    scene.environment = env.texture;
    scene.environmentIntensity = 0.32;

    this.lights = createLights(this.quality);
    scene.add(this.lights.group);

    this.overlays = new AnalysisOverlays(DEFAULT_MODEL);
    scene.add(this.overlays.group);

    this.cutaway = new CutawayController(this.assets.cutaway);
    scene.add(this.cutaway.group);

    this.door = new DoorController(this.assets.doorPivot, DEFAULT_MODEL.door);

    this.parcel = new ParcelController(
      this.assets.parcel,
      this.camera,
      this.renderer.domElement,
      this.controls,
      {
        onPoseChange: (pose, phase) => this.callbacks.onParcelPose(pose, phase),
        onSelect: (s) => this.callbacks.onParcelSelect(s),
        canInteract: () => this.callbacks.canInteract(),
      },
      initialParcel,
    );
    this.parcel.setVisible(false);

    this.avatar = new AvatarController(this.assets.avatar);
    scene.add(this.avatar.root);

    this.observation = new ObservationCone(this.lens);
    scene.add(this.observation.group);

    this.resize();
    this.post = new PostFX(this.renderer, scene, this.camera, this.size.w, this.size.h, this.quality);
    this.resize();
    this.rig.jumpTo(SHOTS.hero);

    // Compile shaders before the first visible frame. On Windows (ANGLE/D3D11)
    // compilation finishes lazily on the GPU, so also render one off-screen view
    // and wait on an async readback: the loading screen absorbs that cost.
    this.callbacks.onProgress(0.93);
    await this.renderer.compileAsync(scene, this.camera);
    await this.prewarm();
    this.callbacks.onProgress(1);
    this.start();
  }

  /**
   * Draw every mesh, overlay and actor once while the loading screen is up.
   * ANGLE/D3D11 compiles per-draw GPU variants on first use; without this the
   * GPU stalls for seconds whenever the camera first sees something new.
   */
  private async prewarm(): Promise<void> {
    const culled: Array<[{ frustumCulled: boolean }, boolean]> = [];
    this.scene.traverse((o) => {
      culled.push([o, o.frustumCulled]);
      o.frustumCulled = false;
    });
    const actors = [this.assets.parcel, this.avatar.root, this.observation.group, this.cutaway.group];
    const vis = actors.map((o) => [o, o.visible] as const);
    for (const o of actors) o.visible = true;
    // Populate every overlay layer with a real (blocked) analysis so each overlay
    // shader variant — dashed lines, ribbons, points, hatches — compiles now.
    const sample = analyzeEntrance({
      model: DEFAULT_MODEL,
      parcel: SCENARIOS.A.parcel,
      placement: { source: 'estimated_prior', uncertaintyRadius: 0.3 },
      requiredClearWidth: DEFAULT_MODEL.defaultRequiredClearWidth,
    });
    this.overlays.update(sample);
    this.overlays.setPathProgress(1);
    this.observation.setTarget(sample.parcelFootprint);
    this.avatar.setPath(sample.path.reachable);
    this.overlays.setAll(1);
    this.overlays.setSearchProgress(1);
    this.avatar.setFade(1);
    this.observation.set(1);
    this.cutaway.set(0.5);
    for (const shot of [SHOTS.hero, SHOTS.analysis]) {
      this.rig.jumpTo(shot);
      this.post.render(0);
    }
    await this.renderCameraView({ title: '', time: '', footer: '' });
    this.cutaway.set(0);
    this.observation.set(0);
    this.avatar.setFade(0);
    this.overlays.setAll(0);
    for (const [o, v] of vis) o.visible = v;
    for (const [o, v] of culled) o.frustumCulled = v;
    this.rig.jumpTo(SHOTS.hero);
  }

  private get size() {
    const r = this.container.getBoundingClientRect();
    return { w: Math.max(1, Math.floor(r.width)), h: Math.max(1, Math.floor(r.height)) };
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, this.quality === 'high' ? 1.5 : 1);
  }

  resize(): void {
    const { w, h } = this.size;
    const pr = this.pixelRatio();
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.renderer.domElement.style.width = `${w}px`;
    this.renderer.domElement.style.height = `${h}px`;
    this.labels.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h, pr);
    setLineResolution(w * pr, h * pr);
  }

  setQuality(q: Quality): void {
    this.quality = q;
    this.post?.setAOEnabled(q === 'high');
    this.resize();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.timer.connect(document);
    const loop = (timestamp: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.timer.update(timestamp);
      this.frame();
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.timer.disconnect();
  }

  private frame(): void {
    const dt = Math.min(this.timer.getDelta(), 0.1);
    const t = this.timer.getElapsed();
    const owned = this.rig.update(dt, t);
    if (!owned) this.controls.update(dt);
    this.overlays.tick(t);
    this.avatar.tick(t);
    this.observation.tick(t);
    // Never queue more than two frames on the GPU: if it is behind, skip this
    // render rather than build a backlog that later stalls the whole page.
    if (this.gpuBehind()) return;
    this.post.render(t);
    this.labels.render(this.scene, this.camera);
    this.fences.push(this.gl.fenceSync(this.gl.SYNC_GPU_COMMANDS_COMPLETE, 0)!);
    this.trackPerformance();
  }

  private lastRender = 0;

  private fences: WebGLSync[] = [];

  private get gl(): WebGL2RenderingContext {
    return this.renderer.getContext() as WebGL2RenderingContext;
  }

  private gpuBehind(): boolean {
    const gl = this.gl;
    while (this.fences.length > 0) {
      const f = this.fences[0];
      if (gl.getSyncParameter(f, gl.SYNC_STATUS) !== gl.SIGNALED) break;
      gl.deleteSync(f);
      this.fences.shift();
    }
    return this.fences.length >= 2;
  }

  /** Drop to balanced quality if fewer than ~32 frames per second actually render (median, after warm-up). */
  private trackPerformance(): void {
    const now = performance.now();
    const interval = this.lastRender ? (now - this.lastRender) / 1000 : 0;
    this.lastRender = now;
    if (this.quality !== 'high' || !interval) return;
    if (++this.frameCount < 240) return; // ignore shader-compile and loading hitches
    this.frameTimes.push(interval);
    if (this.frameTimes.length < 150) return;
    const sorted = [...this.frameTimes].sort((a, b) => a - b);
    this.frameTimes = [];
    if (sorted[Math.floor(sorted.length / 2)] > 1 / 32) this.setQuality('balanced');
  }

  // ── API used by the director and UI ──────────────────────────────────────

  applyAnalysis(result: AnalysisResult): void {
    this.overlays.update(result);
    if (this.observation.fade > 0 && result.parcelFootprint.length) this.observation.setTarget(result.parcelFootprint);
  }

  flyTo(id: ShotId, duration = 3, arc?: number): Promise<boolean> {
    return this.rig.flyTo(SHOTS[id], { duration, arc });
  }

  renderCameraView(stamp: { title: string; time: string; footer: string }): Promise<string> {
    const hide = [this.overlays.group, this.cutaway.group, this.avatar.root, this.observation.group];
    return renderDoorbellView(this.renderer, this.scene, this.lens, this.lensTarget, hide, stamp);
  }

  /** Follow the avatar from behind and slightly above (route view). */
  followAvatar(): void {
    const back = new Vector3();
    const look = new Vector3();
    this.rig.follow(() => {
      const p = this.avatar.root.position;
      const h = this.avatar.heading;
      back.set(p.x - Math.sin(h) * 3.6 + Math.cos(h) * 1.3, p.y + 2.35, p.z - Math.cos(h) * 3.6 - Math.sin(h) * 1.3);
      look.set(p.x + Math.sin(h) * 2.2, p.y + 0.45, p.z + Math.cos(h) * 2.2);
      return { position: back, target: look };
    });
  }

  get canvas(): HTMLCanvasElement {
    return this.renderer.domElement;
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.resizeObserver.disconnect();
    this.parcel?.dispose();
    this.overlays?.dispose();
    this.cutaway?.dispose();
    this.avatar?.dispose();
    this.observation?.dispose();
    this.post?.dispose();
    this.controls.dispose();
    this.scene.traverse((o) => {
      const m = o as unknown as { geometry?: { dispose(): void }; material?: { dispose(): void } | Array<{ dispose(): void }> };
      m.geometry?.dispose();
      if (Array.isArray(m.material)) m.material.forEach((x) => x.dispose());
      else m.material?.dispose();
    });
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }
}
