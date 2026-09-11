import type { GeoCoordinate } from "@/types/location";
import type {
  CanonicalLocationObservation,
  RawLocationTelemetryEvidence,
} from "@/lib/locationTelemetry";

/** Existing foreground transmitter policy, now shared by acquisition, Map, and Planner. */
export const CURRENT_LOCATION_MAX_AGE_MS = 60_000;
export const CURRENT_LOCATION_MAX_FUTURE_SKEW_MS = 60_000;
export const CURRENT_LOCATION_MAX_ACCURACY_METERS = 100;
export const CURRENT_LOCATION_ACQUISITION_TIMEOUT_MS = 12_000;

export type CurrentLocationObservation = CanonicalLocationObservation;

export type AcceptedCurrentLocationObservation = RawLocationTelemetryEvidence & {
  coordinate: GeoCoordinate;
  accuracyMeters: number;
  observedAtMs: number;
  source: CanonicalLocationObservation["source"];
};

type AssessableCurrentLocationObservation = {
  coordinate: GeoCoordinate;
  accuracyMeters: number | null;
  observedAtMs: number;
};

export type LocationObservationRejection =
  | "invalid_coordinate"
  | "invalid_timestamp"
  | "future"
  | "stale"
  | "low_accuracy";

export type LocationObservationAssessment<T extends AssessableCurrentLocationObservation = CurrentLocationObservation> =
  | { accepted: true; observation: T & { accuracyMeters: number } }
  | { accepted: false; reason: LocationObservationRejection };

export function isValidGeoCoordinate(
  coordinate: GeoCoordinate | null | undefined,
): coordinate is GeoCoordinate {
  return Boolean(
    coordinate
    && Number.isFinite(coordinate.latitude)
    && coordinate.latitude >= -90
    && coordinate.latitude <= 90
    && Number.isFinite(coordinate.longitude)
    && coordinate.longitude >= -180
    && coordinate.longitude <= 180,
  );
}

export function assessCurrentLocationObservation<T extends AssessableCurrentLocationObservation>(
  observation: T,
  nowMs = Date.now(),
): LocationObservationAssessment<T> {
  return assessLocationObservationWithinAge(observation, CURRENT_LOCATION_MAX_AGE_MS, nowMs);
}

/** A malformed, poor-accuracy, or failed replacement reading is not a
 * revocation of a previously accepted observation. Retention is permitted
 * only while the existing observation still passes the one canonical live
 * freshness/accuracy authority. */
export function shouldRetainCurrentLocationAfterTransientFailure(
  current: AcceptedCurrentLocationObservation | null | undefined,
  nowMs = Date.now(),
): current is AcceptedCurrentLocationObservation {
  return Boolean(current && assessCurrentLocationObservation(current, nowMs).accepted);
}

/** Uses the same coordinate, timestamp, future-skew, and accuracy authority as
 * current-location projection while allowing a caller-owned durable replay
 * age. This is required for delayed native background batches; it does not
 * make an old observation eligible for the live map or foreground publisher. */
export function assessLocationObservationWithinAge<T extends AssessableCurrentLocationObservation>(
  observation: T,
  maximumAgeMs: number,
  nowMs = Date.now(),
): LocationObservationAssessment<T> {
  if (!isValidGeoCoordinate(observation.coordinate)) {
    return { accepted: false, reason: "invalid_coordinate" };
  }
  if (!Number.isFinite(observation.observedAtMs) || observation.observedAtMs <= 0) {
    return { accepted: false, reason: "invalid_timestamp" };
  }
  if (observation.observedAtMs - nowMs > CURRENT_LOCATION_MAX_FUTURE_SKEW_MS) {
    return { accepted: false, reason: "future" };
  }
  if (
    !Number.isFinite(maximumAgeMs)
    || maximumAgeMs < 0
    || nowMs - observation.observedAtMs > maximumAgeMs
  ) {
    return { accepted: false, reason: "stale" };
  }
  if (
    observation.accuracyMeters === null
    || !Number.isFinite(observation.accuracyMeters)
    || observation.accuracyMeters < 0
    || observation.accuracyMeters > CURRENT_LOCATION_MAX_ACCURACY_METERS
  ) {
    return { accepted: false, reason: "low_accuracy" };
  }
  return { accepted: true, observation: observation as T & { accuracyMeters: number } };
}

export type TransientLocationFailureDisposition =
  | "retain_live"
  | "retain_owner_presentation_only"
  | "clear_all";

/** Separates the strict live observation from the owner's same-runtime map/card
 * snapshot. The retained branch cannot authorize publication or persistence. */
export function resolveTransientLocationFailureDisposition(input: Readonly<{
  currentObservation: AcceptedCurrentLocationObservation | null;
  selfPresentationObservation: AcceptedCurrentLocationObservation | null;
  nowMs?: number;
}>): TransientLocationFailureDisposition {
  const nowMs = input.nowMs ?? Date.now();
  if (shouldRetainCurrentLocationAfterTransientFailure(input.currentObservation, nowMs)) {
    return "retain_live";
  }
  if (input.selfPresentationObservation && assessLocationObservationWithinAge(
    input.selfPresentationObservation,
    Number.MAX_SAFE_INTEGER,
    nowMs,
  ).accepted) {
    return "retain_owner_presentation_only";
  }
  return "clear_all";
}
