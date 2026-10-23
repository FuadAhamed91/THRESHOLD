import gsap from 'gsap';
import { AdditiveBlending, Color, DoubleSide, Group, Mesh, ShaderMaterial, Vector3, type Object3D } from 'three';
import { DEFAULT_LAYOUT, rampPitch } from '../../geometry/coordinateSystem';
import type { Vec2 } from '../../geometry/types';
import { floorY } from '../overlays/drape';

const PITCH = rampPitch(DEFAULT_LAYOUT);
const R = DEFAULT_LAYOUT.ramp;

export type AvatarTone = 'neutral' | 'blocked' | 'clear';
const TONES: Record<AvatarTone, Color> = {
  neutral: new Color('#6fc3ff'),
  blocked: new Color('#ff6b7c'),
  clear: new Color('#4cf0b0'),
};

/** Translucent "digital twin" shading: fresnel rim + soft scanlines. Represents a person, not a specific one. */
function hologram(color: Color, base: number): ShaderMaterial {
  return new ShaderMaterial({
    uniforms: { uColor: { value: color.clone() }, uTime: { value: 0 }, uBase: { value: base }, uFade: { value: 1 } },
    vertexShader: /* glsl */ `
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec4 w = modelMatrix * vec4(position, 1.0);
        vY = w.y;
        vN = mat3(modelMatrix) * normal;
        vV = cameraPosition - w.xyz;
        gl_Position = projectionMatrix * viewMatrix * w;
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uColor; uniform float uTime, uBase, uFade;
      varying vec3 vN; varying vec3 vV; varying float vY;
      void main() {
        vec3 n = vN / max(length(vN), 1e-4);
        vec3 v = vV / max(length(vV), 1e-4);
        float f = pow(clamp(1.0 - abs(dot(n, v)), 0.0, 1.0), 2.2);
        float scan = 0.8 + 0.2 * sin(vY * 140.0 - uTime * 4.0);
        float a = (uBase + f * 0.55) * scan * uFade;
        gl_FragColor = vec4(uColor * (0.45 + f * 1.7), clamp(a, 0.0, 1.0));
      }
    `,
    transparent: true,
    depthWrite: false,
    side: DoubleSide,
    blending: AdditiveBlending,
  });
}

/**
 * Wheelchair avatar that follows ONLY routes produced by the geometry engine.
 * Position comes from arc length along the route polyline, height and pitch
 * from the walking surface, heading from a short look-ahead, and the wheels
 * spin by distance travelled.
 */
export class AvatarController {
  readonly root = new Group();
  private materials: ShaderMaterial[] = [];
  private wheels: Object3D[] = [];
  private casters: Object3D[] = [];
  private tone: AvatarTone = 'neutral';
  private distance = 0;
  private path: Vec2[] = [];
  private cumulative: number[] = [];
  heading = Math.PI; // facing −Z (toward the door)
  fade = 0;

  constructor(model: Object3D) {
    this.root.name = 'AvatarRig';
    this.root.add(model);
    model.traverse((o) => {
      const mesh = o as Mesh;
      if (/^Wheel_[LR]$/.test(o.name)) this.wheels.push(o);
      if (/^Caster_[LR]$/.test(o.name)) this.casters.push(o);
      if (!mesh.isMesh) return;
      const isFigure = /Figure/.test(mesh.name);
      const mat = hologram(TONES.neutral, isFigure ? 0.07 : 0.05);
      this.materials.push(mat);
      mesh.material = mat;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.userData.excludeFromAO = true;
      mesh.renderOrder = 25;
    });
    this.root.visible = false;
    this.setFade(0);
  }

  get position(): Vector3 {
    return this.root.position;
  }

  setTone(tone: AvatarTone, duration = 0.6): void {
    if (tone === this.tone) return;
    this.tone = tone;
    for (const m of this.materials) {
      gsap.to(m.uniforms.uColor.value, { r: TONES[tone].r, g: TONES[tone].g, b: TONES[tone].b, duration });
    }
  }

  setFade(f: number): void {
    this.fade = f;
    this.root.visible = f > 0.01;
    for (const m of this.materials) m.uniforms.uFade.value = f;
  }

