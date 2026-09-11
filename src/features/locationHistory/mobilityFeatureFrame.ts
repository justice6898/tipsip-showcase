import { locationHistoryDayKey } from "@/features/locationHistory/dayPresentation";
import {
  locationHistoryPointIdentity,
  locationHistoryTelemetryIdentity,
  type LocationHistoryPoint,
} from "@/features/locationHistory/domain";
import type { CanonicalMotionEvidenceWindow } from "@/features/locationHistory/motionEvidence";
import {
  buildCanonicalKinematicsIntervals,
  type CanonicalKinematicsInterval,
} from "@/features/locationHistory/mobilityKinematics";
import type { LocationHistoryRoute } from "@/features/locationHistory/routeProjection";
import { MOBILITY_FEATURE_POLICY, MOBILITY_INFERENCE_VERSION } from "@/features/locationHistory/mobilityInferencePolicy";

export type MobilityEvidenceAvailability = "measured" | "unavailable" | "permission_required" | "insufficient";
export type MobilityLocationQuality = "insufficient" | "poor" | "usable" | "good";

export type CanonicalMobilityFeatureFrame = Readonly<{
  accountGeneration: string;
  subjectUserId: string;
  continuityIdentity: string;
  localDayKey: string;
  frameIdentity: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  firstSampleIdentity: string;
  lastSampleIdentity: string;
  captureIdentities: readonly string[];
  routeSampleIdentities: readonly string[];
  sourceMotionEvidenceIdentities: readonly string[];
  sourceEvidenceVersion: string;
  sampleCount: number;
  intervalCount: number;
  validIntervalCount: number;
  rejectedIntervalCount: number;
  trustworthyIntervalShare: number;
  horizontalAccuracyQuality: MobilityLocationQuality;
  medianHorizontalAccuracyMeters?: number;
  displacementMeters: number;
  nativeSpeedMedianMps?: number;
  derivedSpeedMedianMps?: number;
  robustSpeedMps?: number;
  speedLowerQuartileMps?: number;
  speedUpperQuartileMps?: number;
  maximumTrustworthySpeedMps?: number;
  headingChangeDegrees?: number;
  directionalConsistency?: number;
  altitudeChangeMeters?: number;
  verticalSpeedMps?: number;
  maximumAltitudeMeters?: number;
  pedometerAvailability: MobilityEvidenceAvailability;
  stepDelta?: number;
  cadenceStepsPerMinute?: number;
  deviceMotionAvailability: MobilityEvidenceAvailability;
  motionSampleCount: number;
  accelerationRmsMps2?: number;
  accelerationPeakMps2?: number;
  accelerationVarianceMps4?: number;
  jerkRmsMps3?: number;
  rotationRateRmsDegreesPerSecond?: number;
  evidenceQuality: number;
  inferenceVersion: typeof MOBILITY_INFERENCE_VERSION;
}>;

export type MobilityFeatureFrameBuildResult = Readonly<{
  frames: readonly CanonicalMobilityFeatureFrame[];
  sourceSampleCount: number;
  sourceMotionEvidenceWindowCount: number;
  continuityCount: number;
  rejectedCrossAccountMotionWindowCount: number;
}>;

type IntervalEvidence = Readonly<{
  distanceMeters: number;
  durationMs: number;
  derivedSpeedMps?: number;
  nativeSpeedMps?: number;
  fusedSpeedMps?: number;
  bearingDegrees?: number;
  trustworthy: boolean;
}>;

function quantile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return ordered[lower];
  return ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function finiteRange(value: number | undefined, minimum: number, maximum: number): value is number {
  return value !== undefined && Number.isFinite(value) && value >= minimum && value <= maximum;
}

