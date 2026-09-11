import type { GeoCoordinate } from "@/types/location";
import {
  normalizeRawLocationTelemetryEvidence,
  rawLocationTelemetryIdentity,
  type RawLocationTelemetryEvidence,
} from "@/lib/locationTelemetry";

/** Matches the canonical current-location publication clock-skew allowance. */
export const LOCATION_HISTORY_MAX_FUTURE_SKEW_MS = 60_000;

export type LocationHistoryDenialReason =
  | "blocked"
  | "privacy_restricted"
  | "revoked"
  | "account_isolation"
  | "group_location_disabled"
  | "not_authorized";

export type LocationHistoryUnavailableReason =
  | "authority_unavailable"
  | "authority_identity_mismatch"
  | "history_not_configured"
  | "backend_unavailable"
  | "invalid_request";

export type LocationHistoryAvailability =
  | { state: "ready" }
  | { state: "empty" }
  | { state: "denied"; reason: LocationHistoryDenialReason }
  | { state: "unavailable"; reason: LocationHistoryUnavailableReason };

export type LocationHistoryPoint = RawLocationTelemetryEvidence & {
  /** Stable backend sample identity when persistence is configured. */
  sampleId?: string;
  personUserId: string;
  coordinate: GeoCoordinate;
  /** Original authoritative capture timestamp; route projections preserve it. */
  capturedAt: string;
  accuracyMeters?: number;
};

export type LocationHistorySpan =
  | { state: "authorized"; points: readonly LocationHistoryPoint[] }
  | { state: "denied"; reason: LocationHistoryDenialReason }
  | { state: "missing" };

export type PersonLocationHistory = {
  viewerUserId: string;
  personUserId: string;
  availability: LocationHistoryAvailability;
  /** Explicit boundaries prevent route projections from bridging unavailable data. */
  spans: readonly LocationHistorySpan[];
};

export function isExactPersonUserId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 128
    && value === value.trim();
}

export function isValidHistoryCoordinate(coordinate: GeoCoordinate): boolean {
  return Number.isFinite(coordinate.latitude)
    && coordinate.latitude >= -90
    && coordinate.latitude <= 90
    && Number.isFinite(coordinate.longitude)
    && coordinate.longitude >= -180
    && coordinate.longitude <= 180;
}

export function isValidLocationHistoryPoint(
  point: LocationHistoryPoint,
  expectedPersonUserId?: string,
  referenceTimeMs = Date.now(),
): boolean {
  const capturedAtMs = Date.parse(point.capturedAt);
  return (point.sampleId === undefined || isExactPersonUserId(point.sampleId))
    && isExactPersonUserId(point.personUserId)
    && (expectedPersonUserId === undefined || point.personUserId === expectedPersonUserId)
    && isValidHistoryCoordinate(point.coordinate)
    && typeof point.capturedAt === "string"
    && point.capturedAt.length > 0
    && Number.isFinite(capturedAtMs)
    && capturedAtMs <= referenceTimeMs + LOCATION_HISTORY_MAX_FUTURE_SKEW_MS
    && (point.accuracyMeters === undefined
      || (Number.isFinite(point.accuracyMeters)
        && point.accuracyMeters >= 0
        && point.accuracyMeters <= 100));
}

export function createLocationHistoryPoint(
  input: LocationHistoryPoint,
  referenceTimeMs = Date.now(),
): LocationHistoryPoint | null {
  if (!isValidLocationHistoryPoint(input, undefined, referenceTimeMs)) return null;
  const telemetry = normalizeRawLocationTelemetryEvidence({
    speed: input.nativeSpeedMps,
    speedAccuracy: input.nativeSpeedAccuracyMps,
    heading: input.nativeHeadingDegrees,
    headingAccuracy: input.nativeHeadingAccuracyDegrees,
    altitude: input.altitudeMeters,
    altitudeAccuracy: input.verticalAccuracyMeters,
    mocked: input.mocked,
  });
  return {
    ...(input.sampleId === undefined ? {} : { sampleId: input.sampleId }),
    personUserId: input.personUserId,
    coordinate: { ...input.coordinate },
    capturedAt: input.capturedAt,
    ...(input.accuracyMeters === undefined ? {} : { accuracyMeters: input.accuracyMeters }),
    ...telemetry,
  };
}

export function locationHistoryPointIdentity(point: LocationHistoryPoint): string {
  if (point.sampleId) return `${point.personUserId}:sample:${point.sampleId}`;
  return [
    point.personUserId,
    point.capturedAt,
    String(point.coordinate.latitude),
    String(point.coordinate.longitude),
    point.accuracyMeters ?? "",
  ].join(":");
}

/** Telemetry-aware identity is deliberately separate from route/sample
 * identity so adding sensor evidence can invalidate analytics without changing
 * coordinates, event membership, or dedupe semantics. */
export function locationHistoryTelemetryIdentity(
  points: readonly LocationHistoryPoint[],
): string {
  let hash = 2_166_136_261;
  for (const point of points) {
    const value = `${locationHistoryPointIdentity(point)}:${rawLocationTelemetryIdentity(point)}`;
    for (let index = 0; index < value.length; index += 1) {
      hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
    }
  }
  return `raw-location-v${points.some((point) => point.telemetryVersion) ? 1 : 0}:${(hash >>> 0).toString(16)}`;
}

/** Stable chronological ordering. Equal timestamps retain their source ordering. */
export function orderedLocationHistoryPoints(
  points: readonly LocationHistoryPoint[],
  expectedPersonUserId?: string,
  referenceTimeMs = Date.now(),
): LocationHistoryPoint[] {
  return points
    .map((point, sourceIndex) => ({ point: createLocationHistoryPoint(point, referenceTimeMs), sourceIndex }))
    .filter((entry): entry is { point: LocationHistoryPoint; sourceIndex: number } => (
      entry.point !== null
      && (expectedPersonUserId === undefined || entry.point.personUserId === expectedPersonUserId)
    ))
    .sort((left, right) => (
      Date.parse(left.point.capturedAt) - Date.parse(right.point.capturedAt)
      || left.sourceIndex - right.sourceIndex
    ))
    .map(({ point }) => point);
}
