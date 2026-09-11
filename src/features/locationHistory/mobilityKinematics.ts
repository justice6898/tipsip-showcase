import {
  locationHistoryPointIdentity,
  type LocationHistoryPoint,
} from "@/features/locationHistory/domain";
import type { CanonicalMobilityEvent, CanonicalMobilityState } from "@/features/locationHistory/mobilityInference";
import {
  MOBILITY_KINEMATICS_POLICY,
  MOBILITY_KINEMATICS_VERSION,
} from "@/features/locationHistory/mobilityKinematicsPolicy";
import type { LocationHistoryRoute } from "@/features/locationHistory/routeProjection";
import { haversineDistanceMeters } from "@/lib/geoDistance";

export type KinematicsIntervalRejectionReason =
  | "subject_mismatch"
  | "non_positive_time"
  | "interval_too_short"
  | "recording_gap"
  | "accuracy_unavailable"
  | "poor_accuracy"
  | "insufficient_displacement"
  | "physically_impossible_speed"
  | "isolated_terrestrial_speed_spike"
  | "isolated_high_speed";

export type KinematicsSpeedRegime = "terrestrial" | "sustained_high_speed";

type CanonicalKinematicsIntervalBase = Readonly<{
  intervalIdentity: string;
  subjectUserId: string;
  continuityIdentity: string;
  movementEventId?: string;
  startSampleIdentity: string;
  endSampleIdentity: string;
  startPoint: LocationHistoryPoint;
  endPoint: LocationHistoryPoint;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  distanceMeters: number;
  derivedSpeedMps?: number;
  bearingDegrees?: number;
  nativeSpeedMps?: number;
  nativeSpeedAccuracyMps?: number;
  maximumHorizontalAccuracyMeters?: number;
}>;

export type CanonicalKinematicsInterval =
  | CanonicalKinematicsIntervalBase & Readonly<{
      status: "accepted";
      derivedSpeedMps: number;
      speedRegime: KinematicsSpeedRegime;
      bearingDegrees: number;
    }>
  | CanonicalKinematicsIntervalBase & Readonly<{
      status: "rejected";
      rejectionReason: KinematicsIntervalRejectionReason;
    }>;

export type CanonicalKinematicsSpeedSeriesPoint = Readonly<{
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  distanceMeters: number;
  averageSpeedMps: number;
  sourceIntervalCount: number;
}>;

export type CanonicalMobilityKinematics = Readonly<{
  subjectUserId: string;
  movementEventId?: string;
  mobilityState?: CanonicalMobilityState;
  kinematicsVersion: typeof MOBILITY_KINEMATICS_VERSION;
  intervals: readonly CanonicalKinematicsInterval[];
  acceptedIntervals: readonly Extract<CanonicalKinematicsInterval, { status: "accepted" }>[];
  rejectedIntervalCount: number;
  elapsedDurationMs: number;
  movingDurationMs: number;
  pauseDurationMs: number;
  unobservedDurationMs: number;
  distanceMeters: number;
  averageMovingSpeedMps?: number;
  rawAcceptedMaximumSpeedMps?: number;
  validatedPeakSpeedMps?: number;
  minimumMeaningfulSpeedMps?: number;
  medianSpeedMps?: number;
  speedQ1Mps?: number;
  speedQ3Mps?: number;
  speedP90Mps?: number;
  speedP95Mps?: number;
  paceSecondsPerKilometer?: number;
  speedSeries: readonly CanonicalKinematicsSpeedSeriesPoint[];
  evidenceQuality: "insufficient" | "low" | "medium" | "high";
}>;

export type CanonicalMobilityDayKinematics = Readonly<{
  eventCount: number;
  totalDistanceMeters: number;
  totalMovingDurationMs: number;
  totalElapsedDurationMs: number;
  totalPauseDurationMs: number;
  averageMovingSpeedMps?: number;
  validatedPeakSpeedMps?: number;
  kinematicsVersion: typeof MOBILITY_KINEMATICS_VERSION;
}>;

