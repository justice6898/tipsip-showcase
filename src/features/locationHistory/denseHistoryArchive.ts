import {
  LOCATION_HISTORY_ARCHIVE_POLICY_VERSION,
  LOCATION_HISTORY_REPLAY_BATCH_MAX,
  LOCATION_HISTORY_SERVER_BATCH_MAX,
  locationHistoryArchiveCaptureIdentity,
  type LocationHistoryAppendRepository,
  type LocationHistoryArchiveSample,
  type LocationHistoryBatchAppendResult,
  type LocationHistoryReplayAppendResult,
} from "@/features/locationHistory/captureContract";
import {
  DURABLE_LOCATION_OUTBOX_POLICY,
  LOCATION_OUTBOX_PERSISTENCE_VERSION,
  MemoryDurableLocationOutboxStorage,
  type DurableEnqueueResult,
  type DurableLocationInterruption,
  type DurableLocationOutboxHealth,
  type DurableLocationOutboxStorage,
  type RecordingInterruptionReason,
} from "@/features/locationHistory/durableLocationOutbox";
import {
  MOTION_EVIDENCE_POLICY,
  isCanonicalMotionEvidenceWindow,
  motionEvidenceForLocation,
  type CanonicalMotionEvidenceWindow,
} from "@/features/locationHistory/motionEvidence";
import type { AdaptiveLocationSamplingState } from "@/lib/adaptiveLocationSampling";
import { createClientOperationId } from "@/lib/clientOperationId";
import { haversineDistanceMeters } from "@/lib/geoDistance";
import type { AcceptedCurrentLocationObservation } from "@/lib/locationPolicy";

/** Scheduler/acquisition policy retained for compatibility. Durable retention
 * is owned exclusively by DURABLE_LOCATION_OUTBOX_POLICY. */
export const DENSE_LOCATION_HISTORY_BUFFER_POLICY = Object.freeze({
  maximumCount: 300,
  maximumAgeMs: 15 * 60_000,
  flushCount: 20,
  flushIntervalMs: 45_000,
  maximumBatchCount: LOCATION_HISTORY_SERVER_BATCH_MAX,
  stationaryProofIntervalMs: 2 * 60_000,
  initialRetryDelayMs: DURABLE_LOCATION_OUTBOX_POLICY.initialRetryDelayMs,
  maximumRetryDelayMs: DURABLE_LOCATION_OUTBOX_POLICY.maximumRetryDelayMs,
});

/** One serialized burst per existing scheduler/lifecycle opportunity. At the
 * maximum queue this is 18 cycles, or roughly 13.5 minutes of scheduler gaps. */
export const LOCATION_HISTORY_REPLAY_DRAIN_POLICY = Object.freeze({
  maximumBatchCount: LOCATION_HISTORY_REPLAY_BATCH_MAX,
  maximumBatchesPerCycle: 8,
  maximumRowsPerCycle: 1_600,
  maximumElapsedMsPerCycle: 8_000,
});

export type DenseLocationHistoryRejectionReason =
  | "authority"
  | "invalid"
  | "poor_accuracy"
  | "duplicate"
  | "conflicting_duplicate"
  | "storage_unavailable"
  | "redundant_stationary";

export type DenseLocationHistoryMetrics = Readonly<{
  observationCount: number;
  acceptedArchiveCount: number;
  rejectedSampleCount: Readonly<Record<DenseLocationHistoryRejectionReason, number>>;
  flushCount: number;
  flushedSampleCount: number;
  averageBatchSize: number;
  bufferHighWaterMark: number;
  droppedOverflowCount: number;
  droppedOverflowBytes: number;
}>;

function emptyRejections(): Record<DenseLocationHistoryRejectionReason, number> {
  return {
    authority: 0,
    invalid: 0,
    poor_accuracy: 0,
    duplicate: 0,
    conflicting_duplicate: 0,
    storage_unavailable: 0,
    redundant_stationary: 0,
  };
}

