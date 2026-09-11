import {
  LOCATION_HISTORY_SERVER_BATCH_MAX,
  LOCATION_HISTORY_REPLAY_BATCH_MAX,
  LOCATION_HISTORY_REPLAY_MAX_AGE_MS,
  LOCATION_HISTORY_REPLAY_ROLLING_MAX,
  normalizeLocationHistoryBatchAppendRequest,
  type LocationHistoryArchiveSample,
} from "@/features/locationHistory/captureContract";
import { isExactPersonUserId } from "@/features/locationHistory/domain";
import {
  motionEvidenceForLocation,
  type CanonicalMotionEvidenceWindow,
} from "@/features/locationHistory/motionEvidence";

export const LOCATION_OUTBOX_PERSISTENCE_VERSION = 1 as const;

export const ACKNOWLEDGED_LOCATION_SHADOW_POLICY = Object.freeze({
  maximumAgeMs: 24 * 60 * 60_000,
  maximumRecordCountPerAccount: 512,
});

/** Delivery retention, not product-history retention. Technical retention is
 * the 24h offline target plus the bounded drain and clock/network margins
 * shared with the server replay contract. */
export type DurableLocationOutboxPolicy = Readonly<{
  maximumAgeMs: number;
  maximumRecordCount: number;
  maximumBytes: number;
  maximumBatchCount: number;
  maximumReplayBatchCount: number;
  maximumServerBatchSpanMs: number;
  initialRetryDelayMs: number;
  maximumRetryDelayMs: number;
}>;

export const DURABLE_LOCATION_OUTBOX_POLICY: DurableLocationOutboxPolicy = Object.freeze({
  maximumAgeMs: LOCATION_HISTORY_REPLAY_MAX_AGE_MS,
  maximumRecordCount: LOCATION_HISTORY_REPLAY_ROLLING_MAX,
  maximumBytes: 64 * 1024 * 1024,
  maximumBatchCount: LOCATION_HISTORY_SERVER_BATCH_MAX,
  maximumReplayBatchCount: LOCATION_HISTORY_REPLAY_BATCH_MAX,
  maximumServerBatchSpanMs: 20 * 60_000,
  initialRetryDelayMs: 30_000,
  maximumRetryDelayMs: 10 * 60_000,
});

export type RecordingInterruptionReason =
  | "recording_interruption_unknown"
  | "sharing_disabled"
  | "background_consent_disabled"
  | "permission_unavailable"
  | "location_services_unavailable"
  | "authenticated_owner_unavailable"
  | "explicit_logout"
  | "account_switch"
  | "app_background_capture_unavailable"
  | "local_outbox_overflow"
  | "server_replay_window_expired"
  | "server_replay_permanent_rejection"
  | "provider_capture_error";

export type DurableReplayPermanentRejection = Readonly<{
  captureIdentity: string;
  reason: Extract<RecordingInterruptionReason, "server_replay_window_expired" | "server_replay_permanent_rejection">;
}>;

export type DurablePendingLocationCapture = Readonly<{
  persistenceVersion: typeof LOCATION_OUTBOX_PERSISTENCE_VERSION;
  captureIdentity: string;
  accountIdentity: string;
  subjectIdentity: string;
  capturedAtMs: number;
  captureSessionIdentity: string;
  sample: LocationHistoryArchiveSample;
  enqueuedAtMs: number;
}>;

export type DurableLocationInterruption = Readonly<{
  persistenceVersion: typeof LOCATION_OUTBOX_PERSISTENCE_VERSION;
  interruptionIdentity: string;
  accountIdentity: string;
  captureSessionIdentity: string;
  reason: RecordingInterruptionReason;
  startedAtMs: number;
  endedAtMs?: number;
}>;

export type DurableLocationOutboxRow = Readonly<{
  record: DurablePendingLocationCapture;
  state: "pending" | "inflight" | "quarantined";
  retryCount: number;
  nextRetryAtMs: number;
  payloadBytes: number;
}>;

export type DurableLocationOutboxHealth = Readonly<{
  state: "healthy" | "offline_pending" | "retrying" | "capacity_pressure" | "corrupt_record_detected" | "store_unavailable";
  pendingCount: number;
  pendingBytes: number;
  quarantinedCount: number;
  interruptionCount: number;
  oldestCapturedAtMs: number | null;
}>;

