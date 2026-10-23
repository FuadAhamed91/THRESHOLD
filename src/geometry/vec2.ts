import type { Vec2 } from './types';

export const EPS = 1e-9;

export const v2 = (x: number, z: number): Vec2 => ({ x, z });
export const add = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x + b.x, z: a.z + b.z });
export const sub = (a: Vec2, b: Vec2): Vec2 => ({ x: a.x - b.x, z: a.z - b.z });
export const scale = (a: Vec2, s: number): Vec2 => ({ x: a.x * s, z: a.z * s });
export const dot = (a: Vec2, b: Vec2): number => a.x * b.x + a.z * b.z;
/** 2D cross product (a.x·b.z − a.z·b.x). Positive when b lies at a larger plan angle than a. */
export const cross = (a: Vec2, b: Vec2): number => a.x * b.z - a.z * b.x;
export const length = (a: Vec2): number => Math.hypot(a.x, a.z);
export const distance = (a: Vec2, b: Vec2): number => Math.hypot(a.x - b.x, a.z - b.z);
export const lerp = (a: Vec2, b: Vec2, t: number): Vec2 => ({
  x: a.x + (b.x - a.x) * t,
  z: a.z + (b.z - a.z) * t,
});
export const midpoint = (a: Vec2, b: Vec2): Vec2 => lerp(a, b, 0.5);

export function normalize(a: Vec2): Vec2 {
  const l = length(a);
  return l < EPS ? { x: 0, z: 0 } : { x: a.x / l, z: a.z / l };
}

/** Unit vector at plan angle φ, measured from +X toward +Z. */
export const direction = (phi: number): Vec2 => ({ x: Math.cos(phi), z: Math.sin(phi) });

/** Plan angle of a vector, measured from +X toward +Z, in (−π, π]. */
export const angleOf = (a: Vec2): number => Math.atan2(a.z, a.x);

/** Rotate by plan angle φ (from +X toward +Z). */
export function rotate(p: Vec2, phi: number): Vec2 {
  const c = Math.cos(phi);
  const s = Math.sin(phi);
  return { x: p.x * c - p.z * s, z: p.x * s + p.z * c };
}

/**
 * Rotate using the Three.js `Object3D.rotation.y` convention, so a parcel's
 * plan footprint matches its mesh exactly: rotateYaw(p, yaw) === rotate(p, −yaw).
 */
export const rotateYaw = (p: Vec2, yaw: number): Vec2 => rotate(p, -yaw);

export const almostEqual = (a: number, b: number, eps = 1e-6): boolean => Math.abs(a - b) <= eps;

export const isFiniteVec = (p: Vec2 | undefined | null): p is Vec2 =>
  !!p && Number.isFinite(p.x) && Number.isFinite(p.z);
