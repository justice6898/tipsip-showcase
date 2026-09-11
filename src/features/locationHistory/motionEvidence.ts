export const MOTION_EVIDENCE_VERSION = 1 as const;

export const MOTION_EVIDENCE_POLICY = Object.freeze({
  targetWindowDurationMs: 5_000,
  minimumWindowDurationMs: 3_000,
  minimumMotionSampleCount: 15,
  maximumRawSampleCount: 120,
  maximumMalformedFraction: 0.25,
  maximumSensorIntervalMs: 1_000,
  maximumAccelerationMagnitudeMps2: 100,
  maximumRotationRateMagnitudeDegreesPerSecond: 2_000,
  maximumJerkMagnitudeMps3: 1_000,
  maximumStepDeltaPerWindow: 80,
  maximumPlausibleStepRatePerSecond: 5,
  associationToleranceMs: 1_500,
  maximumRecentWindowCount: 36,
});

export type MotionEvidenceAvailability =
  | "measured"
  | "unavailable"
  | "permission_required"
  | "insufficient";

export type MotionVector3 = Readonly<{ x: number; y: number; z: number }>;

export type CanonicalDeviceMotionSample = Readonly<{
  /** Canonical wall-clock receipt time. Native sensor timestamps may be uptime-based. */
  observedAtMs: number;
  /** Expo DeviceMotion user/linear acceleration, already expressed in m/s^2. */
  userAccelerationMps2?: MotionVector3;
  /** Expo DeviceMotion rotation rate, expressed in degrees/second. */
  rotationRateDegreesPerSecond?: MotionVector3;
}>;

export type CanonicalMotionEvidenceWindow = Readonly<{
  accountUserId: string;
  evidenceIdentity: string;
  windowStartedAtMs: number;
  windowEndedAtMs: number;
  durationMs: number;
  pedometerAvailability: MotionEvidenceAvailability;
  pedometerMeasurementSource?: "expo_pedometer_watch" | "expo_pedometer_interval_query";
  stepDelta?: number;
  deviceMotionAvailability: MotionEvidenceAvailability;
  deviceMotionSampleCount: number;
  rejectedMotionSampleCount: number;
  accelerationSource?: "expo_device_motion_user_acceleration";
  accelerationRmsMps2?: number;
  accelerationPeakMps2?: number;
  accelerationVarianceMps4?: number;
  jerkRmsMps3?: number;
  rotationRateSource?: "expo_device_motion_rotation_rate";
  rotationRateRmsDegreesPerSecond?: number;
  motionEvidenceVersion: typeof MOTION_EVIDENCE_VERSION;
}>;

export function motionEvidenceIdentity(windowStartedAtMs: number, windowEndedAtMs: number): string {
  return `motion-v${MOTION_EVIDENCE_VERSION}:${windowStartedAtMs}:${windowEndedAtMs}`;
}

/** Creates the only canonical zero-step evidence used by the foreground stay
 * authority. Unlike a change-driven watch callback, Expo's interval query
 * measures both ends of the requested Core Motion interval, so a returned
 * zero is evidence rather than callback silence. */
export function motionEvidenceFromPedometerInterval(input: Readonly<{
  accountUserId: string;
  requestedFromMs: number;
  requestedThroughMs: number;
  result: Readonly<{ state: "available"; steps: number; fromMs: number; throughMs: number }>;
}>): CanonicalMotionEvidenceWindow | null {
  const { result } = input;
  if (
    !input.accountUserId
    || result.fromMs !== input.requestedFromMs
    || result.throughMs !== input.requestedThroughMs
    || !Number.isFinite(result.fromMs)
    || !Number.isFinite(result.throughMs)
    || result.fromMs < 0
    || result.throughMs <= result.fromMs
    || !Number.isInteger(result.steps)
    || result.steps < 0
  ) return null;
  const durationMs = result.throughMs - result.fromMs;
  const maximumSteps = Math.ceil(
    (durationMs / 1_000) * MOTION_EVIDENCE_POLICY.maximumPlausibleStepRatePerSecond,
  );
  if (result.steps > maximumSteps) return null;
  return {
    accountUserId: input.accountUserId,
    evidenceIdentity: motionEvidenceIdentity(result.fromMs, result.throughMs),
    windowStartedAtMs: result.fromMs,
    windowEndedAtMs: result.throughMs,
    durationMs,
    pedometerAvailability: "measured",
    pedometerMeasurementSource: "expo_pedometer_interval_query",
    stepDelta: result.steps,
    deviceMotionAvailability: "unavailable",
    deviceMotionSampleCount: 0,
    rejectedMotionSampleCount: 0,
    motionEvidenceVersion: MOTION_EVIDENCE_VERSION,
  };
}