export type DurableEnqueueResult =
  | { state: "enqueued"; droppedCount: number; droppedBytes: number }
  | { state: "duplicate" }
  | { state: "conflict" }
  | { state: "invalid" }
  | { state: "unavailable" };

export interface DurableLocationOutboxStorage {
  readonly protection: Readonly<{
    kind: "app_private_os_protected" | "test_only" | "unavailable";
    encryptedByApp: false;
    backupExcluded: boolean;
    backupTruth: string;
  }>;
  recover(nowMs?: number): Readonly<{ staleInflightCount: number; corruptRecordCount: number }>;
  enqueue(record: DurablePendingLocationCapture, nowMs?: number): DurableEnqueueResult;
  readChronologicalBatch(accountIdentity: string, nowMs?: number, limit?: number): DurableLocationOutboxRow[];
  markInflight(accountIdentity: string, captureIdentities: readonly string[], nowMs?: number): boolean;
  releaseForRetry(accountIdentity: string, captureIdentities: readonly string[], nowMs?: number): void;
  acknowledge(accountIdentity: string, captureIdentities: readonly string[], nowMs?: number): number;
  acknowledgedSamples(accountIdentity: string, nowMs?: number, limit?: number): LocationHistoryArchiveSample[];
  discardAcknowledged(accountIdentity: string, captureIdentities: readonly string[]): number;
  rejectPermanent(accountIdentity: string, rejections: readonly DurableReplayPermanentRejection[], nowMs?: number): number;
  attachMotionEvidence(accountIdentity: string, evidence: CanonicalMotionEvidenceWindow): number;
  recordInterruption(interruption: DurableLocationInterruption): void;
  interruptions(accountIdentity: string): DurableLocationInterruption[];
  purgeAccount(accountIdentity: string): number;
  health(accountIdentity: string | null): DurableLocationOutboxHealth;
  samples(accountIdentity: string, limit?: number): LocationHistoryArchiveSample[];
  close?(): void;
}

function serializedBytes(value: unknown): number {
  const encoded = JSON.stringify(value);
  if (typeof TextEncoder === "function") return new TextEncoder().encode(encoded).byteLength;
  return encoded.length * 2;
}

function sameRecord(left: DurablePendingLocationCapture, right: DurablePendingLocationCapture): boolean {
  return left.accountIdentity === right.accountIdentity
    && left.subjectIdentity === right.subjectIdentity
    && left.captureIdentity === right.captureIdentity
    && JSON.stringify(left.sample) === JSON.stringify(right.sample);
}

export function decodeDurablePendingLocationCapture(
  value: unknown,
  referenceTimeMs = Date.now(),
): DurablePendingLocationCapture | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<DurablePendingLocationCapture>;
  if (
    candidate.persistenceVersion !== LOCATION_OUTBOX_PERSISTENCE_VERSION
    || !isExactPersonUserId(candidate.accountIdentity)
    || candidate.subjectIdentity !== candidate.accountIdentity
    || typeof candidate.captureSessionIdentity !== "string"
    || candidate.captureSessionIdentity.length < 10
    || candidate.captureSessionIdentity.length > 160
    || typeof candidate.capturedAtMs !== "number"
    || !Number.isFinite(candidate.capturedAtMs)
    || typeof candidate.enqueuedAtMs !== "number"
    || !Number.isFinite(candidate.enqueuedAtMs)
    || !candidate.sample
    || candidate.captureIdentity !== candidate.sample.captureIdentity
    || candidate.capturedAtMs !== Date.parse(candidate.sample.capturedAt)
  ) return null;
  const samples = normalizeLocationHistoryBatchAppendRequest({
    accountUserId: candidate.accountIdentity,
    subjectUserId: candidate.accountIdentity,
    samples: [candidate.sample],
  }, referenceTimeMs);
  if (!samples) return null;
  return {
    persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
    captureIdentity: candidate.captureIdentity,
    accountIdentity: candidate.accountIdentity,
    subjectIdentity: candidate.accountIdentity,
    capturedAtMs: candidate.capturedAtMs,
    captureSessionIdentity: candidate.captureSessionIdentity,
    sample: samples[0]!,
    enqueuedAtMs: candidate.enqueuedAtMs,
  };
}

/** Deterministic, transaction-like test adapter. Production uses the SQLite
 * adapter; this implementation intentionally has no AsyncStorage fallback. */