type RawInterval = Readonly<{
  startPoint: LocationHistoryPoint;
  endPoint: LocationHistoryPoint;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  distanceMeters: number;
  derivedSpeedMps?: number;
  bearingDegrees?: number;
  maximumHorizontalAccuracyMeters?: number;
}>;

function bearingDegrees(left: LocationHistoryPoint, right: LocationHistoryPoint): number {
  const leftLatitude = left.coordinate.latitude * Math.PI / 180;
  const rightLatitude = right.coordinate.latitude * Math.PI / 180;
  const longitudeDelta = (right.coordinate.longitude - left.coordinate.longitude) * Math.PI / 180;
  const y = Math.sin(longitudeDelta) * Math.cos(rightLatitude);
  const x = Math.cos(leftLatitude) * Math.sin(rightLatitude)
    - Math.sin(leftLatitude) * Math.cos(rightLatitude) * Math.cos(longitudeDelta);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function angularDifference(left: number, right: number): number {
  const difference = Math.abs(left - right) % 360;
  return difference > 180 ? 360 - difference : difference;
}

function rawInterval(left: LocationHistoryPoint, right: LocationHistoryPoint): RawInterval {
  const startedAtMs = Date.parse(left.capturedAt);
  const endedAtMs = Date.parse(right.capturedAt);
  const durationMs = endedAtMs - startedAtMs;
  const distanceMeters = haversineDistanceMeters(left.coordinate, right.coordinate);
  const accuracies = [left.accuracyMeters, right.accuracyMeters];
  const maximumHorizontalAccuracyMeters = accuracies.every((value) => value !== undefined && Number.isFinite(value))
    ? Math.max(...accuracies as number[])
    : undefined;
  const derivedSpeedMps = durationMs > 0 && Number.isFinite(distanceMeters)
    ? distanceMeters / (durationMs / 1_000)
    : undefined;
  return {
    startPoint: left,
    endPoint: right,
    startedAtMs,
    endedAtMs,
    durationMs,
    distanceMeters,
    ...(derivedSpeedMps === undefined ? {} : { derivedSpeedMps }),
    ...(distanceMeters > 0 ? { bearingDegrees: bearingDegrees(left, right) } : {}),
    ...(maximumHorizontalAccuracyMeters === undefined ? {} : { maximumHorizontalAccuracyMeters }),
  };
}

function speedRatio(left: number, right: number): number {
  const minimum = Math.min(left, right);
  return minimum <= 0 ? Number.POSITIVE_INFINITY : Math.max(left, right) / minimum;
}

function highSpeedQuality(interval: RawInterval): boolean {
  return interval.derivedSpeedMps !== undefined
    && interval.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps
    && interval.derivedSpeedMps <= MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps
    && interval.maximumHorizontalAccuracyMeters !== undefined
    && interval.maximumHorizontalAccuracyMeters <= MOBILITY_KINEMATICS_POLICY.maximumHighSpeedHorizontalAccuracyMeters
    && interval.bearingDegrees !== undefined;
}

function highSpeedPairIsCoherent(left: RawInterval, right: RawInterval): boolean {
  return highSpeedQuality(left)
    && highSpeedQuality(right)
    && speedRatio(left.derivedSpeedMps!, right.derivedSpeedMps!) <= MOBILITY_KINEMATICS_POLICY.highSpeedCorroborationRatio
    && angularDifference(left.bearingDegrees!, right.bearingDegrees!) <= MOBILITY_KINEMATICS_POLICY.highSpeedMaximumBearingChangeDegrees;
}

/** Sustained high speed must be supported by a chronological neighbor. This is
 * shared by route continuity and kinematics so relaxing flight support cannot
 * independently weaken GPS-spike rejection. */
export function isSustainedHighSpeedInterval(
  points: readonly LocationHistoryPoint[],
  intervalIndex: number,
): boolean {
  if (intervalIndex < 0 || intervalIndex >= points.length - 1) return false;
  const current = rawInterval(points[intervalIndex], points[intervalIndex + 1]);
  const previous = intervalIndex > 0 ? rawInterval(points[intervalIndex - 1], points[intervalIndex]) : null;
  const next = intervalIndex + 2 < points.length ? rawInterval(points[intervalIndex + 1], points[intervalIndex + 2]) : null;
  return (previous !== null && highSpeedPairIsCoherent(previous, current))
    || (next !== null && highSpeedPairIsCoherent(current, next));
}

function isIsolatedTerrestrialSpeedSpike(
  points: readonly LocationHistoryPoint[],
  intervalIndex: number,
): boolean {
  if (intervalIndex <= 0 || intervalIndex + 2 >= points.length) return false;
  const current = rawInterval(points[intervalIndex], points[intervalIndex + 1]);
  const previous = rawInterval(points[intervalIndex - 1], points[intervalIndex]);
  const next = rawInterval(points[intervalIndex + 1], points[intervalIndex + 2]);
  if (
    current.derivedSpeedMps === undefined
    || current.derivedSpeedMps < MOBILITY_KINEMATICS_POLICY.minimumTerrestrialSpikeSpeedMps
    || current.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps
  ) return false;
  const neighborIsTrustworthyAndUnsupported = (neighbor: RawInterval) => neighbor.durationMs >= MOBILITY_KINEMATICS_POLICY.minimumIntervalMs
    && neighbor.durationMs <= MOBILITY_KINEMATICS_POLICY.maximumRecordingIntervalMs
    && neighbor.maximumHorizontalAccuracyMeters !== undefined
    && neighbor.maximumHorizontalAccuracyMeters <= MOBILITY_KINEMATICS_POLICY.maximumUsableHorizontalAccuracyMeters
    && neighbor.derivedSpeedMps !== undefined
    && neighbor.derivedSpeedMps < current.derivedSpeedMps! * MOBILITY_KINEMATICS_POLICY.terrestrialSpikeNeighborRatio;
  return neighborIsTrustworthyAndUnsupported(previous) && neighborIsTrustworthyAndUnsupported(next);
}

export function canonicalRouteIntervalBreakReason(
  points: readonly LocationHistoryPoint[],
  intervalIndex: number,
): "recording_gap" | "physically_impossible" | "isolated_high_speed" | null {
  if (intervalIndex < 0 || intervalIndex >= points.length - 1) return "physically_impossible";
  const interval = rawInterval(points[intervalIndex], points[intervalIndex + 1]);
  if (!Number.isFinite(interval.durationMs) || interval.durationMs <= 0) return "physically_impossible";
  if (interval.durationMs > MOBILITY_KINEMATICS_POLICY.maximumRecordingIntervalMs) return "recording_gap";
  if (
    interval.derivedSpeedMps === undefined
    || interval.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps
  ) return "physically_impossible";
  if (
    interval.distanceMeters >= MOBILITY_KINEMATICS_POLICY.minimumSuspiciousJumpMeters
    && interval.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps
    && !isSustainedHighSpeedInterval(points, intervalIndex)
  ) return "isolated_high_speed";
  return null;
}

function intervalBase(input: {
  subjectUserId: string;
  continuityIdentity: string;
  movementEventId?: string;
  raw: RawInterval;
}): CanonicalKinematicsIntervalBase {
  const startSampleIdentity = locationHistoryPointIdentity(input.raw.startPoint);
  const endSampleIdentity = locationHistoryPointIdentity(input.raw.endPoint);
  const nativeSpeedMps = input.raw.endPoint.nativeSpeedMps;
  const nativeSpeedAccuracyMps = input.raw.endPoint.nativeSpeedAccuracyMps;
  const nativeSpeedValid = nativeSpeedMps !== undefined
    && Number.isFinite(nativeSpeedMps)
    && nativeSpeedMps >= 0
    && nativeSpeedMps <= MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps;
  const nativeAccuracyValid = nativeSpeedAccuracyMps !== undefined
    && Number.isFinite(nativeSpeedAccuracyMps)
    && nativeSpeedAccuracyMps >= 0;
  return {
    intervalIdentity: `kinematics-v${MOBILITY_KINEMATICS_VERSION}:${input.subjectUserId}:${startSampleIdentity}:${endSampleIdentity}`,
    subjectUserId: input.subjectUserId,
    continuityIdentity: input.continuityIdentity,
    ...(input.movementEventId ? { movementEventId: input.movementEventId } : {}),
    startSampleIdentity,
    endSampleIdentity,
    startPoint: input.raw.startPoint,
    endPoint: input.raw.endPoint,
    startedAtMs: input.raw.startedAtMs,
    endedAtMs: input.raw.endedAtMs,
    durationMs: input.raw.durationMs,
    distanceMeters: input.raw.distanceMeters,
    ...(input.raw.derivedSpeedMps === undefined ? {} : { derivedSpeedMps: input.raw.derivedSpeedMps }),
    ...(input.raw.bearingDegrees === undefined ? {} : { bearingDegrees: input.raw.bearingDegrees }),
    ...(nativeSpeedValid ? { nativeSpeedMps } : {}),
    ...(nativeAccuracyValid ? { nativeSpeedAccuracyMps } : {}),
    ...(input.raw.maximumHorizontalAccuracyMeters === undefined ? {} : { maximumHorizontalAccuracyMeters: input.raw.maximumHorizontalAccuracyMeters }),
  };
}

export function buildCanonicalKinematicsIntervals(input: {
  subjectUserId: string;
  continuityIdentity: string;
  points: readonly LocationHistoryPoint[];
  movementEventId?: string;
}): CanonicalKinematicsInterval[] {
  const intervals: CanonicalKinematicsInterval[] = [];
  for (let index = 0; index < input.points.length - 1; index += 1) {
    const raw = rawInterval(input.points[index], input.points[index + 1]);
    const base = intervalBase({ ...input, raw });
    let rejectionReason: KinematicsIntervalRejectionReason | null = null;
    if (raw.startPoint.personUserId !== input.subjectUserId || raw.endPoint.personUserId !== input.subjectUserId) rejectionReason = "subject_mismatch";
    else if (!Number.isFinite(raw.durationMs) || raw.durationMs <= 0) rejectionReason = "non_positive_time";
    else if (raw.durationMs < MOBILITY_KINEMATICS_POLICY.minimumIntervalMs) rejectionReason = "interval_too_short";
    else if (raw.durationMs > MOBILITY_KINEMATICS_POLICY.maximumRecordingIntervalMs) rejectionReason = "recording_gap";
    else if (raw.maximumHorizontalAccuracyMeters === undefined) rejectionReason = "accuracy_unavailable";
    else if (raw.maximumHorizontalAccuracyMeters > MOBILITY_KINEMATICS_POLICY.maximumUsableHorizontalAccuracyMeters) rejectionReason = "poor_accuracy";
    else if (raw.distanceMeters <= Math.max(
      MOBILITY_KINEMATICS_POLICY.minimumSignalDistanceMeters,
      raw.maximumHorizontalAccuracyMeters * MOBILITY_KINEMATICS_POLICY.accuracySignalRatio,
    )) rejectionReason = "insufficient_displacement";
    else if (
      raw.derivedSpeedMps === undefined
      || !Number.isFinite(raw.derivedSpeedMps)
      || raw.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.physicallyRetainableSpeedCeilingMps
    ) rejectionReason = "physically_impossible_speed";
    else if (
      raw.derivedSpeedMps > MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps
      && !isSustainedHighSpeedInterval(input.points, index)
    ) rejectionReason = "isolated_high_speed";
    else if (isIsolatedTerrestrialSpeedSpike(input.points, index)) rejectionReason = "isolated_terrestrial_speed_spike";

    if (rejectionReason) {
      intervals.push({ ...base, status: "rejected", rejectionReason });
    } else {
      intervals.push({
        ...base,
        status: "accepted",
        derivedSpeedMps: raw.derivedSpeedMps!,
        speedRegime: raw.derivedSpeedMps! > MOBILITY_KINEMATICS_POLICY.terrestrialSpeedCeilingMps
          ? "sustained_high_speed"
          : "terrestrial",
        bearingDegrees: raw.bearingDegrees!,
      });
    }
  }
  return intervals;
}

function weightedQuantileFromSorted(
  ordered: readonly Extract<CanonicalKinematicsInterval, { status: "accepted" }>[],
  totalWeight: number,
  fraction: number,
): number | undefined {
  if (ordered.length === 0) return undefined;
  const target = totalWeight * fraction;
  let cumulative = 0;
  for (const interval of ordered) {
    cumulative += interval.durationMs;
    if (cumulative >= target) return interval.derivedSpeedMps;
  }
  return ordered.at(-1)!.derivedSpeedMps;
}

function validatedPeak(
  intervals: readonly Extract<CanonicalKinematicsInterval, { status: "accepted" }>[],
): number | undefined {
  if (intervals.length < MOBILITY_KINEMATICS_POLICY.minimumSummaryIntervals) return undefined;
  const supported = intervals.filter((interval, index) => {
    const previous = intervals[index - 1];
    const next = intervals[index + 1];
    const supportedBy = (neighbor: typeof previous) => neighbor
      && (neighbor.endSampleIdentity === interval.startSampleIdentity || interval.endSampleIdentity === neighbor.startSampleIdentity)
      && neighbor.derivedSpeedMps >= interval.derivedSpeedMps * MOBILITY_KINEMATICS_POLICY.validatedPeakNeighborRatio;
    return Boolean(supportedBy(previous) || supportedBy(next));
  });
  return supported.length === 0 ? undefined : Math.max(...supported.map((interval) => interval.derivedSpeedMps));
}

function speedSeries(
  intervals: readonly Extract<CanonicalKinematicsInterval, { status: "accepted" }>[],
): CanonicalKinematicsSpeedSeriesPoint[] {
  if (intervals.length <= MOBILITY_KINEMATICS_POLICY.maximumSeriesPointCount) {
    return intervals.map((interval) => ({
      startedAtMs: interval.startedAtMs,
      endedAtMs: interval.endedAtMs,
      durationMs: interval.durationMs,
      distanceMeters: interval.distanceMeters,
      averageSpeedMps: interval.derivedSpeedMps,
      sourceIntervalCount: 1,
    }));
  }
  const firstAt = intervals[0].startedAtMs;
  const lastAt = intervals.at(-1)!.endedAtMs;
  const bucketMs = Math.max(1, Math.ceil((lastAt - firstAt) / MOBILITY_KINEMATICS_POLICY.maximumSeriesPointCount));
  const buckets = new Map<number, Extract<CanonicalKinematicsInterval, { status: "accepted" }>[]>();
  for (const interval of intervals) {
    const key = Math.floor((interval.startedAtMs - firstAt) / bucketMs);
    const bucket = buckets.get(key) ?? [];
    bucket.push(interval);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].map((bucket) => {
    const durationMs = bucket.reduce((total, interval) => total + interval.durationMs, 0);
    const distanceMeters = bucket.reduce((total, interval) => total + interval.distanceMeters, 0);
    return {
      startedAtMs: bucket[0].startedAtMs,
      endedAtMs: bucket.at(-1)!.endedAtMs,
      durationMs,
      distanceMeters,
      averageSpeedMps: distanceMeters / (durationMs / 1_000),
      sourceIntervalCount: bucket.length,
    };
  });
}

export function canonicalPaceSecondsPerKilometer(distanceMeters: number, durationMs: number): number | undefined {
  if (distanceMeters < MOBILITY_KINEMATICS_POLICY.minimumPaceDistanceMeters || durationMs <= 0) return undefined;
  const pace = (durationMs / 1_000) / (distanceMeters / 1_000);
  return Number.isFinite(pace)
    && pace >= MOBILITY_KINEMATICS_POLICY.minimumPaceSecondsPerKilometer
    && pace <= MOBILITY_KINEMATICS_POLICY.maximumPaceSecondsPerKilometer
      ? pace
      : undefined;
}

export function calculateCanonicalMobilityKinematics(input: {
  subjectUserId: string;
  points: readonly LocationHistoryPoint[];
  continuityIdentity: string;
  movementEventId?: string;
  mobilityState?: CanonicalMobilityState;
  pauseDurationMs?: number;
}): CanonicalMobilityKinematics {
  const intervals = buildCanonicalKinematicsIntervals(input);
  const acceptedIntervals = intervals.filter((interval): interval is Extract<CanonicalKinematicsInterval, { status: "accepted" }> => interval.status === "accepted");
  const distanceMeters = acceptedIntervals.reduce((total, interval) => total + interval.distanceMeters, 0);
  const movingDurationMs = acceptedIntervals.reduce((total, interval) => total + interval.durationMs, 0);
  const firstAt = input.points.length > 0 ? Date.parse(input.points[0].capturedAt) : Number.NaN;
  const lastAt = input.points.length > 0 ? Date.parse(input.points.at(-1)!.capturedAt) : Number.NaN;
  const elapsedDurationMs = Number.isFinite(firstAt) && Number.isFinite(lastAt) && lastAt > firstAt ? lastAt - firstAt : 0;
  const availablePauseMs = Math.max(0, elapsedDurationMs - movingDurationMs);
  const pauseDurationMs = Math.min(availablePauseMs, Math.max(0, input.pauseDurationMs ?? 0));
  const unobservedDurationMs = Math.max(0, elapsedDurationMs - movingDurationMs - pauseDurationMs);
  const averageMovingSpeedMps = movingDurationMs > 0 && distanceMeters > 0
    ? distanceMeters / (movingDurationMs / 1_000)
    : undefined;
  const rawAcceptedMaximumSpeedMps = acceptedIntervals.length > 0
    ? Math.max(...acceptedIntervals.map((interval) => interval.derivedSpeedMps))
    : undefined;
  const validatedPeakSpeedMps = validatedPeak(acceptedIntervals);
  const speedOrdered = [...acceptedIntervals].sort((left, right) => left.derivedSpeedMps - right.derivedSpeedMps);
  const quantile = (fraction: number) => weightedQuantileFromSorted(speedOrdered, movingDurationMs, fraction);
  const quantiles = {
    minimum: quantile(0),
    median: quantile(0.5),
    q1: quantile(0.25),
    q3: quantile(0.75),
    p90: quantile(0.9),
    p95: quantile(0.95),
  };
  const coverage = elapsedDurationMs > 0 ? movingDurationMs / elapsedDurationMs : 0;
  const evidenceQuality = acceptedIntervals.length < MOBILITY_KINEMATICS_POLICY.minimumSummaryIntervals
    ? "insufficient"
    : coverage >= 0.8 && acceptedIntervals.length >= 4
      ? "high"
      : coverage >= 0.5
        ? "medium"
        : "low";
  const paceEligible = input.mobilityState === "walking" || input.mobilityState === "running";
  const pace = paceEligible ? canonicalPaceSecondsPerKilometer(distanceMeters, movingDurationMs) : undefined;
  return {
    subjectUserId: input.subjectUserId,
    ...(input.movementEventId ? { movementEventId: input.movementEventId } : {}),
    ...(input.mobilityState ? { mobilityState: input.mobilityState } : {}),
    kinematicsVersion: MOBILITY_KINEMATICS_VERSION,
    intervals,
    acceptedIntervals,
    rejectedIntervalCount: intervals.length - acceptedIntervals.length,
    elapsedDurationMs,
    movingDurationMs,
    pauseDurationMs,
    unobservedDurationMs,
    distanceMeters,
    ...(averageMovingSpeedMps === undefined ? {} : { averageMovingSpeedMps }),
    ...(rawAcceptedMaximumSpeedMps === undefined ? {} : { rawAcceptedMaximumSpeedMps }),
    ...(validatedPeakSpeedMps === undefined ? {} : { validatedPeakSpeedMps }),
    ...(quantiles.minimum === undefined ? {} : { minimumMeaningfulSpeedMps: quantiles.minimum }),
    ...(quantiles.median === undefined ? {} : { medianSpeedMps: quantiles.median }),
    ...(quantiles.q1 === undefined ? {} : { speedQ1Mps: quantiles.q1 }),
    ...(quantiles.q3 === undefined ? {} : { speedQ3Mps: quantiles.q3 }),
    ...(quantiles.p90 === undefined ? {} : { speedP90Mps: quantiles.p90 }),
    ...(quantiles.p95 === undefined ? {} : { speedP95Mps: quantiles.p95 }),
    ...(pace === undefined ? {} : { paceSecondsPerKilometer: pace }),
    speedSeries: speedSeries(acceptedIntervals),
    evidenceQuality,
  };
}

export function calculateCanonicalRouteDistance(
  subjectUserId: string,
  points: readonly LocationHistoryPoint[],
  continuityIdentity = "canonical-route",
): number {
  return calculateCanonicalMobilityKinematics({ subjectUserId, points, continuityIdentity }).distanceMeters;
}

export function calculateCanonicalMobilityEventKinematics(input: {
  event: CanonicalMobilityEvent;
  route: LocationHistoryRoute;
}): CanonicalMobilityKinematics {
  if (input.route.personUserId !== input.event.subjectUserId) {
    return calculateCanonicalMobilityKinematics({
      subjectUserId: input.event.subjectUserId,
      points: [],
      continuityIdentity: "subject-mismatch",
      movementEventId: input.event.eventId,
      mobilityState: input.event.mobilityState,
    });
  }
  const allowed = new Set(input.event.routeSampleIdentities);
  const points = input.route.segments.flatMap((segment) => segment.points)
    .filter((point) => allowed.has(locationHistoryPointIdentity(point)));
  return calculateCanonicalMobilityKinematics({
    subjectUserId: input.event.subjectUserId,
    points,
    continuityIdentity: input.event.eventId,
    movementEventId: input.event.eventId,
    mobilityState: input.event.mobilityState,
    pauseDurationMs: input.event.temporaryPauseDurationMs,
  });
}

export function createCanonicalMobilityDayKinematics(
  events: readonly CanonicalMobilityKinematics[],
): CanonicalMobilityDayKinematics {
  const totalDistanceMeters = events.reduce((total, event) => total + event.distanceMeters, 0);
  const totalMovingDurationMs = events.reduce((total, event) => total + event.movingDurationMs, 0);
  const peaks = events.flatMap((event) => event.validatedPeakSpeedMps === undefined ? [] : [event.validatedPeakSpeedMps]);
  return {
    eventCount: events.length,
    totalDistanceMeters,
    totalMovingDurationMs,
    totalElapsedDurationMs: events.reduce((total, event) => total + event.elapsedDurationMs, 0),
    totalPauseDurationMs: events.reduce((total, event) => total + event.pauseDurationMs, 0),
    ...(totalDistanceMeters > 0 && totalMovingDurationMs > 0
      ? { averageMovingSpeedMps: totalDistanceMeters / (totalMovingDurationMs / 1_000) }
      : {}),
    ...(peaks.length > 0 ? { validatedPeakSpeedMps: Math.max(...peaks) } : {}),
    kinematicsVersion: MOBILITY_KINEMATICS_VERSION,
  };
}