function finiteVector(vector: MotionVector3 | undefined, maximumMagnitude: number): MotionVector3 | null {
  if (!vector || !Number.isFinite(vector.x) || !Number.isFinite(vector.y) || !Number.isFinite(vector.z)) return null;
  const magnitude = Math.hypot(vector.x, vector.y, vector.z);
  return Number.isFinite(magnitude) && magnitude <= maximumMagnitude ? vector : null;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function rms(values: readonly number[]): number {
  return Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length);
}

export class MeasuredStepDeltaAccumulator {
  private baseline: number | null = null;
  private pendingDelta = 0;
  private resetCount = 0;
  private rejectedCount = 0;

  observeCumulativeSteps(cumulativeSteps: number): number {
    if (!Number.isInteger(cumulativeSteps) || cumulativeSteps < 0) {
      this.rejectedCount += 1;
      return 0;
    }
    if (this.baseline === null || cumulativeSteps < this.baseline) {
      if (this.baseline !== null) this.resetCount += 1;
      this.baseline = cumulativeSteps;
      return 0;
    }
    const delta = cumulativeSteps - this.baseline;
    this.baseline = cumulativeSteps;
    if (
      delta > MOTION_EVIDENCE_POLICY.maximumStepDeltaPerWindow
      || this.pendingDelta + delta > MOTION_EVIDENCE_POLICY.maximumStepDeltaPerWindow
    ) {
      this.rejectedCount += 1;
      return 0;
    }
    this.pendingDelta += delta;
    return delta;
  }

  consumeWindowDelta(): number {
    const result = this.pendingDelta;
    this.pendingDelta = 0;
    return result;
  }

  restart(): void {
    this.baseline = null;
  }

  clear(): void {
    this.baseline = null;
    this.pendingDelta = 0;
  }

  snapshot(): Readonly<{ resetCount: number; rejectedCount: number; pendingDelta: number }> {
    return { resetCount: this.resetCount, rejectedCount: this.rejectedCount, pendingDelta: this.pendingDelta };
  }
}

type AcceptedMotionSample = Readonly<{
  observedAtMs: number;
  acceleration?: MotionVector3;
  accelerationMagnitude?: number;
  rotationRateMagnitude?: number;
}>;

export class MotionEvidenceWindowAggregator {
  private accountUserId: string | null = null;
  private windowStartedAtMs: number | null = null;
  private samples: AcceptedMotionSample[] = [];
  private receivedMotionSampleCount = 0;
  private rejectedMotionSampleCount = 0;
  private pedometerAvailability: MotionEvidenceAvailability = "unavailable";
  private deviceMotionAvailability: MotionEvidenceAvailability = "unavailable";
  private stepAccumulator = new MeasuredStepDeltaAccumulator();

  begin(input: Readonly<{
    accountUserId: string;
    startedAtMs: number;
    pedometerAvailability: MotionEvidenceAvailability;
    deviceMotionAvailability: MotionEvidenceAvailability;
  }>): void {
    this.clear();
    this.accountUserId = input.accountUserId;
    this.windowStartedAtMs = input.startedAtMs;
    this.pedometerAvailability = input.pedometerAvailability;
    this.deviceMotionAvailability = input.deviceMotionAvailability;
  }

  setAvailability(input: Readonly<{
    pedometer?: MotionEvidenceAvailability;
    deviceMotion?: MotionEvidenceAvailability;
  }>): void {
    if (input.pedometer) this.pedometerAvailability = input.pedometer;
    if (input.deviceMotion) this.deviceMotionAvailability = input.deviceMotion;
  }

  observeCumulativeSteps(cumulativeSteps: number): number {
    return this.stepAccumulator.observeCumulativeSteps(cumulativeSteps);
  }

  restartPedometerBaseline(): void {
    this.stepAccumulator.restart();
  }

  ingest(sample: CanonicalDeviceMotionSample): boolean {
    this.receivedMotionSampleCount += 1;
    if (!Number.isFinite(sample.observedAtMs) || this.windowStartedAtMs === null || sample.observedAtMs < this.windowStartedAtMs) {
      this.rejectedMotionSampleCount += 1;
      return false;
    }
    const acceleration = finiteVector(
      sample.userAccelerationMps2,
      MOTION_EVIDENCE_POLICY.maximumAccelerationMagnitudeMps2,
    );
    const rotation = finiteVector(
      sample.rotationRateDegreesPerSecond,
      MOTION_EVIDENCE_POLICY.maximumRotationRateMagnitudeDegreesPerSecond,
    );
    if (!acceleration && !rotation) {
      this.rejectedMotionSampleCount += 1;
      return false;
    }
    if (this.samples.length >= MOTION_EVIDENCE_POLICY.maximumRawSampleCount) {
      this.rejectedMotionSampleCount += 1;
      return false;
    }
    this.samples.push({
      observedAtMs: sample.observedAtMs,
      ...(acceleration ? { acceleration, accelerationMagnitude: Math.hypot(acceleration.x, acceleration.y, acceleration.z) } : {}),
      ...(rotation ? { rotationRateMagnitude: Math.hypot(rotation.x, rotation.y, rotation.z) } : {}),
    });
    return true;
  }

