import { Vector3 } from 'three';

export type ShotId = 'hero' | 'delivery' | 'analysis' | 'cutaway' | 'plan' | 'resolution';

export interface Shot {
  readonly position: Vector3;
  readonly target: Vector3;
  readonly fov: number;
}

/** Camera compositions (app world frame, meters). */
export const SHOTS: Record<ShotId, Shot> = {
  hero: { position: new Vector3(3.4, 1.55, 9.6), target: new Vector3(-0.15, 1.25, 0.6), fov: 36 },
  delivery: { position: new Vector3(-0.45, 1.3, 3.55), target: new Vector3(0.1, 0.5, 0.5), fov: 40 },
  analysis: { position: new Vector3(4.6, 7.4, 7.6), target: new Vector3(-0.15, 0.25, 1.9), fov: 34 },
  cutaway: { position: new Vector3(3.9, 4.6, 4.4), target: new Vector3(-0.1, 0.4, 0.55), fov: 38 },
  // Steep but not vertical, so "up" on screen stays toward the house.
  plan: { position: new Vector3(0, 10.8, 7.6), target: new Vector3(0, 0.2, 2.5), fov: 38 },
  resolution: { position: new Vector3(-1.75, 1.55, 9.9), target: new Vector3(0.2, 1.25, 0.5), fov: 35 },
};

export const SHOT_LABELS: Record<ShotId, string> = {
  hero: 'Hero',
  delivery: 'Delivery',
  analysis: 'Analysis',
  cutaway: 'Cutaway',
  plan: 'Plan',
  resolution: 'Resolution',
};
