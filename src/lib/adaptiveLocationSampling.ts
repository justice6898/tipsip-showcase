import type { AcceptedCurrentLocationObservation } from "@/lib/locationPolicy";
import { haversineDistanceMeters } from "@/lib/geoDistance";

export type AdaptiveLocationSamplingState = "rest" | "active" | "fast";

export type AdaptiveLocationSamplingProfile = Readonly<{
  state: AdaptiveLocationSamplingState;
  accuracy: "balanced" | "high";
  timeIntervalMs: number;
  distanceIntervalMeters: number;
}>;

/** These are acquisition-density profiles, never transport classifications. */
export const ADAPTIVE_LOCATION_SAMPLING_PROFILES: Readonly<Record<AdaptiveLocationSamplingState, AdaptiveLocationSamplingProfile>> = Object.freeze({
  rest: Object.freeze({ state: "rest", accuracy: "balanced", timeIntervalMs: 15_000, distanceIntervalMeters: 25 }),
  active: Object.freeze({ state: "active", accuracy: "high", timeIntervalMs: 5_000, distanceIntervalMeters: 8 }),
  fast: Object.freeze({ state: "fast", accuracy: "high", timeIntervalMs: 3_000, distanceIntervalMeters: 12 }),
});

export const ADAPTIVE_LOCATION_EVIDENCE_POLICY = Object.freeze({
  maximumEvidenceAccuracyMeters: 65,
  maximumObservationGapMs: 60_000,
  minimumDerivedIntervalMs: 2_000,
  maximumDerivedSpeedMps: 55,
  minimumDerivedDistanceMeters: 5,
  accuracyDistanceRatio: 0.5,
  activeEnterSpeedMps: 1.2,
  activeExitSpeedMps: 0.55,
  fastEnterSpeedMps: 6,
  fastExitSpeedMps: 3.5,
  restToActiveSamples: 2,
  restToActiveDurationMs: 8_000,
  activeToFastSamples: 3,
  activeToFastDurationMs: 8_000,
  fastToActiveSamples: 4,
  fastToActiveDurationMs: 15_000,
  activeToRestSamples: 4,
  activeToRestDurationMs: 30_000,
  minimumStateResidenceMs: 20_000,
});

export type RawMovementEvidenceKind = "stationary" | "active" | "fast" | "uncertain";

export type RawMovementEvidence = Readonly<{
  kind: RawMovementEvidenceKind;
  observedAtMs: number;
  speedMps: number | null;
  source: "native_speed" | "gps_interval" | "displacement" | "insufficient";
}>;

export type AdaptiveSamplingDecision = Readonly<{
  state: AdaptiveLocationSamplingState;
  changed: boolean;
  evidence: RawMovementEvidence;
}>;

function validNativeSpeed(observation: AcceptedCurrentLocationObservation): number | null {
  const value = observation.nativeSpeedMps;
  return typeof value === "number"
    && Number.isFinite(value)
    && value >= 0
    && value <= ADAPTIVE_LOCATION_EVIDENCE_POLICY.maximumDerivedSpeedMps
      ? value
      : null;
}

function movementKind(speedMps: number): Exclude<RawMovementEvidenceKind, "uncertain"> {
  if (speedMps >= ADAPTIVE_LOCATION_EVIDENCE_POLICY.fastEnterSpeedMps) return "fast";
  if (speedMps >= ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeEnterSpeedMps) return "active";
  return "stationary";
}

