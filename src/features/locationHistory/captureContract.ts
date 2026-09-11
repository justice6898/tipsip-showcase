import {
  createLocationHistoryPoint,
  isExactPersonUserId,
  type LocationHistoryPoint,
} from "@/features/locationHistory/domain";
import type { RawLocationTelemetryEvidence } from "@/lib/locationTelemetry";
import {
  MOTION_EVIDENCE_POLICY,
  isCanonicalMotionEvidenceWindow,
  type CanonicalMotionEvidenceWindow,
} from "@/features/locationHistory/motionEvidence";

export type LocationHistoryAppendRequest = Readonly<RawLocationTelemetryEvidence & {
  accountUserId: string;
  subjectUserId: string;
  coordinate: LocationHistoryPoint["coordinate"];
  capturedAt: string;
  accuracyMeters?: number;
  /** Must identify the already-legitimate current-location publication. */
  publicationObservedAt: string;
}>;

export type LocationHistoryAppendResult =
  | { state: "appended"; point: LocationHistoryPoint }
  | { state: "duplicate"; point: LocationHistoryPoint }
  | { state: "disabled"; reason: "history_not_configured" }
  | { state: "denied"; reason: "account_isolation" | "publication_mismatch" }
  | { state: "unavailable"; reason: "invalid_sample" | "backend_unavailable" };

