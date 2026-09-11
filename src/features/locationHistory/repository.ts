import {
  isExactPersonUserId,
  orderedLocationHistoryPoints,
  type LocationHistoryAvailability,
  type LocationHistoryDenialReason,
  type LocationHistoryPoint,
  type LocationHistoryUnavailableReason,
  type PersonLocationHistory,
} from "@/features/locationHistory/domain";

export type LocationHistoryConsumptionContext =
  | { type: "friend" }
  | { type: "group"; groupId: string };

export type LocationHistoryReadRequest = {
  viewerUserId: string;
  personUserId: string;
  context: LocationHistoryConsumptionContext;
  fromCapturedAt?: string;
  throughCapturedAt?: string;
};

export type LocationHistoryReadAuthorityDecision =
  | { state: "authorized"; viewerUserId: string; personUserId: string }
  | { state: "denied"; viewerUserId: string; personUserId: string; reason: LocationHistoryDenialReason }
  | { state: "unavailable"; viewerUserId: string; personUserId: string; reason: LocationHistoryUnavailableReason };

/**
 * Adapter boundary for the existing live-location authority. Implementations
 * must consult current friendship/block/group/privacy state on every read.
 */
export interface LocationHistoryReadAuthority {
  authorizeHistoryRead(
    request: LocationHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryReadAuthorityDecision>;
}

export interface LocationHistoryRepository {
  read(
    request: LocationHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<PersonLocationHistory>;
}

function closedResult(
  request: LocationHistoryReadRequest,
  availability: LocationHistoryAvailability,
): PersonLocationHistory {
  return {
    viewerUserId: request.viewerUserId,
    personUserId: request.personUserId,
    availability,
    spans: availability.state === "denied"
      ? [{ state: "denied", reason: availability.reason }]
      : [{ state: "missing" }],
  };
}

function validWindow(request: LocationHistoryReadRequest): boolean {
  const from = request.fromCapturedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.fromCapturedAt);
  const through = request.throughCapturedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(request.throughCapturedAt);
  return Number.isFinite(from) || from === Number.NEGATIVE_INFINITY
    ? (Number.isFinite(through) || through === Number.POSITIVE_INFINITY) && from <= through
    : false;
}

/** Deterministic test/development reader. Constructor fixtures are not a write API. */
export class DeterministicLocationHistoryRepository implements LocationHistoryRepository {
  private readonly points: readonly LocationHistoryPoint[];

  constructor(
    points: readonly LocationHistoryPoint[],
    private readonly authority: LocationHistoryReadAuthority,
    private readonly referenceTimeMs: number = Date.now(),
  ) {
    this.points = points.map((point) => ({
      ...point,
      coordinate: { ...point.coordinate },
    }));
  }

  async read(
    request: LocationHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<PersonLocationHistory> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      !isExactPersonUserId(request.viewerUserId)
      || !isExactPersonUserId(request.personUserId)
      || (request.context.type === "group" && !isExactPersonUserId(request.context.groupId))
      || !validWindow(request)
    ) {
      return closedResult(request, { state: "unavailable", reason: "invalid_request" });
    }

    const decision = await this.authority.authorizeHistoryRead(request, signal);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      decision.viewerUserId !== request.viewerUserId
      || decision.personUserId !== request.personUserId
    ) {
      return closedResult(request, { state: "unavailable", reason: "authority_identity_mismatch" });
    }
    if (decision.state === "denied") {
      return closedResult(request, { state: "denied", reason: decision.reason });
    }
    if (decision.state === "unavailable") {
      return closedResult(request, { state: "unavailable", reason: decision.reason });
    }

    const from = request.fromCapturedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.fromCapturedAt);
    const through = request.throughCapturedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(request.throughCapturedAt);
    const points = orderedLocationHistoryPoints(this.points, request.personUserId, this.referenceTimeMs)
      .filter((point) => {
        const capturedAt = Date.parse(point.capturedAt);
        return capturedAt >= from && capturedAt <= through;
      });
    if (points.length === 0) {
      return closedResult(request, { state: "empty" });
    }
    return {
      viewerUserId: request.viewerUserId,
      personUserId: request.personUserId,
      availability: { state: "ready" },
      spans: [{ state: "authorized", points }],
    };
  }
}

/** Runtime-safe reader until an owner-approved history backend exists. */
export class UnconfiguredLocationHistoryRepository implements LocationHistoryRepository {
  constructor(private readonly authority: LocationHistoryReadAuthority) {}

  async read(
    request: LocationHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<PersonLocationHistory> {
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      !isExactPersonUserId(request.viewerUserId)
      || !isExactPersonUserId(request.personUserId)
      || (request.context.type === "group" && !isExactPersonUserId(request.context.groupId))
      || !validWindow(request)
    ) {
      return closedResult(request, { state: "unavailable", reason: "invalid_request" });
    }
    const decision = await this.authority.authorizeHistoryRead(request, signal);
    if (signal?.aborted) throw new DOMException("The operation was aborted.", "AbortError");
    if (
      decision.viewerUserId !== request.viewerUserId
      || decision.personUserId !== request.personUserId
    ) {
      return closedResult(request, { state: "unavailable", reason: "authority_identity_mismatch" });
    }
    if (decision.state === "denied") {
      return closedResult(request, { state: "denied", reason: decision.reason });
    }
    if (decision.state === "unavailable") {
      return closedResult(request, { state: "unavailable", reason: decision.reason });
    }
    return closedResult(request, { state: "unavailable", reason: "history_not_configured" });
  }
}
