/**
 * Sanitized selection of canonical tipSip location-history regression cases.
 * Production calls and assertions preserve their original semantics; account
 * labels, dates, and coordinates are deliberately synthetic.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  LocationCaptureOwnershipCoordinator,
  type LocationCaptureOwnershipAdapter,
} from "../src/features/locationHistory/backgroundLocationCapture.ts";
import {
  LOCATION_HISTORY_ARCHIVE_POLICY_VERSION,
  locationHistoryArchiveCaptureIdentity,
  type LocationHistoryArchiveSample,
} from "../src/features/locationHistory/captureContract.ts";
import {
  filterPersonLocationHistoryForDay,
  locationHistoryDayKey,
  projectLocationHistoryDayEventsForRoute,
} from "../src/features/locationHistory/dayPresentation.ts";
import type {
  LocationHistoryPoint,
  PersonLocationHistory,
} from "../src/features/locationHistory/domain.ts";
import {
  LOCATION_OUTBOX_PERSISTENCE_VERSION,
  MemoryDurableLocationOutboxStorage,
  type DurablePendingLocationCapture,
} from "../src/features/locationHistory/durableLocationOutbox.ts";
import {
  MOTION_EVIDENCE_VERSION,
  motionEvidenceIdentity,
  type CanonicalMotionEvidenceWindow,
} from "../src/features/locationHistory/motionEvidence.ts";
import { projectLocationHistoryRoute } from "../src/features/locationHistory/routeProjection.ts";
import {
  composeSelfPrivateHistory,
  selfPrivateHistoryObservationIdentity,
  type SelfPrivateHistoryEvidence,
} from "../src/features/locationHistory/selfPrivateHistory.ts";
import { SelfStayEvidenceAuthority } from "../src/features/locationHistory/selfStayEvidence.ts";
import {
  assessCurrentLocationObservation,
} from "../src/lib/locationPolicy.ts";
import { normalizeCanonicalLocationObservation } from "../src/lib/locationTelemetry.ts";

const ACCOUNT_A = "account-alpha";
const ACCOUNT_B = "account-beta";
const START_MS = Date.parse("2024-01-15T12:00:00.000Z");
const SYNTHETIC_SITE: Readonly<{ latitude: number; longitude: number }> = Object.freeze({ latitude: 10, longitude: 20 });
const SYNTHETIC_AWAY: Readonly<{ latitude: number; longitude: number }> = Object.freeze({ latitude: 10.01, longitude: 20.01 });

function point(
  offsetMs = 0,
  coordinate = SYNTHETIC_SITE,
  account = ACCOUNT_A,
  capturedAt?: string,
): LocationHistoryPoint {
  return {
    personUserId: account,
    coordinate,
    capturedAt: capturedAt ?? new Date(START_MS + offsetMs).toISOString(),
    accuracyMeters: 8,
    nativeSpeedMps: 0,
  };
}

function archiveSample(offsetMs = 0, account = ACCOUNT_A): LocationHistoryArchiveSample {
  const value = point(offsetMs, SYNTHETIC_SITE, account);
  return {
    captureIdentity: locationHistoryArchiveCaptureIdentity({
      observedAtMs: Date.parse(value.capturedAt),
      coordinate: value.coordinate,
    }),
    coordinate: value.coordinate,
    capturedAt: value.capturedAt,
    accuracyMeters: value.accuracyMeters!,
    archivePolicyVersion: LOCATION_HISTORY_ARCHIVE_POLICY_VERSION,
  };
}

function durableRecord(offsetMs = 0, account = ACCOUNT_A): DurablePendingLocationCapture {
  const sample = archiveSample(offsetMs, account);
  const capturedAtMs = Date.parse(sample.capturedAt);
  return {
    persistenceVersion: LOCATION_OUTBOX_PERSISTENCE_VERSION,
    captureIdentity: sample.captureIdentity,
    accountIdentity: account,
    subjectIdentity: account,
    capturedAtMs,
    captureSessionIdentity: `synthetic-session-${account}`,
    sample,
    enqueuedAtMs: capturedAtMs + 1_000,
  };
}

function history(
  points: readonly LocationHistoryPoint[],
  account = ACCOUNT_A,
): PersonLocationHistory {
  return {
    viewerUserId: account,
    personUserId: account,
    availability: points.length > 0 ? { state: "ready" } : { state: "empty" },
    spans: points.length > 0
      ? [{ state: "authorized", points }]
      : [{ state: "missing" }],
  };
}

test("canonical acquisition normalizes provider time once before acceptance", () => {
  const normalized = normalizeCanonicalLocationObservation({
    timestamp: START_MS + 0.75,
    coords: {
      latitude: SYNTHETIC_SITE.latitude,
      longitude: SYNTHETIC_SITE.longitude,
      accuracy: 8,
      speed: 0,
    },
  });
  assert.ok(normalized);
  assert.equal(normalized.observedAtMs, START_MS);
  assert.equal(assessCurrentLocationObservation(normalized, START_MS + 30_000).accepted, true);
});

test("foreground/background handoff never owns two continuous authorities", async () => {
  let foreground = false;
  let background = false;
  const adapter: LocationCaptureOwnershipAdapter = {
    async stopForeground() { foreground = false; },
    async startForeground() { foreground = true; },
    async stopBackground() { background = false; },
    async backgroundPermissionGranted() { return true; },
    async startBackground() { background = true; },
  };
  const coordinator = new LocationCaptureOwnershipCoordinator(adapter);

  await coordinator.reconcile({
    accountUserId: ACCOUNT_A,
    lifecycleState: "active",
    foregroundCaptureEnabled: true,
    backgroundCaptureEnabled: true,
    backgroundConsentGranted: true,
  });
  assert.deepEqual([foreground, background, coordinator.snapshot().state], [true, false, "foreground_owned"]);

  await coordinator.reconcile({
    accountUserId: ACCOUNT_A,
    lifecycleState: "background",
    foregroundCaptureEnabled: true,
    backgroundCaptureEnabled: true,
    backgroundConsentGranted: true,
  });
  assert.deepEqual([foreground, background, coordinator.snapshot().state], [false, true, "background_owned"]);

  await coordinator.reconcile({
    accountUserId: ACCOUNT_A,
    lifecycleState: "active",
    foregroundCaptureEnabled: true,
    backgroundCaptureEnabled: true,
    backgroundConsentGranted: true,
  });
  assert.deepEqual(
    [foreground, background, coordinator.snapshot().activeContinuousAuthorities, coordinator.snapshot().maximumActiveContinuousAuthorities],
    [true, false, 1, 1],
  );
});

test("durable outbox preserves chronology, recovers inflight work, and retires only acknowledged evidence", () => {
  const storage = new MemoryDurableLocationOutboxStorage();
  const later = durableRecord(60_000);
  const earlier = durableRecord(0);
  const otherAccount = durableRecord(30_000, ACCOUNT_B);
  const nowMs = START_MS + 2 * 60_000;

  assert.equal(storage.enqueue(later, nowMs).state, "enqueued");
  assert.equal(storage.enqueue(earlier, nowMs).state, "enqueued");
  assert.equal(storage.enqueue(otherAccount, nowMs).state, "enqueued");
  assert.deepEqual(
    storage.readChronologicalBatch(ACCOUNT_A, nowMs).map((row) => row.record.captureIdentity),
    [earlier.captureIdentity, later.captureIdentity],
  );

  assert.equal(storage.markInflight(ACCOUNT_A, [earlier.captureIdentity], nowMs), true);
  assert.equal(storage.recover(nowMs).staleInflightCount, 1);
  assert.equal(storage.acknowledge(ACCOUNT_A, [earlier.captureIdentity], nowMs), 1);
  assert.equal(storage.health(ACCOUNT_A).pendingCount, 1);
  assert.equal(storage.acknowledgedSamples(ACCOUNT_A, nowMs).length, 1);
  assert.equal(storage.health(ACCOUNT_B).pendingCount, 1);
  assert.equal(storage.discardAcknowledged(ACCOUNT_A, [earlier.captureIdentity]), 1);
});

test("equivalent local and server timestamp spellings have one canonical identity", () => {
  const local = point(0, SYNTHETIC_SITE, ACCOUNT_A, "2024-01-15T12:00:00.000Z");
  const remote = {
    ...local,
    sampleId: "synthetic-server-row",
    capturedAt: "2024-01-15T12:00:00+00:00",
  };
  assert.equal(
    selfPrivateHistoryObservationIdentity(local),
    selfPrivateHistoryObservationIdentity(remote),
  );

  const localEvidence: SelfPrivateHistoryEvidence = { accountUserId: ACCOUNT_A, points: [local] };
  const projection = composeSelfPrivateHistory({
    accountUserId: ACCOUNT_A,
    localEvidence,
    remoteHistory: history([remote]),
    referenceTimeMs: START_MS + 60_000,
  });
  const composedPoints = projection.history.spans.flatMap((span) => span.state === "authorized" ? span.points : []);
  assert.deepEqual([projection.localOnlyPointCount, composedPoints.length, composedPoints[0]?.sampleId], [0, 1, "synthetic-server-row"]);
});

test("local evidence cannot cross an account boundary", () => {
  const localEvidence: SelfPrivateHistoryEvidence = {
    accountUserId: ACCOUNT_A,
    points: [point()],
  };
  const projection = composeSelfPrivateHistory({
    accountUserId: ACCOUNT_B,
    localEvidence,
    remoteHistory: history([], ACCOUNT_B),
    referenceTimeMs: START_MS + 60_000,
  });
  assert.deepEqual([projection.syncState, projection.localOnlyPointCount], ["unavailable", 0]);

  const authority = new SelfStayEvidenceAuthority();
  authority.observePoint(ACCOUNT_A, point());
  authority.setAccount(ACCOUNT_B);
  assert.deepEqual([authority.snapshot().phase, authority.snapshot().currentContinuityProven], ["NO_EVIDENCE", false]);
});

test("a directly proven current stay remains ongoing across sparse stationary cadence", () => {
  const points = [point(), point(6 * 60_000)];
  const authority = new SelfStayEvidenceAuthority();
  points.forEach((value) => authority.observePoint(ACCOUNT_A, value));

  const snapshot = authority.snapshot(START_MS + 8 * 60_000);
  assert.deepEqual(
    [snapshot.phase, snapshot.currentContinuityProven, snapshot.temporalEvidence?.ongoing, snapshot.temporalEvidence?.startedAtMs],
    ["CONFIRMED_STAY", true, true, START_MS],
  );
});

test("history-only reconstruction stays conservative until an exact current durable callback", () => {
  const points = [point(), point(6 * 60_000)];
  const authority = new SelfStayEvidenceAuthority();
  authority.reconcilePoints(ACCOUNT_A, points);
  const beforeCount = authority.snapshot().locationEvidenceCount;
  assert.deepEqual(
    [authority.snapshot(START_MS + 8 * 60_000).currentContinuityProven, authority.snapshot(START_MS + 8 * 60_000).temporalEvidence?.ongoing],
    [false, false],
  );

  assert.equal(authority.observePoint(ACCOUNT_A, points[1]), true);
  assert.deepEqual(
    [authority.snapshot().locationEvidenceCount, authority.snapshot(START_MS + 8 * 60_000).temporalEvidence?.ongoing],
    [beforeCount, true],
  );
});

test("credible measured movement finalizes the confirmed current stay", () => {
  const authority = new SelfStayEvidenceAuthority();
  authority.observePoint(ACCOUNT_A, point());
  authority.observePoint(ACCOUNT_A, point(6 * 60_000));
  const movement: CanonicalMotionEvidenceWindow = {
    accountUserId: ACCOUNT_A,
    evidenceIdentity: motionEvidenceIdentity(
      START_MS + 7 * 60_000,
      START_MS + 7 * 60_000 + 5_000,
    ),
    windowStartedAtMs: START_MS + 7 * 60_000,
    windowEndedAtMs: START_MS + 7 * 60_000 + 5_000,
    durationMs: 5_000,
    pedometerAvailability: "measured",
    pedometerMeasurementSource: "expo_pedometer_interval_query",
    stepDelta: 6,
    deviceMotionAvailability: "unavailable",
    deviceMotionSampleCount: 0,
    rejectedMotionSampleCount: 0,
    motionEvidenceVersion: MOTION_EVIDENCE_VERSION,
  };

  assert.equal(authority.observeMotionEvidence(ACCOUNT_A, movement), true);
  assert.deepEqual(
    [authority.snapshot().temporalEvidence?.ongoing, authority.snapshot().finalizedBoundaryReason],
    [false, "credible_movement"],
  );
});

test("a long canonical evidence gap starts a new visit candidate", () => {
  const authority = new SelfStayEvidenceAuthority();
  authority.observePoint(ACCOUNT_A, point());
  authority.observePoint(ACCOUNT_A, point(6 * 60_000));
  authority.observePoint(ACCOUNT_A, point(37 * 60_000));
  assert.deepEqual(
    [authority.snapshot().phase, authority.snapshot().temporalEvidence?.startedAtMs, authority.snapshot().candidateResetReason],
    ["CANDIDATE_STAY_ONLY", START_MS + 37 * 60_000, "relocation_or_gap"],
  );
});

test("selected-day projection extends one ongoing stay without creating timer evidence", () => {
  const points = [point(), point(6 * 60_000)];
  const nowMs = START_MS + 8 * 60_000;
  const authority = new SelfStayEvidenceAuthority();
  points.forEach((value) => authority.observePoint(ACCOUNT_A, value));
  const sourceHistory = history(points);
  const selectedHistory = filterPersonLocationHistoryForDay(
    sourceHistory,
    locationHistoryDayKey(START_MS)!,
    nowMs,
  );
  const route = projectLocationHistoryRoute({
    personUserId: ACCOUNT_A,
    spans: selectedHistory.spans,
    referenceTimeMs: nowMs,
    retainSparseStationaryIntervals: true,
  });
  const events = projectLocationHistoryDayEventsForRoute(route, {
    selfStayEvidence: authority.snapshot(nowMs).temporalEvidence,
    referenceTimeMs: nowMs,
  });
  const stays = events.filter((event) => event.type === "stay");

  assert.deepEqual(
    [route.segments.flatMap((segment) => segment.points).length, stays.length, stays[0]?.ongoing, Date.parse(stays[0]!.endAt), Date.parse(stays[0]!.lastEvidenceAt!)],
    [2, 1, true, nowMs, START_MS + 6 * 60_000],
  );
});

test("two real stationary clusters remain two visits", () => {
  const points = [
    point(),
    point(6 * 60_000),
    point(7 * 60_000, SYNTHETIC_AWAY),
    point(13 * 60_000, SYNTHETIC_AWAY),
  ];
  const route = projectLocationHistoryRoute({
    personUserId: ACCOUNT_A,
    spans: [{ state: "authorized", points }],
    referenceTimeMs: START_MS + 14 * 60_000,
    retainSparseStationaryIntervals: true,
  });
  const events = projectLocationHistoryDayEventsForRoute(route);
  assert.equal(events.filter((event) => event.type === "stay").length, 2);
});
