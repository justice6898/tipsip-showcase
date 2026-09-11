import type { LocationHistoryPoint } from "@/features/locationHistory/domain";
import {
  MOTION_EVIDENCE_POLICY,
  isCanonicalMotionEvidenceWindow,
  type CanonicalMotionEvidenceWindow,
} from "@/features/locationHistory/motionEvidence";
import { selfPrivateHistoryObservationIdentity } from "@/features/locationHistory/selfPrivateHistory";
import { haversineDistanceMeters } from "@/lib/geoDistance";

export const SELF_STAY_EVIDENCE_POLICY = Object.freeze({
  confirmationDurationMs: 5 * 60_000,
  minimumStationaryMotionCoverageMs: 4 * 60_000,
  maximumStationaryMotionGapMs: MOTION_EVIDENCE_POLICY.targetWindowDurationMs * 3,
  maximumSparseLocationGapMs: 30 * 60_000,
  stayRadiusMeters: 40,
  maximumAccuracyAllowanceMeters: 25,
  credibleActiveStepDelta: 6,
  contradictoryAccelerationRmsMps2: 0.8,
  contradictoryJerkRmsMps3: 2,
  contradictoryRotationRateRmsDegreesPerSecond: 20,
  ongoingEvidenceMaximumAgeMs: 90_000,
  maximumRememberedObservationIdentities: 1_024,
  maximumRememberedMotionEvidenceIdentities: 1_024,
});

export type SelfStayEvidencePhase =
  | "NO_EVIDENCE"
  | "CANDIDATE_STAY_ONLY"
  | "CONFIRMED_STAY";

export type SelfStayConfirmationSource =
  | "sparse_location"
  | "stationary_motion";

/** Read-time evidence only. It never creates or persists a location sample. */
export type SelfStayTemporalEvidence = Readonly<{
  state: "candidate" | "confirmed";
  anchorPointIdentity: string;
  latestPointIdentity: string;
  startedAtMs: number;
  corroboratedThroughMs: number;
  locationEvidenceCount: number;
  stationaryMotionCoverageMs: number;
  confirmationSource: SelfStayConfirmationSource | null;
  ongoing: boolean;
}>;

export type SelfStayEvidenceSnapshot = Readonly<{
  phase: SelfStayEvidencePhase;
  accountGeneration: number;
  candidateAgeMs: number;
  confirmationSource: SelfStayConfirmationSource | null;
  locationEvidenceCount: number;
  stationaryMotionCoverageMs: number;
  latestCorroborationAgeMs: number | null;
  currentContinuityProven: boolean;
  finalizedBoundaryReason: "credible_movement" | null;
  temporalEvidence: SelfStayTemporalEvidence | null;
  measuredMotionWindowCount: number;
  motionIntervalDuplicateIgnoredCount: number;
  lastLocationPointAtMs: number | null;
  lastEvaluationAtMs: number | null;
  lastEvaluationTrigger: "account" | "location" | "motion" | "clear" | null;
  candidateResetReason: "account_switch" | "explicit_clear" | "credible_movement" | "relocation_or_gap" | null;
  confirmationBlockReason: "no_candidate" | "candidate_too_young" | "stationary_coverage_insufficient" | null;
}>;

type Candidate = {
  anchor: LocationHistoryPoint;
  latest: LocationHistoryPoint;
  locationEvidenceCount: number;
  phase: "candidate" | "confirmed";
  confirmationSource: SelfStayConfirmationSource | null;
  corroboratedThroughMs: number;
  stationaryMotionCoverageMs: number;
  lastStationaryWindowEndMs: number | null;
  ongoing: boolean;
  /** Latched only by an exact current callback after it crossed the durable
   * archive boundary. A history-only reconstruction never sets this bit. */
  currentContinuityProven: boolean;
};

function pointTime(point: LocationHistoryPoint): number {
  return Date.parse(point.capturedAt);
}