export interface LocationHistoryAppendRepository {
  appendOwnPublishedSample(
    request: LocationHistoryAppendRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryAppendResult>;
  appendOwnSamplesBatch(
    request: LocationHistoryBatchAppendRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryBatchAppendResult>;
  /** Optional additive long-offline replay path. Older clients/test adapters
   * remain compatible through appendOwnSamplesBatch. */
  appendOwnSamplesReplay?(
    request: LocationHistoryBatchAppendRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryReplayAppendResult>;
}

export const LOCATION_HISTORY_ARCHIVE_POLICY_VERSION = 1 as const;
export const LOCATION_HISTORY_SERVER_BATCH_MAX = 50;
export const LOCATION_HISTORY_REPLAY_BATCH_MAX = 200;
export const LOCATION_HISTORY_REPLAY_PAYLOAD_MAX_BYTES = 256 * 1024;
/** 24h local retention + 1h bounded drain/retry grace + 1h clock/network margin. */
export const LOCATION_HISTORY_REPLAY_MAX_AGE_MS = 26 * 60 * 60_000;
/** FAST 1,200/hour across the complete 26h server acceptance window. */
export const LOCATION_HISTORY_REPLAY_ROLLING_MAX = 31_200;

export type LocationHistoryArchiveSample = Readonly<RawLocationTelemetryEvidence & {
  captureIdentity: string;
  coordinate: LocationHistoryPoint["coordinate"];
  capturedAt: string;
  accuracyMeters: number;
  archivePolicyVersion: typeof LOCATION_HISTORY_ARCHIVE_POLICY_VERSION;
  /** Private subject-owned summary. Never returned by friend history reads. */
  motionEvidence?: CanonicalMotionEvidenceWindow;
}>;

export type LocationHistoryBatchAppendRequest = Readonly<{
  accountUserId: string;
  subjectUserId: string;
  samples: readonly LocationHistoryArchiveSample[];
}>;

export type LocationHistoryBatchAppendResult =
  | { state: "appended"; acknowledgedCaptureIdentities: readonly string[] }
  | { state: "disabled"; reason: "history_not_configured" | "batch_rpc_unavailable" }
  | { state: "denied"; reason: "account_isolation" }
  | { state: "unavailable"; reason: "invalid_batch" | "backend_unavailable" };

export type LocationHistoryReplayPermanentRejectionReason =
  | "replay_window_expired"
  | "capture_identity_collision";

export type LocationHistoryReplayAppendResult =
  | {
      state: "appended";
      acknowledgedCaptureIdentities: readonly string[];
      permanentRejections: readonly Readonly<{
        captureIdentity: string;
        reason: LocationHistoryReplayPermanentRejectionReason;
      }>[];
      serverTime: string;
      replayCutoff: string;
    }
  | { state: "disabled"; reason: "history_not_configured" | "replay_rpc_unavailable" }
  | { state: "denied"; reason: "account_isolation" }
  | { state: "unavailable"; reason: "invalid_batch" | "backend_unavailable" | "replay_volume_exceeded" };

export function locationHistoryArchiveCaptureIdentity(input: Readonly<{
  observedAtMs: number;
  coordinate: LocationHistoryPoint["coordinate"];
}>): string {
  return `v1:${input.observedAtMs}:${String(input.coordinate.latitude)}:${String(input.coordinate.longitude)}`;
}

export function normalizeLocationHistoryBatchAppendRequest(
  request: LocationHistoryBatchAppendRequest,
  referenceTimeMs = Date.now(),
): LocationHistoryArchiveSample[] | null {
  if (
    !isExactPersonUserId(request.accountUserId)
    || request.accountUserId !== request.subjectUserId
    || request.samples.length < 1
    || request.samples.length > LOCATION_HISTORY_SERVER_BATCH_MAX
  ) return null;
  const normalized: LocationHistoryArchiveSample[] = [];
  for (const sample of request.samples) {
    const capturedAtMs = Date.parse(sample.capturedAt);
    const point = createLocationHistoryPoint({
      personUserId: request.subjectUserId,
      coordinate: sample.coordinate,
      capturedAt: sample.capturedAt,
      accuracyMeters: sample.accuracyMeters,
      ...(sample.nativeSpeedMps === undefined ? {} : { nativeSpeedMps: sample.nativeSpeedMps }),
      ...(sample.nativeSpeedAccuracyMps === undefined ? {} : { nativeSpeedAccuracyMps: sample.nativeSpeedAccuracyMps }),
      ...(sample.nativeHeadingDegrees === undefined ? {} : { nativeHeadingDegrees: sample.nativeHeadingDegrees }),
      ...(sample.nativeHeadingAccuracyDegrees === undefined ? {} : { nativeHeadingAccuracyDegrees: sample.nativeHeadingAccuracyDegrees }),
      ...(sample.altitudeMeters === undefined ? {} : { altitudeMeters: sample.altitudeMeters }),
      ...(sample.verticalAccuracyMeters === undefined ? {} : { verticalAccuracyMeters: sample.verticalAccuracyMeters }),
      ...(sample.mocked === undefined ? {} : { mocked: sample.mocked }),
      ...(sample.telemetryVersion === undefined ? {} : { telemetryVersion: sample.telemetryVersion }),
    }, referenceTimeMs);
    if (
      !point
      || sample.archivePolicyVersion !== LOCATION_HISTORY_ARCHIVE_POLICY_VERSION
      || sample.captureIdentity !== locationHistoryArchiveCaptureIdentity({
        observedAtMs: capturedAtMs,
        coordinate: sample.coordinate,
      })
    ) return null;
    if (sample.motionEvidence) {
      const distanceFromWindow = capturedAtMs < sample.motionEvidence.windowStartedAtMs
        ? sample.motionEvidence.windowStartedAtMs - capturedAtMs
        : capturedAtMs > sample.motionEvidence.windowEndedAtMs
          ? capturedAtMs - sample.motionEvidence.windowEndedAtMs
          : 0;
      if (
        !isCanonicalMotionEvidenceWindow(sample.motionEvidence, request.accountUserId)
        || distanceFromWindow > MOTION_EVIDENCE_POLICY.associationToleranceMs
      ) return null;
    }
    normalized.push({
      ...sample,
      coordinate: { ...sample.coordinate },
      ...(sample.motionEvidence ? { motionEvidence: { ...sample.motionEvidence } } : {}),
    });
  }
  return normalized.sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
}

/** Replay validation deliberately widens only row count. Capture time remains
 * canonical, the one-minute future bound remains in createLocationHistoryPoint,
 * and the authoritative historical floor is returned by the server. */
export function normalizeLocationHistoryReplayAppendRequest(
  request: LocationHistoryBatchAppendRequest,
  referenceTimeMs = Date.now(),
): LocationHistoryArchiveSample[] | null {
  if (
    !isExactPersonUserId(request.accountUserId)
    || request.accountUserId !== request.subjectUserId
    || request.samples.length < 1
    || request.samples.length > LOCATION_HISTORY_REPLAY_BATCH_MAX
  ) return null;
  const normalized: LocationHistoryArchiveSample[] = [];
  for (const sample of request.samples) {
    const capturedAtMs = Date.parse(sample.capturedAt);
    const point = createLocationHistoryPoint({
      personUserId: request.subjectUserId,
      coordinate: sample.coordinate,
      capturedAt: sample.capturedAt,
      accuracyMeters: sample.accuracyMeters,
      ...(sample.nativeSpeedMps === undefined ? {} : { nativeSpeedMps: sample.nativeSpeedMps }),
      ...(sample.nativeSpeedAccuracyMps === undefined ? {} : { nativeSpeedAccuracyMps: sample.nativeSpeedAccuracyMps }),
      ...(sample.nativeHeadingDegrees === undefined ? {} : { nativeHeadingDegrees: sample.nativeHeadingDegrees }),
      ...(sample.nativeHeadingAccuracyDegrees === undefined ? {} : { nativeHeadingAccuracyDegrees: sample.nativeHeadingAccuracyDegrees }),
      ...(sample.altitudeMeters === undefined ? {} : { altitudeMeters: sample.altitudeMeters }),
      ...(sample.verticalAccuracyMeters === undefined ? {} : { verticalAccuracyMeters: sample.verticalAccuracyMeters }),
      ...(sample.mocked === undefined ? {} : { mocked: sample.mocked }),
      ...(sample.telemetryVersion === undefined ? {} : { telemetryVersion: sample.telemetryVersion }),
    }, referenceTimeMs);
    if (
      !point
      || sample.archivePolicyVersion !== LOCATION_HISTORY_ARCHIVE_POLICY_VERSION
      || sample.captureIdentity !== locationHistoryArchiveCaptureIdentity({
        observedAtMs: capturedAtMs,
        coordinate: sample.coordinate,
      })
    ) return null;
    if (sample.motionEvidence) {
      const distanceFromWindow = capturedAtMs < sample.motionEvidence.windowStartedAtMs
        ? sample.motionEvidence.windowStartedAtMs - capturedAtMs
        : capturedAtMs > sample.motionEvidence.windowEndedAtMs
          ? capturedAtMs - sample.motionEvidence.windowEndedAtMs
          : 0;
      if (
        !isCanonicalMotionEvidenceWindow(sample.motionEvidence, request.accountUserId)
        || distanceFromWindow > MOTION_EVIDENCE_POLICY.associationToleranceMs
      ) return null;
    }
    normalized.push({
      ...sample,
      coordinate: { ...sample.coordinate },
      ...(sample.motionEvidence ? { motionEvidence: { ...sample.motionEvidence } } : {}),
    });
  }
  return normalized.sort((left, right) => Date.parse(left.capturedAt) - Date.parse(right.capturedAt));
}

export function normalizeLocationHistoryAppendRequest(
  request: LocationHistoryAppendRequest,
): LocationHistoryPoint | null {
  if (
    !isExactPersonUserId(request.accountUserId)
    || request.accountUserId !== request.subjectUserId
    || request.publicationObservedAt !== request.capturedAt
  ) return null;
  return createLocationHistoryPoint({
    personUserId: request.subjectUserId,
    coordinate: request.coordinate,
    capturedAt: request.capturedAt,
    ...(request.accuracyMeters === undefined ? {} : { accuracyMeters: request.accuracyMeters }),
    ...(request.nativeSpeedMps === undefined ? {} : { nativeSpeedMps: request.nativeSpeedMps }),
    ...(request.nativeHeadingDegrees === undefined ? {} : { nativeHeadingDegrees: request.nativeHeadingDegrees }),
    ...(request.altitudeMeters === undefined ? {} : { altitudeMeters: request.altitudeMeters }),
    ...(request.verticalAccuracyMeters === undefined ? {} : { verticalAccuracyMeters: request.verticalAccuracyMeters }),
    ...(request.mocked === undefined ? {} : { mocked: request.mocked }),
    ...(request.telemetryVersion === undefined ? {} : { telemetryVersion: request.telemetryVersion }),
  });
}

/** Exact timestamp+coordinate suppression only; no smoothing or interpolation. */
export function locationHistoryCaptureDedupeKey(
  point: Pick<LocationHistoryPoint, "personUserId" | "capturedAt" | "coordinate">,
): string {
  return [
    point.personUserId,
    point.capturedAt,
    String(point.coordinate.latitude),
    String(point.coordinate.longitude),
  ].join(":");
}

export function shouldAppendLocationHistorySample(
  previous: LocationHistoryPoint | null | undefined,
  candidate: LocationHistoryPoint,
): boolean {
  return !previous
    || locationHistoryCaptureDedupeKey(previous) !== locationHistoryCaptureDedupeKey(candidate);
}

/** Fail-closed writer for offline/demo backends without history persistence. */
export class DisabledLocationHistoryAppendRepository implements LocationHistoryAppendRepository {
  async appendOwnPublishedSample(
    request: LocationHistoryAppendRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryAppendResult> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (!normalizeLocationHistoryAppendRequest(request)) {
      return request.accountUserId !== request.subjectUserId
        ? { state: "denied", reason: "account_isolation" }
        : { state: "unavailable", reason: "invalid_sample" };
    }
    return { state: "disabled", reason: "history_not_configured" };
  }

  async appendOwnSamplesBatch(
    request: LocationHistoryBatchAppendRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryBatchAppendResult> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (request.accountUserId !== request.subjectUserId) return { state: "denied", reason: "account_isolation" };
    if (!normalizeLocationHistoryBatchAppendRequest(request)) return { state: "unavailable", reason: "invalid_batch" };
    return { state: "disabled", reason: "history_not_configured" };
  }
}
