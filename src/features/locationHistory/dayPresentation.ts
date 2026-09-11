import {
  locationHistoryPointIdentity,
  orderedLocationHistoryPoints,
  type LocationHistoryPoint,
  type LocationHistorySpan,
  type PersonLocationHistory,
} from "@/features/locationHistory/domain";
import {
  DEFAULT_HISTORY_ROUTE_GAP_MS,
  projectLocationHistoryRoute,
  type LocationHistoryRoute,
} from "@/features/locationHistory/routeProjection";
import { calculateCanonicalRouteDistance } from "@/features/locationHistory/mobilityKinematics";
import type { SelfStayTemporalEvidence } from "@/features/locationHistory/selfStayEvidence";
import { selfPrivateHistoryObservationIdentity } from "@/features/locationHistory/selfPrivateHistory";
import { haversineDistanceMeters } from "@/lib/geoDistance";
import { CURRENT_LOCATION_MAX_AGE_MS } from "@/lib/locationPolicy";

const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Presentation-only thresholds. They classify an authorized route without
 * claiming travel mode or place identity. Accuracy-aware stay clustering keeps
 * normal GPS jitter from becoming movement. */
export const LOCATION_HISTORY_EVENT_THRESHOLDS = Object.freeze({
  stayMinimumDurationMs: 5 * 60_000,
  stayMinimumSamples: 2,
  stayRadiusMeters: 40,
  maximumAccuracyAllowanceMeters: 25,
  movementMinimumDistanceMeters: 30,
  routeGapMs: DEFAULT_HISTORY_ROUTE_GAP_MS,
});

export type LocationHistoryDayBounds = Readonly<{
  dayKey: string;
  startMs: number;
  endMs: number;
}>;

type EventBase = Readonly<{
  id: string;
  startAt: string;
  endAt: string;
  durationMs: number;
}>;

export type LocationHistoryMovementEvent = EventBase & Readonly<{
  type: "movement";
  distanceMeters: number;
  points: readonly LocationHistoryPoint[];
  startCoordinate: LocationHistoryPoint["coordinate"];
  endCoordinate: LocationHistoryPoint["coordinate"];
  selectionPoint: LocationHistoryPoint;
}>;

export type LocationHistoryStayEvent = EventBase & Readonly<{
  type: "stay";
  points: readonly LocationHistoryPoint[];
  representativeCoordinate: LocationHistoryPoint["coordinate"];
  selectionPoint: LocationHistoryPoint;
  /** Present only while a fresh, durably accepted self observation supports
   * the final cluster. endAt/durationMs are then a read-time projection; no
   * repeatedly rewritten duration text is persisted. */
  ongoing?: true;
  lastEvidenceAt?: string;
}>;

export type LocationHistoryGapEvent = EventBase & Readonly<{
  type: "gap";
  reason: "temporal_gap" | "unavailable_span";
  selectionPoint: null;
}>;

export type LocationHistoryRecordEvent = EventBase & Readonly<{
  type: "record";
  point: LocationHistoryPoint;
  selectionPoint: LocationHistoryPoint;
}>;

export type LocationHistoryDayEvent =
  | LocationHistoryMovementEvent
  | LocationHistoryStayEvent
  | LocationHistoryGapEvent
  | LocationHistoryRecordEvent;

function localDayKey(timestampMs: number): string {
  const date = new Date(timestampMs);
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("-");
}

export function locationHistoryDayKey(value: Date | number | string): string | null {
  const timestampMs = value instanceof Date ? value.getTime() : typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(timestampMs) ? localDayKey(timestampMs) : null;
}

export function locationHistoryDayBounds(dayKey: string): LocationHistoryDayBounds | null {
  const match = DAY_KEY_PATTERN.exec(dayKey);
  if (!match) return null;
  const start = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), 0, 0, 0, 0);
  if (
    start.getFullYear() !== Number(match[1])
    || start.getMonth() !== Number(match[2]) - 1
    || start.getDate() !== Number(match[3])
  ) return null;
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { dayKey, startMs: start.getTime(), endMs: end.getTime() };
}

export function shiftLocationHistoryDayKey(dayKey: string, offset: number): string | null {
  const bounds = locationHistoryDayBounds(dayKey);
  if (!bounds || !Number.isInteger(offset)) return null;
  const date = new Date(bounds.startMs);
  date.setDate(date.getDate() + offset);
  return localDayKey(date.getTime());
}