function samePlace(left: LocationHistoryPoint, right: LocationHistoryPoint): boolean {
  const accuracyAllowance = Math.min(
    SELF_STAY_EVIDENCE_POLICY.maximumAccuracyAllowanceMeters,
    Math.max(left.accuracyMeters ?? 0, right.accuracyMeters ?? 0),
  );
  return haversineDistanceMeters(left.coordinate, right.coordinate)
    <= SELF_STAY_EVIDENCE_POLICY.stayRadiusMeters + accuracyAllowance;
}

function stationaryMotionWindow(evidence: CanonicalMotionEvidenceWindow): boolean {
  return evidence.pedometerAvailability === "measured"
    && evidence.pedometerMeasurementSource === "expo_pedometer_interval_query"
    && evidence.stepDelta === 0;
}

function contradictoryMotionWindow(evidence: CanonicalMotionEvidenceWindow): boolean {
  return evidence.deviceMotionAvailability === "measured" && (
    (evidence.accelerationRmsMps2 ?? 0) >= SELF_STAY_EVIDENCE_POLICY.contradictoryAccelerationRmsMps2
    || (evidence.jerkRmsMps3 ?? 0) >= SELF_STAY_EVIDENCE_POLICY.contradictoryJerkRmsMps3
    || (evidence.rotationRateRmsDegreesPerSecond ?? 0)
      >= SELF_STAY_EVIDENCE_POLICY.contradictoryRotationRateRmsDegreesPerSecond
  );
}

/**
 * Account-scoped self dwell authority. It consumes only location points that
 * have already crossed the durable archive boundary and already-authorized
 * sensor windows. Its state is reconstructible from local/remote history on a
 * remount; it never fabricates a periodic coordinate.
 */
export class SelfStayEvidenceAuthority {
  private accountUserId: string | null = null;
  private accountGeneration = 0;
  private candidate: Candidate | null = null;
  private processedIdentities = new Set<string>();
  private latestProcessedPointAtMs: number | null = null;
  private measuredMotionWindowCount = 0;
  private processedMotionEvidenceIdentities = new Set<string>();
  private motionIntervalDuplicateIgnoredCount = 0;
  private lastEvaluationAtMs: number | null = null;
  private lastEvaluationTrigger: SelfStayEvidenceSnapshot["lastEvaluationTrigger"] = null;
  private candidateResetReason: SelfStayEvidenceSnapshot["candidateResetReason"] = null;

  matchesAccount(accountUserId: string | null): boolean {
    return this.accountUserId === accountUserId;
  }

  setAccount(accountUserId: string | null): boolean {
    if (this.accountUserId === accountUserId) return false;
    this.accountUserId = accountUserId;
    this.accountGeneration += 1;
    this.candidate = null;
    this.processedIdentities.clear();
    this.latestProcessedPointAtMs = null;
    this.measuredMotionWindowCount = 0;
    this.processedMotionEvidenceIdentities.clear();
    this.motionIntervalDuplicateIgnoredCount = 0;
    this.lastEvaluationAtMs = Date.now();
    this.lastEvaluationTrigger = "account";
    this.candidateResetReason = "account_switch";
    return true;
  }

  clear(reason: SelfStayEvidenceSnapshot["candidateResetReason"] = "explicit_clear"): boolean {
    const changed = this.candidate !== null || this.processedIdentities.size > 0;
    this.candidate = null;
    this.processedIdentities.clear();
    this.latestProcessedPointAtMs = null;
    this.measuredMotionWindowCount = 0;
    this.processedMotionEvidenceIdentities.clear();
    this.motionIntervalDuplicateIgnoredCount = 0;
    this.lastEvaluationAtMs = Date.now();
    this.lastEvaluationTrigger = "clear";
    this.candidateResetReason = reason;
    return changed;
  }

  reconcilePoints(accountUserId: string, points: readonly LocationHistoryPoint[]): boolean {
    let changed = this.setAccount(accountUserId);
    const ordered = [...points]
      .filter((point) => point.personUserId === accountUserId && Number.isFinite(pointTime(point)))
      .sort((left, right) => pointTime(left) - pointTime(right));
    for (const point of ordered) {
      const identity = selfPrivateHistoryObservationIdentity(point);
      if (this.processedIdentities.has(identity)) continue;
      if (!this.shouldObservePoint(point)) continue;
      this.rememberProcessedIdentity(identity);
      changed = this.observeNewPoint(point, false) || changed;
    }
    return changed;
  }