export class MemoryDurableLocationOutboxStorage implements DurableLocationOutboxStorage {
  readonly protection = Object.freeze({
    kind: "test_only" as const,
    encryptedByApp: false as const,
    backupExcluded: true,
    backupTruth: "Volatile test adapter; never selected by production runtime.",
  });
  private rows = new Map<string, DurableLocationOutboxRow>();
  private acknowledged = new Map<string, Readonly<{
    record: DurablePendingLocationCapture;
    acknowledgedAtMs: number;
  }>>();
  private boundaries = new Map<string, DurableLocationInterruption>();
  private accountTotals = new Map<string, { count: number; bytes: number; oldestCapturedAtMs: number }>();
  private corruptCount = 0;

  constructor(private readonly policy: DurableLocationOutboxPolicy = DURABLE_LOCATION_OUTBOX_POLICY) {}

  private key(accountIdentity: string, captureIdentity: string): string {
    return `${accountIdentity}\u0000${captureIdentity}`;
  }

  recover(nowMs = Date.now()) {
    let staleInflightCount = 0;
    const touchedAccounts = new Set<string>();
    for (const [key, row] of this.rows) {
      if (row.state === "quarantined") continue;
      const decoded = decodeDurablePendingLocationCapture(row.record, nowMs);
      if (!decoded) {
        this.rows.set(key, { ...row, state: "quarantined" });
        touchedAccounts.add(row.record.accountIdentity);
        this.corruptCount += 1;
        continue;
      }
      if (row.state === "inflight") {
        staleInflightCount += 1;
        this.rows.set(key, {
          ...row,
          record: decoded,
          state: "pending",
          nextRetryAtMs: Math.max(row.nextRetryAtMs, nowMs + this.policy.initialRetryDelayMs),
        });
      }
    }
    for (const accountIdentity of touchedAccounts) this.recomputeAccountTotals(accountIdentity);
    this.pruneAcknowledged(nowMs);
    return { staleInflightCount, corruptRecordCount: this.corruptCount };
  }

  enqueue(record: DurablePendingLocationCapture, nowMs = Date.now()): DurableEnqueueResult {
    const decoded = decodeDurablePendingLocationCapture(record, nowMs);
    if (!decoded) return { state: "invalid" };
    const key = this.key(decoded.accountIdentity, decoded.captureIdentity);
    const existing = this.rows.get(key);
    if (existing) return sameRecord(existing.record, decoded) ? { state: "duplicate" } : { state: "conflict" };
    const payloadBytes = serializedBytes(decoded);
    if (payloadBytes > this.policy.maximumBytes) return { state: "invalid" };
    this.rows.set(key, { record: decoded, state: "pending", retryCount: 0, nextRetryAtMs: 0, payloadBytes });
    const previousTotals = this.accountTotals.get(decoded.accountIdentity);
    const nextTotals = {
      count: (previousTotals?.count ?? 0) + 1,
      bytes: (previousTotals?.bytes ?? 0) + payloadBytes,
      oldestCapturedAtMs: Math.min(previousTotals?.oldestCapturedAtMs ?? decoded.capturedAtMs, decoded.capturedAtMs),
    };
    this.accountTotals.set(decoded.accountIdentity, nextTotals);
    if (
      nextTotals.count <= this.policy.maximumRecordCount
      && nextTotals.bytes <= this.policy.maximumBytes
      && nextTotals.oldestCapturedAtMs >= nowMs - this.policy.maximumAgeMs
    ) return { state: "enqueued", droppedCount: 0, droppedBytes: 0 };
    const eligible = [...this.rows.entries()]
      .filter(([, row]) => row.record.accountIdentity === decoded.accountIdentity && row.state !== "quarantined")
      .sort((left, right) => left[1].record.capturedAtMs - right[1].record.capturedAtMs || left[1].record.captureIdentity.localeCompare(right[1].record.captureIdentity));
    let totalBytes = eligible.reduce((sum, [, row]) => sum + row.payloadBytes, 0);
    let droppedCount = 0;
    let droppedBytes = 0;
    while (
      eligible.length > 0
      && (eligible.length > this.policy.maximumRecordCount
        || totalBytes > this.policy.maximumBytes
        || eligible[0][1].record.capturedAtMs < nowMs - this.policy.maximumAgeMs)
    ) {
      const [dropKey, dropped] = eligible.shift()!;
      this.rows.delete(dropKey);
      totalBytes -= dropped.payloadBytes;
      droppedBytes += dropped.payloadBytes;
      droppedCount += 1;
    }
    this.recomputeAccountTotals(decoded.accountIdentity);
    if (droppedCount > 0) {
      const interruption: DurableLocationInterruption = {
        persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
        interruptionIdentity: `overflow:${decoded.accountIdentity}:${nowMs}:${droppedCount}`,
        accountIdentity: decoded.accountIdentity,
        captureSessionIdentity: decoded.captureSessionIdentity,
        reason: "local_outbox_overflow",
        startedAtMs: nowMs,
      };
      this.boundaries.set(interruption.interruptionIdentity, interruption);
    }
    return { state: "enqueued", droppedCount, droppedBytes };
  }

