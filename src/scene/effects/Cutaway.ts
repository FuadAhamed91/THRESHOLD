import gsap from 'gsap';
import {
  AdditiveBlending,
  DoubleSide,
  EdgesGeometry,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  type Material,
  type MeshStandardMaterial,
} from 'three';

/** Fade order: what hides the entrance most goes first. Unlisted meshes fade last. */
const ORDER: Array<[RegExp, number]> = [
  [/^Canopy/, 0],
  [/^Light_Fixtures/, 0.05],
  [/^Facade_Wall/, 0.08],
  [/^(Sidelight|House_Number|SafeDropZone_Sign)/, 0.12],
  [/^Window/, 0.16],
  [/^Slat_Screen/, 0.2],
  [/^(Upper|Roof)/, 0.26],
  [/^Facade_Side/, 0.32],
];

/** Only the large architectural masses get X-ray edges; details simply dissolve. */
const XRAY = /^(Facade_Wall|Facade_Side|Canopy$|Roof_Slab|Upper_Volume)/;

interface Entry {
  mesh: Mesh;
  materials: MeshStandardMaterial[];
  baseOpacity: number[];
  edges: LineSegments | null;
  shell: Mesh | null;
  delay: number;
}

/**
 * Selective architectural cutaway. Walls dissolve in a staggered sequence into
 * an X-ray of their edges, so the analytical overlays can be read in context
 * of the real architecture. Materials are cloned per mesh so shared materials
 * on non-cutaway objects are never affected.
 */
export class CutawayController {
  readonly group = new Group();
  amount = 0;
  private entries: Entry[] = [];
  private edgeMaterial = new LineBasicMaterial({ color: '#8fd3ff', transparent: true, opacity: 0, depthWrite: false, blending: AdditiveBlending });
  private shellMaterial = new MeshBasicMaterial({ color: '#2b6fd8', transparent: true, opacity: 0, depthWrite: false, side: DoubleSide, blending: AdditiveBlending });

  constructor(meshes: Mesh[]) {
    this.group.name = 'Cutaway';
    for (const mesh of meshes) {
      mesh.updateWorldMatrix(true, false);
      const mats = (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).map((m: Material) => m.clone() as MeshStandardMaterial);
      mesh.material = Array.isArray(mesh.material) ? mats : mats[0];
      let edges: LineSegments | null = null;
      let shell: Mesh | null = null;
      if (XRAY.test(mesh.name)) {
        edges = new LineSegments(new EdgesGeometry(mesh.geometry, 28), this.edgeMaterial);
        edges.applyMatrix4(mesh.matrixWorld);
        edges.userData.excludeFromAO = true;
        edges.raycast = () => {};
        shell = new Mesh(mesh.geometry, this.shellMaterial);
        shell.applyMatrix4(mesh.matrixWorld);
        shell.userData.excludeFromAO = true;
        shell.renderOrder = 2;
        shell.visible = false;
        shell.raycast = () => {};
        this.group.add(edges, shell);
      }
      const delay = ORDER.find(([re]) => re.test(mesh.name))?.[1] ?? 0.36;
      this.entries.push({ mesh, materials: mats, baseOpacity: mats.map((m) => m.opacity), edges, shell, delay });
    }
    this.apply(0);
  }

  private apply(a: number): void {
    const maxDelay = 0.36;
    let anyEdges = 0;
    for (const e of this.entries) {
      const l = Math.min(1, Math.max(0, (a - e.delay) / (1 - maxDelay)));
      e.materials.forEach((m, i) => {
        const transparent = l > 0.001;
        if (m.transparent !== transparent) {
          m.transparent = transparent;
          m.needsUpdate = true;
        }
        m.opacity = e.baseOpacity[i] * (1 - 0.97 * l);
        m.depthWrite = l < 0.4;
      });
      e.mesh.visible = l < 0.995;
      e.mesh.castShadow = l < 0.5 && e.mesh.userData.castShadowDefault !== false;
      if (e.shell) e.shell.visible = l > 0.01;
      anyEdges = Math.max(anyEdges, l);
    }
    this.edgeMaterial.opacity = 0.32 * anyEdges;
    this.shellMaterial.opacity = 0.035 * anyEdges;
    this.group.visible = anyEdges > 0.005;
  }

  set(a: number): void {
    gsap.killTweensOf(this);
    this.amount = a;
    this.apply(a);
  }

  animateTo(target: number, duration = 2.4): gsap.core.Tween {
    return gsap.to(this, {
      amount: target,
      duration,
      ease: 'power2.inOut',
      overwrite: 'auto',
      onUpdate: () => this.apply(this.amount),
    });
  }

  dispose(): void {
    for (const e of this.entries) e.edges?.geometry.dispose();
    this.edgeMaterial.dispose();
    this.shellMaterial.dispose();
  }
}
