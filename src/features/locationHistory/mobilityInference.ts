import type { CanonicalMotionEvidenceWindow } from "@/features/locationHistory/motionEvidence";
import {
  buildCanonicalMobilityFeatureFrames,
  type CanonicalMobilityFeatureFrame,
  type MobilityFeatureFrameBuildResult,
} from "@/features/locationHistory/mobilityFeatureFrame";
import {
  MOBILITY_FEATURE_POLICY,
  MOBILITY_INFERENCE_VERSION,
  MOBILITY_SCORE_POLICY,
  MOBILITY_TEMPORAL_POLICY,
} from "@/features/locationHistory/mobilityInferencePolicy";
import type { LocationHistoryInferredMovementMode } from "@/features/locationHistory/movementModeOverride";
import type { LocationHistoryRoute } from "@/features/locationHistory/routeProjection";

export const CANONICAL_MOBILITY_STATES = [
  "stationary",
  "walking",
  "running",
  "bicycle_candidate",
  "road_vehicle_candidate",
  "rail_candidate",
  "flight_candidate",
  "ambiguous_movement",
  "unknown",
] as const;

export type CanonicalMobilityState = typeof CANONICAL_MOBILITY_STATES[number];
export type MobilityInferenceConfidence = "insufficient" | "low" | "medium" | "high";
export type MobilityTransitionReason =
  | "movement_onset"
  | "sustained_state_change"
  | "sustained_stationary"
  | "recording_gap"
  | "day_boundary"
  | "end_of_input";

export type MobilityStateEvidenceScore = Readonly<{
  state: Exclude<CanonicalMobilityState, "ambiguous_movement" | "unknown">;
  support: number;
  contradiction: number;
  score: number;
  reasons: readonly string[];
}>;

export type InferredMobilityFrame = Readonly<{
  frame: CanonicalMobilityFeatureFrame;
  state: CanonicalMobilityState;
  confidence: MobilityInferenceConfidence;
  scores: readonly MobilityStateEvidenceScore[];
  leadingScore: number;
  leadingMargin: number;
}>;

export type CanonicalMobilityEvent = Readonly<{
  eventId: string;
  subjectUserId: string;
  accountGeneration: string;
  localDayKey: string;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  movingDurationMs: number;
  temporaryPauseDurationMs: number;
  firstCanonicalSampleIdentity: string;
  lastCanonicalSampleIdentity: string;
  captureIdentities: readonly string[];
  routeSampleIdentities: readonly string[];
  featureFrameIdentities: readonly string[];
  mobilityState: Exclude<CanonicalMobilityState, "stationary" | "unknown">;
  confidence: MobilityInferenceConfidence;
  inferenceVersion: typeof MOBILITY_INFERENCE_VERSION;
  sourceEvidenceVersions: readonly string[];
  distanceMeters: number;
  intervalCount: number;
  validIntervalCount: number;
  rejectedIntervalCount: number;
  robustSpeedMedianMps?: number;
  robustSpeedLowerQuartileMps?: number;
  robustSpeedUpperQuartileMps?: number;
  maximumTrustworthySpeedMps?: number;
  totalMeasuredStepDelta?: number;
  cadenceMedianStepsPerMinute?: number;
  meanEvidenceQuality: number;
  motionEvidenceFrameCount: number;
  locationOnlyFrameCount: number;
  startConfidence: MobilityInferenceConfidence;
  endConfidence: MobilityInferenceConfidence;
  transitionReason: MobilityTransitionReason;
}>;

export type CanonicalMobilityInferenceResult = Readonly<{
  state: "ready";
  featureBuild: MobilityFeatureFrameBuildResult;
  inferredFrames: readonly InferredMobilityFrame[];
  events: readonly CanonicalMobilityEvent[];
  inferenceVersion: typeof MOBILITY_INFERENCE_VERSION;
}>;

export type StaleMobilityInferenceResult = Readonly<{
  state: "stale";
  featureBuild: null;
  inferredFrames: readonly [];
  events: readonly [];
  inferenceVersion: typeof MOBILITY_INFERENCE_VERSION;
}>;

type ScoringState = MobilityStateEvidenceScore["state"];

function inRange(value: number | undefined, range: readonly [number, number]): boolean {
  return value !== undefined && value >= range[0] && value <= range[1];
}

