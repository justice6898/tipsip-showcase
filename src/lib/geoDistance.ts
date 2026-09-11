import type { GeoCoordinate } from "@/types/location";
// The private application imports this helper through a broader shared barrel.
// The showcase points directly at the one included, public-safe module so the
// selected mobility slice stays dependency-closed.
import { calculatePlanningDistanceMeters } from "@shared/planning/publicCandidatePolicy";

export function isValidCoordinate(coordinate: GeoCoordinate): boolean {
  return (
    Number.isFinite(coordinate.latitude) &&
    Number.isFinite(coordinate.longitude) &&
    Math.abs(coordinate.latitude) <= 90 &&
    Math.abs(coordinate.longitude) <= 180
  );
}

export function haversineDistanceMeters(
  left: GeoCoordinate,
  right: GeoCoordinate,
): number {
  return calculatePlanningDistanceMeters(left, right);
}