  observePoint(accountUserId: string, point: LocationHistoryPoint): boolean {
    if (point.personUserId !== accountUserId || !Number.isFinite(pointTime(point))) return false;
    if (this.accountUserId !== null && this.accountUserId !== accountUserId) return false;
    let changed = this.accountUserId === null ? this.setAccount(accountUserId) : false;
    const identity = selfPrivateHistoryObservationIdentity(point);
    if (this.processedIdentities.has(identity)) {
      if (
        this.candidate?.ongoing
        && pointTime(point) === pointTime(this.candidate.latest)
        && samePlace(this.candidate.anchor, point)
        && !this.candidate.currentContinuityProven
      ) {
        // A process can reconstruct the latest durable row before the native
        // foreground callback delivers that exact observation. The duplicate
        // must not add evidence, but it does prove that this logical visit is
        // current in this process.
        this.candidate.currentContinuityProven = true;
        return true;
      }
      return changed;
    }
    if (!this.shouldObservePoint(point)) return changed;
    this.rememberProcessedIdentity(identity);
    changed = this.observeNewPoint(point, true) || changed;
    return changed;
  }

  observeMotionEvidence(
    accountUserId: string,
    evidence: CanonicalMotionEvidenceWindow,
  ): boolean {
    if (
      this.accountUserId !== accountUserId
      || !this.candidate
      || !isCanonicalMotionEvidenceWindow(evidence, accountUserId)
      || evidence.windowEndedAtMs <= pointTime(this.candidate.anchor)
    ) return false;

    if (this.processedMotionEvidenceIdentities.has(evidence.evidenceIdentity)) {
      this.motionIntervalDuplicateIgnoredCount += 1;
      return false;
    }
    this.rememberProcessedMotionEvidenceIdentity(evidence.evidenceIdentity);

    this.lastEvaluationAtMs = evidence.windowEndedAtMs;
    this.lastEvaluationTrigger = "motion";
    if (evidence.pedometerAvailability === "measured" || evidence.deviceMotionAvailability === "measured") {
      this.measuredMotionWindowCount += 1;
    }

    if (
      (evidence.pedometerAvailability === "measured"
        && (evidence.stepDelta ?? 0) >= SELF_STAY_EVIDENCE_POLICY.credibleActiveStepDelta)
      || contradictoryMotionWindow(evidence)
    ) {
      if (this.candidate.phase === "candidate") {
        this.candidate = null;
      } else {
        this.candidate.ongoing = false;
        this.candidate.corroboratedThroughMs = Math.max(
          pointTime(this.candidate.anchor),
          Math.min(this.candidate.corroboratedThroughMs, evidence.windowStartedAtMs),
        );
      }
      this.candidateResetReason = "credible_movement";
      return true;
    }
    if (!stationaryMotionWindow(evidence) || !this.candidate.ongoing) return false;

    const candidateStartedAtMs = pointTime(this.candidate.anchor);
    const coveredStartMs = Math.max(candidateStartedAtMs, evidence.windowStartedAtMs);
    const previousEndMs = this.candidate.lastStationaryWindowEndMs;
    if (
      previousEndMs === null
      || coveredStartMs - previousEndMs > SELF_STAY_EVIDENCE_POLICY.maximumStationaryMotionGapMs
    ) {
      this.candidate.stationaryMotionCoverageMs = Math.max(0, evidence.windowEndedAtMs - coveredStartMs);
    } else {
      this.candidate.stationaryMotionCoverageMs += Math.max(0, evidence.windowEndedAtMs - Math.max(coveredStartMs, previousEndMs));
    }
    this.candidate.lastStationaryWindowEndMs = Math.max(
      previousEndMs ?? evidence.windowEndedAtMs,
      evidence.windowEndedAtMs,
    );
    this.candidate.corroboratedThroughMs = Math.max(
      this.candidate.corroboratedThroughMs,
      evidence.windowEndedAtMs,
    );
    this.confirmIfEligible("stationary_motion");
    // Coverage growth is a real authority state transition even before the
    // confirmation threshold. Notify the sole subscriber so diagnostics and
    // candidate UI cannot remain frozen until the final window.
    return true;
  }

