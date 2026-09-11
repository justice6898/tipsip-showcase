import {
  locationHistoryArchiveCaptureIdentity,
  type LocationHistoryArchiveSample,
} from "@/features/locationHistory/captureContract";
import {
  createLocationHistoryPoint,
  isExactPersonUserId,
  orderedLocationHistoryPoints,
  type LocationHistoryPoint,
  type PersonLocationHistory,
} from "@/features/locationHistory/domain";
import type { AcceptedCurrentLocationObservation } from "@/lib/locationPolicy";

export const SELF_PRIVATE_HISTORY_SESSION_EVIDENCE_LIMIT = 512;

export type SelfPrivateHistoryEvidence = Readonly<{
  accountUserId: string | null;
  points: readonly LocationHistoryPoint[];
}>;

export type SelfPrivateHistorySyncState =
  | "remote_current"
  | "remote_empty"
  | "local_sync_pending"
  | "remote_unavailable_local_available"
  | "unavailable";

export type SelfPrivateHistoryProjection = Readonly<{
  history: PersonLocationHistory;
  syncState: SelfPrivateHistorySyncState;
  localOnlyPointCount: number;
}>;

export const EMPTY_SELF_PRIVATE_HISTORY_EVIDENCE: SelfPrivateHistoryEvidence = Object.freeze({
  accountUserId: null,
  points: Object.freeze([]),
});

/** Provider/sample-id-neutral identity shared by the self read-through and
 * dwell authority. A server-assigned sample id must not make the same physical
 * observation look different after local acknowledgement. */
export function selfPrivateHistoryObservationIdentity(point: LocationHistoryPoint): string {
  const capturedAtMs = Date.parse(point.capturedAt);
  return [
    point.personUserId,
    Number.isFinite(capturedAtMs) ? String(capturedAtMs) : point.capturedAt,
    String(point.coordinate.latitude),
    String(point.coordinate.longitude),
  ].join(":");
}

/** A non-captured foreground callback may read through account-partitioned
 * SQLite/ACK state only when that durable state contains the exact callback
 * observation. Once anchored, older rows from the same partition may be
 * returned so process-recreation continuity can be reconstructed. */
export function selectDurableSelfHistoryRecoverySamples(input: Readonly<{
  accountUserId: string;
  durableAccountUserId: string;
  observation: AcceptedCurrentLocationObservation;
  durableSamples: readonly LocationHistoryArchiveSample[];
}>): readonly LocationHistoryArchiveSample[] {
  if (
    !isExactPersonUserId(input.accountUserId)
    || input.durableAccountUserId !== input.accountUserId
    || !Number.isFinite(input.observation.observedAtMs)
  ) return [];
  const captureIdentity = locationHistoryArchiveCaptureIdentity({
    observedAtMs: input.observation.observedAtMs,
    coordinate: input.observation.coordinate,
  });
  return input.durableSamples.some((sample) => sample.captureIdentity === captureIdentity)
    ? input.durableSamples
    : [];
}

