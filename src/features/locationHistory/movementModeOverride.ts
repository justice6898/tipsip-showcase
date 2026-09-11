import { isExactPersonUserId } from "@/features/locationHistory/domain";
import type { LocationHistoryMovementEvent } from "@/features/locationHistory/dayPresentation";
import type { LocationHistoryConsumptionContext, LocationHistoryReadRequest } from "@/features/locationHistory/repository";

export const LOCATION_HISTORY_SELECTABLE_MOVEMENT_MODES = [
  "walking",
  "vehicle",
  "bicycle",
  "bus",
  "train",
  "airplane",
] as const;

export const LOCATION_HISTORY_LEGACY_MOVEMENT_MODES = [
  "taxi",
  "other",
] as const;

/** Persistence/read compatibility includes legacy values. New manual choices
 * are intentionally limited to LOCATION_HISTORY_SELECTABLE_MOVEMENT_MODES. */
export const LOCATION_HISTORY_MANUAL_MOVEMENT_MODES = [
  ...LOCATION_HISTORY_SELECTABLE_MOVEMENT_MODES,
  ...LOCATION_HISTORY_LEGACY_MOVEMENT_MODES,
] as const;

export type LocationHistoryInferredMovementMode = "walking" | "vehicle" | "bicycle" | "unknown";
export type LocationHistoryManualMovementMode = typeof LOCATION_HISTORY_MANUAL_MOVEMENT_MODES[number];
export type LocationHistorySelectableMovementMode = typeof LOCATION_HISTORY_SELECTABLE_MOVEMENT_MODES[number];
export type LocationHistoryEffectiveMovementMode =
  | LocationHistoryInferredMovementMode
  | LocationHistoryManualMovementMode;

export type LocationHistoryMovementModeOverride = Readonly<{
  subjectUserId: string;
  anchorSampleId: string;
  eventStartedAt: string;
  mode: LocationHistoryManualMovementMode;
}>;

export type LocationHistoryViewerMovementModeOverride = LocationHistoryMovementModeOverride & Readonly<{
  viewerUserId: string;
}>;

export type LocationHistoryMovementModeOverrideReadResult = Readonly<{
  viewerUserId: string;
  personUserId: string;
  /** Subject-owned corrections visible through the canonical history read. */
  overrides: readonly LocationHistoryMovementModeOverride[];
  /** Current viewer's private interpretations only. */
  viewerOverrides: readonly LocationHistoryViewerMovementModeOverride[];
}>;

export type LocationHistoryMovementModeOverrideWriteRequest = Readonly<{
  accountUserId: string;
  subjectUserId: string;
  anchorSampleId: string;
  eventStartedAt: string;
  mode: LocationHistoryManualMovementMode | null;
}>;

export type LocationHistoryMovementModeOverrideWriteResult =
  | { state: "saved"; override: LocationHistoryMovementModeOverride }
  | { state: "removed"; subjectUserId: string; anchorSampleId: string }
  | { state: "denied"; reason: "account_isolation" }
  | { state: "unavailable"; reason: "invalid_request" | "backend_unavailable" | "not_configured" };

export type LocationHistoryViewerMovementModeOverrideWriteRequest = Readonly<{
  accountUserId: string;
  viewerUserId: string;
  subjectUserId: string;
  anchorSampleId: string;
  eventStartedAt: string;
  mode: LocationHistoryManualMovementMode | null;
  context: LocationHistoryConsumptionContext;
  fromCapturedAt?: string;
  throughCapturedAt?: string;
}>;

export type LocationHistoryViewerMovementModeOverrideWriteResult =
  | { state: "saved"; override: LocationHistoryViewerMovementModeOverride }
  | { state: "removed"; viewerUserId: string; subjectUserId: string; anchorSampleId: string }
  | { state: "denied"; reason: "account_isolation" | "history_not_authorized" }
  | { state: "unavailable"; reason: "invalid_request" | "backend_unavailable" | "not_configured" };

