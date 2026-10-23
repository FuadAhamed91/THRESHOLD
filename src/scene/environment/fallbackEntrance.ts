import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import { DEFAULT_LAYOUT } from '../../geometry/coordinateSystem';

/**
 * Procedural massing model built from the same calibrated layout, used only if
 * the Blender GLB cannot be loaded. It keeps the analysis meaningful (same
 * coordinates) while signalling a degraded visual mode.
 */
export function buildFallbackEntrance(): Object3D {
  const L = DEFAULT_LAYOUT;
  const g = new Group();
  const mat = (color: string, roughness = 0.8) => new MeshStandardMaterial({ color, roughness });
  const box = (name: string, x: number, y: number, z: number, sx: number, sy: number, sz: number, m: MeshStandardMaterial, role?: string) => {
    const mesh = new Mesh(new BoxGeometry(sx, sy, sz), m);
    mesh.position.set(x, y, z);
    mesh.name = name;
    if (role) mesh.userData.threshold_role = role;
    g.add(mesh);
    return mesh;
  };
  const top = L.levels.landing;
  const f = L.facade;
  const d = L.doorOpening;
  const wall = mat('#5a5550');
  box('Facade_Left', (f.xMin + d.xMin) / 2, f.height / 2, -f.thickness / 2, d.xMin - f.xMin, f.height, f.thickness, wall, 'cutaway');
  box('Facade_Right', (d.xMax + f.xMax) / 2, f.height / 2, -f.thickness / 2, f.xMax - d.xMax, f.height, f.thickness, wall, 'cutaway');
  box('Facade_Head', 0, (top + d.height + f.height) / 2, -f.thickness / 2, d.xMax - d.xMin, f.height - top - d.height, f.thickness, wall, 'cutaway');
  const ld = L.landing;
  box('Landing', (ld.xMin + ld.xMax) / 2, top / 2, (ld.zMin + ld.zMax) / 2, ld.xMax - ld.xMin, top, ld.zMax - ld.zMin, mat('#3b3a38', 0.6));
  const r = L.ramp;
  const rampLen = r.zBottom - r.zTop;
  const ramp = box('Ramp', 0, top / 2 - 0.02, (r.zTop + r.zBottom) / 2, r.xMax - r.xMin, 0.05, Math.hypot(rampLen, top), mat('#3b3a38', 0.6));
  ramp.rotation.x = Math.atan2(top, rampLen);
  const w = L.walkway;
  box('Walkway', 0, -0.02, (w.zMin + 12) / 2, w.xMax - w.xMin, 0.04, 12 - w.zMin, mat('#4a4844', 0.7));
  box('Lawn', 0, -0.05, 4.5, 30, 0.04, 21, mat('#0f1a0c', 0.95));
  for (const p of L.planters) box(p.id, p.center.x, top + p.height / 2, p.center.z, p.size, p.height, p.size, mat('#222428'));
  const pivot = new Group();
  pivot.name = 'Door_Pivot';
  pivot.position.set(L.door.hinge.x, top, L.door.hinge.z);
  const leaf = new Mesh(new BoxGeometry(L.door.width, L.door.height, L.door.thickness), mat('#3a2616', 0.5));
  leaf.position.set(L.door.width / 2, L.door.height / 2, -L.door.thickness / 2);
  pivot.add(leaf);
  g.add(pivot);
  return g;
}
