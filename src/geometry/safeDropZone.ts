/**
 * Safe-drop-zone containment. The parcel counts as inside only when its whole
 * footprint lies within the zone. Containment says nothing about the route or
 * the door: those are recomputed independently after every move.
 */
import { clipPolygon, polygonArea, polygonContainsPolygon } from './polygons';
import type { Polygon, SafeZoneResult } from './types';

export function analyzeSafeDropZone(zone: Polygon, parcelFootprint: Polygon | null): SafeZoneResult {
  if (!parcelFootprint || parcelFootprint.length < 3) return { contained: false, overlapFraction: 0 };
  const overlap = clipPolygon(parcelFootprint, zone); // zone is validated convex
  const area = overlap.length >= 3 ? polygonArea(overlap) : 0;
  const parcelArea = polygonArea(parcelFootprint);
  const fraction = parcelArea > 0 ? Math.min(1, area / parcelArea) : 0;
  return {
    contained: polygonContainsPolygon(zone, parcelFootprint, 1e-9),
    overlapFraction: fraction,
  };
}
