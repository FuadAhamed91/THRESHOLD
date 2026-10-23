/**
 * Route-intrusion test: does the parcel footprint overlap the configured
 * accessible-route corridor? This is an area-overlap test (Sutherland–Hodgman
 * clipping of the corridor by the convex parcel footprint), not a proximity
 * heuristic: a parcel that merely touches the corridor edge does not intrude.
 */
import { clipPolygon, polygonArea } from './polygons';
import type { Polygon, RouteIntrusionResult } from './types';

/** Overlap below this area (m²) is treated as touching, not intruding (1 cm²). */
export const INTRUSION_AREA_EPSILON = 1e-4;

export function analyzeRouteIntrusion(corridor: Polygon, parcelFootprint: Polygon | null): RouteIntrusionResult {
  if (!parcelFootprint || parcelFootprint.length < 3) {
    return { intrudes: false, overlapArea: 0, overlapPolygon: [], footprintShare: 0 };
  }
  const overlap = clipPolygon(corridor, parcelFootprint);
  const area = overlap.length >= 3 ? polygonArea(overlap) : 0;
  const parcelArea = polygonArea(parcelFootprint);
  const intrudes = area > INTRUSION_AREA_EPSILON;
  return {
    intrudes,
    overlapArea: area,
    overlapPolygon: intrudes ? overlap : [],
    footprintShare: parcelArea > 0 ? Math.min(1, area / parcelArea) : 0,
  };
}