  fadeTo(f: number, duration = 0.8): gsap.core.Tween {
    return gsap.to(this, { fade: f, duration, ease: 'power2.out', onUpdate: () => this.setFade(this.fade), overwrite: 'auto' });
  }

  /** Place at a plan point facing a heading (radians, rotation.y convention: 0 = +Z). */
  placeAt(p: Vec2, heading = this.heading): void {
    this.heading = heading;
    this.root.position.set(p.x, floorY(p.x, p.z), p.z);
    this.root.rotation.set(this.pitchAt(p, heading), heading, 0, 'YXZ');
  }

  private pitchAt(p: Vec2, heading: number): number {
    const onRamp = p.z > R.zTop && p.z < R.zBottom && Math.abs(p.x) <= R.xMax + R.curbWidth;
    if (!onRamp) return 0;
    // The ramp rises toward −Z: travelling with a −Z component means nose up (negative X rotation in YXZ order).
    const forwardZ = Math.cos(heading);
    return PITCH * forwardZ;
  }

  setPath(points: readonly Vec2[]): number {
    this.path = [...points];
    this.cumulative = [0];
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1];
      const b = points[i];
      this.cumulative.push(this.cumulative[i - 1] + Math.hypot(b.x - a.x, b.z - a.z));
    }
    this.distance = 0;
    if (points.length) this.placeAt(points[0], this.headingAlong(0));
    return this.length;
  }

  get length(): number {
    return this.cumulative[this.cumulative.length - 1] ?? 0;
  }

  private sample(s: number): Vec2 {
    const c = this.cumulative;
    const pts = this.path;
    if (pts.length === 0) return { x: 0, z: 0 };
    if (s <= 0) return pts[0];
    if (s >= c[c.length - 1]) return pts[pts.length - 1];
    let lo = 0;
    let hi = c.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (c[mid] <= s) lo = mid;
      else hi = mid;
    }
    const t = (s - c[lo]) / Math.max(1e-9, c[hi] - c[lo]);
    return { x: pts[lo].x + (pts[hi].x - pts[lo].x) * t, z: pts[lo].z + (pts[hi].z - pts[lo].z) * t };
  }

  private headingAlong(s: number): number {
    const a = this.sample(Math.max(0, s - 0.15));
    const b = this.sample(Math.min(this.length, s + 0.35));
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    if (Math.hypot(dx, dz) < 1e-4) return this.heading;
    return Math.atan2(dx, dz);
  }

  private setDistance(s: number): void {
    const delta = s - this.distance;
    this.distance = s;
    const p = this.sample(s);
    const target = this.headingAlong(s);
    let dh = target - this.heading;
    dh = Math.atan2(Math.sin(dh), Math.cos(dh));
    this.placeAt(p, this.heading + dh * 0.35);
    for (const w of this.wheels) w.rotation.x += delta / 0.3;
    for (const c of this.casters) c.rotation.x += delta / 0.075;
  }

  /** Drive along the current path at `speed` m/s; `onMove` sees every intermediate distance. */
  drive(speed = 0.85, from = 0, to = this.length, onMove?: (s: number) => void): gsap.core.Tween {
    const state = { s: from };
    this.distance = from;
    const duration = Math.max(0.4, Math.abs(to - from) / speed);
    return gsap.to(state, {
      s: to,
      duration,
      ease: 'power1.inOut',
      onUpdate: () => {
        this.setDistance(state.s);
        onMove?.(state.s);
      },
    });
  }

  /** A short forward nudge and recoil: the avatar reached a passage it cannot fit through. */
  bump(): gsap.core.Timeline {
    const tl = gsap.timeline();
    const start = this.distance;
    const state = { s: start };
    tl.to(state, { s: Math.min(this.length, start + 0.06), duration: 0.18, ease: 'power2.out', onUpdate: () => this.setDistance(state.s) });
    tl.to(state, { s: start, duration: 0.35, ease: 'power2.inOut', onUpdate: () => this.setDistance(state.s) });
    return tl;
  }

  tick(time: number): void {
    for (const m of this.materials) m.uniforms.uTime.value = time;
  }

  dispose(): void {
    for (const m of this.materials) m.dispose();
  }
}