function scoreState(
  state: ScoringState,
  contributions: readonly Readonly<{ when: boolean; support?: number; contradiction?: number; reason: string }>[],
): MobilityStateEvidenceScore {
  let support = 0;
  let contradiction = 0;
  const reasons: string[] = [];
  for (const contribution of contributions) {
    if (!contribution.when) continue;
    support += contribution.support ?? 0;
    contradiction += contribution.contradiction ?? 0;
    reasons.push(contribution.reason);
  }
  return {
    state,
    support,
    contradiction,
    score: Math.max(0, Math.min(MOBILITY_SCORE_POLICY.maximumScore, support - contradiction)),
    reasons,
  };
}

function frameScores(frame: CanonicalMobilityFeatureFrame): MobilityStateEvidenceScore[] {
  const speed = frame.robustSpeedMps;
  const cadence = frame.cadenceStepsPerMinute;
  const measuredSteps = frame.pedometerAvailability === "measured" ? frame.stepDelta : undefined;
  const meaningfulMovement = frame.displacementMeters >= MOBILITY_FEATURE_POLICY.minimumDisplacementMeters
    || (speed !== undefined && speed > MOBILITY_FEATURE_POLICY.stationaryMaximumSpeedMps);
  const smoothAcceleration = frame.accelerationRmsMps2 !== undefined
    && frame.accelerationRmsMps2 <= MOBILITY_FEATURE_POLICY.smoothAccelerationMaximumMps2;
  const smoothRotation = frame.rotationRateRmsDegreesPerSecond !== undefined
    && frame.rotationRateRmsDegreesPerSecond <= MOBILITY_FEATURE_POLICY.smoothRotationMaximumDegreesPerSecond;
  const directional = (frame.directionalConsistency ?? 0) >= MOBILITY_FEATURE_POLICY.minimumDirectionalConsistency;
  const flightSignalCount = [
    speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.flightMinimumSpeedMps,
    frame.maximumAltitudeMeters !== undefined && frame.maximumAltitudeMeters >= MOBILITY_FEATURE_POLICY.flightMinimumAltitudeMeters,
    frame.verticalSpeedMps !== undefined && Math.abs(frame.verticalSpeedMps) >= MOBILITY_FEATURE_POLICY.flightMinimumVerticalSpeedMps,
    frame.displacementMeters >= 1_000,
    measuredSteps === 0,
  ].filter(Boolean).length;

  return [
    scoreState("stationary", [
      { when: speed !== undefined && speed <= MOBILITY_FEATURE_POLICY.stationaryMaximumSpeedMps, support: 3, reason: "low_robust_speed" },
      { when: speed === undefined && frame.displacementMeters <= MOBILITY_FEATURE_POLICY.stationaryMaximumDisplacementMeters, support: 2, reason: "no_trustworthy_displacement" },
      { when: frame.displacementMeters <= MOBILITY_FEATURE_POLICY.stationaryMaximumDisplacementMeters, support: 2, reason: "bounded_displacement" },
      { when: measuredSteps === 0, support: 1, reason: "measured_zero_steps" },
      { when: (frame.accelerationRmsMps2 ?? 0) > 4, contradiction: 2, reason: "strong_motion_contradiction" },
      { when: (measuredSteps ?? 0) > 0, contradiction: 4, reason: "measured_steps_contradiction" },
      { when: meaningfulMovement && (speed ?? 0) > 1, contradiction: 3, reason: "movement_contradiction" },
    ]),
    scoreState("walking", [
      { when: inRange(speed, MOBILITY_FEATURE_POLICY.walkingSpeedRangeMps), support: 3, reason: "pedestrian_speed" },
      { when: inRange(cadence, MOBILITY_FEATURE_POLICY.walkingCadenceRangeSpm), support: 4, reason: "walking_cadence" },
      { when: measuredSteps !== undefined && measuredSteps > 0, support: 2, reason: "measured_steps" },
      { when: frame.accelerationRmsMps2 !== undefined && frame.accelerationRmsMps2 >= 0.4 && frame.accelerationRmsMps2 <= 4.5, support: 1, reason: "pedestrian_motion_intensity" },
      { when: frame.displacementMeters >= 15, support: 1, reason: "coherent_displacement" },
      { when: speed !== undefined && speed > MOBILITY_FEATURE_POLICY.walkingSpeedRangeMps[1] + 1, contradiction: 4, reason: "speed_too_high" },
      { when: measuredSteps === 0 && (speed ?? 0) > 2.5, contradiction: 2, reason: "zero_steps_at_speed" },
    ]),
    scoreState("running", [
      { when: inRange(speed, MOBILITY_FEATURE_POLICY.runningSpeedRangeMps), support: 3, reason: "running_speed" },
      { when: cadence !== undefined && cadence >= MOBILITY_FEATURE_POLICY.runningCadenceMinimumSpm, support: 4, reason: "running_cadence" },
      { when: measuredSteps !== undefined && measuredSteps > 0, support: 1.5, reason: "measured_steps" },
      { when: (frame.accelerationRmsMps2 ?? 0) >= 2, support: 1.5, reason: "higher_motion_intensity" },
      { when: (frame.jerkRmsMps3 ?? 0) >= 3, support: 1, reason: "impact_variation" },
      { when: speed !== undefined && speed < MOBILITY_FEATURE_POLICY.runningSpeedRangeMps[0], contradiction: 3, reason: "speed_too_low" },
      { when: cadence !== undefined && cadence < 100, contradiction: 3, reason: "cadence_too_low" },
    ]),
    scoreState("bicycle_candidate", [
      { when: inRange(speed, MOBILITY_FEATURE_POLICY.bicycleSpeedRangeMps), support: 3, reason: "moderate_sustained_speed" },
      { when: measuredSteps === 0, support: 2, reason: "measured_step_absence" },
      { when: smoothAcceleration, support: 1, reason: "smooth_motion" },
      { when: directional, support: 1, reason: "route_continuity" },
      { when: frame.displacementMeters >= 60, support: 1, reason: "sustained_displacement" },
      { when: measuredSteps !== undefined && measuredSteps > 1, contradiction: 4, reason: "pedestrian_steps" },
      { when: speed !== undefined && speed >= 15, contradiction: 3, reason: "speed_above_candidate_range" },
    ]),
    scoreState("road_vehicle_candidate", [
      { when: speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.roadVehicleMinimumSpeedMps, support: 4, reason: "non_pedestrian_speed" },
      { when: speed !== undefined && speed >= 10, support: 2, reason: "sustained_higher_speed" },
      { when: measuredSteps === 0, support: 2, reason: "measured_step_absence" },
      { when: frame.displacementMeters >= 100, support: 1, reason: "longer_displacement" },
      { when: directional, support: 1, reason: "route_continuity" },
      { when: measuredSteps !== undefined && measuredSteps > 2, contradiction: 5, reason: "pedestrian_cadence_contradiction" },
      { when: inRange(cadence, MOBILITY_FEATURE_POLICY.walkingCadenceRangeSpm), contradiction: 4, reason: "walking_cadence_contradiction" },
    ]),
    scoreState("rail_candidate", [
      { when: speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.railMinimumSpeedMps, support: 3, reason: "sustained_transit_speed" },
      { when: measuredSteps === 0, support: 2, reason: "measured_step_absence" },
      { when: speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.railMinimumSpeedMps && (frame.directionalConsistency ?? 0) >= MOBILITY_FEATURE_POLICY.railDirectionalConsistency, support: 3, reason: "strong_directional_persistence" },
      { when: speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.railMinimumSpeedMps && smoothAcceleration, support: 1.5, reason: "smooth_acceleration" },
      { when: speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.railMinimumSpeedMps && smoothRotation, support: 1.5, reason: "low_rotation" },
      { when: measuredSteps !== undefined && measuredSteps > 1, contradiction: 4, reason: "pedestrian_steps" },
      { when: (frame.directionalConsistency ?? 1) < 0.5, contradiction: 2, reason: "directional_volatility" },
    ]),
    scoreState("flight_candidate", [
      { when: flightSignalCount >= 3 && speed !== undefined && speed >= MOBILITY_FEATURE_POLICY.flightMinimumSpeedMps, support: 6, reason: "multi_signal_high_speed" },
      { when: flightSignalCount >= 3 && (frame.maximumAltitudeMeters ?? 0) >= MOBILITY_FEATURE_POLICY.flightMinimumAltitudeMeters, support: 3, reason: "trusted_altitude" },
      { when: flightSignalCount >= 3 && frame.displacementMeters >= 1_000, support: 2, reason: "large_displacement" },
      { when: flightSignalCount >= 3 && frame.verticalSpeedMps !== undefined && Math.abs(frame.verticalSpeedMps) >= MOBILITY_FEATURE_POLICY.flightMinimumVerticalSpeedMps, support: 1, reason: "vertical_change" },
      { when: flightSignalCount < 3, contradiction: 8, reason: "insufficient_independent_flight_signals" },
    ]),
  ];
}