function legacyTestStorage(): DurableLocationOutboxStorage {
  return new MemoryDurableLocationOutboxStorage({
    ...DURABLE_LOCATION_OUTBOX_POLICY,
    maximumRecordCount: DENSE_LOCATION_HISTORY_BUFFER_POLICY.maximumCount,
    maximumAgeMs: DENSE_LOCATION_HISTORY_BUFFER_POLICY.maximumAgeMs,
    maximumBytes: 8 * 1024 * 1024,
  });
}

function replayPermanentRejections(
  result: LocationHistoryBatchAppendResult | LocationHistoryReplayAppendResult,
): Extract<LocationHistoryReplayAppendResult, { state: "appended" }>["permanentRejections"] {
  if (result.state !== "appended" || !("permanentRejections" in result)) return [];
  return (result as Extract<LocationHistoryReplayAppendResult, { state: "appended" }>).permanentRejections;
}

/** Canonical foreground archive orchestrator. It never creates a watcher,
 * sensor subscription, connectivity listener, or timer. */
export class DenseLocationHistoryArchive {
  private accountUserId: string | null = null;
  private captureEnabled = false;
  private captureSessionIdentity = createClientOperationId();
  private recentIdentities = new Map<string, number>();
  private lastAcceptedSample: LocationHistoryArchiveSample | null = null;
  private recentMotionEvidence: CanonicalMotionEvidenceWindow[] = [];
  private inFlight: Promise<void> | null = null;
  private authorityGeneration = 0;
  private metrics = {
    observationCount: 0,
    acceptedArchiveCount: 0,
    rejectedSampleCount: emptyRejections(),
    flushCount: 0,
    flushedSampleCount: 0,
    bufferHighWaterMark: 0,
    droppedOverflowCount: 0,
    droppedOverflowBytes: 0,
  };

  constructor(
    private readonly repository: LocationHistoryAppendRepository,
    private readonly outbox: DurableLocationOutboxStorage = legacyTestStorage(),
    private readonly backgroundDurableOnly = false,
  ) {}

  updateAuthority(input: Readonly<{ accountUserId: string | null; captureEnabled: boolean }>): void {
    if (this.accountUserId !== input.accountUserId) {
      this.authorityGeneration += 1;
      this.clearVolatileState();
      this.accountUserId = input.accountUserId;
      this.captureSessionIdentity = createClientOperationId();
    }
    const nextEnabled = Boolean(input.accountUserId && input.captureEnabled);
    if (nextEnabled !== this.captureEnabled) {
      this.authorityGeneration += 1;
      if (nextEnabled) this.captureSessionIdentity = createClientOperationId();
    }
    this.captureEnabled = nextEnabled;
  }

  /** Suspends authority without deleting durable evidence. Use purgeProtectedState
   * only for an explicit consent/account boundary. */
  invalidateProtectedState(): void {
    this.authorityGeneration += 1;
    this.captureEnabled = false;
    this.clearVolatileState();
  }

  purgeProtectedState(reason: Extract<RecordingInterruptionReason, "sharing_disabled" | "explicit_logout" | "account_switch">, nowMs = Date.now()): number {
    const accountUserId = this.accountUserId;
    if (!accountUserId) return 0;
    this.authorityGeneration += 1;
    if (!this.captureEnabled && this.outbox.health(accountUserId).pendingCount === 0) return 0;
    this.captureEnabled = false;
    const deleted = this.outbox.purgeAccount(accountUserId);
    this.clearVolatileState();
    if (reason === "sharing_disabled") this.recordInterruption(reason, nowMs);
    return deleted;
  }

  pause(reason: RecordingInterruptionReason = "app_background_capture_unavailable", nowMs = Date.now()): void {
    this.authorityGeneration += 1;
    if (this.captureEnabled) this.recordInterruption(reason, nowMs);
    this.captureEnabled = false;
    this.captureSessionIdentity = createClientOperationId();
  }

  recordInterruption(reason: RecordingInterruptionReason, nowMs = Date.now()): void {
    if (!this.accountUserId) return;
    const interruption: DurableLocationInterruption = {
      persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
      interruptionIdentity: `interruption-v1:${this.accountUserId}:${nowMs}:${this.captureSessionIdentity}`,
      accountIdentity: this.accountUserId,
      captureSessionIdentity: this.captureSessionIdentity,
      reason,
      startedAtMs: nowMs,
    };
    this.outbox.recordInterruption(interruption);
  }

