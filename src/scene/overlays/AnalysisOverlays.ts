import gsap from 'gsap';
import { BufferGeometry, Float32BufferAttribute, Group, Mesh, Points, type ShaderMaterial } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import type { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import type { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { DEG } from '../../geometry/coordinateSystem';
import { sectorPolygon } from '../../geometry/polygons';
import type { AnalysisResult, EntranceModel, Vec2 } from '../../geometry/types';
import { add, direction, scale } from '../../geometry/vec2';
import { circlePoints, drapeLine, drapePolygon, drapeRibbon, floorY, ribbonPolygon } from './drape';
import { SceneLabel, type LabelTone } from './labels';
import { PALETTE, createFillMaterial, createLineMaterial, createSearchMaterial, overlayUniforms } from './materials';

export type LayerId =
  | 'grid'
  | 'corridor'
  | 'safe'
  | 'door'
  | 'parcel'
  | 'uncertainty'
  | 'intrusion'
  | 'search'
  | 'route'
  | 'clearance'
  | 'markers';

const fmt = (n: number) => n.toFixed(2);

/** A fadeable group of overlay meshes, fat lines, points and labels. */
class Layer {
  readonly group = new Group();
  fade = 0;
  private fills = new Set<ShaderMaterial>();
  private lines = new Map<LineMaterial, number>();
  private labels: SceneLabel[] = [];
  private geometries: BufferGeometry[] = [];

  constructor(readonly id: LayerId) {
    this.group.name = `overlay:${id}`;
    this.group.visible = false;
  }

  mesh(geo: BufferGeometry, mat: ShaderMaterial, order = 10): Mesh {
    const m = new Mesh(geo, mat);
    m.renderOrder = order;
    m.userData.excludeFromAO = true;
    m.raycast = () => {};
    this.group.add(m);
    this.geometries.push(geo);
    this.fills.add(mat);
    mat.uniforms.uFade.value = this.fade;
    return m;
  }

  line(geo: LineGeometry, mat: LineMaterial, order = 12): Line2 {
    const l = new Line2(geo, mat);
    if (mat.dashed) l.computeLineDistances();
    l.renderOrder = order;
    l.userData.excludeFromAO = true;
    l.raycast = () => {};
    this.group.add(l);
    this.geometries.push(geo);
    if (!this.lines.has(mat)) this.lines.set(mat, mat.opacity);
    mat.opacity = (this.lines.get(mat) ?? 1) * this.fade;
    return l;
  }

  points(geo: BufferGeometry, mat: ShaderMaterial): Points {
    const p = new Points(geo, mat);
    p.renderOrder = 11;
    p.raycast = () => {};
    this.group.add(p);
    this.geometries.push(geo);
    this.fills.add(mat);
    mat.uniforms.uFade.value = this.fade;
    return p;
  }

  label(label: SceneLabel, x: number, y: number, z: number): SceneLabel {
    label.object.position.set(x, y, z);
    if (!this.labels.includes(label)) this.labels.push(label);
    this.group.add(label.object);
    label.setOpacity(this.fade);
    return label;
  }

  /** Remove geometry (materials and labels are owned by the overlay system and reused). */
  clear(): void {
    for (const child of [...this.group.children]) this.group.remove(child);
    for (const g of this.geometries) g.dispose();
    this.geometries = [];
    this.labels = [];
  }

  setFade(f: number): void {
    this.fade = f;
    this.group.visible = f > 0.002;
    for (const m of this.fills) m.uniforms.uFade.value = f;
    for (const [m, base] of this.lines) m.opacity = base * f;
    for (const l of this.labels) l.setOpacity(f);
  }
}

/**
 * Every analytical overlay in the scene, rebuilt from the geometry engine's
 * result. Nothing here decides a state: colours and shapes are pure functions
 * of the AnalysisResult.
 */
export class AnalysisOverlays {
  readonly group = new Group();
  readonly layers: Record<LayerId, Layer>;
  private model: EntranceModel;
  private pathLines: Line2[] = [];
  private continuationLine: Line2 | null = null;
  private ribbonMesh: Mesh | null = null;
  private searchMaterial = createSearchMaterial(PALETTE.path);
  private searchCount = 1;
  private contactRing: Line2 | null = null;
  private stopRing: Line2 | null = null;
  pathProgress = 1;

  // materials (reused across rebuilds)
  private m = {
    grid: createFillMaterial({ color: PALETTE.grid, opacity: 0.32, pattern: 'grid', intensity: 1.1 }),
    corridor: createFillMaterial({ color: PALETTE.route, opacity: 0.2, pattern: 'flow', flowDir: [0, -1], intensity: 1.5 }),
    corridorEdge: createLineMaterial({ color: PALETTE.routeEdge, width: 1.6, opacity: 0.8 }),
    safe: createFillMaterial({ color: PALETTE.safe, opacity: 0.16, pattern: 'dots', intensity: 1.6 }),
    safeEdge: createLineMaterial({ color: PALETTE.safe, width: 2, dashed: true, dashSize: 0.1, gapSize: 0.06 }),
    door: createFillMaterial({ color: PALETTE.neutral, opacity: 0.14, intensity: 1.3 }),
    doorEdge: createLineMaterial({ color: PALETTE.neutral, width: 1.6, opacity: 0.85 }),
    doorBlocked: createFillMaterial({ color: PALETTE.conflict, opacity: 0.3, pattern: 'hatch', intensity: 1.8 }),
    doorStop: createLineMaterial({ color: PALETTE.conflict, width: 3.2, intensity: 2.2 }),
    overlap: createFillMaterial({ color: PALETTE.conflict, opacity: 0.55, pattern: 'hatch', intensity: 2.4 }),
    contact: createLineMaterial({ color: PALETTE.conflict, width: 2.4, intensity: 2.6 }),
    parcel: createFillMaterial({ color: PALETTE.conflict, opacity: 0.32, intensity: 1.8 }),
    parcelEdge: createLineMaterial({ color: PALETTE.conflict, width: 2.4, intensity: 2 }),
    parcelEdgeDashed: createLineMaterial({ color: PALETTE.estimate, width: 2.2, dashed: true, dashSize: 0.06, gapSize: 0.045, intensity: 2 }),
    unc: createFillMaterial({ color: PALETTE.estimate, opacity: 0.1, intensity: 1.4 }),
    uncEdge: createLineMaterial({ color: PALETTE.estimate, width: 1.6, dashed: true, dashSize: 0.08, gapSize: 0.06 }),
    uncBlocked: createFillMaterial({ color: PALETTE.conflict, opacity: 0.85, intensity: 2.2 }),
    uncClear: createFillMaterial({ color: PALETTE.clear, opacity: 0.85, intensity: 2.2 }),
    path: createLineMaterial({ color: PALETTE.path, width: 4, intensity: 2.6 }),
    pathCore: createLineMaterial({ color: '#e9fbff', width: 1.4, intensity: 2.2 }),
    pathClear: createLineMaterial({ color: PALETTE.clear, width: 4, intensity: 2.6 }),
    continuation: createLineMaterial({ color: PALETTE.conflict, width: 2.6, dashed: true, dashSize: 0.12, gapSize: 0.09, intensity: 2.2 }),
    ribbon: createFillMaterial({ color: PALETTE.path, opacity: 0.12, intensity: 1.3 }),
    ribbonClear: createFillMaterial({ color: PALETTE.clear, opacity: 0.14, intensity: 1.4 }),
    ribbonEdge: createLineMaterial({ color: PALETTE.path, width: 1.2, opacity: 0.6, dashed: true, dashSize: 0.18, gapSize: 0.1 }),
    ribbonEdgeClear: createLineMaterial({ color: PALETTE.clear, width: 1.2, opacity: 0.6, dashed: true, dashSize: 0.18, gapSize: 0.1 }),
    stop: createLineMaterial({ color: PALETTE.conflict, width: 2.6, intensity: 2.6 }),
    dimension: createLineMaterial({ color: '#ffffff', width: 2, intensity: 2.2, depthTest: false }),
    dimensionBad: createLineMaterial({ color: PALETTE.conflict, width: 2.6, intensity: 2.8, depthTest: false }),
    dimensionGood: createLineMaterial({ color: PALETTE.clear, width: 2.6, intensity: 2.6, depthTest: false }),
    marker: createLineMaterial({ color: PALETTE.routeEdge, width: 1.6, opacity: 0.8 }),
  };

  readonly labels = {
    safe: new SceneLabel('clear'),
    door: new SceneLabel('neutral'),
    parcel: new SceneLabel('conflict'),
    unc: new SceneLabel('estimate'),
    pinch: new SceneLabel('conflict', true),
    stop: new SceneLabel('conflict'),
  };

  constructor(model: EntranceModel) {
    this.model = model;
    const ids: LayerId[] = ['grid', 'corridor', 'safe', 'door', 'parcel', 'uncertainty', 'intrusion', 'search', 'route', 'clearance', 'markers'];
    this.layers = Object.fromEntries(ids.map((id) => [id, new Layer(id)])) as Record<LayerId, Layer>;
    for (const id of ids) this.group.add(this.layers[id].group);
    this.group.name = 'AnalysisOverlays';
    this.buildStatic();
  }

  private buildStatic(): void {
    const { model } = this;
    const grid = this.layers.grid;
    grid.mesh(drapePolygon(model.walkable.polygon, 0.003), this.m.grid, 5);

    const cor = this.layers.corridor;
    cor.mesh(drapePolygon(model.route.corridor, 0.005), this.m.corridor, 6);
    cor.line(drapeLine(model.route.corridor, 0.012, true), this.m.corridorEdge);

    const safe = this.layers.safe;
    safe.mesh(drapePolygon(model.safeDropZone.polygon, 0.02), this.m.safe, 7);
    safe.line(drapeLine(model.safeDropZone.polygon, 0.025, true, 0.1), this.m.safeEdge);
    const sc = model.safeDropZone.suggestedCenter;
    safe.label(this.labels.safe.set('Safe drop zone', 'configured'), sc.x, floorY(sc.x, sc.z) + 0.05, sc.z + 0.55);

    const mk = this.layers.markers;
    for (const p of [model.route.start, model.route.goal]) {
      mk.line(drapeLine(circlePoints(p, 0.16, 40), 0.015, true, 0.05), this.m.marker);
      mk.line(drapeLine(circlePoints(p, 0.05, 20), 0.015, true, 0.05), this.m.marker);
    }
  }

  /** Rebuild every analysis-dependent overlay from a result. */
  update(r: AnalysisResult): void {
    if (r.status === 'invalid') return;
    const resolved = r.status === 'clear';
    this.updateDoor(r);
    this.updateParcel(r);
    this.updateUncertainty(r);
    this.updateIntrusion(r);
    this.updateSearch(r);
    this.updateRoute(r, resolved);
    this.updateClearance(r);
    this.setPathProgress(this.pathProgress);
  }

  private updateDoor(r: AnalysisResult): void {
    const L = this.layers.door;
    L.clear();
    const d = r.door;
    const door = this.model.door;
    const tone: LabelTone = d.physicallyBlocked ? 'conflict' : d.intersectsSwingRegion ? 'caution' : 'neutral';
    const color = d.physicallyBlocked ? PALETTE.conflict : d.intersectsSwingRegion ? PALETTE.caution : PALETTE.neutral;
    this.m.door.uniforms.uColor.value.set(color);
    this.m.doorEdge.color.set(color).multiplyScalar(1.6);
    L.mesh(drapePolygon(d.swingRegion, 0.009), this.m.door, 7);
    L.line(drapeLine(d.swingRegion, 0.016, true, 0.06), this.m.doorEdge);
    if (d.physicallyBlocked) {
      const start = door.closedAngle + door.openingSense * d.maxOpening;
      const sweep = door.openingSense * (d.requiredOpening - d.maxOpening);
      L.mesh(drapePolygon(sectorPolygon(door.hinge, door.width, start, sweep, 32), 0.011), this.m.doorBlocked, 8);
      const tip = add(door.hinge, scale(direction(start), door.width));
      L.line(drapeLine([door.hinge, tip], 0.03), this.m.doorStop);
    }
    // Place the label outside the swept arc so it never covers the parcel.
    const mid = door.closedAngle + door.openingSense * door.requiredOpening * 0.62;
    const lp = add(door.hinge, scale(direction(mid), door.width * 1.28));
    const deg = Math.round(d.maxOpening / DEG);
    const req = Math.round(d.requiredOpening / DEG);
    this.labels.door
      .setTone(tone)
      .set(d.physicallyBlocked ? `Door stops at ${deg}°` : `Door swing ${req}°`, d.physicallyBlocked ? `${req}° needed · blocked by ${(d.blockedBy ?? 'obstacle').toLowerCase()}` : d.intersectsSwingRegion ? 'parcel in swing region' : 'clear');
    L.label(this.labels.door, lp.x, floorY(lp.x, lp.z) + 0.06, lp.z);
    this.contactRing = null;
    if (d.contactPoint) {
      this.contactRing = L.line(drapeLine(circlePoints(d.contactPoint, 0.07, 28), 0.05, true, 0.03), this.m.contact, 14);
    }
  }

  private parcelTone(r: AnalysisResult): { tone: LabelTone; color: string } {
    if (r.placement.source === 'estimated_prior') return { tone: 'estimate', color: PALETTE.estimate };
    const causes = r.door.physicallyBlocked || r.route.intrudes || (!r.path.found && !!r.clearance.pinch && [r.clearance.pinch.labelA, r.clearance.pinch.labelB].includes('Parcel'));
    if (causes) return { tone: 'conflict', color: PALETTE.conflict };
    if (r.safeZone.contained) return { tone: 'clear', color: PALETTE.clear };
    return { tone: 'neutral', color: PALETTE.neutral };
  }

  private updateParcel(r: AnalysisResult): void {
    const L = this.layers.parcel;
    L.clear();
    if (!r.parcel || r.parcelFootprint.length < 3) return;
    const { tone, color } = this.parcelTone(r);
    this.m.parcel.uniforms.uColor.value.set(color);
    this.m.parcelEdge.color.set(color).multiplyScalar(2);
    const estimated = r.placement.source === 'estimated_prior';
    L.mesh(drapePolygon(r.parcelFootprint, 0.014), this.m.parcel, 9);
    L.line(drapeLine(r.parcelFootprint, 0.02, true, 0.05), estimated ? this.m.parcelEdgeDashed : this.m.parcelEdge);
    const c = r.parcel.center;
    const sourceText: Record<string, string> = {
      simulated: 'simulated position',
      estimated_prior: `estimated · ±${fmt(r.placement.uncertaintyRadius)} m`,
      user_adjusted: 'moved on model',
      user_confirmed: 'confirmed',
    };
    this.labels.parcel.setTone(tone).set('Parcel', sourceText[r.placement.source]);
    L.label(this.labels.parcel, c.x, floorY(c.x, c.z) + r.parcel.size.height + 0.12, c.z);
  }

  private updateUncertainty(r: AnalysisResult): void {
    const L = this.layers.uncertainty;
    L.clear();
    if (!r.parcel || r.placement.uncertaintyRadius <= 0.08) return;
    const ring = circlePoints(r.parcel.center, r.placement.uncertaintyRadius, 72);
    L.mesh(drapePolygon(ring, 0.007), this.m.unc, 6);
    L.line(drapeLine(ring, 0.012, true, 0.05), this.m.uncEdge);
    for (const s of r.uncertainty.samples) {
      const dot = circlePoints(s.center, 0.035, 14);
      L.mesh(drapePolygon(dot, 0.03), s.routeFound && !s.doorBlocked ? this.m.uncClear : this.m.uncBlocked, 13);
    }
    const blocking = r.uncertainty.samples.filter((s) => !s.routeFound || s.doorBlocked).length;
    const c = r.parcel.center;
    this.labels.unc.set(`Position uncertain ±${fmt(r.placement.uncertaintyRadius)} m`, r.uncertainty.evaluated ? `${blocking}/${r.uncertainty.samples.length} plausible placements obstruct` : '');
    L.label(this.labels.unc, c.x, floorY(c.x, c.z) + 0.04, c.z + r.placement.uncertaintyRadius + 0.05);
  }

  private updateIntrusion(r: AnalysisResult): void {
    const L = this.layers.intrusion;
    L.clear();
    if (r.route.overlapPolygon.length >= 3) L.mesh(drapePolygon(r.route.overlapPolygon, 0.017), this.m.overlap, 10);
    if (r.door.overlapPolygon.length >= 3) L.mesh(drapePolygon(r.door.overlapPolygon, 0.018), this.m.overlap, 10);
  }

  private updateSearch(r: AnalysisResult): void {
    const L = this.layers.search;
    L.clear();
    const e = r.path.explored;
    const n = e.length / 2;
    if (n === 0) return;
    const stride = n > 9000 ? 2 : 1;
    const count = Math.floor(n / stride);
    const pos = new Float32Array(count * 3);
    const order = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = e[i * stride * 2];
      const z = e[i * stride * 2 + 1];
      pos[i * 3] = x;
      pos[i * 3 + 1] = floorY(x, z) + 0.02;
      pos[i * 3 + 2] = z;
      order[i] = i;
    }
    const geo = new BufferGeometry();
    geo.setAttribute('position', new Float32BufferAttribute(pos, 3));
    geo.setAttribute('aOrder', new Float32BufferAttribute(order, 1));
    this.searchCount = count;
    this.searchMaterial.uniforms.uCount.value = count;
    L.points(geo, this.searchMaterial);
  }

  private updateRoute(r: AnalysisResult, resolved: boolean): void {
    const L = this.layers.route;
    L.clear();
    this.pathLines = [];
    this.continuationLine = null;
    this.ribbonMesh = null;
    this.stopRing = null;
    const half = r.clearance.required / 2;
    const pts = r.path.found ? r.path.points : r.path.reachable;
    if (pts.length >= 2) {
      this.ribbonMesh = L.mesh(drapeRibbon(pts, half, 0.01), resolved ? this.m.ribbonClear : this.m.ribbon, 8);
      const rib = ribbonPolygon(pts, half);
      const n = pts.length;
      const left = rib.slice(0, n);
      const right = rib.slice(n).reverse();
      const edgeMat = resolved ? this.m.ribbonEdgeClear : this.m.ribbonEdge;
      this.pathLines.push(L.line(drapeLine(left, 0.02, false, 0.15), edgeMat));
      this.pathLines.push(L.line(drapeLine(right, 0.02, false, 0.15), edgeMat));
      this.pathLines.push(L.line(drapeLine(pts, 0.03, false, 0.12), resolved ? this.m.pathClear : this.m.path, 13));
      this.pathLines.push(L.line(drapeLine(pts, 0.032, false, 0.12), this.m.pathCore, 14));
    }
    if (!r.path.found) {
      if (r.path.blockedContinuation.length >= 2) {
        this.continuationLine = L.line(drapeLine(r.path.blockedContinuation, 0.03, false, 0.1), this.m.continuation, 13);
      }
      const sp = r.path.stopPoint;
      if (sp) {
        this.stopRing = L.line(drapeLine(circlePoints(sp, half, 56), 0.03, true, 0.05), this.m.stop, 14);
        this.labels.stop.set('Route blocked', r.path.failure?.code === 'PASSAGE_TOO_NARROW' ? `needs ${fmt(r.clearance.required)} m clear` : 'no connection');
        L.label(this.labels.stop, sp.x, floorY(sp.x, sp.z) + 1.35, sp.z);
      }
    }
  }

  private updateClearance(r: AnalysisResult): void {
    const L = this.layers.clearance;
    L.clear();
    const p = r.clearance.pinch;
    if (!p) return;
    const good = r.clearance.meetsRequirement;
    const mat = good ? this.m.dimensionGood : this.m.dimensionBad;
    const lift = 0.06;
    L.line(drapeLine([p.a, p.b], lift, false, 0.05), mat, 20);
    const dx = p.b.x - p.a.x;
    const dz = p.b.z - p.a.z;
    const len = Math.hypot(dx, dz) || 1;
    const nx = (-dz / len) * 0.07;
    const nz = (dx / len) * 0.07;
    for (const q of [p.a, p.b]) {
      const t1: Vec2 = { x: q.x + nx, z: q.z + nz };
      const t2: Vec2 = { x: q.x - nx, z: q.z - nz };
      L.line(drapeLine([t1, t2], lift, false, 0.05), mat, 20);
    }
    const mid = { x: (p.a.x + p.b.x) / 2, z: (p.a.z + p.b.z) / 2 };
    this.labels.pinch
      .setTone(good ? 'clear' : 'conflict')
      .set(`${fmt(r.clearance.width)} m`, `${good ? '≥' : '<'} ${fmt(r.clearance.required)} m required${r.clearance.method === 'grid' ? ` · ±${fmt(r.clearance.tolerance)}` : ''}`);
    L.label(this.labels.pinch, mid.x, floorY(mid.x, mid.z) + 0.55, mid.z);
  }

  // ── animation hooks ──────────────────────────────────────────────────────

  fadeTo(id: LayerId, value: number, duration = 0.8, delay = 0): gsap.core.Tween {
    const layer = this.layers[id];
    return gsap.to(layer, {
      fade: value,
      duration,
      delay,
      ease: 'power2.out',
      onUpdate: () => layer.setFade(layer.fade),
      overwrite: 'auto',
    });
  }

  setFade(id: LayerId, value: number): void {
    gsap.killTweensOf(this.layers[id]);
    this.layers[id].setFade(value);
  }

  setAll(value: number, except: LayerId[] = []): void {
    for (const id of Object.keys(this.layers) as LayerId[]) if (!except.includes(id)) this.setFade(id, value);
  }

  /** Draw the computed route progressively (0 → 1). */
  setPathProgress(p: number): void {
    this.pathProgress = p;
    for (const line of this.pathLines) {
      const g = line.geometry as LineGeometry;
      const total = (g.attributes.instanceStart?.count as number | undefined) ?? 0;
      g.instanceCount = Math.max(0, Math.round(total * p));
    }
    if (this.ribbonMesh) {
      const count = this.ribbonMesh.geometry.attributes.position.count;
      this.ribbonMesh.geometry.setDrawRange(0, Math.floor((count * p) / 3) * 3);
    }
    if (this.continuationLine) this.continuationLine.visible = p >= 0.999;
    if (this.stopRing) this.stopRing.visible = p >= 0.999;
  }

  setSearchProgress(p: number): void {
    this.searchMaterial.uniforms.uProgress.value = p;
  }

  get searchNodes(): number {
    return this.searchCount;
  }

  setLabelsVisible(v: boolean): void {
    for (const l of Object.values(this.labels)) l.el.style.display = v ? 'flex' : 'none';
  }

  /** Choose which labels the current act shows (the rest stay drawn but unlabelled). */
  showLabels(names: Array<keyof AnalysisOverlays['labels']> | 'all'): void {
    for (const [k, l] of Object.entries(this.labels)) l.setEnabled(names === 'all' || names.includes(k as keyof AnalysisOverlays['labels']));
  }

  tick(time: number): void {
    overlayUniforms.uTime.value = time;
    if (this.contactRing) this.m.contact.opacity = this.layers.door.fade * (0.55 + 0.45 * Math.sin(time * 6) ** 2);
    if (this.stopRing) this.m.stop.opacity = this.layers.route.fade * (0.6 + 0.4 * Math.sin(time * 4) ** 2);
    this.m.continuation.dashOffset = -time * 0.25;
    this.m.ribbonEdge.dashOffset = -time * 0.15;
    this.m.ribbonEdgeClear.dashOffset = -time * 0.15;
    this.m.safeEdge.dashOffset = -time * 0.05;
  }

  dispose(): void {
    for (const layer of Object.values(this.layers)) layer.clear();
    for (const mat of Object.values(this.m)) mat.dispose();
    this.searchMaterial.dispose();
  }
}
