import { LOCATION_TELEMETRY_LIMITS } from "@/lib/locationTelemetry";

export const MOBILITY_KINEMATICS_VERSION = 1 as const;

/** Layered physical policy: acquisition retains physically possible evidence,
 * route continuity rejects isolated corruption, and mode inference applies its
 * own terrestrial/rail/flight eligibility rules. */
export const MOBILITY_KINEMATICS_POLICY = Object.freeze({
  minimumIntervalMs: 1_000,
  maximumRecordingIntervalMs: 5 * 60_000,
  maximumUsableHorizontalAccuracyMeters: 65,
  maximumHighSpeedHorizontalAccuracyMeters: 30,
  minimumSignalDistanceMeters: 3,
  accuracySignalRatio: 0.5,
  terrestrialSpeedCeilingMps: 70,
  physicallyRetainableSpeedCeilingMps: LOCATION_TELEMETRY_LIMITS.maximumNativeSpeedMps,
  minimumSuspiciousJumpMeters: 500,
  minimumTerrestrialSpikeSpeedMps: 25,
  terrestrialSpikeNeighborRatio: 0.6,
  highSpeedCorroborationRatio: 2.5,
  highSpeedMaximumBearingChangeDegrees: 45,
  minimumSummaryIntervals: 2,
  validatedPeakNeighborRatio: 0.6,
  maximumSeriesPointCount: 240,
  minimumPaceDistanceMeters: 100,
  minimumPaceSecondsPerKilometer: 120,
  maximumPaceSecondsPerKilometer: 3_600,
});