  capture(
    accountUserId: string,
    observation: AcceptedCurrentLocationObservation,
    state: AdaptiveLocationSamplingState,
    movementTransition = false,
    nowMs = Date.now(),
    maximumObservationAgeMs = 60_000,
  ): boolean {
    this.metrics.observationCount += 1;
    if (!this.captureEnabled || !this.accountUserId || this.accountUserId !== accountUserId) {
      return this.reject("authority");
    }
    if (
      !Number.isFinite(observation.observedAtMs)
      || observation.observedAtMs > nowMs + 60_000
      || !Number.isFinite(maximumObservationAgeMs)
      || maximumObservationAgeMs < 0
      || maximumObservationAgeMs > DURABLE_LOCATION_OUTBOX_POLICY.maximumAgeMs
      || nowMs - observation.observedAtMs > maximumObservationAgeMs
    ) return this.reject("invalid");
    if (!Number.isFinite(observation.accuracyMeters) || observation.accuracyMeters < 0 || observation.accuracyMeters > 100) {
      return this.reject("poor_accuracy");
    }
    const captureIdentity = locationHistoryArchiveCaptureIdentity({
      observedAtMs: observation.observedAtMs,
      coordinate: observation.coordinate,
    });
    if (this.recentIdentities.has(captureIdentity)) return this.reject("duplicate");
    const previous = this.lastAcceptedSample;
    if (state === "rest" && !movementTransition && previous) {
      const elapsedMs = observation.observedAtMs - Date.parse(previous.capturedAt);
      const distanceMeters = haversineDistanceMeters(previous.coordinate, observation.coordinate);
      const stationaryRadius = Math.max(3, previous.accuracyMeters, observation.accuracyMeters);
      if (
        elapsedMs >= 0
        && elapsedMs < DENSE_LOCATION_HISTORY_BUFFER_POLICY.stationaryProofIntervalMs
        && distanceMeters <= stationaryRadius
      ) return this.reject("redundant_stationary");
    }
    const motionEvidence = motionEvidenceForLocation(accountUserId, observation.observedAtMs, this.recentMotionEvidence);
    const sample: LocationHistoryArchiveSample = {
      captureIdentity,
      coordinate: { ...observation.coordinate },
      capturedAt: new Date(observation.observedAtMs).toISOString(),
      accuracyMeters: observation.accuracyMeters,
      ...(observation.nativeSpeedMps === undefined ? {} : { nativeSpeedMps: observation.nativeSpeedMps }),
      ...(observation.nativeSpeedAccuracyMps === undefined ? {} : { nativeSpeedAccuracyMps: observation.nativeSpeedAccuracyMps }),
      ...(observation.nativeHeadingDegrees === undefined ? {} : { nativeHeadingDegrees: observation.nativeHeadingDegrees }),
      ...(observation.nativeHeadingAccuracyDegrees === undefined ? {} : { nativeHeadingAccuracyDegrees: observation.nativeHeadingAccuracyDegrees }),
      ...(observation.altitudeMeters === undefined ? {} : { altitudeMeters: observation.altitudeMeters }),
      ...(observation.verticalAccuracyMeters === undefined ? {} : { verticalAccuracyMeters: observation.verticalAccuracyMeters }),
      ...(observation.mocked === undefined ? {} : { mocked: observation.mocked }),
      ...(observation.telemetryVersion === undefined ? {} : { telemetryVersion: observation.telemetryVersion }),
      archivePolicyVersion: LOCATION_HISTORY_ARCHIVE_POLICY_VERSION,
      ...(motionEvidence ? { motionEvidence: { ...motionEvidence } } : {}),
    };
    let result: DurableEnqueueResult;
    try {
      result = this.outbox.enqueue({
        persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
        captureIdentity,
        accountIdentity: accountUserId,
        subjectIdentity: accountUserId,
        capturedAtMs: observation.observedAtMs,
        captureSessionIdentity: this.captureSessionIdentity,
        sample,
        enqueuedAtMs: nowMs,
      }, nowMs);
    } catch {
      // A native durable-storage I/O failure must reject this capture without escaping
      // into the location watcher callback. The adapter transaction owns
      // rollback; the archive records only the fail-closed health outcome.
      return this.reject("storage_unavailable");
    }
    if (result.state === "duplicate") return this.reject("duplicate");
    if (result.state === "conflict") return this.reject("conflicting_duplicate");
    if (result.state === "invalid") return this.reject("invalid");
    if (result.state === "unavailable") return this.reject("storage_unavailable");
    this.recentIdentities.set(captureIdentity, observation.observedAtMs);
    while (this.recentIdentities.size > DENSE_LOCATION_HISTORY_BUFFER_POLICY.maximumCount) {
      const oldestIdentity = this.recentIdentities.keys().next().value;
      if (typeof oldestIdentity !== "string") break;
      this.recentIdentities.delete(oldestIdentity);
    }
    if (!this.lastAcceptedSample || observation.observedAtMs >= Date.parse(this.lastAcceptedSample.capturedAt)) {
      this.lastAcceptedSample = sample;
    }
    this.metrics.acceptedArchiveCount += 1;
    this.metrics.droppedOverflowCount += result.droppedCount;
    this.metrics.droppedOverflowBytes += result.droppedBytes;
    const pendingCount = this.outbox.health(accountUserId).pendingCount;
    this.metrics.bufferHighWaterMark = Math.max(this.metrics.bufferHighWaterMark, pendingCount);
    if (pendingCount >= DENSE_LOCATION_HISTORY_BUFFER_POLICY.flushCount && this.backgroundDurableOnly !== true) {
      void this.flush(nowMs);
    }
    return true;
  }

