import { MOBILITY_KINEMATICS_POLICY } from "@/features/locationHistory/mobilityKinematicsPolicy";

/**
 * Phase 5.4 inference policy. Every physical threshold, temporal gate, and
 * confidence boundary lives here so classification behavior is reviewable and
 * versioned independently from collection and presentation.
 */
export const MOBILITY_INFERENCE_VERSION = 1 as const;

export const MOBILITY_FEATURE_POLICY = Object.freeze({
  targetFrameDurationMs: 20_000,
  maximumFrameDurationMs: 45_000,
  maximumFrameSampleCount: 10,
  minimumFrameDurationMs: 5_000,
  maximumContinuousIntervalMs: MOBILITY_KINEMATICS_POLICY.maximumRecordingIntervalMs,
  maximumHorizontalAccuracyMeters: 50,
  excellentHorizontalAccuracyMeters: 15,
  maximumVerticalAccuracyMeters: 40,
  maximumPlausibleSpeedMps: MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps,
  minimumDisplacementMeters: 4,
  accuracySignalRatio: 0.75,
  minimumTrustworthyIntervals: 1,
  minimumTrustworthyIntervalShare: 0.5,
  maximumNativeSpeedAccuracyMps: 5,
  stationaryMaximumSpeedMps: 0.55,
  stationaryMaximumDisplacementMeters: 12,
  walkingSpeedRangeMps: [0.55, 2.6] as const,
  runningSpeedRangeMps: [2.1, 6.5] as const,
  bicycleSpeedRangeMps: [2.8, 13] as const,
  roadVehicleMinimumSpeedMps: 4.5,
  railMinimumSpeedMps: 11,
  flightMinimumSpeedMps: 55,
  flightMinimumAltitudeMeters: 1_500,
  flightMinimumVerticalSpeedMps: 2,
  walkingCadenceRangeSpm: [45, 150] as const,
  runningCadenceMinimumSpm: 125,
  minimumDirectionalConsistency: 0.55,
  railDirectionalConsistency: 0.82,
  smoothRotationMaximumDegreesPerSecond: 35,
  smoothAccelerationMaximumMps2: 3,
});

export const MOBILITY_SCORE_POLICY = Object.freeze({
  maximumScore: 12,
  minimumMovementScore: 4,
  minimumStationaryScore: 3,
  ambiguousMargin: 0.75,
  mediumConfidenceScore: 6,
  highConfidenceScore: 8,
  highConfidenceMargin: 2,
  insufficientQualityScore: 0.3,
  lowQualityScore: 0.5,
  mediumQualityScore: 0.75,
});

export const MOBILITY_TEMPORAL_POLICY = Object.freeze({
  movementStartMinimumFrames: 2,
  movementStartMinimumDurationMs: 15_000,
  flightStartMinimumFrames: 3,
  flightStartMinimumDurationMs: 90_000,
  stateTransitionMinimumFrames: 2,
  stateTransitionMinimumDurationMs: 15_000,
  pedestrianPauseMaximumMs: 90_000,
  bicyclePauseMaximumMs: 120_000,
  roadVehiclePauseMaximumMs: 150_000,
  railPauseMaximumMs: 180_000,
  flightPauseMaximumMs: 10 * 60_000,
  ambiguousPauseMaximumMs: 60_000,
  minimumEventDistanceMeters: 20,
  minimumEventMovingDurationMs: 10_000,
});
