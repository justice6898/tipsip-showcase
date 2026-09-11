import type { GeoCoordinate } from "@/types/location";

/** Version of the normalized raw-source contract. This is not an analytics version. */
export const LOCATION_TELEMETRY_VERSION = 1 as const;

/** One centralized validation policy for native location source facts. */
export const LOCATION_TELEMETRY_LIMITS = Object.freeze({
  minimumLatitude: -90,
  maximumLatitude: 90,
  minimumLongitude: -180,
  maximumLongitude: 180,
  minimumAltitudeMeters: -500,
  maximumAltitudeMeters: 20_000,
  /** Covers commercial air travel while rejecting corrupt native values. */
  maximumNativeSpeedMps: 400,
  /** Poor accuracy is evidence too; this bound rejects infinities/corrupt magnitudes. */
  maximumAccuracyMeters: 1_000_000,
});

export type LocationTelemetrySource = "expo_location" | "development_fixture";

/** Optional facts supplied by the native/provider observation itself.
 * None of these values are inferred from coordinate deltas. */
export type RawLocationTelemetryEvidence = Readonly<{
  nativeSpeedMps?: number;
  nativeSpeedAccuracyMps?: number;
  nativeHeadingDegrees?: number;
  nativeHeadingAccuracyDegrees?: number;
  altitudeMeters?: number;
  verticalAccuracyMeters?: number;
  /** Expo exposes this observation property on Android, not iOS. */
  mocked?: boolean;
  telemetryVersion?: typeof LOCATION_TELEMETRY_VERSION;
}>;

/** The sole normalized output of the current native location acquisition path. */
export type CanonicalLocationObservation = RawLocationTelemetryEvidence & Readonly<{
  coordinate: GeoCoordinate;
  observedAtMs: number;
  /** Null means the provider did not supply a valid horizontal accuracy. */
  accuracyMeters: number | null;
  source: LocationTelemetrySource;
}>;

export type NativeLocationObservationInput = Readonly<{
  timestamp: unknown;
  mocked?: unknown;
  coords: Readonly<{
    latitude: unknown;
    longitude: unknown;
    accuracy: unknown;
    altitude?: unknown;
    altitudeAccuracy?: unknown;
    heading?: unknown;
    speed?: unknown;
    /** Not exposed by Expo Location 55; retained for provider-neutral future inputs. */
    speedAccuracy?: unknown;
    /** Not exposed by Expo Location 55; retained for provider-neutral future inputs. */
    headingAccuracy?: unknown;
  }>;
}>;

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validAccuracy(value: unknown): value is number {
  return finite(value)
    && value >= 0
    && value <= LOCATION_TELEMETRY_LIMITS.maximumAccuracyMeters;
}

function normalizeHeading(value: unknown): number | null {
  if (!finite(value) || value < 0 || value > 360) return null;
  return value === 360 ? 0 : value;
}

function hasTelemetryEvidence(value: Omit<RawLocationTelemetryEvidence, "telemetryVersion">): boolean {
  return Object.keys(value).length > 0;
}

/** Optional fields fail independently. A corrupt optional sensor value never
 * changes a valid coordinate, timestamp, or another valid source fact. */
