import {
  isValidLocationHistoryPoint,
  orderedLocationHistoryPoints,
  type LocationHistoryPoint,
  type LocationHistorySpan,
} from "@/features/locationHistory/domain";
import { canonicalRouteIntervalBreakReason } from "@/features/locationHistory/mobilityKinematics";
import { MOBILITY_KINEMATICS_POLICY } from "@/features/locationHistory/mobilityKinematicsPolicy";
import { SELF_STAY_EVIDENCE_POLICY } from "@/features/locationHistory/selfStayEvidence";
import { haversineDistanceMeters } from "@/lib/geoDistance";

export const DEFAULT_HISTORY_ROUTE_GAP_MS = 5 * 60_000;
export const LOCATION_HISTORY_ROUTE_CONTINUITY = Object.freeze({
  maximumPlausibleSpeedMetersPerSecond: MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps,
  maximumPhysicallyRetainableSpeedMetersPerSecond: MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps,
  minimumSuspiciousJumpMeters: MOBILITY_KINEMATICS_POLICY.minimumSuspiciousJumpMeters,
  poorAccuracyMeters: 50,
});

export type LocationHistoryRouteSegment = Readonly<{
  points: readonly LocationHistoryPoint[];
}>;

export type LocationHistoryRoute = Readonly<{
  personUserId: string;
  segments: readonly LocationHistoryRouteSegment[];
}>;

function isExactDuplicate(left: LocationHistoryPoint, right: LocationHistoryPoint): boolean {
  return left.personUserId === right.personUserId
    && left.capturedAt === right.capturedAt
    && left.coordinate.latitude === right.coordinate.latitude
    && left.coordinate.longitude === right.coordinate.longitude
    && left.accuracyMeters === right.accuracyMeters;
}

function isImpossibleJump(left: LocationHistoryPoint, right: LocationHistoryPoint): boolean {
  return canonicalRouteIntervalBreakReason([left, right], 0) !== null;
}

function isSparseStationaryInterval(left: LocationHistoryPoint, right: LocationHistoryPoint): boolean {
  const elapsedMs = Date.parse(right.capturedAt) - Date.parse(left.capturedAt);
  if (elapsedMs <= 0 || elapsedMs > SELF_STAY_EVIDENCE_POLICY.maximumSparseLocationGapMs) return false;
  const accuracyAllowance = Math.min(
    SELF_STAY_EVIDENCE_POLICY.maximumAccuracyAllowanceMeters,
    Math.max(left.accuracyMeters ?? 0, right.accuracyMeters ?? 0),
  );
  return haversineDistanceMeters(left.coordinate, right.coordinate)
    <= SELF_STAY_EVIDENCE_POLICY.stayRadiusMeters + accuracyAllowance;
}

/** Removes only an isolated, poor-accuracy middle spike when both detours are
 * impossible and the direct neighboring continuity is plausible. */
export function rejectLocationHistoryMiddleOutliers(
  points: readonly LocationHistoryPoint[],
): LocationHistoryPoint[] {
  if (points.length < 3) return [...points];
  return points.filter((candidate, index) => {
    if (index === 0 || index === points.length - 1) return true;
    const previous = points[index - 1];
    const next = points[index + 1];
    return !(
      (candidate.accuracyMeters ?? 0) >= LOCATION_HISTORY_ROUTE_CONTINUITY.poorAccuracyMeters
      && isImpossibleJump(previous, candidate)
      && isImpossibleJump(candidate, next)
      && !isImpossibleJump(previous, next)
    );
  });
}

export function projectLocationHistoryRoute(input: {
  personUserId: string;
  spans: readonly LocationHistorySpan[];
  maximumContinuousGapMs?: number;
  /** Self-only product option: two real same-cluster observations can retain a
   * sparse stationary interval without asserting a route through an unknown
   * moving gap. Friend/default history preserves the legacy gap contract. */
  retainSparseStationaryIntervals?: boolean;
  referenceTimeMs?: number;
}): LocationHistoryRoute {
  const gap = Number.isFinite(input.maximumContinuousGapMs)
    ? Math.max(0, input.maximumContinuousGapMs!)
    : DEFAULT_HISTORY_ROUTE_GAP_MS;
  const segments: LocationHistoryRouteSegment[] = [];

  for (const span of input.spans) {
    if (span.state !== "authorized") continue;
    const points = rejectLocationHistoryMiddleOutliers(
      orderedLocationHistoryPoints(span.points, input.personUserId, input.referenceTimeMs)
        .filter((point) => isValidLocationHistoryPoint(point, input.personUserId, input.referenceTimeMs)),
    );
    let current: LocationHistoryPoint[] = [];
    for (let pointIndex = 0; pointIndex < points.length; pointIndex += 1) {
      const point = points[pointIndex];
      const previous = current[current.length - 1];
      if (previous && isExactDuplicate(previous, point)) continue;
      const temporalGap = previous
        ? Date.parse(point.capturedAt) - Date.parse(previous.capturedAt) > gap
        : false;
      const retainedSparseStay = Boolean(
        previous
        && input.retainSparseStationaryIntervals
        && temporalGap
        && isSparseStationaryInterval(previous, point),
      );
      const intervalBreakReason = previous
        ? canonicalRouteIntervalBreakReason(points, pointIndex - 1)
        : null;
      if (previous && (
        (temporalGap && !retainedSparseStay)
        || (intervalBreakReason !== null
          && !(retainedSparseStay && intervalBreakReason === "recording_gap"))
      )) {
        if (current.length > 0) segments.push({ points: current });
        current = [];
      }
      current.push(point);
    }
    if (current.length > 0) segments.push({ points: current });
  }

  return { personUserId: input.personUserId, segments };
}