/** Raw trustworthy evidence only. This function never assigns a transport mode. */
export function evaluateRawMovementEvidence(
  previous: AcceptedCurrentLocationObservation | null,
  current: AcceptedCurrentLocationObservation,
): RawMovementEvidence {
  const uncertain = (source: RawMovementEvidence["source"] = "insufficient"): RawMovementEvidence => ({
    kind: "uncertain",
    observedAtMs: current.observedAtMs,
    speedMps: null,
    source,
  });
  if (
    !Number.isFinite(current.observedAtMs)
    || current.accuracyMeters > ADAPTIVE_LOCATION_EVIDENCE_POLICY.maximumEvidenceAccuracyMeters
  ) return uncertain();

  const nativeSpeed = validNativeSpeed(current);
  if (nativeSpeed !== null) {
    return {
      kind: movementKind(nativeSpeed),
      observedAtMs: current.observedAtMs,
      speedMps: nativeSpeed,
      source: "native_speed",
    };
  }
  if (!previous || previous.accuracyMeters > ADAPTIVE_LOCATION_EVIDENCE_POLICY.maximumEvidenceAccuracyMeters) {
    return uncertain();
  }
  const durationMs = current.observedAtMs - previous.observedAtMs;
  if (
    !Number.isFinite(durationMs)
    || durationMs < ADAPTIVE_LOCATION_EVIDENCE_POLICY.minimumDerivedIntervalMs
    || durationMs > ADAPTIVE_LOCATION_EVIDENCE_POLICY.maximumObservationGapMs
  ) return uncertain();
  const distanceMeters = haversineDistanceMeters(previous.coordinate, current.coordinate);
  if (!Number.isFinite(distanceMeters)) return uncertain();
  const minimumSignalDistance = Math.max(
    ADAPTIVE_LOCATION_EVIDENCE_POLICY.minimumDerivedDistanceMeters,
    Math.max(previous.accuracyMeters, current.accuracyMeters)
      * ADAPTIVE_LOCATION_EVIDENCE_POLICY.accuracyDistanceRatio,
  );
  if (distanceMeters <= minimumSignalDistance) {
    return {
      kind: "stationary",
      observedAtMs: current.observedAtMs,
      speedMps: 0,
      source: "displacement",
    };
  }
  const speedMps = distanceMeters / (durationMs / 1_000);
  if (!Number.isFinite(speedMps) || speedMps > ADAPTIVE_LOCATION_EVIDENCE_POLICY.maximumDerivedSpeedMps) {
    return uncertain("gps_interval");
  }
  return { kind: movementKind(speedMps), observedAtMs: current.observedAtMs, speedMps, source: "gps_interval" };
}

function sustained(
  history: readonly RawMovementEvidence[],
  count: number,
  durationMs: number,
  predicate: (evidence: RawMovementEvidence) => boolean,
): boolean {
  const tail = history.slice(-count);
  return tail.length === count
    && tail.every(predicate)
    && tail[tail.length - 1].observedAtMs - tail[0].observedAtMs >= durationMs;
}

export class AdaptiveLocationSamplingPolicy {
  private currentState: AdaptiveLocationSamplingState = "rest";
  private stateEnteredAtMs = Number.NEGATIVE_INFINITY;
  private previous: AcceptedCurrentLocationObservation | null = null;
  private evidence: RawMovementEvidence[] = [];

  state(): AdaptiveLocationSamplingState {
    return this.currentState;
  }

  reset(): void {
    this.currentState = "rest";
    this.stateEnteredAtMs = Number.NEGATIVE_INFINITY;
    this.previous = null;
    this.evidence = [];
  }

