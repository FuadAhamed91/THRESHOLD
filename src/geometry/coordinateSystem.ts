/**
 * Coordinate system and calibrated entrance layout.
 *
 * Frame (meters, right-handed, Y up), shared 1:1 by the geometry engine,
 * Three.js and the Blender export (Blender stores (x, −z, y); glTF converts):
 *   origin  outside face of the facade on the door centerline, at grade
 *   +X      to the right when facing the door from the street
 *   +Y      up (only used for presentation; the analysis is a plan analysis)
 *   +Z      away from the facade, toward the street
 *
 * Plan analysis works on (x, z). Angles in plan are measured from +X toward +Z.
 * Object yaw uses the Three.js `rotation.y` convention (see vec2.rotateYaw).
 */
import layoutJson from '../config/entrance-layout.json';
import type { Vec2 } from './types';

export const DEG = Math.PI / 180;

interface P2 {
  x: number;
  z: number;
}

export interface EntranceLayout {
  version: number;
  name: string;
  units: string;
  coordinateFrame: string;
  levels: { grade: number; landing: number };
  facade: { outerZ: number; thickness: number; xMin: number; xMax: number; height: number };
  doorOpening: { xMin: number; xMax: number; height: number; frameWidth: number };
  door: {
    label: string;
    hinge: P2;
    width: number;
    thickness: number;
    height: number;
    swing: 'out' | 'in';
    closedDirectionDeg: number;
    openingSense: 1 | -1;
    requiredOpeningDeg: number;
    undercut: number;
  };
  landing: { xMin: number; xMax: number; zMin: number; zMax: number };
  ramp: {
    xMin: number;
    xMax: number;
    zTop: number;
    zBottom: number;
    curbWidth: number;
    curbHeight: number;
    handrailHeight: number;
  };
  walkway: { xMin: number; xMax: number; zMin: number; zMax: number };
  foyer: { xMin: number; xMax: number; zMin: number };
  planters: Array<{ id: string; label: string; center: P2; size: number; height: number }>;
  route: { label: string; corridor: P2[]; corridorNote: string; start: P2; goal: P2 };
  safeDropZone: { label: string; polygon: P2[]; suggestedParcelCenter: P2 };
  requiredClearWidth: number;
  dropPrior: { label: string; center: P2; radius: number; yawDeg: number; note: string };
  parcel: { size: { width: number; depth: number; height: number } };
  ringDoorbell: {
    label: string;
    position: { x: number; y: number; z: number };
    lookAt: { x: number; y: number; z: number };
    fovDeg: number;
  };
  fixtures: {
    sconces: Array<{ x: number; y: number; z: number }>;
    downlights: Array<{ x: number; y: number; z: number }>;
    bollards: Array<{ x: number; z: number }>;
    interior: { x: number; y: number; z: number };
  };
  analysisGrid: { spacing: number };
}

export const DEFAULT_LAYOUT = layoutJson as EntranceLayout;

/**
 * Height of the walking surface at a plan point. Used to drape overlays and to
 * place the parcel and avatar; the clearance analysis itself is two-dimensional.
 */
export function floorHeightAt(layout: EntranceLayout, x: number, z: number): number {
  const { grade, landing } = layout.levels;
  const r = layout.ramp;
  const platformXMin = Math.min(layout.landing.xMin, layout.foyer.xMin);
  const platformXMax = Math.max(layout.landing.xMax, layout.foyer.xMax);
  if (z <= r.zTop + 1e-9 && z >= layout.foyer.zMin - 1e-9 && x >= platformXMin - 1e-9 && x <= platformXMax + 1e-9) {
    return landing;
  }
  const rampXMin = r.xMin - r.curbWidth;
  const rampXMax = r.xMax + r.curbWidth;
  if (z > r.zTop && z < r.zBottom && x >= rampXMin && x <= rampXMax) {
    const t = (z - r.zTop) / (r.zBottom - r.zTop);
    return landing + (grade - landing) * t;
  }
  return grade;
}

/** Plan z-values where the walking surface changes slope (overlays are split there). */
export function floorCreases(layout: EntranceLayout): number[] {
  return [layout.ramp.zTop, layout.ramp.zBottom];
}

/** Ramp pitch in radians (positive = rising toward −Z, i.e. toward the door). */
export function rampPitch(layout: EntranceLayout): number {
  const r = layout.ramp;
  return Math.atan2(layout.levels.landing - layout.levels.grade, r.zBottom - r.zTop);
}

export function toWorld(layout: EntranceLayout, p: Vec2, lift = 0): [number, number, number] {
  return [p.x, floorHeightAt(layout, p.x, p.z) + lift, p.z];
}
