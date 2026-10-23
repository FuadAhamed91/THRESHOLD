import gsap from 'gsap';
import {
  AdditiveBlending,
  BufferGeometry,
  Color,
  DoubleSide,
  Float32BufferAttribute,
  Group,
  Mesh,
  ShaderMaterial,
  Vector3,
} from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import type { Vec2 } from '../../geometry/types';
import { floorY } from '../overlays/drape';
import { createLineMaterial } from '../overlays/materials';

/**
 * Visualises the doorbell camera "seeing" the delivery: a translucent pyramid
 * from the lens to the parcel's estimated footprint with a travelling scan
 * band. It illustrates an observation, not a measurement — the footprint it
 * lands on carries its own estimated/simulated label.
 */
export class ObservationCone {
  readonly group = new Group();
  private mesh: Mesh;
  private lines: Line2;
  private material: ShaderMaterial;
  private lineMat = createLineMaterial({ color: '#38d6f5', width: 1.4, opacity: 0.85, intensity: 2.2 });
  fade = 0;

  constructor(private readonly lens: Vector3) {
    this.group.name = 'ObservationCone';
    this.material = new ShaderMaterial({
      uniforms: { uColor: { value: new Color('#38d6f5') }, uTime: { value: 0 }, uFade: { value: 0 } },
      vertexShader: /* glsl */ `
        attribute float aT;
        varying float vT;
        void main() { vT = aT; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
      `,
      fragmentShader: /* glsl */ `
        uniform vec3 uColor; uniform float uTime, uFade; varying float vT;
        void main() {
          float bd = (fract(vT - uTime * 0.6) - 0.5) * 9.0;
          float band = exp(-bd * bd);
          float a = (0.05 + 0.22 * band + 0.08 * vT) * uFade;
          gl_FragColor = vec4(uColor * (1.2 + band * 2.0), a);
        }
      `,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      blending: AdditiveBlending,
    });
    this.mesh = new Mesh(new BufferGeometry(), this.material);
    this.mesh.userData.excludeFromAO = true;
    this.mesh.renderOrder = 15;
    this.mesh.raycast = () => {};
    this.lines = new Line2(new LineGeometry(), this.lineMat);
    this.lines.userData.excludeFromAO = true;
    this.lines.raycast = () => {};
    this.group.add(this.mesh, this.lines);
    this.group.visible = false;
  }

  /** Aim the pyramid at a plan footprint. */
  setTarget(footprint: readonly Vec2[], lift = 0.02): void {
    if (footprint.length < 3) return;
    const corners = footprint.map((p) => new Vector3(p.x, floorY(p.x, p.z) + lift, p.z));
    const pos: number[] = [];
    const t: number[] = [];
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i];
      const b = corners[(i + 1) % corners.length];
      pos.push(this.lens.x, this.lens.y, this.lens.z, a.x, a.y, a.z, b.x, b.y, b.z);
      t.push(0, 1, 1);
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aT', new Float32BufferAttribute(t, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = geo;
    const lp: number[] = [];
    for (const c of corners) lp.push(this.lens.x, this.lens.y, this.lens.z, c.x, c.y, c.z);
    const lg = new LineGeometry();
    lg.setPositions(lp);
    this.lines.geometry.dispose();
    this.lines.geometry = lg;
  }

  private apply(): void {
    this.group.visible = this.fade > 0.01;
    this.material.uniforms.uFade.value = this.fade;
    this.lineMat.opacity = 0.85 * this.fade;
  }

  fadeTo(v: number, duration = 0.8): gsap.core.Tween {
    return gsap.to(this, { fade: v, duration, ease: 'power2.out', onUpdate: () => this.apply(), overwrite: 'auto' });
  }

  set(v: number): void {
    gsap.killTweensOf(this);
    this.fade = v;
    this.apply();
  }

  tick(time: number): void {
    this.material.uniforms.uTime.value = time;
  }

  dispose(): void {
    this.mesh.geometry.dispose();
    this.material.dispose();
    this.lines.geometry.dispose();
    this.lineMat.dispose();
  }
}