  snapshot(referenceTimeMs = Date.now()): SelfStayEvidenceSnapshot {
    if (!this.candidate) {
      return {
        phase: "NO_EVIDENCE",
        accountGeneration: this.accountGeneration,
        candidateAgeMs: 0,
        confirmationSource: null,
        locationEvidenceCount: 0,
        stationaryMotionCoverageMs: 0,
        latestCorroborationAgeMs: null,
        currentContinuityProven: false,
        finalizedBoundaryReason: null,
        temporalEvidence: null,
        measuredMotionWindowCount: this.measuredMotionWindowCount,
        motionIntervalDuplicateIgnoredCount: this.motionIntervalDuplicateIgnoredCount,
        lastLocationPointAtMs: this.latestProcessedPointAtMs,
        lastEvaluationAtMs: this.lastEvaluationAtMs,
        lastEvaluationTrigger: this.lastEvaluationTrigger,
        candidateResetReason: this.candidateResetReason,
        confirmationBlockReason: "no_candidate",
      };
    }
    const startedAtMs = pointTime(this.candidate.anchor);
    const latestCorroborationAgeMs = Math.max(0, referenceTimeMs - this.candidate.corroboratedThroughMs);
    const ongoing = this.candidate.phase === "confirmed"
      && this.candidate.ongoing
      && (
        this.candidate.currentContinuityProven
        || latestCorroborationAgeMs <= SELF_STAY_EVIDENCE_POLICY.ongoingEvidenceMaximumAgeMs
      );
    const temporalEvidence: SelfStayTemporalEvidence = {
      state: this.candidate.phase,
      anchorPointIdentity: selfPrivateHistoryObservationIdentity(this.candidate.anchor),
      latestPointIdentity: selfPrivateHistoryObservationIdentity(this.candidate.latest),
      startedAtMs,
      corroboratedThroughMs: this.candidate.corroboratedThroughMs,
      locationEvidenceCount: this.candidate.locationEvidenceCount,
      stationaryMotionCoverageMs: this.candidate.stationaryMotionCoverageMs,
      confirmationSource: this.candidate.confirmationSource,
      ongoing,
    };
    return {
      phase: this.candidate.phase === "confirmed" ? "CONFIRMED_STAY" : "CANDIDATE_STAY_ONLY",
      accountGeneration: this.accountGeneration,
      candidateAgeMs: Math.max(0, referenceTimeMs - startedAtMs),
      confirmationSource: this.candidate.confirmationSource,
      locationEvidenceCount: this.candidate.locationEvidenceCount,
      stationaryMotionCoverageMs: this.candidate.stationaryMotionCoverageMs,
      latestCorroborationAgeMs,
      currentContinuityProven: this.candidate.currentContinuityProven,
      finalizedBoundaryReason: this.candidate.ongoing ? null : "credible_movement",
      temporalEvidence,
      measuredMotionWindowCount: this.measuredMotionWindowCount,
      motionIntervalDuplicateIgnoredCount: this.motionIntervalDuplicateIgnoredCount,
      lastLocationPointAtMs: this.latestProcessedPointAtMs,
      lastEvaluationAtMs: this.lastEvaluationAtMs,
      lastEvaluationTrigger: this.lastEvaluationTrigger,
      candidateResetReason: this.candidateResetReason,
      confirmationBlockReason: this.candidate.phase === "confirmed"
        ? null
        : this.candidate.corroboratedThroughMs - startedAtMs < SELF_STAY_EVIDENCE_POLICY.confirmationDurationMs
          ? "candidate_too_young"
          : "stationary_coverage_insufficient",
    };
  }

