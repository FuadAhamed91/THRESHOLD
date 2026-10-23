import gsap from 'gsap';
import type { Object3D } from 'three';
import type { DoorModel } from '../../geometry/types';

/**
 * Drives the Blender door leaf about its hinge pivot. Angles are opening
 * angles θ (0 = closed). The plan angle of the leaf is closedAngle + sense·θ,
 * and Three.js rotation.y is the negative plan angle.
 */
export class DoorController {
  angle = 0;

  constructor(
    private readonly pivot: Object3D,
    private readonly door: DoorModel,
  ) {
    this.set(0);
  }

  set(theta: number): void {
    this.angle = theta;
    this.pivot.rotation.y = -(this.door.closedAngle + this.door.openingSense * theta);
  }

  /** Open toward `theta`. If `blocked`, the leaf stops there with a small rebound. */
  swingTo(theta: number, duration = 1.6, blocked = false): gsap.core.Timeline {
    const tl = gsap.timeline();
    tl.to(this, {
      angle: theta,
      duration,
      ease: blocked ? 'power2.in' : 'power2.inOut',
      onUpdate: () => this.set(this.angle),
    });
    if (blocked) {
      const back = Math.max(0, theta - 0.045);
      tl.to(this, { angle: back, duration: 0.18, ease: 'power2.out', onUpdate: () => this.set(this.angle) });
      tl.to(this, { angle: theta - 0.012, duration: 0.35, ease: 'power2.inOut', onUpdate: () => this.set(this.angle) });
    }
    return tl;
  }

  close(duration = 1.2): gsap.core.Tween {
    return gsap.to(this, { angle: 0, duration, ease: 'power2.inOut', onUpdate: () => this.set(this.angle), overwrite: 'auto' });
  }
}