  observe(observation: AcceptedCurrentLocationObservation): AdaptiveSamplingDecision {
    const evidence = evaluateRawMovementEvidence(this.previous, observation);
    if (!this.previous || observation.observedAtMs > this.previous.observedAtMs) {
      this.previous = observation;
    }
    this.evidence.push(evidence);
    if (this.evidence.length > 16) this.evidence.shift();

    const residenceSatisfied = observation.observedAtMs - this.stateEnteredAtMs
      >= ADAPTIVE_LOCATION_EVIDENCE_POLICY.minimumStateResidenceMs;
    let next = this.currentState;
    if (residenceSatisfied && this.currentState === "rest" && sustained(
      this.evidence,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.restToActiveSamples,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.restToActiveDurationMs,
      (item) => item.kind === "active" || item.kind === "fast",
    )) next = "active";
    else if (residenceSatisfied && this.currentState === "active" && sustained(
      this.evidence,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeToFastSamples,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeToFastDurationMs,
      (item) => item.kind === "fast",
    )) next = "fast";
    else if (residenceSatisfied && this.currentState === "fast" && sustained(
      this.evidence,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.fastToActiveSamples,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.fastToActiveDurationMs,
      (item) => item.kind !== "uncertain"
        && item.speedMps !== null
        && item.speedMps <= ADAPTIVE_LOCATION_EVIDENCE_POLICY.fastExitSpeedMps,
    )) next = "active";
    else if (residenceSatisfied && this.currentState === "active" && sustained(
      this.evidence,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeToRestSamples,
      ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeToRestDurationMs,
      (item) => item.kind === "stationary"
        && (item.speedMps ?? 0) <= ADAPTIVE_LOCATION_EVIDENCE_POLICY.activeExitSpeedMps,
    )) next = "rest";

    const changed = next !== this.currentState;
    if (changed) {
      this.currentState = next;
      this.stateEnteredAtMs = observation.observedAtMs;
      this.evidence = [evidence];
    }
    return { state: this.currentState, changed, evidence };
  }
}

export type LocationWatcherSubscription = { remove(): void };
export type LocationWatcherStart<T> = (
  profile: AdaptiveLocationSamplingProfile,
  onObservation: (observation: T) => void,
) => Promise<LocationWatcherSubscription>;

export type AdaptiveLocationWatcherMetrics = Readonly<{
  transitionCount: number;
  startupCount: number;
  removalCount: number;
  staleStartupRemovalCount: number;
  activeWatcherCount: number;
  maximumActiveWatcherCount: number;
}>;

/** Serialized stop-before-start ownership. Pending native starts are generation
 * checked, so logout/background during startup can never leave a ghost watch. */
export class SerializedAdaptiveLocationWatcher<T> {
  private generation = 0;
  private desiredKey = "stopped";
  private subscription: LocationWatcherSubscription | null = null;
  private chain: Promise<void> = Promise.resolve();
  private metrics = {
    transitionCount: 0,
    startupCount: 0,
    removalCount: 0,
    staleStartupRemovalCount: 0,
    activeWatcherCount: 0,
    maximumActiveWatcherCount: 0,
  };

  constructor(private readonly startWatcher: LocationWatcherStart<T>) {}

  reconcile(input: Readonly<{
    accountUserId: string | null;
    enabled: boolean;
    state: AdaptiveLocationSamplingState;
    onObservation: (observation: T) => void;
  }>): Promise<void> {
    const key = input.enabled && input.accountUserId ? `${input.accountUserId}:${input.state}` : "stopped";
    if (key === this.desiredKey) return this.chain;
    this.desiredKey = key;
    const generation = ++this.generation;
    this.metrics.transitionCount += 1;
    this.chain = this.chain.then(async () => {
      this.removeCurrent();
      if (key === "stopped" || generation !== this.generation || key !== this.desiredKey) return;
      const profile = ADAPTIVE_LOCATION_SAMPLING_PROFILES[input.state];
      this.metrics.startupCount += 1;
      const next = await this.startWatcher(profile, input.onObservation);
      if (generation !== this.generation || key !== this.desiredKey) {
        next.remove();
        this.metrics.staleStartupRemovalCount += 1;
        return;
      }
      this.subscription = next;
      this.metrics.activeWatcherCount = 1;
      this.metrics.maximumActiveWatcherCount = Math.max(this.metrics.maximumActiveWatcherCount, 1);
    }).catch(() => {
      // A failed native start leaves the authority stopped; a later eligibility
      // transition may request a fresh generation without a restart loop.
    });
    return this.chain;
  }

  stop(): Promise<void> {
    return this.reconcile({ accountUserId: null, enabled: false, state: "rest", onObservation: () => undefined });
  }

  snapshot(): AdaptiveLocationWatcherMetrics {
    return { ...this.metrics };
  }

  private removeCurrent(): void {
    if (!this.subscription) return;
    this.subscription.remove();
    this.subscription = null;
    this.metrics.removalCount += 1;
    this.metrics.activeWatcherCount = 0;
  }
}