export function locationHistoryAccessibleDayRange(input: {
  fromCapturedAt: string | null;
  nowMs: number;
}): Readonly<{ earliestDayKey: string; latestDayKey: string }> {
  const latestDayKey = localDayKey(Number.isFinite(input.nowMs) ? input.nowMs : Date.now());
  const fromMs = input.fromCapturedAt ? Date.parse(input.fromCapturedAt) : Number.NaN;
  return {
    earliestDayKey: Number.isFinite(fromMs) ? localDayKey(fromMs) : latestDayKey,
    latestDayKey,
  };
}

export function filterPersonLocationHistoryForDay(
  history: PersonLocationHistory,
  dayKey: string,
  referenceTimeMs = Date.now(),
): PersonLocationHistory {
  if (history.availability.state === "denied" || history.availability.state === "unavailable") {
    return history;
  }
  const bounds = locationHistoryDayBounds(dayKey);
  if (!bounds) {
    return { ...history, availability: { state: "unavailable", reason: "invalid_request" }, spans: [{ state: "missing" }] };
  }
  const spans: LocationHistorySpan[] = [];
  for (const span of history.spans) {
    if (span.state !== "authorized") {
      if (spans.length > 0) spans.push(span);
      continue;
    }
    const points = orderedLocationHistoryPoints(span.points, history.personUserId, referenceTimeMs).filter((point) => {
      const timestampMs = Date.parse(point.capturedAt);
      return timestampMs >= bounds.startMs && timestampMs < bounds.endMs;
    });
    if (points.length > 0) spans.push({ state: "authorized", points });
  }
  const pointCount = spans.reduce((count, span) => count + (span.state === "authorized" ? span.points.length : 0), 0);
  return {
    ...history,
    availability: pointCount > 0 ? { state: "ready" } : { state: "empty" },
    spans: pointCount > 0 ? spans : [{ state: "missing" }],
  };
}

function distanceAcross(points: readonly LocationHistoryPoint[]): number {
  const personUserId = points[0]?.personUserId;
  return personUserId ? calculateCanonicalRouteDistance(personUserId, points, "day-presentation") : 0;
}

function representativePoint(points: readonly LocationHistoryPoint[]): LocationHistoryPoint {
  return points[Math.floor((points.length - 1) / 2)];
}

function eventId(type: LocationHistoryDayEvent["type"], points: readonly LocationHistoryPoint[]): string {
  return `${type}:${locationHistoryPointIdentity(points[0])}:${locationHistoryPointIdentity(points[points.length - 1])}`;
}

function stayEventId(points: readonly LocationHistoryPoint[]): string {
  // The first canonical observation owns visit identity. The provider-neutral
  // identity survives local-to-server sample replacement, while later
  // continuation points can extend the visit without remounting it as new.
  return `stay:${selfPrivateHistoryObservationIdentity(points[0])}`;
}

function createMovementOrRecord(points: readonly LocationHistoryPoint[]): LocationHistoryMovementEvent | LocationHistoryRecordEvent {
  const distanceMeters = distanceAcross(points);
  const first = points[0];
  const last = points[points.length - 1];
  if (points.length > 1 && distanceMeters >= LOCATION_HISTORY_EVENT_THRESHOLDS.movementMinimumDistanceMeters) {
    return {
      type: "movement",
      id: eventId("movement", points),
      startAt: first.capturedAt,
      endAt: last.capturedAt,
      durationMs: Math.max(0, Date.parse(last.capturedAt) - Date.parse(first.capturedAt)),
      distanceMeters,
      points,
      startCoordinate: first.coordinate,
      endCoordinate: last.coordinate,
      selectionPoint: last,
    };
  }
  return {
    type: "record",
    id: eventId("record", [last]),
    startAt: last.capturedAt,
    endAt: last.capturedAt,
    durationMs: 0,
    point: last,
    selectionPoint: last,
  };
}

type StayRange = Readonly<{
  start: number;
  end: number;
  corroboratedThroughMs?: number;
  supplementalEvidence?: SelfStayTemporalEvidence;
}>;

function coalesceStayRangesWithoutCanonicalBoundary(
  points: readonly LocationHistoryPoint[],
  ranges: readonly StayRange[],
): StayRange[] {
  const result: StayRange[] = [];
  for (const range of ranges) {
    const previous = result[result.length - 1];
    if (!previous) {
      result.push(range);
      continue;
    }
    const boundary = createMovementOrRecord(points.slice(previous.end, range.start + 1));
    if (boundary.type === "movement") {
      result.push(range);
      continue;
    }
    // Transport, runtime recreation, and slow in-radius drift are not visit
    // boundaries. Until canonical movement evidence exists, retain one logical
    // stay identity anchored at the first durable point.
    const supplementalEvidence = range.supplementalEvidence ?? previous.supplementalEvidence;
    const corroboratedThroughMs = Math.max(
      previous.corroboratedThroughMs ?? Date.parse(points[previous.end].capturedAt),
      range.corroboratedThroughMs ?? Date.parse(points[range.end].capturedAt),
    );
    result[result.length - 1] = {
      start: previous.start,
      end: range.end,
      ...(supplementalEvidence ? { supplementalEvidence, corroboratedThroughMs } : {}),
    };
  }
  return result;
}