  attachMotionEvidence(accountUserId: string, evidence: CanonicalMotionEvidenceWindow): number {
    if (!this.captureEnabled || this.accountUserId !== accountUserId || !isCanonicalMotionEvidenceWindow(evidence, accountUserId)) return 0;
    this.recentMotionEvidence = [
      ...this.recentMotionEvidence.filter((candidate) => candidate.evidenceIdentity !== evidence.evidenceIdentity),
      { ...evidence },
    ].sort((left, right) => left.windowStartedAtMs - right.windowStartedAtMs)
      .slice(-MOTION_EVIDENCE_POLICY.maximumRecentWindowCount);
    return this.outbox.attachMotionEvidence(accountUserId, evidence);
  }

  flush(nowMs = Date.now()): Promise<void> {
    return this.flushBounded({
      nowMs,
      maximumBatches: LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumBatchesPerCycle,
      maximumRows: LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumRowsPerCycle,
      maximumElapsedMs: LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumElapsedMsPerCycle,
    });
  }

  /** One task-invocation opportunity. Durable inflight ownership remains the
   * cross-archive lease, so a foreground drain can never claim these rows too. */
  flushOneBatch(
    nowMs = Date.now(),
    signal?: AbortSignal,
    verifyAuthority?: () => Promise<boolean>,
  ): Promise<void> {
    return this.flushBounded({
      nowMs,
      maximumBatches: 1,
      maximumRows: LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumBatchCount,
      maximumElapsedMs: LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumElapsedMsPerCycle,
      signal,
      verifyAuthority,
    });
  }

