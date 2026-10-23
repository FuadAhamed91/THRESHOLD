import gsap from 'gsap';
import { Vector3, type PerspectiveCamera } from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import type { Shot } from './shots';

export interface FlyOptions {
  duration?: number;
  ease?: string;
  /** Extra height of the arc between shots (meters). */
  arc?: number;
}

/**
 * Cinematic camera moves. Positions travel on a gentle quadratic arc (no
 * flying through walls, no spins), the look-at target eases independently,
 * and any user interaction interrupts the move and hands control back.
 */
export class CameraRig {
  private tween: gsap.core.Tween | null = null;
  private followFn: (() => { position: Vector3; target: Vector3 } | null) | null = null;
  private target = new Vector3();
  private readonly tmp = new Vector3();
  driftAmount = 0;

  constructor(
    private readonly camera: PerspectiveCamera,
    private readonly controls: OrbitControls,
  ) {
    this.target.copy(controls.target);
  }

  get busy(): boolean {
    return !!this.tween || !!this.followFn;
  }

  jumpTo(shot: Shot): void {
    this.stop();
    this.camera.position.copy(shot.position);
    this.camera.fov = shot.fov;
    this.camera.updateProjectionMatrix();
    this.target.copy(shot.target);
    this.camera.lookAt(this.target);
    this.controls.target.copy(this.target);
  }

  flyTo(shot: Shot, opts: FlyOptions = {}): Promise<boolean> {
    this.stop();
    const p0 = this.camera.position.clone();
    const t0 = this.controls.target.clone();
    const f0 = this.camera.fov;
    const p1 = shot.position.clone();
    const dist = p0.distanceTo(p1);
    const ctrl = p0.clone().add(p1).multiplyScalar(0.5);
    ctrl.y += (opts.arc ?? Math.min(2.2, dist * 0.18));
    const state = { t: 0 };
    return new Promise((resolve) => {
      this.tween = gsap.to(state, {
        t: 1,
        duration: opts.duration ?? 3,
        ease: opts.ease ?? 'power2.inOut',
        onUpdate: () => {
          const t = state.t;
          const u = 1 - t;
          this.camera.position.set(
            u * u * p0.x + 2 * u * t * ctrl.x + t * t * p1.x,
            u * u * p0.y + 2 * u * t * ctrl.y + t * t * p1.y,
            u * u * p0.z + 2 * u * t * ctrl.z + t * t * p1.z,
          );
          const te = t * t * (3 - 2 * t);
          this.target.lerpVectors(t0, shot.target, te);
          this.camera.fov = f0 + (shot.fov - f0) * te;
          this.camera.updateProjectionMatrix();
          this.camera.lookAt(this.target);
        },
        onComplete: () => {
          this.tween = null;
          this.controls.target.copy(this.target);
          resolve(true);
        },
        onInterrupt: () => resolve(false),
      });
    });
  }

  /** Continuously track a moving subject (route view). */
  follow(fn: () => { position: Vector3; target: Vector3 } | null): void {
    this.stop();
    this.followFn = fn;
  }

  stop(): void {
    if (this.tween) {
      this.tween.kill();
      this.tween = null;
    }
    this.followFn = null;
    this.controls.target.copy(this.target);
  }

  /** Called every frame before rendering. Returns true while the rig owns the camera. */
  update(dt: number, time: number): boolean {
    if (this.followFn) {
      const goal = this.followFn();
      if (goal) {
        const k = 1 - Math.exp(-dt * 2.6);
        this.camera.position.lerp(goal.position, k);
        this.target.lerp(goal.target, k);
        this.camera.lookAt(this.target);
      }
      return true;
    }
    if (this.tween) return true;
    if (this.driftAmount > 0) {
      // slow breathing dolly for idle hero compositions
      this.tmp.set(Math.sin(time * 0.11) * 0.25, Math.sin(time * 0.17) * 0.06, Math.cos(time * 0.09) * 0.2).multiplyScalar(this.driftAmount * dt);
      this.camera.position.add(this.tmp);
      this.camera.lookAt(this.controls.target);
      return true;
    }
    return false;
  }
}