function findStayRanges(
  points: readonly LocationHistoryPoint[],
  selfStayEvidence?: SelfStayTemporalEvidence,
): StayRange[] {
  const ranges: StayRange[] = [];
  let start = 0;
  while (start < points.length) {
    let end = start;
    const anchor = points[start];
    while (end + 1 < points.length) {
      const candidate = points[end + 1];
      const accuracyAllowance = Math.min(
        LOCATION_HISTORY_EVENT_THRESHOLDS.maximumAccuracyAllowanceMeters,
        Math.max(anchor.accuracyMeters ?? 0, candidate.accuracyMeters ?? 0),
      );
      if (haversineDistanceMeters(anchor.coordinate, candidate.coordinate) > LOCATION_HISTORY_EVENT_THRESHOLDS.stayRadiusMeters + accuracyAllowance) break;
      end += 1;
    }
    const matchingSupplementalEvidence = selfStayEvidence?.state === "confirmed"
      && selfStayEvidence.anchorPointIdentity === selfPrivateHistoryObservationIdentity(anchor)
      ? selfStayEvidence
      : undefined;
    const corroboratedThroughMs = matchingSupplementalEvidence
      ? Math.max(Date.parse(points[end].capturedAt), matchingSupplementalEvidence.corroboratedThroughMs)
      : Date.parse(points[end].capturedAt);
    const durationMs = corroboratedThroughMs - Date.parse(anchor.capturedAt);
    if (
      (end - start + 1 >= LOCATION_HISTORY_EVENT_THRESHOLDS.stayMinimumSamples || matchingSupplementalEvidence)
      && durationMs >= LOCATION_HISTORY_EVENT_THRESHOLDS.stayMinimumDurationMs
    ) {
      ranges.push({
        start,
        end,
        ...(matchingSupplementalEvidence ? {
          corroboratedThroughMs,
          supplementalEvidence: matchingSupplementalEvidence,
        } : {}),
      });
      start = end + 1;
    } else {
      start += 1;
    }
  }
  return coalesceStayRangesWithoutCanonicalBoundary(points, ranges);
}

type LocationHistoryOngoingStayEvidence = Readonly<{
  pointIdentity: string;
  referenceTimeMs: number;
}>;

function eventsForSegment(
  points: readonly LocationHistoryPoint[],
  ongoingEvidence?: LocationHistoryOngoingStayEvidence,
  selfStayEvidence?: SelfStayTemporalEvidence,
  referenceTimeMs?: number,
): LocationHistoryDayEvent[] {
  if (points.length === 0) return [];
  if (
    points.length === 1
    && !(selfStayEvidence?.state === "confirmed"
      && selfStayEvidence.anchorPointIdentity === selfPrivateHistoryObservationIdentity(points[0]))
  ) return [createMovementOrRecord(points)];
  const stays = findStayRanges(points, selfStayEvidence);
  if (stays.length === 0) return [createMovementOrRecord(points)];
  const events: LocationHistoryDayEvent[] = [];
  let movementStart = 0;
  for (const stay of stays) {
    if (stay.start > movementStart) {
      events.push(createMovementOrRecord(points.slice(movementStart, stay.start + 1)));
    }
    const stayPoints = points.slice(stay.start, stay.end + 1);
    const first = stayPoints[0];
    const last = stayPoints[stayPoints.length - 1];
    const representative = representativePoint(stayPoints);
    const supplementalOngoing = Boolean(
      stay.supplementalEvidence?.ongoing
      && stay.end === points.length - 1,
    );
    const ongoing = supplementalOngoing || Boolean(
      ongoingEvidence
      && stay.end === points.length - 1
      && selfPrivateHistoryObservationIdentity(last) === ongoingEvidence.pointIdentity
      && ongoingEvidence.referenceTimeMs >= Date.parse(last.capturedAt)
      && ongoingEvidence.referenceTimeMs - Date.parse(last.capturedAt) <= CURRENT_LOCATION_MAX_AGE_MS,
    );
    const evidenceEndAtMs = stay.corroboratedThroughMs ?? Date.parse(last.capturedAt);
    const projectedEndAt = ongoing
      ? new Date(ongoingEvidence?.referenceTimeMs ?? referenceTimeMs ?? evidenceEndAtMs).toISOString()
      : new Date(evidenceEndAtMs).toISOString();
    events.push({
      type: "stay",
      id: stayEventId(stayPoints),
      startAt: first.capturedAt,
      endAt: projectedEndAt,
      durationMs: Math.max(0, Date.parse(projectedEndAt) - Date.parse(first.capturedAt)),
      points: stayPoints,
      representativeCoordinate: representative.coordinate,
      selectionPoint: representative,
      ...(ongoing ? {
        ongoing: true as const,
        lastEvidenceAt: new Date(evidenceEndAtMs).toISOString(),
      } : {}),
    });
    movementStart = stay.end;
  }
  if (movementStart < points.length - 1) {
    events.push(createMovementOrRecord(points.slice(movementStart)));
  }
  return events;
}