function angularDifference(left: number, right: number): number {
  const difference = Math.abs(left - right) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function availability(values: readonly MobilityEvidenceAvailability[]): MobilityEvidenceAvailability {
  if (values.includes("measured")) return "measured";
  if (values.includes("insufficient")) return "insufficient";
  if (values.includes("permission_required")) return "permission_required";
  return "unavailable";
}

function weightedRms(
  windows: readonly CanonicalMotionEvidenceWindow[],
  read: (window: CanonicalMotionEvidenceWindow) => number | undefined,
): number | undefined {
  const values = windows.flatMap((window) => {
    const value = read(window);
    return value === undefined || window.deviceMotionSampleCount <= 0
      ? []
      : [{ value, weight: window.deviceMotionSampleCount }];
  });
  const weight = values.reduce((total, value) => total + value.weight, 0);
  return weight === 0
    ? undefined
    : Math.sqrt(values.reduce((total, value) => total + value.value ** 2 * value.weight, 0) / weight);
}

function weightedMean(
  windows: readonly CanonicalMotionEvidenceWindow[],
  read: (window: CanonicalMotionEvidenceWindow) => number | undefined,
): number | undefined {
  const values = windows.flatMap((window) => {
    const value = read(window);
    return value === undefined || window.deviceMotionSampleCount <= 0
      ? []
      : [{ value, weight: window.deviceMotionSampleCount }];
  });
  const weight = values.reduce((total, value) => total + value.weight, 0);
  return weight === 0
    ? undefined
    : values.reduce((total, value) => total + value.value * value.weight, 0) / weight;
}

function frameForPoints(input: {
  accountGeneration: string;
  subjectUserId: string;
  continuityIdentity: string;
  points: readonly LocationHistoryPoint[];
  motionWindows: readonly CanonicalMotionEvidenceWindow[];
  canonicalIntervals?: readonly CanonicalKinematicsInterval[];
}): CanonicalMobilityFeatureFrame | null {
  const first = input.points[0];
  const last = input.points.at(-1);
  if (!first || !last) return null;
  const startedAtMs = Date.parse(first.capturedAt);
  const endedAtMs = Date.parse(last.capturedAt);
  const durationMs = endedAtMs - startedAtMs;
  if (durationMs < MOBILITY_FEATURE_POLICY.minimumFrameDurationMs) return null;
  const pointIdentities = new Set(input.points.map(locationHistoryPointIdentity));
  const canonicalIntervals = input.canonicalIntervals?.filter((interval) => (
    pointIdentities.has(interval.startSampleIdentity) && pointIdentities.has(interval.endSampleIdentity)
  )) ?? buildCanonicalKinematicsIntervals({
      subjectUserId: input.subjectUserId,
      continuityIdentity: input.continuityIdentity,
      points: input.points,
    });
  const intervals: IntervalEvidence[] = canonicalIntervals.map((interval) => {
    if (interval.status === "rejected") {
      return { distanceMeters: interval.distanceMeters, durationMs: interval.durationMs, trustworthy: false };
    }
    const nativeValid = finiteRange(interval.nativeSpeedMps, 0, MOBILITY_FEATURE_POLICY.maximumPlausibleSpeedMps)
      && (interval.nativeSpeedAccuracyMps === undefined || interval.nativeSpeedAccuracyMps <= MOBILITY_FEATURE_POLICY.maximumNativeSpeedAccuracyMps);
    const speeds = [interval.derivedSpeedMps, nativeValid ? interval.nativeSpeedMps : undefined]
      .filter((value): value is number => value !== undefined);
    return {
      distanceMeters: interval.distanceMeters,
      durationMs: interval.durationMs,
      derivedSpeedMps: interval.derivedSpeedMps,
      ...(nativeValid ? { nativeSpeedMps: interval.nativeSpeedMps } : {}),
      fusedSpeedMps: quantile(speeds, 0.5),
      bearingDegrees: interval.bearingDegrees,
      trustworthy: true,
    };
  });
  const trustworthy = intervals.filter((interval) => interval.trustworthy);
  const derivedSpeeds = trustworthy.flatMap((interval) => interval.derivedSpeedMps === undefined ? [] : [interval.derivedSpeedMps]);
  const nativeSpeeds = trustworthy.flatMap((interval) => interval.nativeSpeedMps === undefined ? [] : [interval.nativeSpeedMps]);
  const robustSpeeds = trustworthy.flatMap((interval) => interval.fusedSpeedMps === undefined ? [] : [interval.fusedSpeedMps]);
  const accuracies = input.points.flatMap((point) => finiteRange(point.accuracyMeters, 0, 100) ? [point.accuracyMeters] : []);
  const accuracyShare = accuracies.filter((value) => value <= MOBILITY_FEATURE_POLICY.maximumHorizontalAccuracyMeters).length
    / Math.max(1, input.points.length);
  const medianAccuracy = quantile(accuracies, 0.5);
  const horizontalAccuracyQuality: MobilityLocationQuality = accuracyShare < 0.5 || medianAccuracy === undefined
    ? "insufficient"
    : medianAccuracy <= MOBILITY_FEATURE_POLICY.excellentHorizontalAccuracyMeters
      ? "good"
      : medianAccuracy <= MOBILITY_FEATURE_POLICY.maximumHorizontalAccuracyMeters
        ? "usable"
        : "poor";
  const bearings = trustworthy.flatMap((interval) => interval.bearingDegrees === undefined ? [] : [interval.bearingDegrees]);
  const headingChange = bearings.slice(1).reduce((total, value, index) => total + angularDifference(bearings[index], value), 0);
  const directionalConsistency = bearings.length < 2 ? undefined : Math.hypot(
    bearings.reduce((total, value) => total + Math.cos(value * Math.PI / 180), 0),
    bearings.reduce((total, value) => total + Math.sin(value * Math.PI / 180), 0),
  ) / bearings.length;
  const altitudePoints = input.points.filter((point) => (
    finiteRange(point.altitudeMeters, -500, 20_000)
    && finiteRange(point.verticalAccuracyMeters, 0, MOBILITY_FEATURE_POLICY.maximumVerticalAccuracyMeters)
  ));
  const firstAltitude = altitudePoints[0]?.altitudeMeters;
  const lastAltitude = altitudePoints.at(-1)?.altitudeMeters;
  const altitudeChangeMeters = firstAltitude !== undefined && lastAltitude !== undefined
    ? lastAltitude - firstAltitude
    : undefined;
  const verticalDurationMs = altitudePoints.length > 1
    ? Date.parse(altitudePoints.at(-1)!.capturedAt) - Date.parse(altitudePoints[0].capturedAt)
    : 0;
  const relevantMotion = input.motionWindows.filter((window) => {
    const midpoint = (window.windowStartedAtMs + window.windowEndedAtMs) / 2;
    return midpoint > startedAtMs && midpoint <= endedAtMs;
  });
  const pedometerAvailability = availability(relevantMotion.map((window) => window.pedometerAvailability));
  const deviceMotionAvailability = availability(relevantMotion.map((window) => window.deviceMotionAvailability));
  const measuredStepWindows = relevantMotion.filter((window) => (
    window.pedometerAvailability === "measured" && window.stepDelta !== undefined
  ));
  const stepDelta = measuredStepWindows.length > 0
    ? measuredStepWindows.reduce((total, window) => total + (window.stepDelta ?? 0), 0)
    : undefined;
  const measuredStepDurationMs = measuredStepWindows.reduce((total, window) => total + window.durationMs, 0);
  const motionSampleCount = relevantMotion.reduce((total, window) => total + window.deviceMotionSampleCount, 0);
  const captureIdentities = input.points.map(locationHistoryPointIdentity);
  const trustworthyShare = trustworthy.length / Math.max(1, intervals.length);
  const motionQuality = deviceMotionAvailability === "measured" || pedometerAvailability === "measured" ? 1 : 0;
  const evidenceQuality = Math.min(1, trustworthyShare * 0.5 + accuracyShare * 0.3 + motionQuality * 0.2);
  const accelerationPeaks = relevantMotion.flatMap((window) => window.accelerationPeakMps2 === undefined ? [] : [window.accelerationPeakMps2]);
  const localDay = locationHistoryDayKey(endedAtMs) ?? "unknown";
  return {
    accountGeneration: input.accountGeneration,
    subjectUserId: input.subjectUserId,
    continuityIdentity: input.continuityIdentity,
    localDayKey: localDay,
    frameIdentity: `mobility-frame-v${MOBILITY_INFERENCE_VERSION}:${input.continuityIdentity}:${captureIdentities[0]}:${endedAtMs}`,
    startedAtMs,
    endedAtMs,
    durationMs,
    firstSampleIdentity: captureIdentities[0],
    lastSampleIdentity: captureIdentities.at(-1)!,
    captureIdentities,
    routeSampleIdentities: captureIdentities,
    sourceMotionEvidenceIdentities: relevantMotion.map((window) => window.evidenceIdentity),
    sourceEvidenceVersion: `${locationHistoryTelemetryIdentity(input.points)}:motion-v${relevantMotion.reduce((version, window) => Math.max(version, window.motionEvidenceVersion), 0)}`,
    sampleCount: input.points.length,
    intervalCount: intervals.length,
    validIntervalCount: trustworthy.length,
    rejectedIntervalCount: intervals.length - trustworthy.length,
    trustworthyIntervalShare: trustworthyShare,
    horizontalAccuracyQuality,
    ...(medianAccuracy === undefined ? {} : { medianHorizontalAccuracyMeters: medianAccuracy }),
    displacementMeters: trustworthy.reduce((total, interval) => total + (interval.derivedSpeedMps === undefined ? 0 : interval.distanceMeters), 0),
    ...(quantile(nativeSpeeds, 0.5) === undefined ? {} : { nativeSpeedMedianMps: quantile(nativeSpeeds, 0.5) }),
    ...(quantile(derivedSpeeds, 0.5) === undefined ? {} : { derivedSpeedMedianMps: quantile(derivedSpeeds, 0.5) }),
    ...(quantile(robustSpeeds, 0.5) === undefined ? {} : { robustSpeedMps: quantile(robustSpeeds, 0.5) }),
    ...(quantile(robustSpeeds, 0.25) === undefined ? {} : { speedLowerQuartileMps: quantile(robustSpeeds, 0.25) }),
    ...(quantile(robustSpeeds, 0.75) === undefined ? {} : { speedUpperQuartileMps: quantile(robustSpeeds, 0.75) }),
    ...(robustSpeeds.length === 0 ? {} : { maximumTrustworthySpeedMps: Math.max(...robustSpeeds) }),
    ...(bearings.length < 2 ? {} : { headingChangeDegrees: headingChange }),
    ...(directionalConsistency === undefined ? {} : { directionalConsistency }),
    ...(altitudeChangeMeters === undefined ? {} : { altitudeChangeMeters }),
    ...(altitudeChangeMeters === undefined || verticalDurationMs <= 0 ? {} : { verticalSpeedMps: altitudeChangeMeters / (verticalDurationMs / 1_000) }),
    ...(altitudePoints.length === 0 ? {} : { maximumAltitudeMeters: Math.max(...altitudePoints.map((point) => point.altitudeMeters!)) }),
    pedometerAvailability,
    ...(stepDelta === undefined ? {} : { stepDelta }),
    ...(stepDelta === undefined || measuredStepDurationMs <= 0 ? {} : { cadenceStepsPerMinute: stepDelta / (measuredStepDurationMs / 60_000) }),
    deviceMotionAvailability,
    motionSampleCount,
    ...(weightedRms(relevantMotion, (window) => window.accelerationRmsMps2) === undefined ? {} : {
      accelerationRmsMps2: weightedRms(relevantMotion, (window) => window.accelerationRmsMps2),
    }),
    ...(accelerationPeaks.length === 0 ? {} : { accelerationPeakMps2: Math.max(...accelerationPeaks) }),
    ...(weightedMean(relevantMotion, (window) => window.accelerationVarianceMps4) === undefined ? {} : {
      accelerationVarianceMps4: weightedMean(relevantMotion, (window) => window.accelerationVarianceMps4),
    }),
    ...(weightedRms(relevantMotion, (window) => window.jerkRmsMps3) === undefined ? {} : {
      jerkRmsMps3: weightedRms(relevantMotion, (window) => window.jerkRmsMps3),
    }),
    ...(weightedRms(relevantMotion, (window) => window.rotationRateRmsDegreesPerSecond) === undefined ? {} : {
      rotationRateRmsDegreesPerSecond: weightedRms(relevantMotion, (window) => window.rotationRateRmsDegreesPerSecond),
    }),
    evidenceQuality,
    inferenceVersion: MOBILITY_INFERENCE_VERSION,
  };
}

function continuityBlocks(points: readonly LocationHistoryPoint[]): readonly LocationHistoryPoint[][] {
  const blocks: LocationHistoryPoint[][] = [];
  let current: LocationHistoryPoint[] = [];
  for (const point of points) {
    const previous = current.at(-1);
    const intervalMs = previous ? Date.parse(point.capturedAt) - Date.parse(previous.capturedAt) : 0;
    if (previous && (intervalMs <= 0 || intervalMs > MOBILITY_FEATURE_POLICY.maximumContinuousIntervalMs)) {
      if (current.length > 0) blocks.push(current);
      current = [];
    }
    current.push(point);
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function framePointGroups(points: readonly LocationHistoryPoint[]): readonly LocationHistoryPoint[][] {
  const groups: LocationHistoryPoint[][] = [];
  let start = 0;
  while (start < points.length - 1) {
    let end = start + 1;
    while (end + 1 < points.length && end - start + 1 < MOBILITY_FEATURE_POLICY.maximumFrameSampleCount) {
      const candidateDuration = Date.parse(points[end + 1].capturedAt) - Date.parse(points[start].capturedAt);
      const currentDuration = Date.parse(points[end].capturedAt) - Date.parse(points[start].capturedAt);
      if (candidateDuration > MOBILITY_FEATURE_POLICY.maximumFrameDurationMs && currentDuration >= MOBILITY_FEATURE_POLICY.minimumFrameDurationMs) break;
      end += 1;
      if (candidateDuration >= MOBILITY_FEATURE_POLICY.targetFrameDurationMs) break;
    }
    groups.push(points.slice(start, end + 1));
    start = end;
  }
  return groups;
}

/** Builds frames only from an already-authorized, continuity-normalized route.
 * Motion evidence is accepted only for the authenticated subject themselves. */
export function buildCanonicalMobilityFeatureFrames(input: {
  accountUserId: string;
  accountGeneration: string;
  subjectUserId: string;
  route: LocationHistoryRoute;
  motionEvidenceWindows?: readonly CanonicalMotionEvidenceWindow[];
}): MobilityFeatureFrameBuildResult {
  if (input.route.personUserId !== input.subjectUserId) {
    return { frames: [], sourceSampleCount: 0, sourceMotionEvidenceWindowCount: 0, continuityCount: 0, rejectedCrossAccountMotionWindowCount: input.motionEvidenceWindows?.length ?? 0 };
  }
  const suppliedMotion = input.motionEvidenceWindows ?? [];
  const motionWindows = input.accountUserId === input.subjectUserId
    ? suppliedMotion.filter((window) => window.accountUserId === input.subjectUserId)
    : [];
  const rejectedCrossAccountMotionWindowCount = suppliedMotion.length - motionWindows.length;
  const frames: CanonicalMobilityFeatureFrame[] = [];
  let continuityCount = 0;
  input.route.segments.forEach((segment, segmentIndex) => {
    continuityBlocks(segment.points).forEach((block, blockIndex) => {
      const continuityIdentity = `${input.subjectUserId}:route:${segmentIndex}:continuity:${blockIndex}:${locationHistoryPointIdentity(block[0])}`;
      continuityCount += 1;
      const canonicalIntervals = buildCanonicalKinematicsIntervals({
        subjectUserId: input.subjectUserId,
        continuityIdentity,
        points: block,
      });
      framePointGroups(block).forEach((points) => {
        const frame = frameForPoints({
          accountGeneration: input.accountGeneration,
          subjectUserId: input.subjectUserId,
          continuityIdentity,
          points,
          motionWindows,
          canonicalIntervals,
        });
        if (frame) frames.push(frame);
      });
    });
  });
  return {
    frames,
    sourceSampleCount: input.route.segments.reduce((total, segment) => total + segment.points.length, 0),
    sourceMotionEvidenceWindowCount: motionWindows.length,
    continuityCount,
    rejectedCrossAccountMotionWindowCount,
  };
}
