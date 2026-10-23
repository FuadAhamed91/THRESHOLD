import gsap from 'gsap';
import {
  AdditiveBlending,
  EdgesGeometry,
  Euler,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Quaternion,
  Raycaster,
  RingGeometry,
  Vector2,
  Vector3,
  type Camera,
  type Object3D,
} from 'three';
import type { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_LAYOUT, rampPitch } from '../../geometry/coordinateSystem';
import { DEFAULT_MODEL } from '../../geometry/entranceModel';
import { orientedRectangle, polygonContainsPolygon, polygonsIntersect } from '../../geometry/polygons';
import type { ParcelPose, Vec2 } from '../../geometry/types';
import { floorY } from '../overlays/drape';

export type DragPhase = 'start' | 'move' | 'end';

export interface ParcelCallbacks {
  onPoseChange(pose: ParcelPose, phase: DragPhase): void;
  onSelect(selected: boolean): void;
  canInteract(): boolean;
}

const PITCH = rampPitch(DEFAULT_LAYOUT);
const R = DEFAULT_LAYOUT.ramp;

/** Walking surface tilt at a plan point (the ramp is the only slope). */
function slopeAt(p: Vec2): number {
  return p.z > R.zTop && p.z < R.zBottom && Math.abs(p.x) <= R.xMax + R.curbWidth ? PITCH : 0;
}

/** A parcel can only be placed fully on the walkable surface, clear of fixed obstacles. */
export function isPlaceable(center: Vec2, yaw: number, size = DEFAULT_LAYOUT.parcel.size): boolean {
  const fp = orientedRectangle(center, yaw, size.width, size.depth);
  if (!polygonContainsPolygon(DEFAULT_MODEL.walkable.polygon, fp, 1e-6)) return false;
  return !DEFAULT_MODEL.obstacles.some((o) => polygonsIntersect(o.polygon, fp));
}

/**
 * The delivered parcel: places the Blender mesh from a plan pose, and turns
 * pointer input into ground-plane drags (ray ∩ horizontal plane at the floor
 * height), constrained to the walkable surface. Vertical motion is impossible
 * by construction: height always comes from the floor.
 */
export class ParcelController {
  private pose: ParcelPose;
  private readonly outline: LineSegments;
  private readonly ring: Mesh;
  private readonly raycaster = new Raycaster();
  private readonly plane = new Plane(new Vector3(0, 1, 0), 0);
  private readonly ndc = new Vector2();
  private readonly hit = new Vector3();
  private dragging = false;
  private grab = { x: 0, z: 0 };
  private downAt = { x: 0, y: 0, onParcel: false };
  private hovered = false;
  selected = false;
  private lastValid: ParcelPose;
  lift = 0;

  constructor(
    readonly object: Object3D,
    private readonly camera: Camera,
    private readonly dom: HTMLElement,
    private readonly controls: OrbitControls,
    private readonly callbacks: ParcelCallbacks,
    initial: ParcelPose,
  ) {
    this.pose = initial;
    this.lastValid = initial;
    const mesh = object as Mesh;
    this.outline = new LineSegments(
      new EdgesGeometry(mesh.geometry ?? undefined, 25),
      new LineBasicMaterial({ color: '#7fe3ff', transparent: true, opacity: 0, depthTest: false, blending: AdditiveBlending }),
    );
    this.outline.renderOrder = 30;
    this.outline.userData.excludeFromAO = true;
    this.outline.raycast = () => {};
    object.add(this.outline);
    this.ring = new Mesh(
      new RingGeometry(0.42, 0.45, 64),
      new MeshBasicMaterial({ color: '#7fe3ff', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending }),
    );
    this.ring.rotation.x = -Math.PI / 2;
    this.ring.position.y = 0.012;
    this.ring.userData.excludeFromAO = true;
    this.ring.raycast = () => {};
    object.add(this.ring);
    this.apply();
    dom.addEventListener('pointerdown', this.onDown, { capture: true });
    window.addEventListener('pointermove', this.onMove);
    window.addEventListener('pointerup', this.onUp);
    window.addEventListener('keydown', this.onKey);
    dom.addEventListener('wheel', this.onWheel, { passive: false, capture: true });
  }

  get current(): ParcelPose {
    return this.pose;
  }

  get isDragging(): boolean {
    return this.dragging;
  }

  setPose(pose: ParcelPose): void {
    this.pose = pose;
    if (isPlaceable(pose.center, pose.yaw, pose.size)) this.lastValid = pose;
    this.apply();
  }

  setVisible(v: boolean): void {
    this.object.visible = v;
  }

  setSelected(v: boolean): void {
    this.selected = v;
    this.updateHighlight();
  }

  private updateHighlight(): void {
    const o = this.selected ? 0.95 : this.hovered ? 0.45 : 0;
    gsap.to(this.outline.material, { opacity: o, duration: 0.25, overwrite: 'auto' });
    gsap.to(this.ring.material, { opacity: this.selected ? 0.75 : this.hovered ? 0.3 : 0, duration: 0.25, overwrite: 'auto' });
  }

  private apply(): void {
    const { center, yaw } = this.pose;
    this.object.position.set(center.x, floorY(center.x, center.z) + this.lift, center.z);
    const qYaw = new Quaternion().setFromEuler(new Euler(0, yaw, 0));
    const qSlope = new Quaternion().setFromAxisAngle(new Vector3(1, 0, 0), slopeAt(center));
    this.object.quaternion.copy(qSlope.multiply(qYaw));
  }