export function projectLocationHistoryDayEvents(input: {
  personUserId: string;
  spans: readonly LocationHistorySpan[];
  ongoingPointIdentity?: string | null;
  referenceTimeMs?: number;
  selfStayEvidence?: SelfStayTemporalEvidence | null;
}): LocationHistoryDayEvent[] {
  const route = projectLocationHistoryRoute({
    personUserId: input.personUserId,
    spans: input.spans,
    referenceTimeMs: input.referenceTimeMs,
  });
  return projectLocationHistoryDayEventsForRoute(route, {
    ongoingPointIdentity: input.ongoingPointIdentity,
    referenceTimeMs: input.referenceTimeMs,
    selfStayEvidence: input.selfStayEvidence,
  });
}

/** Reuses an already normalized continuity projection. Canonical selected-day
 * presentation calls this so event segmentation never projects the route twice. */
export function projectLocationHistoryDayEventsForRoute(
  route: LocationHistoryRoute,
  input?: Readonly<{
    ongoingPointIdentity?: string | null;
    referenceTimeMs?: number;
    selfStayEvidence?: SelfStayTemporalEvidence | null;
  }>,
): LocationHistoryDayEvent[] {
  const events: LocationHistoryDayEvent[] = [];
  const ongoingEvidence = input?.ongoingPointIdentity
    && typeof input.referenceTimeMs === "number"
    && Number.isFinite(input.referenceTimeMs)
    ? { pointIdentity: input.ongoingPointIdentity, referenceTimeMs: input.referenceTimeMs! }
    : undefined;
  const segments = route.segments.reduce<LocationHistoryRoute["segments"][number][]>((canonical, segment) => {
    const previous = canonical[canonical.length - 1];
    const previousLast = previous?.points.at(-1);
    const nextFirst = segment.points[0];
    if (
      previousLast
      && nextFirst
      && selfPrivateHistoryObservationIdentity(previousLast)
        === selfPrivateHistoryObservationIdentity(nextFirst)
    ) {
      // An unavailable-span container boundary is not a visit boundary when
      // both sides retain the exact same canonical observation. Do not infer
      // continuity from place/address/cluster similarity or a nearby time.
      canonical[canonical.length - 1] = {
        points: [...previous.points, ...segment.points.slice(1)],
      };
    } else {
      canonical.push(segment);
    }
    return canonical;
  }, []);
  segments.forEach((segment, segmentIndex) => {
    if (segmentIndex > 0) {
      const previous = segments[segmentIndex - 1].points.at(-1);
      const next = segment.points[0];
      if (previous && next) {
        const durationMs = Math.max(0, Date.parse(next.capturedAt) - Date.parse(previous.capturedAt));
        events.push({
          type: "gap",
          id: `gap:${locationHistoryPointIdentity(previous)}:${locationHistoryPointIdentity(next)}`,
          startAt: previous.capturedAt,
          endAt: next.capturedAt,
          durationMs,
          reason: durationMs > LOCATION_HISTORY_EVENT_THRESHOLDS.routeGapMs ? "temporal_gap" : "unavailable_span",
          selectionPoint: null,
        });
      }
    }
    events.push(...eventsForSegment(
      segment.points,
      ongoingEvidence,
      input?.selfStayEvidence ?? undefined,
      input?.referenceTimeMs,
    ));
  });
  return events.sort((left, right) => Date.parse(left.startAt) - Date.parse(right.startAt));
}

export function locationHistoryEventContainsPoint(
  event: LocationHistoryDayEvent,
  point: LocationHistoryPoint | null,
): boolean {
  if (!point || event.type === "gap") return false;
  const identity = locationHistoryPointIdentity(point);
  if (event.type === "record") return locationHistoryPointIdentity(event.point) === identity;
  return event.points.some((candidate) => locationHistoryPointIdentity(candidate) === identity);
}