  finish(windowEndedAtMs: number): CanonicalMotionEvidenceWindow | null {
    if (!this.accountUserId || this.windowStartedAtMs === null || !Number.isFinite(windowEndedAtMs)) return null;
    const windowStartedAtMs = this.windowStartedAtMs;
    const durationMs = windowEndedAtMs - windowStartedAtMs;
    if (durationMs <= 0) return null;
    const acceptedSamples = this.samples;
    const malformedFraction = this.receivedMotionSampleCount === 0
      ? 0
      : this.rejectedMotionSampleCount / this.receivedMotionSampleCount;
    const durationSufficient = durationMs >= MOTION_EVIDENCE_POLICY.minimumWindowDurationMs;
    const sampleCountSufficient = acceptedSamples.length >= MOTION_EVIDENCE_POLICY.minimumMotionSampleCount;
    const qualitySufficient = durationSufficient
      && sampleCountSufficient
      && malformedFraction <= MOTION_EVIDENCE_POLICY.maximumMalformedFraction;
    const accelerationSamples = acceptedSamples.filter((sample) => sample.accelerationMagnitude !== undefined);
    const accelerationMagnitudes = accelerationSamples.map((sample) => sample.accelerationMagnitude as number);
    const rotationMagnitudes = acceptedSamples.flatMap((sample) => (
      sample.rotationRateMagnitude === undefined ? [] : [sample.rotationRateMagnitude]
    ));
    const jerkMagnitudes: number[] = [];
    for (let index = 1; index < accelerationSamples.length; index += 1) {
      const previous = accelerationSamples[index - 1];
      const current = accelerationSamples[index];
      if (!previous.acceleration || !current.acceleration) continue;
      const intervalMs = current.observedAtMs - previous.observedAtMs;
      if (intervalMs <= 0 || intervalMs > MOTION_EVIDENCE_POLICY.maximumSensorIntervalMs) continue;
      const deltaMagnitude = Math.hypot(
        current.acceleration.x - previous.acceleration.x,
        current.acceleration.y - previous.acceleration.y,
        current.acceleration.z - previous.acceleration.z,
      );
      const jerk = deltaMagnitude / (intervalMs / 1_000);
      if (Number.isFinite(jerk) && jerk <= MOTION_EVIDENCE_POLICY.maximumJerkMagnitudeMps3) jerkMagnitudes.push(jerk);
    }
    const accelerationMean = accelerationMagnitudes.length > 0 ? mean(accelerationMagnitudes) : undefined;
    const stepDelta = this.stepAccumulator.consumeWindowDelta();
    // `watchStepCount` is change-driven. Only a positive observed delta proves
    // a measured streaming window; no callback (or only its initial baseline)
    // is explicitly insufficient and can never become a synthetic zero.
    const streamingPedometerAvailability = this.pedometerAvailability === "measured"
      ? stepDelta > 0 ? "measured" : "insufficient"
      : this.pedometerAvailability;
    const result: CanonicalMotionEvidenceWindow = {
      accountUserId: this.accountUserId,
      evidenceIdentity: motionEvidenceIdentity(windowStartedAtMs, windowEndedAtMs),
      windowStartedAtMs,
      windowEndedAtMs,
      durationMs,
      pedometerAvailability: streamingPedometerAvailability,
      ...(streamingPedometerAvailability === "measured" ? {
        pedometerMeasurementSource: "expo_pedometer_watch" as const,
        stepDelta,
      } : {}),
      deviceMotionAvailability: this.deviceMotionAvailability === "measured" && !qualitySufficient
        ? "insufficient"
        : this.deviceMotionAvailability,
      deviceMotionSampleCount: acceptedSamples.length,
      rejectedMotionSampleCount: this.rejectedMotionSampleCount,
      ...(qualitySufficient && accelerationMagnitudes.length >= MOTION_EVIDENCE_POLICY.minimumMotionSampleCount && accelerationMean !== undefined ? {
        accelerationSource: "expo_device_motion_user_acceleration" as const,
        accelerationRmsMps2: rms(accelerationMagnitudes),
        accelerationPeakMps2: Math.max(...accelerationMagnitudes),
        accelerationVarianceMps4: mean(accelerationMagnitudes.map((value) => (value - accelerationMean) ** 2)),
        ...(jerkMagnitudes.length >= MOTION_EVIDENCE_POLICY.minimumMotionSampleCount - 1
          ? { jerkRmsMps3: rms(jerkMagnitudes) }
          : {}),
      } : {}),
      ...(qualitySufficient && rotationMagnitudes.length >= MOTION_EVIDENCE_POLICY.minimumMotionSampleCount ? {
        rotationRateSource: "expo_device_motion_rotation_rate" as const,
        rotationRateRmsDegreesPerSecond: rms(rotationMagnitudes),
      } : {}),
      motionEvidenceVersion: MOTION_EVIDENCE_VERSION,
    };
    this.windowStartedAtMs = windowEndedAtMs;
    this.samples = [];
    this.receivedMotionSampleCount = 0;
    this.rejectedMotionSampleCount = 0;
    return result;
  }