  readChronologicalBatch(accountIdentity: string, nowMs = Date.now(), limit = this.policy.maximumBatchCount): DurableLocationOutboxRow[] {
    const boundedLimit = Math.max(1, Math.min(limit, this.policy.maximumReplayBatchCount));
    const rows = [...this.rows.values()]
      .filter((row) => row.record.accountIdentity === accountIdentity && row.state === "pending")
      .sort((left, right) => left.record.capturedAtMs - right.record.capturedAtMs || left.record.captureIdentity.localeCompare(right.record.captureIdentity));
    if ((rows[0]?.nextRetryAtMs ?? 0) > nowMs) return [];
    const first = rows[0]?.record.capturedAtMs;
    return rows.filter((row) => first === undefined || row.record.capturedAtMs - first <= this.policy.maximumServerBatchSpanMs).slice(0, boundedLimit);
  }

  markInflight(accountIdentity: string, captureIdentities: readonly string[], _nowMs = Date.now()): boolean {
    const keys = captureIdentities.map((identity) => this.key(accountIdentity, identity));
    if (keys.some((key) => this.rows.get(key)?.state !== "pending")) return false;
    for (const key of keys) this.rows.set(key, { ...this.rows.get(key)!, state: "inflight" });
    return true;
  }

  releaseForRetry(accountIdentity: string, captureIdentities: readonly string[], nowMs = Date.now()): void {
    for (const identity of captureIdentities) {
      const key = this.key(accountIdentity, identity);
      const row = this.rows.get(key);
      if (!row || row.state === "quarantined") continue;
      const retryCount = row.retryCount + 1;
      const delay = Math.min(this.policy.initialRetryDelayMs * 2 ** Math.max(0, retryCount - 1), this.policy.maximumRetryDelayMs);
      this.rows.set(key, { ...row, state: "pending", retryCount, nextRetryAtMs: nowMs + delay });
    }
  }

  acknowledge(accountIdentity: string, captureIdentities: readonly string[], nowMs = Date.now()): number {
    let deleted = 0;
    for (const identity of new Set(captureIdentities)) {
      const key = this.key(accountIdentity, identity);
      const row = this.rows.get(key);
      if (row && row.state !== "quarantined" && this.rows.delete(key)) {
        this.acknowledged.set(key, { record: row.record, acknowledgedAtMs: nowMs });
        deleted += 1;
      }
    }
    if (deleted > 0) this.recomputeAccountTotals(accountIdentity);
    this.pruneAcknowledged(nowMs, accountIdentity);
    return deleted;
  }

  acknowledgedSamples(
    accountIdentity: string,
    nowMs = Date.now(),
    limit = ACKNOWLEDGED_LOCATION_SHADOW_POLICY.maximumRecordCountPerAccount,
  ): LocationHistoryArchiveSample[] {
    this.pruneAcknowledged(nowMs, accountIdentity);
    const boundedLimit = Math.max(1, Math.min(
      Math.floor(limit),
      ACKNOWLEDGED_LOCATION_SHADOW_POLICY.maximumRecordCountPerAccount,
    ));
    return [...this.acknowledged.values()]
      .filter((entry) => entry.record.accountIdentity === accountIdentity)
      .sort((left, right) => left.record.capturedAtMs - right.record.capturedAtMs
        || left.record.captureIdentity.localeCompare(right.record.captureIdentity))
      .slice(-boundedLimit)
      .map((entry) => entry.record.sample);
  }

  discardAcknowledged(accountIdentity: string, captureIdentities: readonly string[]): number {
    let deleted = 0;
    for (const identity of new Set(captureIdentities)) {
      if (this.acknowledged.delete(this.key(accountIdentity, identity))) deleted += 1;
    }
    return deleted;
  }