  /** Courier "drop": fall a short distance and settle. */
  dropIn(duration = 0.9): gsap.core.Timeline {
    this.setVisible(true);
    this.lift = 0.7;
    this.apply();
    const tl = gsap.timeline();
    tl.to(this, { lift: 0, duration: duration * 0.55, ease: 'power2.in', onUpdate: () => this.apply() });
    tl.to(this, { lift: 0.04, duration: duration * 0.15, ease: 'power1.out', onUpdate: () => this.apply() });
    tl.to(this, { lift: 0, duration: duration * 0.3, ease: 'bounce.out', onUpdate: () => this.apply() });
    return tl;
  }

  /** Real movement to a target pose; every intermediate pose is reported for live recomputation. */
  moveTo(target: { center: Vec2; yaw: number }, duration = 2.4): gsap.core.Timeline {
    const from = { ...this.pose.center, yaw: this.pose.yaw };
    const state = { t: 0 };
    const tl = gsap.timeline();
    this.callbacks.onPoseChange(this.pose, 'start');
    tl.to(state, {
      t: 1,
      duration,
      ease: 'power2.inOut',
      onUpdate: () => {
        const t = state.t;
        const center = { x: from.x + (target.center.x - from.x) * t, z: from.z + (target.center.z - from.z) * t };
        this.lift = Math.sin(Math.PI * t) * 0.14;
        this.pose = { ...this.pose, center, yaw: from.yaw + (target.yaw - from.yaw) * t };
        this.apply();
        this.callbacks.onPoseChange(this.pose, 'move');
      },
      onComplete: () => {
        this.lift = 0;
        this.apply();
        this.lastValid = this.pose;
        this.callbacks.onPoseChange(this.pose, 'end');
      },
    });
    return tl;
  }

  rotateBy(delta: number): void {
    const yaw = this.pose.yaw + delta;
    if (!isPlaceable(this.pose.center, yaw, this.pose.size)) return;
    this.pose = { ...this.pose, yaw };
    this.lastValid = this.pose;
    this.apply();
    this.callbacks.onPoseChange(this.pose, 'end');
  }

  private pick(e: PointerEvent): boolean {
    if (!this.object.visible) return false;
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    return this.raycaster.intersectObject(this.object, true).some((h) => h.object !== this.outline && h.object !== this.ring);
  }

  private groundPoint(e: PointerEvent, height: number): Vector3 | null {
    const rect = this.dom.getBoundingClientRect();
    this.ndc.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.camera);
    this.plane.constant = -height;
    return this.raycaster.ray.intersectPlane(this.plane, this.hit);
  }

  private onDown = (e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const onParcel = this.callbacks.canInteract() && this.pick(e);
    this.downAt = { x: e.clientX, y: e.clientY, onParcel };
    if (!onParcel) return;
    e.stopImmediatePropagation();
    e.preventDefault();
    const h = floorY(this.pose.center.x, this.pose.center.z);
    const p = this.groundPoint(e, h);
    if (!p) return;
    this.dragging = true;
    this.controls.enabled = false;
    this.grab = { x: this.pose.center.x - p.x, z: this.pose.center.z - p.z };
    this.dom.style.cursor = 'grabbing';
    if (!this.selected) this.callbacks.onSelect(true);
    this.callbacks.onPoseChange(this.pose, 'start');
  };

  private onMove = (e: PointerEvent) => {
    if (!this.dragging) {
      if (e.target !== this.dom && !(e.target as HTMLElement)?.closest?.('.label-layer')) return;
      const over = this.callbacks.canInteract() && this.pick(e);
      if (over !== this.hovered) {
        this.hovered = over;
        this.dom.style.cursor = over ? 'grab' : '';
        this.updateHighlight();
      }
      return;
    }
    const p = this.groundPoint(e, floorY(this.pose.center.x, this.pose.center.z));
    if (!p) return;
    const desired = { x: p.x + this.grab.x, z: p.z + this.grab.z };
    const { yaw, size } = this.pose;
    let next: Vec2 | null = null;
    if (isPlaceable(desired, yaw, size)) next = desired;
    else if (isPlaceable({ x: desired.x, z: this.lastValid.center.z }, yaw, size)) next = { x: desired.x, z: this.lastValid.center.z };
    else if (isPlaceable({ x: this.lastValid.center.x, z: desired.z }, yaw, size)) next = { x: this.lastValid.center.x, z: desired.z };
    if (!next) return;
    this.pose = { ...this.pose, center: next };
    this.lastValid = this.pose;
    this.apply();
    this.callbacks.onPoseChange(this.pose, 'move');
  };

  private onUp = (e: PointerEvent) => {
    if (this.dragging) {
      this.dragging = false;
      this.controls.enabled = true;
      this.dom.style.cursor = this.hovered ? 'grab' : '';
      this.callbacks.onPoseChange(this.pose, 'end');
      return;
    }
    const moved = Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y);
    if (!this.downAt.onParcel && moved < 4 && this.selected && e.target === this.dom) this.callbacks.onSelect(false);
  };

  private onKey = (e: KeyboardEvent) => {
    if (!this.selected || !this.callbacks.canInteract()) return;
    if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
    if (e.key === 'q' || e.key === 'Q') this.rotateBy(Math.PI / 24);
    if (e.key === 'e' || e.key === 'E') this.rotateBy(-Math.PI / 24);
  };

  private onWheel = (e: WheelEvent) => {
    if (!this.dragging) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    this.rotateBy(Math.sign(e.deltaY) * (Math.PI / 36));
  };

  dispose(): void {
    this.dom.removeEventListener('pointerdown', this.onDown, { capture: true });
    window.removeEventListener('pointermove', this.onMove);
    window.removeEventListener('pointerup', this.onUp);
    window.removeEventListener('keydown', this.onKey);
    this.dom.removeEventListener('wheel', this.onWheel, { capture: true });
    this.outline.geometry.dispose();
    this.ring.geometry.dispose();
  }
}