function confidenceFor(frame: CanonicalMobilityFeatureFrame, leadingScore: number, margin: number): MobilityInferenceConfidence {
  if (frame.evidenceQuality < MOBILITY_SCORE_POLICY.insufficientQualityScore || leadingScore < MOBILITY_SCORE_POLICY.minimumMovementScore) return "insufficient";
  if (frame.evidenceQuality < MOBILITY_SCORE_POLICY.lowQualityScore || margin < MOBILITY_SCORE_POLICY.ambiguousMargin) return "low";
  if (
    frame.evidenceQuality >= MOBILITY_SCORE_POLICY.mediumQualityScore
    && leadingScore >= MOBILITY_SCORE_POLICY.highConfidenceScore
    && margin >= MOBILITY_SCORE_POLICY.highConfidenceMargin
  ) return "high";
  return leadingScore >= MOBILITY_SCORE_POLICY.mediumConfidenceScore ? "medium" : "low";
}

export function inferCanonicalMobilityFrame(frame: CanonicalMobilityFeatureFrame): InferredMobilityFrame {
  const scores = frameScores(frame).sort((left, right) => right.score - left.score || left.state.localeCompare(right.state));
  const leading = scores[0];
  const second = scores[1];
  const margin = leading.score - second.score;
  const movementScores = scores.filter((score) => score.state !== "stationary");
  const leadingMovement = movementScores[0];
  const stationary = scores.find((score) => score.state === "stationary")!;
  let state: CanonicalMobilityState;
  if (
    frame.horizontalAccuracyQuality === "insufficient"
    && frame.pedometerAvailability !== "measured"
    && frame.deviceMotionAvailability !== "measured"
  ) {
    state = "unknown";
  } else if (
    stationary.score >= MOBILITY_SCORE_POLICY.minimumStationaryScore
    && stationary.score >= leadingMovement.score
  ) {
    state = "stationary";
  } else if (leadingMovement.score < MOBILITY_SCORE_POLICY.minimumMovementScore) {
    state = frame.displacementMeters > MOBILITY_FEATURE_POLICY.stationaryMaximumDisplacementMeters
      ? "ambiguous_movement"
      : "unknown";
  } else if (leadingMovement.score - movementScores[1].score < MOBILITY_SCORE_POLICY.ambiguousMargin) {
    state = "ambiguous_movement";
  } else {
    state = leadingMovement.state;
  }
  return {
    frame,
    state,
    confidence: confidenceFor(frame, state === "stationary" ? stationary.score : leadingMovement.score, margin),
    scores,
    leadingScore: state === "stationary" ? stationary.score : leadingMovement.score,
    leadingMargin: margin,
  };
}