  private observeNewPoint(point: LocationHistoryPoint, currentContinuityProven: boolean): boolean {
    const timestampMs = pointTime(point);
    this.lastEvaluationAtMs = timestampMs;
    this.lastEvaluationTrigger = "location";
    if (!this.candidate) {
      this.startCandidate(point, currentContinuityProven);
      return true;
    }
    const latestAtMs = pointTime(this.candidate.latest);
    if (
      timestampMs - latestAtMs > SELF_STAY_EVIDENCE_POLICY.maximumSparseLocationGapMs
      || !samePlace(this.candidate.anchor, point)
    ) {
      this.candidateResetReason = "relocation_or_gap";
      this.startCandidate(point, currentContinuityProven);
      return true;
    }
    this.candidate.locationEvidenceCount += 1;
    if (timestampMs >= latestAtMs) this.candidate.latest = point;
    if (timestampMs < pointTime(this.candidate.anchor)) this.candidate.anchor = point;
    this.candidate.corroboratedThroughMs = Math.max(this.candidate.corroboratedThroughMs, timestampMs);
    this.candidate.ongoing = true;
    this.candidate.currentContinuityProven ||= currentContinuityProven;
    this.confirmIfEligible("sparse_location");
    return true;
  }

  private startCandidate(point: LocationHistoryPoint, currentContinuityProven: boolean): void {
    this.candidate = {
      anchor: point,
      latest: point,
      locationEvidenceCount: 1,
      phase: "candidate",
      confirmationSource: null,
      corroboratedThroughMs: pointTime(point),
      stationaryMotionCoverageMs: 0,
      lastStationaryWindowEndMs: null,
      ongoing: true,
      currentContinuityProven,
    };
  }

  private confirmIfEligible(source: SelfStayConfirmationSource): boolean {
    if (!this.candidate || this.candidate.phase === "confirmed") return false;
    const durationMs = this.candidate.corroboratedThroughMs - pointTime(this.candidate.anchor);
    const locationConfirmed = this.candidate.locationEvidenceCount >= 2
      && durationMs >= SELF_STAY_EVIDENCE_POLICY.confirmationDurationMs;
    const motionConfirmed = this.candidate.stationaryMotionCoverageMs
      >= SELF_STAY_EVIDENCE_POLICY.minimumStationaryMotionCoverageMs
      && durationMs >= SELF_STAY_EVIDENCE_POLICY.confirmationDurationMs;
    if (!(source === "sparse_location" ? locationConfirmed : motionConfirmed)) return false;
    this.candidate.phase = "confirmed";
    this.candidate.confirmationSource = source;
    return true;
  }

  private shouldObservePoint(point: LocationHistoryPoint): boolean {
    const timestampMs = pointTime(point);
    if (this.latestProcessedPointAtMs === null || timestampMs >= this.latestProcessedPointAtMs) {
      this.latestProcessedPointAtMs = Math.max(this.latestProcessedPointAtMs ?? timestampMs, timestampMs);
      return true;
    }
    // A remote row may arrive after a newer local row during read-through.
    // Only a same-cluster row immediately preceding the current anchor may
    // backdate that candidate. Older replayed rows cannot roll current state
    // backward after their bounded identities have been evicted.
    if (!this.candidate) return false;
    const anchorAtMs = pointTime(this.candidate.anchor);
    return timestampMs < anchorAtMs
      && anchorAtMs - timestampMs <= SELF_STAY_EVIDENCE_POLICY.maximumSparseLocationGapMs
      && samePlace(this.candidate.anchor, point);
  }

  private rememberProcessedIdentity(identity: string): void {
    this.processedIdentities.add(identity);
    while (this.processedIdentities.size > SELF_STAY_EVIDENCE_POLICY.maximumRememberedObservationIdentities) {
      const oldest = this.processedIdentities.values().next().value;
      if (typeof oldest !== "string") break;
      this.processedIdentities.delete(oldest);
    }
  }

  private rememberProcessedMotionEvidenceIdentity(identity: string): void {
    this.processedMotionEvidenceIdentities.add(identity);
    while (
      this.processedMotionEvidenceIdentities.size
      > SELF_STAY_EVIDENCE_POLICY.maximumRememberedMotionEvidenceIdentities
    ) {
      const oldest = this.processedMotionEvidenceIdentities.values().next().value;
      if (typeof oldest !== "string") break;
      this.processedMotionEvidenceIdentities.delete(oldest);
    }
  }
}