export function selfPrivateHistoryPointFromArchiveSample(
  accountUserId: string,
  sample: LocationHistoryArchiveSample,
  referenceTimeMs: number,
): LocationHistoryPoint | null {
  return createLocationHistoryPoint({
    personUserId: accountUserId,
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
}

export function selfPrivateHistoryPointFromObservation(
  accountUserId: string,
  observation: AcceptedCurrentLocationObservation,
  referenceTimeMs = Date.now(),
): LocationHistoryPoint | null {
  return createLocationHistoryPoint({
    personUserId: accountUserId,
    coordinate: observation.coordinate,
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
  }, referenceTimeMs);
}

/** Bounded process-memory continuity for observations already accepted by the
 * durable writer. It is not persistence and is cleared at the account/consent
 * boundary; SQLite and the server remain the only durable authorities. */
export function adoptSelfPrivateHistoryEvidence(input: Readonly<{
  current: SelfPrivateHistoryEvidence;
  accountUserId: string | null;
  observations?: readonly AcceptedCurrentLocationObservation[];
  archiveSamples?: readonly LocationHistoryArchiveSample[];
  referenceTimeMs?: number;
}>): SelfPrivateHistoryEvidence {
  if (!input.accountUserId) return EMPTY_SELF_PRIVATE_HISTORY_EVIDENCE;
  const referenceTimeMs = input.referenceTimeMs ?? Date.now();
  const prior = input.current.accountUserId === input.accountUserId
    ? input.current.points
    : [];
  const candidates = [
    ...prior,
    ...(input.archiveSamples ?? []).flatMap((sample) => {
      const point = selfPrivateHistoryPointFromArchiveSample(input.accountUserId!, sample, referenceTimeMs);
      return point ? [point] : [];
    }),
    ...(input.observations ?? []).flatMap((observation) => {
      const point = selfPrivateHistoryPointFromObservation(input.accountUserId!, observation, referenceTimeMs);
      return point ? [point] : [];
    }),
  ];
  const byObservation = new Map<string, LocationHistoryPoint>();
  for (const point of orderedLocationHistoryPoints(candidates, input.accountUserId, referenceTimeMs)) {
    byObservation.set(selfPrivateHistoryObservationIdentity(point), point);
  }
  return {
    accountUserId: input.accountUserId,
    points: [...byObservation.values()].slice(-SELF_PRIVATE_HISTORY_SESSION_EVIDENCE_LIMIT),
  };
}

/** Returns only client capture identities whose exact physical observation is
 * now visible in the authenticated remote history. This lets the existing
 * SQLite authority retire its bounded ACK shadow without trusting server row
 * ids or leaking evidence across accounts. */
export function acknowledgedCaptureIdentitiesVisibleRemotely(input: Readonly<{
  accountUserId: string;
  acknowledgedSamples: readonly LocationHistoryArchiveSample[];
  remoteHistory: PersonLocationHistory;
  referenceTimeMs?: number;
}>): string[] {
  if (
    input.remoteHistory.viewerUserId !== input.accountUserId
    || input.remoteHistory.personUserId !== input.accountUserId
    || input.remoteHistory.availability.state !== "ready"
  ) return [];
  const referenceTimeMs = input.referenceTimeMs ?? Date.now();
  const remoteIdentities = new Set(input.remoteHistory.spans.flatMap((span) => (
    span.state === "authorized" ? span.points.map(selfPrivateHistoryObservationIdentity) : []
  )));
  return input.acknowledgedSamples.flatMap((sample) => {
    const point = selfPrivateHistoryPointFromArchiveSample(
      input.accountUserId,
      sample,
      referenceTimeMs,
    );
    return point && remoteIdentities.has(selfPrivateHistoryObservationIdentity(point))
      ? [sample.captureIdentity]
      : [];
  });
}

/** Self-only read-through composition. Remote rows win exact duplicates, while
 * locally durable pending/recently acknowledged evidence keeps Activity
 * truthful during offline sync and read-after-write delay. */
export function composeSelfPrivateHistory(input: Readonly<{
  accountUserId: string;
  remoteHistory: PersonLocationHistory;
  localEvidence: SelfPrivateHistoryEvidence;
  referenceTimeMs?: number;
}>): SelfPrivateHistoryProjection {
  const { remoteHistory } = input;
  if (
    remoteHistory.viewerUserId !== input.accountUserId
    || remoteHistory.personUserId !== input.accountUserId
    || remoteHistory.availability.state === "denied"
    || input.localEvidence.accountUserId !== input.accountUserId
  ) {
    return { history: remoteHistory, syncState: "unavailable", localOnlyPointCount: 0 };
  }
  const referenceTimeMs = input.referenceTimeMs ?? Date.now();
  const remotePoints = remoteHistory.spans.flatMap((span) => (
    span.state === "authorized" ? span.points : []
  ));
  const remoteIdentities = new Set(remotePoints.map(selfPrivateHistoryObservationIdentity));
  const localPoints = orderedLocationHistoryPoints(
    input.localEvidence.points,
    input.accountUserId,
    referenceTimeMs,
  );
  const localOnlyPointCount = localPoints.filter((point) => !remoteIdentities.has(selfPrivateHistoryObservationIdentity(point))).length;
  const merged = new Map<string, LocationHistoryPoint>();
  for (const point of localPoints) merged.set(selfPrivateHistoryObservationIdentity(point), point);
  // Server sample identity and normalized telemetry are authoritative after ACK.
  for (const point of remotePoints) merged.set(selfPrivateHistoryObservationIdentity(point), point);
  const points = orderedLocationHistoryPoints([...merged.values()], input.accountUserId, referenceTimeMs);
  if (points.length === 0) {
    return {
      history: remoteHistory,
      syncState: remoteHistory.availability.state === "empty" ? "remote_empty" : "unavailable",
      localOnlyPointCount: 0,
    };
  }
  return {
    history: {
      viewerUserId: input.accountUserId,
      personUserId: input.accountUserId,
      availability: { state: "ready" },
      spans: [{ state: "authorized", points }],
    },
    syncState: remoteHistory.availability.state === "unavailable"
      ? "remote_unavailable_local_available"
      : localOnlyPointCount > 0
        ? "local_sync_pending"
        : "remote_current",
    localOnlyPointCount,
  };
}

export function selfPrivateHistoryOngoingPointIdentity(input: Readonly<{
  accountUserId: string;
  evidence: SelfPrivateHistoryEvidence;
  observation: AcceptedCurrentLocationObservation | null;
  observationCurrent: boolean;
  referenceTimeMs?: number;
}>): string | null {
  if (
    !input.observation
    || !input.observationCurrent
    || input.evidence.accountUserId !== input.accountUserId
  ) return null;
  const point = selfPrivateHistoryPointFromObservation(
    input.accountUserId,
    input.observation,
    input.referenceTimeMs,
  );
  if (!point) return null;
  const identity = selfPrivateHistoryObservationIdentity(point);
  const durable = input.evidence.points.find((candidate) => selfPrivateHistoryObservationIdentity(candidate) === identity);
  return durable ? selfPrivateHistoryObservationIdentity(durable) : null;
}