export interface LocationHistoryMovementModeOverrideRepository {
  read(
    request: LocationHistoryReadRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryMovementModeOverrideReadResult>;
  writeOwn(
    request: LocationHistoryMovementModeOverrideWriteRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryMovementModeOverrideWriteResult>;
  writeViewer(
    request: LocationHistoryViewerMovementModeOverrideWriteRequest,
    signal?: AbortSignal,
  ): Promise<LocationHistoryViewerMovementModeOverrideWriteResult>;
}

export function isLocationHistoryManualMovementMode(
  value: unknown,
): value is LocationHistoryManualMovementMode {
  return typeof value === "string"
    && (LOCATION_HISTORY_MANUAL_MOVEMENT_MODES as readonly string[]).includes(value);
}

export function isLocationHistorySelectableMovementMode(
  value: unknown,
): value is LocationHistorySelectableMovementMode {
  return typeof value === "string"
    && (LOCATION_HISTORY_SELECTABLE_MOVEMENT_MODES as readonly string[]).includes(value);
}

/** Resolves the six-choice dialog selection without exposing unknown/other.
 * Legacy taxi reads as Vehicle; legacy other remains an unselected fallback. */
export function selectableLocationHistoryMovementMode(input: {
  inferredMode: LocationHistoryInferredMovementMode;
  currentOverride: LocationHistoryManualMovementMode | null;
}): LocationHistorySelectableMovementMode | null {
  if (input.currentOverride === "taxi") return "vehicle";
  if (isLocationHistorySelectableMovementMode(input.currentOverride)) return input.currentOverride;
  return isLocationHistorySelectableMovementMode(input.inferredMode) ? input.inferredMode : null;
}

/** Selecting the inferred supported mode is the natural return-to-detected
 * operation and therefore clears a redundant persisted correction. */
export function persistedLocationHistoryMovementModeForSelection(input: {
  inferredMode: LocationHistoryInferredMovementMode;
  selectedMode: LocationHistorySelectableMovementMode;
}): LocationHistoryManualMovementMode | null {
  return input.selectedMode === input.inferredMode ? null : input.selectedMode;
}

export function locationHistoryMovementAnchor(
  event: LocationHistoryMovementEvent,
): Readonly<{ subjectUserId: string; anchorSampleId: string; eventStartedAt: string }> | null {
  const first = event.points[0];
  if (
    !first
    || event.points.some((point) => point.personUserId !== first.personUserId)
    || !isExactPersonUserId(first.sampleId)
    || first.capturedAt !== event.startAt
  ) return null;
  return {
    subjectUserId: first.personUserId,
    anchorSampleId: first.sampleId,
    eventStartedAt: event.startAt,
  };
}

export function locationHistoryMovementModeOverrideIdentity(
  value: Pick<LocationHistoryMovementModeOverride, "subjectUserId" | "anchorSampleId">,
): string {
  return `${value.subjectUserId}:movement-anchor:${value.anchorSampleId}`;
}

export function locationHistoryViewerMovementModeOverrideIdentity(
  value: Pick<LocationHistoryViewerMovementModeOverride, "viewerUserId" | "subjectUserId" | "anchorSampleId">,
): string {
  return `${value.viewerUserId}:viewer:${value.subjectUserId}:movement-anchor:${value.anchorSampleId}`;
}

export function matchingLocationHistoryMovementModeOverride(
  event: LocationHistoryMovementEvent,
  overrides: readonly LocationHistoryMovementModeOverride[],
): LocationHistoryMovementModeOverride | null {
  const anchor = locationHistoryMovementAnchor(event);
  if (!anchor) return null;
  return overrides.find((override) => (
    override.subjectUserId === anchor.subjectUserId
    && override.anchorSampleId === anchor.anchorSampleId
    && override.eventStartedAt === anchor.eventStartedAt
    && isLocationHistoryManualMovementMode(override.mode)
  )) ?? null;
}

export function matchingLocationHistoryViewerMovementModeOverride(
  event: LocationHistoryMovementEvent,
  viewerUserId: string,
  overrides: readonly LocationHistoryViewerMovementModeOverride[],
): LocationHistoryViewerMovementModeOverride | null {
  const anchor = locationHistoryMovementAnchor(event);
  if (!anchor || viewerUserId === anchor.subjectUserId) return null;
  return overrides.find((override) => (
    override.viewerUserId === viewerUserId
    && override.subjectUserId === anchor.subjectUserId
    && override.anchorSampleId === anchor.anchorSampleId
    && override.eventStartedAt === anchor.eventStartedAt
    && isLocationHistoryManualMovementMode(override.mode)
  )) ?? null;
}

export function effectiveLocationHistoryMovementMode(
  inferredMode: LocationHistoryInferredMovementMode,
  subjectOwnedOverride: LocationHistoryMovementModeOverride | null | undefined,
  viewerScopedOverride?: LocationHistoryViewerMovementModeOverride | null,
): LocationHistoryEffectiveMovementMode {
  return viewerScopedOverride?.mode ?? subjectOwnedOverride?.mode ?? inferredMode;
}

export function validLocationHistoryViewerMovementModeOverrideWrite(
  request: LocationHistoryViewerMovementModeOverrideWriteRequest,
): boolean {
  const from = request.fromCapturedAt === undefined ? Number.NEGATIVE_INFINITY : Date.parse(request.fromCapturedAt);
  const through = request.throughCapturedAt === undefined ? Number.POSITIVE_INFINITY : Date.parse(request.throughCapturedAt);
  return isExactPersonUserId(request.accountUserId)
    && request.accountUserId === request.viewerUserId
    && request.viewerUserId !== request.subjectUserId
    && isExactPersonUserId(request.subjectUserId)
    && isExactPersonUserId(request.anchorSampleId)
    && Number.isFinite(Date.parse(request.eventStartedAt))
    && (request.context.type === "friend" || isExactPersonUserId(request.context.groupId))
    && (Number.isFinite(from) || from === Number.NEGATIVE_INFINITY)
    && (Number.isFinite(through) || through === Number.POSITIVE_INFINITY)
    && from <= through
    && (request.mode === null || isLocationHistoryManualMovementMode(request.mode));
}

export function validLocationHistoryMovementModeOverrideWrite(
  request: LocationHistoryMovementModeOverrideWriteRequest,
): boolean {
  return isExactPersonUserId(request.accountUserId)
    && request.accountUserId === request.subjectUserId
    && isExactPersonUserId(request.anchorSampleId)
    && Number.isFinite(Date.parse(request.eventStartedAt))
    && (request.mode === null || isLocationHistoryManualMovementMode(request.mode));
}

export class DisabledLocationHistoryMovementModeOverrideRepository
implements LocationHistoryMovementModeOverrideRepository {
  async read(request: LocationHistoryReadRequest): Promise<LocationHistoryMovementModeOverrideReadResult> {
    return { viewerUserId: request.viewerUserId, personUserId: request.personUserId, overrides: [], viewerOverrides: [] };
  }

  async writeOwn(
    request: LocationHistoryMovementModeOverrideWriteRequest,
  ): Promise<LocationHistoryMovementModeOverrideWriteResult> {
    if (request.accountUserId !== request.subjectUserId) return { state: "denied", reason: "account_isolation" };
    if (!validLocationHistoryMovementModeOverrideWrite(request)) return { state: "unavailable", reason: "invalid_request" };
    return { state: "unavailable", reason: "not_configured" };
  }

  async writeViewer(
    request: LocationHistoryViewerMovementModeOverrideWriteRequest,
  ): Promise<LocationHistoryViewerMovementModeOverrideWriteResult> {
    if (request.accountUserId !== request.viewerUserId) return { state: "denied", reason: "account_isolation" };
    if (!validLocationHistoryViewerMovementModeOverrideWrite(request)) return { state: "unavailable", reason: "invalid_request" };
    return { state: "unavailable", reason: "not_configured" };
  }
}