  rejectPermanent(accountIdentity: string, rejections: readonly DurableReplayPermanentRejection[], nowMs = Date.now()): number {
    let deleted = 0;
    const unique = new Map(rejections.map((rejection) => [rejection.captureIdentity, rejection]));
    for (const rejection of unique.values()) {
      const key = this.key(accountIdentity, rejection.captureIdentity);
      const row = this.rows.get(key);
      if (!row || row.record.accountIdentity !== accountIdentity || row.state === "quarantined") continue;
      this.rows.delete(key);
      deleted += 1;
      const interruption: DurableLocationInterruption = {
        persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
        interruptionIdentity: `server-rejection:${accountIdentity}:${rejection.captureIdentity}`,
        accountIdentity,
        captureSessionIdentity: row.record.captureSessionIdentity,
        reason: rejection.reason,
        startedAtMs: row.record.capturedAtMs,
        endedAtMs: Math.max(row.record.capturedAtMs, nowMs),
      };
      this.boundaries.set(interruption.interruptionIdentity, interruption);
    }
    if (deleted > 0) this.recomputeAccountTotals(accountIdentity);
    return deleted;
  }

  attachMotionEvidence(accountIdentity: string, evidence: CanonicalMotionEvidenceWindow): number {
    let attached = 0;
    for (const [key, row] of this.rows) {
      if (row.record.accountIdentity !== accountIdentity || row.state !== "pending") continue;
      const best = motionEvidenceForLocation(accountIdentity, row.record.capturedAtMs, [evidence]);
      if (!best || best.evidenceIdentity === row.record.sample.motionEvidence?.evidenceIdentity) continue;
      const record = { ...row.record, sample: { ...row.record.sample, motionEvidence: { ...best } } };
      this.rows.set(key, { ...row, record, payloadBytes: serializedBytes(record) });
      attached += 1;
    }
    if (attached > 0) this.recomputeAccountTotals(accountIdentity);
    return attached;
  }

  recordInterruption(interruption: DurableLocationInterruption): void {
    if (interruption.persistenceVersion !== LOCATION_OUTBOX_PERSISTENCE_VERSION || !isExactPersonUserId(interruption.accountIdentity)) return;
    this.boundaries.set(interruption.interruptionIdentity, { ...interruption });
  }

  interruptions(accountIdentity: string): DurableLocationInterruption[] {
    return [...this.boundaries.values()]
      .filter((entry) => entry.accountIdentity === accountIdentity)
      .sort((left, right) => left.startedAtMs - right.startedAtMs);
  }

  purgeAccount(accountIdentity: string): number {
    let deleted = 0;
    for (const [key, row] of this.rows) {
      if (row.record.accountIdentity === accountIdentity && this.rows.delete(key)) deleted += 1;
    }
    for (const [key, interruption] of this.boundaries) {
      if (interruption.accountIdentity === accountIdentity) this.boundaries.delete(key);
    }
    for (const [key, entry] of this.acknowledged) {
      if (entry.record.accountIdentity === accountIdentity) this.acknowledged.delete(key);
    }
    this.accountTotals.delete(accountIdentity);
    return deleted;
  }

  private pruneAcknowledged(nowMs: number, accountIdentity?: string): void {
    const cutoff = nowMs - ACKNOWLEDGED_LOCATION_SHADOW_POLICY.maximumAgeMs;
    for (const [key, entry] of this.acknowledged) {
      if ((accountIdentity === undefined || entry.record.accountIdentity === accountIdentity)
        && entry.acknowledgedAtMs < cutoff) {
        this.acknowledged.delete(key);
      }
    }
    const accounts = accountIdentity
      ? [accountIdentity]
      : [...new Set([...this.acknowledged.values()].map((entry) => entry.record.accountIdentity))];
    for (const account of accounts) {
      const overflow = [...this.acknowledged.entries()]
        .filter(([, entry]) => entry.record.accountIdentity === account)
        .sort((left, right) => right[1].acknowledgedAtMs - left[1].acknowledgedAtMs
          || right[1].record.capturedAtMs - left[1].record.capturedAtMs)
        .slice(ACKNOWLEDGED_LOCATION_SHADOW_POLICY.maximumRecordCountPerAccount);
      for (const [key] of overflow) this.acknowledged.delete(key);
    }
  }