function quantile(values: readonly number[], fraction: number): number | undefined {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  const position = (ordered.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return lower === upper ? ordered[lower] : ordered[lower] + (ordered[upper] - ordered[lower]) * (position - lower);
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function confidenceRank(value: MobilityInferenceConfidence): number {
  return { insufficient: 0, low: 1, medium: 2, high: 3 }[value];
}

function aggregateConfidence(frames: readonly InferredMobilityFrame[]): MobilityInferenceConfidence {
  if (frames.length === 0) return "insufficient";
  const average = frames.reduce((total, frame) => total + confidenceRank(frame.confidence), 0) / frames.length;
  return average >= 2.5 ? "high" : average >= 1.5 ? "medium" : average >= 0.5 ? "low" : "insufficient";
}

function stableHash(value: string): string {
  let hash = 2_166_136_261;
  for (let index = 0; index < value.length; index += 1) hash = Math.imul(hash ^ value.charCodeAt(index), 16_777_619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function pauseMaximumMs(state: CanonicalMobilityState): number {
  if (state === "walking" || state === "running") return MOBILITY_TEMPORAL_POLICY.pedestrianPauseMaximumMs;
  if (state === "bicycle_candidate") return MOBILITY_TEMPORAL_POLICY.bicyclePauseMaximumMs;
  if (state === "road_vehicle_candidate") return MOBILITY_TEMPORAL_POLICY.roadVehiclePauseMaximumMs;
  if (state === "rail_candidate") return MOBILITY_TEMPORAL_POLICY.railPauseMaximumMs;
  if (state === "flight_candidate") return MOBILITY_TEMPORAL_POLICY.flightPauseMaximumMs;
  return MOBILITY_TEMPORAL_POLICY.ambiguousPauseMaximumMs;
}

function isMovementState(state: CanonicalMobilityState): state is Exclude<CanonicalMobilityState, "stationary" | "unknown"> {
  return state !== "stationary" && state !== "unknown";
}

type EventAccumulator = {
  state: Exclude<CanonicalMobilityState, "stationary" | "unknown">;
  movingFrames: InferredMobilityFrame[];
  acceptedFrames: InferredMobilityFrame[];
  pauseFrames: InferredMobilityFrame[];
  committedPauseFrames: InferredMobilityFrame[];
  reason: MobilityTransitionReason;
};

function framesDuration(frames: readonly InferredMobilityFrame[]): number {
  return frames.reduce((total, inferred) => total + inferred.frame.durationMs, 0);
}

function eventFromAccumulator(accumulator: EventAccumulator, transitionReason: MobilityTransitionReason): CanonicalMobilityEvent | null {
  const frames = accumulator.acceptedFrames;
  const first = frames[0];
  const last = frames.at(-1);
  if (!first || !last) return null;
  const distanceMeters = accumulator.movingFrames.reduce((total, inferred) => total + inferred.frame.displacementMeters, 0);
  const movingDurationMs = framesDuration(accumulator.movingFrames);
  if (
    distanceMeters < MOBILITY_TEMPORAL_POLICY.minimumEventDistanceMeters
    || movingDurationMs < MOBILITY_TEMPORAL_POLICY.minimumEventMovingDurationMs
  ) return null;
  const robustSpeeds = accumulator.movingFrames.flatMap((inferred) => inferred.frame.robustSpeedMps === undefined ? [] : [inferred.frame.robustSpeedMps]);
  const maximumSpeeds = accumulator.movingFrames.flatMap((inferred) => inferred.frame.maximumTrustworthySpeedMps === undefined ? [] : [inferred.frame.maximumTrustworthySpeedMps]);
  const stepFrames = accumulator.movingFrames.filter((inferred) => inferred.frame.stepDelta !== undefined);
  const cadences = accumulator.movingFrames.flatMap((inferred) => inferred.frame.cadenceStepsPerMinute === undefined ? [] : [inferred.frame.cadenceStepsPerMinute]);
  const captureIdentities = unique(frames.flatMap((inferred) => inferred.frame.captureIdentities));
  const anchor = `${first.frame.subjectUserId}:${first.frame.firstSampleIdentity}:${first.frame.startedAtMs}:${accumulator.state}:v${MOBILITY_INFERENCE_VERSION}`;
  return {
    eventId: `mobility-event-v${MOBILITY_INFERENCE_VERSION}:${stableHash(anchor)}`,
    subjectUserId: first.frame.subjectUserId,
    accountGeneration: first.frame.accountGeneration,
    localDayKey: first.frame.localDayKey,
    startedAtMs: first.frame.startedAtMs,
    endedAtMs: last.frame.endedAtMs,
    durationMs: last.frame.endedAtMs - first.frame.startedAtMs,
    movingDurationMs,
    temporaryPauseDurationMs: framesDuration([...accumulator.committedPauseFrames, ...accumulator.pauseFrames]),
    firstCanonicalSampleIdentity: first.frame.firstSampleIdentity,
    lastCanonicalSampleIdentity: last.frame.lastSampleIdentity,
    captureIdentities,
    routeSampleIdentities: unique(frames.flatMap((inferred) => inferred.frame.routeSampleIdentities)),
    featureFrameIdentities: frames.map((inferred) => inferred.frame.frameIdentity),
    mobilityState: accumulator.state,
    confidence: aggregateConfidence(accumulator.movingFrames),
    inferenceVersion: MOBILITY_INFERENCE_VERSION,
    sourceEvidenceVersions: unique(frames.map((inferred) => inferred.frame.sourceEvidenceVersion)),
    distanceMeters,
    intervalCount: frames.reduce((total, inferred) => total + inferred.frame.intervalCount, 0),
    validIntervalCount: frames.reduce((total, inferred) => total + inferred.frame.validIntervalCount, 0),
    rejectedIntervalCount: frames.reduce((total, inferred) => total + inferred.frame.rejectedIntervalCount, 0),
    ...(quantile(robustSpeeds, 0.5) === undefined ? {} : { robustSpeedMedianMps: quantile(robustSpeeds, 0.5) }),
    ...(quantile(robustSpeeds, 0.25) === undefined ? {} : { robustSpeedLowerQuartileMps: quantile(robustSpeeds, 0.25) }),
    ...(quantile(robustSpeeds, 0.75) === undefined ? {} : { robustSpeedUpperQuartileMps: quantile(robustSpeeds, 0.75) }),
    ...(maximumSpeeds.length === 0 ? {} : { maximumTrustworthySpeedMps: Math.max(...maximumSpeeds) }),
    ...(stepFrames.length === 0 ? {} : { totalMeasuredStepDelta: stepFrames.reduce((total, inferred) => total + (inferred.frame.stepDelta ?? 0), 0) }),
    ...(quantile(cadences, 0.5) === undefined ? {} : { cadenceMedianStepsPerMinute: quantile(cadences, 0.5) }),
    meanEvidenceQuality: frames.reduce((total, inferred) => total + inferred.frame.evidenceQuality, 0) / frames.length,
    motionEvidenceFrameCount: frames.filter((inferred) => inferred.frame.deviceMotionAvailability === "measured" || inferred.frame.pedometerAvailability === "measured").length,
    locationOnlyFrameCount: frames.filter((inferred) => inferred.frame.deviceMotionAvailability !== "measured" && inferred.frame.pedometerAvailability !== "measured").length,
    startConfidence: accumulator.movingFrames[0].confidence,
    endConfidence: accumulator.movingFrames.at(-1)!.confidence,
    transitionReason,
  };
}

function enoughForStart(frames: readonly InferredMobilityFrame[], state: CanonicalMobilityState): boolean {
  const minimumFrames = state === "flight_candidate"
    ? MOBILITY_TEMPORAL_POLICY.flightStartMinimumFrames
    : MOBILITY_TEMPORAL_POLICY.movementStartMinimumFrames;
  const minimumDuration = state === "flight_candidate"
    ? MOBILITY_TEMPORAL_POLICY.flightStartMinimumDurationMs
    : MOBILITY_TEMPORAL_POLICY.movementStartMinimumDurationMs;
  return frames.length >= minimumFrames && framesDuration(frames) >= minimumDuration;
}

export function segmentCanonicalMobilityEvents(inferredFrames: readonly InferredMobilityFrame[]): CanonicalMobilityEvent[] {
  const events: CanonicalMobilityEvent[] = [];
  let active: EventAccumulator | null = null;
  let onset: InferredMobilityFrame[] = [];
  let transition: InferredMobilityFrame[] = [];
  let previous: InferredMobilityFrame | null = null;

  const finalize = (reason: MobilityTransitionReason) => {
    if (!active) return;
    const event = eventFromAccumulator(active, reason);
    if (event) events.push(event);
    active = null;
    transition = [];
  };

  for (const inferred of inferredFrames) {
    const boundaryReason: MobilityTransitionReason | null = previous && previous.frame.continuityIdentity !== inferred.frame.continuityIdentity
      ? "recording_gap"
      : previous && previous.frame.localDayKey !== inferred.frame.localDayKey
        ? "day_boundary"
        : null;
    if (boundaryReason) {
      finalize(boundaryReason);
      onset = [];
    }
    previous = inferred;

    if (!active) {
      if (!isMovementState(inferred.state)) {
        onset = [];
        continue;
      }
      if (onset.length > 0 && onset[0].state !== inferred.state) onset = [];
      onset.push(inferred);
      if (enoughForStart(onset, inferred.state)) {
        active = {
          state: inferred.state,
          movingFrames: [...onset],
          acceptedFrames: [...onset],
          pauseFrames: [],
          committedPauseFrames: [],
          reason: "movement_onset",
        };
        onset = [];
      }
      continue;
    }

    if (inferred.state === "stationary" || inferred.state === "unknown") {
      active.pauseFrames.push(inferred);
      if (framesDuration(active.pauseFrames) > pauseMaximumMs(active.state)) {
        active.pauseFrames = [];
        finalize("sustained_stationary");
        onset = [];
      }
      continue;
    }

    if (inferred.state === active.state || inferred.state === "ambiguous_movement") {
      if (active.pauseFrames.length > 0) {
        active.acceptedFrames.push(...active.pauseFrames);
        active.committedPauseFrames.push(...active.pauseFrames);
        active.pauseFrames = [];
      }
      if (transition.length > 0) {
        active.movingFrames.push(...transition);
        active.acceptedFrames.push(...transition);
        transition = [];
      }
      active.movingFrames.push(inferred);
      active.acceptedFrames.push(inferred);
      continue;
    }

    if (active.pauseFrames.length > 0) {
      active.acceptedFrames.push(...active.pauseFrames);
      active.committedPauseFrames.push(...active.pauseFrames);
      active.pauseFrames = [];
    }
    if (transition.length > 0 && transition[0].state !== inferred.state) {
      active.movingFrames.push(...transition);
      active.acceptedFrames.push(...transition);
      transition = [];
    }
    transition.push(inferred);
    if (
      transition.length >= MOBILITY_TEMPORAL_POLICY.stateTransitionMinimumFrames
      && framesDuration(transition) >= MOBILITY_TEMPORAL_POLICY.stateTransitionMinimumDurationMs
    ) {
      const nextFrames = [...transition];
      finalize("sustained_state_change");
      active = {
        state: inferred.state,
        movingFrames: nextFrames,
        acceptedFrames: nextFrames,
        pauseFrames: [],
        committedPauseFrames: [],
        reason: "sustained_state_change",
      };
    }
  }
  if (active?.pauseFrames.length && framesDuration(active.pauseFrames) <= pauseMaximumMs(active.state)) {
    active.acceptedFrames.push(...active.pauseFrames);
    active.committedPauseFrames.push(...active.pauseFrames);
    active.pauseFrames = [];
  }
  finalize("end_of_input");
  return events;
}

export function inferCanonicalMobilityEvents(input: {
  accountUserId: string;
  accountGeneration: string;
  subjectUserId: string;
  route: LocationHistoryRoute;
  motionEvidenceWindows?: readonly CanonicalMotionEvidenceWindow[];
}): CanonicalMobilityInferenceResult {
  const featureBuild = buildCanonicalMobilityFeatureFrames(input);
  const inferredFrames = featureBuild.frames.map(inferCanonicalMobilityFrame);
  return {
    state: "ready",
    featureBuild,
    inferredFrames,
    events: segmentCanonicalMobilityEvents(inferredFrames),
    inferenceVersion: MOBILITY_INFERENCE_VERSION,
  };
}

/** A small generation authority for asynchronous callers. The inference itself
 * remains pure; late tasks must present the exact current token to publish. */
export class CanonicalMobilityInferenceAuthority {
  private generation = 0;
  private current: Readonly<{ accountUserId: string; subjectUserId: string; token: string }> | null = null;

  activate(accountUserId: string, subjectUserId: string): string {
    this.generation += 1;
    const token = `mobility-authority:${this.generation}:${stableHash(`${accountUserId}:${subjectUserId}`)}`;
    this.current = { accountUserId, subjectUserId, token };
    return token;
  }

  invalidate(): void {
    this.generation += 1;
    this.current = null;
  }

  infer(token: string, input: Omit<Parameters<typeof inferCanonicalMobilityEvents>[0], "accountGeneration">): CanonicalMobilityInferenceResult | StaleMobilityInferenceResult {
    if (
      !this.current
      || token !== this.current.token
      || input.accountUserId !== this.current.accountUserId
      || input.subjectUserId !== this.current.subjectUserId
    ) {
      return { state: "stale", featureBuild: null, inferredFrames: [], events: [], inferenceVersion: MOBILITY_INFERENCE_VERSION };
    }
    return inferCanonicalMobilityEvents({ ...input, accountGeneration: token });
  }
}

/** Conservative compatibility projection only. Manual subject/viewer overrides
 * remain downstream and never feed back into canonical inference. */
export function canonicalMobilityStateToLegacyPresentationMode(
  state: CanonicalMobilityState,
): LocationHistoryInferredMovementMode {
  if (state === "walking" || state === "running") return "walking";
  if (state === "bicycle_candidate") return "bicycle";
  if (state === "road_vehicle_candidate") return "vehicle";
  return "unknown";
}