export function normalizeRawLocationTelemetryEvidence(input: Readonly<{
  speed?: unknown;
  speedAccuracy?: unknown;
  heading?: unknown;
  headingAccuracy?: unknown;
  altitude?: unknown;
  altitudeAccuracy?: unknown;
  mocked?: unknown;
}>): RawLocationTelemetryEvidence {
  const nativeSpeedMps = finite(input.speed)
    && input.speed >= 0
    && input.speed <= LOCATION_TELEMETRY_LIMITS.maximumNativeSpeedMps
      ? input.speed
      : null;
  const nativeSpeedAccuracyMps = validAccuracy(input.speedAccuracy)
    ? input.speedAccuracy
    : null;
  const nativeHeadingDegrees = normalizeHeading(input.heading);
  const nativeHeadingAccuracyDegrees = validAccuracy(input.headingAccuracy)
    ? input.headingAccuracy
    : null;
  const altitudeMeters = finite(input.altitude)
    && input.altitude >= LOCATION_TELEMETRY_LIMITS.minimumAltitudeMeters
    && input.altitude <= LOCATION_TELEMETRY_LIMITS.maximumAltitudeMeters
      ? input.altitude
      : null;
  const verticalAccuracyMeters = validAccuracy(input.altitudeAccuracy)
    ? input.altitudeAccuracy
    : null;
  const evidence: Omit<RawLocationTelemetryEvidence, "telemetryVersion"> = {
    ...(nativeSpeedMps === null ? {} : { nativeSpeedMps }),
    ...(nativeSpeedAccuracyMps === null ? {} : { nativeSpeedAccuracyMps }),
    ...(nativeHeadingDegrees === null ? {} : { nativeHeadingDegrees }),
    ...(nativeHeadingAccuracyDegrees === null ? {} : { nativeHeadingAccuracyDegrees }),
    ...(altitudeMeters === null ? {} : { altitudeMeters }),
    ...(verticalAccuracyMeters === null ? {} : { verticalAccuracyMeters }),
    ...(typeof input.mocked === "boolean" ? { mocked: input.mocked } : {}),
  };
  return hasTelemetryEvidence(evidence)
    ? { ...evidence, telemetryVersion: LOCATION_TELEMETRY_VERSION }
    : {};
}

/** Strictly normalizes one native observation exactly once at acquisition. */
export function normalizeCanonicalLocationObservation(
  input: NativeLocationObservationInput,
  source: LocationTelemetrySource = "expo_location",
): CanonicalLocationObservation | null {
  const { coords } = input;
  if (
    !finite(coords.latitude)
    || coords.latitude < LOCATION_TELEMETRY_LIMITS.minimumLatitude
    || coords.latitude > LOCATION_TELEMETRY_LIMITS.maximumLatitude
    || !finite(coords.longitude)
    || coords.longitude < LOCATION_TELEMETRY_LIMITS.minimumLongitude
    || coords.longitude > LOCATION_TELEMETRY_LIMITS.maximumLongitude
    || !finite(input.timestamp)
    || input.timestamp <= 0
  ) return null;
  // Expo iOS derives this value from CLLocation's sub-millisecond NSDate
  // precision. JavaScript Date/ISO persistence has integer-millisecond
  // precision, so canonicalize it exactly once before any consumer builds an
  // identity or durable record from it. This preserves the represented instant
  // without fabricating time and keeps every downstream timestamp comparison
  // on the same precision contract.
  const observedAtMs = new Date(input.timestamp).getTime();
  if (!Number.isFinite(observedAtMs) || observedAtMs <= 0) return null;
  return {
    coordinate: { latitude: coords.latitude, longitude: coords.longitude },
    observedAtMs,
    accuracyMeters: validAccuracy(coords.accuracy) ? coords.accuracy : null,
    ...normalizeRawLocationTelemetryEvidence({
      speed: coords.speed,
      speedAccuracy: coords.speedAccuracy,
      heading: coords.heading,
      headingAccuracy: coords.headingAccuracy,
      altitude: coords.altitude,
      altitudeAccuracy: coords.altitudeAccuracy,
      mocked: input.mocked,
    }),
    source,
  };
}

/** Stable bounded identity for caches that may later consume raw telemetry. */
export function rawLocationTelemetryIdentity(
  input: RawLocationTelemetryEvidence,
): string {
  return [
    input.telemetryVersion ?? 0,
    input.nativeSpeedMps ?? "",
    input.nativeSpeedAccuracyMps ?? "",
    input.nativeHeadingDegrees ?? "",
    input.nativeHeadingAccuracyDegrees ?? "",
    input.altitudeMeters ?? "",
    input.verticalAccuracyMeters ?? "",
    input.mocked === undefined ? "" : Number(input.mocked),
  ].join("|");
}