  rawSampleCount(): number {
    return this.samples.length;
  }

  clear(): void {
    this.accountUserId = null;
    this.windowStartedAtMs = null;
    this.samples = [];
    this.receivedMotionSampleCount = 0;
    this.rejectedMotionSampleCount = 0;
    this.pedometerAvailability = "unavailable";
    this.deviceMotionAvailability = "unavailable";
    this.stepAccumulator.clear();
  }
}

function distanceFromWindowMs(observedAtMs: number, evidence: CanonicalMotionEvidenceWindow): number {
  if (observedAtMs < evidence.windowStartedAtMs) return evidence.windowStartedAtMs - observedAtMs;
  if (observedAtMs > evidence.windowEndedAtMs) return observedAtMs - evidence.windowEndedAtMs;
  return 0;
}

export function motionEvidenceForLocation(
  accountUserId: string,
  observedAtMs: number,
  windows: readonly CanonicalMotionEvidenceWindow[],
): CanonicalMotionEvidenceWindow | undefined {
  return windows
    .filter((window) => (
      window.accountUserId === accountUserId
      && distanceFromWindowMs(observedAtMs, window) <= MOTION_EVIDENCE_POLICY.associationToleranceMs
    ))
    .sort((left, right) => {
      const distance = distanceFromWindowMs(observedAtMs, left) - distanceFromWindowMs(observedAtMs, right);
      if (distance !== 0) return distance;
      const leftMidpoint = (left.windowStartedAtMs + left.windowEndedAtMs) / 2;
      const rightMidpoint = (right.windowStartedAtMs + right.windowEndedAtMs) / 2;
      return Math.abs(observedAtMs - leftMidpoint) - Math.abs(observedAtMs - rightMidpoint);
    })[0];
}

export function isCanonicalMotionEvidenceWindow(
  evidence: CanonicalMotionEvidenceWindow,
  accountUserId: string,
): boolean {
  if (
    evidence.accountUserId !== accountUserId
    || evidence.motionEvidenceVersion !== MOTION_EVIDENCE_VERSION
    || evidence.evidenceIdentity !== motionEvidenceIdentity(evidence.windowStartedAtMs, evidence.windowEndedAtMs)
    || !Number.isFinite(evidence.windowStartedAtMs)
    || !Number.isFinite(evidence.windowEndedAtMs)
    || evidence.durationMs !== evidence.windowEndedAtMs - evidence.windowStartedAtMs
    || evidence.durationMs <= 0
    || !Number.isInteger(evidence.deviceMotionSampleCount)
    || evidence.deviceMotionSampleCount < 0
    || !Number.isInteger(evidence.rejectedMotionSampleCount)
    || evidence.rejectedMotionSampleCount < 0
  ) return false;
  const maximumStepDelta = Math.max(
    MOTION_EVIDENCE_POLICY.maximumStepDeltaPerWindow,
    Math.ceil(
      (evidence.durationMs / 1_000) * MOTION_EVIDENCE_POLICY.maximumPlausibleStepRatePerSecond,
    ),
  );
  if (evidence.stepDelta !== undefined && (
    evidence.pedometerAvailability !== "measured"
    || !Number.isInteger(evidence.stepDelta)
    || evidence.stepDelta < 0
    || evidence.stepDelta > maximumStepDelta
  )) return false;
  if (evidence.pedometerMeasurementSource !== undefined
    && evidence.pedometerMeasurementSource !== "expo_pedometer_watch"
    && evidence.pedometerMeasurementSource !== "expo_pedometer_interval_query") return false;
  const optionalFinite = [
    evidence.accelerationRmsMps2,
    evidence.accelerationPeakMps2,
    evidence.accelerationVarianceMps4,
    evidence.jerkRmsMps3,
    evidence.rotationRateRmsDegreesPerSecond,
  ];
  return optionalFinite.every((value) => value === undefined || (Number.isFinite(value) && value >= 0));
}