  private flushBounded(input: Readonly<{
    nowMs: number;
    maximumBatches: number;
    maximumRows: number;
    maximumElapsedMs: number;
    signal?: AbortSignal;
    verifyAuthority?: () => Promise<boolean>;
  }>): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (!this.accountUserId || !this.captureEnabled) return Promise.resolve();
    const accountUserId = this.accountUserId;
    const authorityGeneration = this.authorityGeneration;
    const nowMs = input.nowMs;
    this.inFlight = (async () => {
      const cycleStartedAtMs = Date.now();
      let batchCount = 0;
      let rowCount = 0;
      while (
        !input.signal?.aborted
        && this.accountUserId === accountUserId
        && this.captureEnabled
        && this.authorityGeneration === authorityGeneration
        && batchCount < input.maximumBatches
        && rowCount < input.maximumRows
        && Date.now() - cycleStartedAtMs < input.maximumElapsedMs
      ) {
        const requestedLimit = this.repository.appendOwnSamplesReplay
          ? LOCATION_HISTORY_REPLAY_DRAIN_POLICY.maximumBatchCount
          : DENSE_LOCATION_HISTORY_BUFFER_POLICY.maximumBatchCount;
        const rows = this.outbox.readChronologicalBatch(accountUserId, nowMs, requestedLimit);
        if (rows.length === 0) return;
        if (input.verifyAuthority && !await input.verifyAuthority()) return;
        const identities = rows.map((row) => row.record.captureIdentity);
        if (!this.outbox.markInflight(accountUserId, identities, nowMs)) return;
        this.metrics.flushCount += 1;
        batchCount += 1;
        rowCount += rows.length;
        let result: LocationHistoryBatchAppendResult | LocationHistoryReplayAppendResult;
        try {
          const request = {
            accountUserId,
            subjectUserId: accountUserId,
            samples: rows.map((row) => row.record.sample),
          };
          result = this.repository.appendOwnSamplesReplay
            ? await this.repository.appendOwnSamplesReplay(request, input.signal)
            : await this.repository.appendOwnSamplesBatch(request, input.signal);
        } catch {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        if (input.signal?.aborted) {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        if (input.verifyAuthority && !await input.verifyAuthority()) {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        if (this.accountUserId !== accountUserId || this.authorityGeneration !== authorityGeneration) {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        if (result.state !== "appended") {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        const batchIdentitySet = new Set(identities);
        const acknowledged = [...new Set(result.acknowledgedCaptureIdentities)]
          .filter((identity) => batchIdentitySet.has(identity));
        const permanentRejections = replayPermanentRejections(result)
          .filter((rejection) => batchIdentitySet.has(rejection.captureIdentity))
          .map((rejection) => ({
            captureIdentity: rejection.captureIdentity,
            reason: rejection.reason === "replay_window_expired"
              ? "server_replay_window_expired" as const
              : "server_replay_permanent_rejection" as const,
          }));
        if (acknowledged.length === 0 && permanentRejections.length === 0) {
          this.outbox.releaseForRetry(accountUserId, identities, nowMs);
          return;
        }
        const deleted = this.outbox.acknowledge(accountUserId, acknowledged, nowMs);
        const rejected = this.outbox.rejectPermanent(accountUserId, permanentRejections, nowMs);
        this.metrics.flushedSampleCount += deleted;
        const terminal = new Set([
          ...acknowledged,
          ...permanentRejections.map((rejection) => rejection.captureIdentity),
        ]);
        const unacknowledged = identities.filter((identity) => !terminal.has(identity));
        if (unacknowledged.length > 0) {
          this.outbox.releaseForRetry(
            accountUserId,
            unacknowledged,
            nowMs - DURABLE_LOCATION_OUTBOX_POLICY.initialRetryDelayMs,
          );
          return;
        }
        if (deleted + rejected === 0) return;
      }
    })().finally(() => {
      this.inFlight = null;
    });
    return this.inFlight;
  }

  size(): number {
    return this.accountUserId ? this.outbox.health(this.accountUserId).pendingCount : 0;
  }

  samples(limit?: number): readonly LocationHistoryArchiveSample[] {
    return this.accountUserId ? this.outbox.samples(this.accountUserId, limit) : [];
  }

  interruptions(): readonly DurableLocationInterruption[] {
    return this.accountUserId ? this.outbox.interruptions(this.accountUserId) : [];
  }

  health(): DurableLocationOutboxHealth {
    return this.outbox.health(this.accountUserId);
  }

  snapshot(): DenseLocationHistoryMetrics {
    return {
      ...this.metrics,
      rejectedSampleCount: { ...this.metrics.rejectedSampleCount },
      averageBatchSize: this.metrics.flushCount === 0 ? 0 : this.metrics.flushedSampleCount / this.metrics.flushCount,
    };
  }

  close(): void {
    this.outbox.close?.();
  }

  private reject(reason: DenseLocationHistoryRejectionReason): false {
    this.metrics.rejectedSampleCount[reason] += 1;
    return false;
  }

  private clearVolatileState(): void {
    this.recentIdentities.clear();
    this.lastAcceptedSample = null;
    this.recentMotionEvidence = [];
  }
}