  health(accountIdentity: string | null): DurableLocationOutboxHealth {
    const rows = [...this.rows.values()].filter((row) => accountIdentity === null || row.record.accountIdentity === accountIdentity);
    const pending = rows.filter((row) => row.state !== "quarantined");
    const pendingBytes = pending.reduce((sum, row) => sum + row.payloadBytes, 0);
    const quarantinedCount = rows.length - pending.length;
    const retrying = pending.some((row) => row.retryCount > 0);
    const pressure = pending.length >= this.policy.maximumRecordCount * 0.9 || pendingBytes >= this.policy.maximumBytes * 0.9;
    return {
      state: quarantinedCount > 0 ? "corrupt_record_detected" : pressure ? "capacity_pressure" : retrying ? "retrying" : pending.length > 0 ? "offline_pending" : "healthy",
      pendingCount: pending.length,
      pendingBytes,
      quarantinedCount,
      interruptionCount: [...this.boundaries.values()].filter((entry) => accountIdentity === null || entry.accountIdentity === accountIdentity).length,
      oldestCapturedAtMs: pending.length === 0 ? null : Math.min(...pending.map((row) => row.record.capturedAtMs)),
    };
  }

  samples(accountIdentity: string, limit?: number): LocationHistoryArchiveSample[] {
    const samples = [...this.rows.values()]
      .filter((row) => row.record.accountIdentity === accountIdentity && row.state !== "quarantined")
      .sort((left, right) => left.record.capturedAtMs - right.record.capturedAtMs)
      .map((row) => row.record.sample);
    return Number.isInteger(limit) && limit! > 0 ? samples.slice(-limit!) : samples;
  }

  /** Test-only corruption seam. It never logs or exposes coordinate payloads. */
  injectCorruptRecordForTest(accountIdentity: string, captureIdentity: string): void {
    const record = {
      persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
      accountIdentity,
      subjectIdentity: accountIdentity,
      captureIdentity,
      capturedAtMs: Number.NaN,
      captureSessionIdentity: "corrupt-test-session",
      sample: {} as LocationHistoryArchiveSample,
      enqueuedAtMs: 0,
    };
    this.rows.set(this.key(accountIdentity, captureIdentity), {
      record,
      state: "pending",
      retryCount: 0,
      nextRetryAtMs: 0,
      payloadBytes: 1,
    });
    this.recomputeAccountTotals(accountIdentity);
  }

  private recomputeAccountTotals(accountIdentity: string): void {
    const rows = [...this.rows.values()].filter((row) => row.record.accountIdentity === accountIdentity && row.state !== "quarantined");
    if (rows.length === 0) {
      this.accountTotals.delete(accountIdentity);
      return;
    }
    this.accountTotals.set(accountIdentity, {
      count: rows.length,
      bytes: rows.reduce((sum, row) => sum + row.payloadBytes, 0),
      oldestCapturedAtMs: Math.min(...rows.map((row) => row.record.capturedAtMs)),
    });
  }
}

export class UnavailableDurableLocationOutboxStorage implements DurableLocationOutboxStorage {
  readonly protection = Object.freeze({
    kind: "unavailable" as const,
    encryptedByApp: false as const,
    backupExcluded: false,
    backupTruth: "Durable storage failed to initialize; no sensitive fallback is used.",
  });
  recover() { return { staleInflightCount: 0, corruptRecordCount: 0 }; }
  enqueue(): DurableEnqueueResult { return { state: "unavailable" }; }
  readChronologicalBatch(): DurableLocationOutboxRow[] { return []; }
  markInflight(): boolean { return false; }
  releaseForRetry(): void {}
  acknowledge(): number { return 0; }
  acknowledgedSamples(): LocationHistoryArchiveSample[] { return []; }
  discardAcknowledged(): number { return 0; }
  rejectPermanent(): number { return 0; }
  attachMotionEvidence(): number { return 0; }
  recordInterruption(): void {}
  interruptions(): DurableLocationInterruption[] { return []; }
  purgeAccount(): number { return 0; }
  health(): DurableLocationOutboxHealth {
    return { state: "store_unavailable", pendingCount: 0, pendingBytes: 0, quarantinedCount: 0, interruptionCount: 0, oldestCapturedAtMs: null };
  }
  samples(_accountIdentity?: string, _limit?: number): LocationHistoryArchiveSample[] { return []; }
}
