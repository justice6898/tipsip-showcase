import { LOCATION_HISTORY_REPLAY_MAX_AGE_MS } from "@/features/locationHistory/captureContract";
import { isExactPersonUserId } from "@/features/locationHistory/domain";
import { assessLocationObservationWithinAge, type AcceptedCurrentLocationObservation } from "@/lib/locationPolicy";
import {
  normalizeCanonicalLocationObservation,
  type NativeLocationObservationInput,
} from "@/lib/locationTelemetry";

export const BACKGROUND_LOCATION_TASK_NAME = "tipsip.location-history.background.v1";

/** Fixed REST-equivalent policy until a later explicitly consented product
 * phase can safely coordinate dynamic background sampling. It does not create
 * a second motion/transport classifier. */
export const BACKGROUND_LOCATION_CAPTURE_POLICY = Object.freeze({
  accuracy: "balanced" as const,
  timeIntervalMs: 15_000,
  distanceIntervalMeters: 25,
  deferredUpdatesIntervalMs: 15_000,
  deferredUpdatesDistanceMeters: 25,
  maximumLocationsPerTaskInvocation: 100,
  maximumObservationAgeMs: LOCATION_HISTORY_REPLAY_MAX_AGE_MS,
});

export const BACKGROUND_LOCATION_AUTHORITY_VERSION = 1 as const;

export type BackgroundLocationAuthorityRecord = Readonly<{
  version: typeof BACKGROUND_LOCATION_AUTHORITY_VERSION;
  accountUserId: string;
  generationIdentity: string;
  captureSessionIdentity: string;
  sharingEnabled: true;
  explicitBackgroundConsent: true;
  activatedAtMs: number;
}>;

export function decodeBackgroundLocationAuthorityRecord(
  value: unknown,
): BackgroundLocationAuthorityRecord | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<BackgroundLocationAuthorityRecord>;
  if (
    candidate.version !== BACKGROUND_LOCATION_AUTHORITY_VERSION
    || !isExactPersonUserId(candidate.accountUserId)
    || typeof candidate.generationIdentity !== "string"
    || candidate.generationIdentity.length < 8
    || typeof candidate.captureSessionIdentity !== "string"
    || candidate.captureSessionIdentity.length < 8
    || candidate.sharingEnabled !== true
    || candidate.explicitBackgroundConsent !== true
    || typeof candidate.activatedAtMs !== "number"
    || !Number.isFinite(candidate.activatedAtMs)
    || candidate.activatedAtMs <= 0
  ) return null;
  return candidate as BackgroundLocationAuthorityRecord;
}

export type LocationCaptureOwnershipState =
  | "foreground_owned"
  | "transitioning_to_background"
  | "background_owned"
  | "transitioning_to_foreground"
  | "suspended_no_permission"
  | "suspended_no_account"
  | "suspended_sharing_disabled"
  | "suspended_consent_required"
  | "suspended_inactive"
  | "failed";

export type LocationCaptureLifecycleState = "active" | "inactive" | "background";

export type LocationCaptureOwnershipInput = Readonly<{
  accountUserId: string | null;
  lifecycleState: LocationCaptureLifecycleState;
  foregroundCaptureEnabled: boolean;
  backgroundCaptureEnabled: boolean;
  backgroundConsentGranted: boolean;
}>;

export interface LocationCaptureOwnershipAdapter {
  stopForeground(): Promise<void>;
  startForeground(accountUserId: string): Promise<void>;
  stopBackground(): Promise<void>;
  backgroundPermissionGranted(): Promise<boolean>;
  startBackground(accountUserId: string, generationIdentity: string): Promise<void>;
}

export type LocationCaptureOwnershipSnapshot = Readonly<{
  state: LocationCaptureOwnershipState;
  generation: number;
  accountUserId: string | null;
  activeContinuousAuthorities: number;
  maximumActiveContinuousAuthorities: number;
  staleCompletionCount: number;
}>;

/** The sole foreground/background continuous-location ownership authority.
 * Every transition is serialized, stop-before-start, generation checked, and
 * idempotent against the latest desired lifecycle state. */
export class LocationCaptureOwnershipCoordinator {
  private desired: LocationCaptureOwnershipInput = {
    accountUserId: null,
    lifecycleState: "inactive",
    foregroundCaptureEnabled: false,
    backgroundCaptureEnabled: false,
    backgroundConsentGranted: false,
  };
  private generation = 0;
  private chain = Promise.resolve();
  private state: LocationCaptureOwnershipState = "suspended_no_account";
  private accountUserId: string | null = null;
  private foregroundOwned = false;
  private backgroundOwned = false;
  private backgroundOwnershipKnown = false;
  private maximumActiveContinuousAuthorities = 0;
  private staleCompletionCount = 0;

  constructor(private readonly adapter: LocationCaptureOwnershipAdapter) {}

  reconcile(input: LocationCaptureOwnershipInput): Promise<void> {
    this.desired = { ...input };
    const generation = ++this.generation;
    this.chain = this.chain.then(() => this.apply(generation)).catch(() => {
      if (generation === this.generation) this.state = "failed";
    });
    return this.chain;
  }

  stop(): Promise<void> {
    return this.reconcile({
      accountUserId: null,
      lifecycleState: "inactive",
      foregroundCaptureEnabled: false,
      backgroundCaptureEnabled: false,
      backgroundConsentGranted: false,
    });
  }

  snapshot(): LocationCaptureOwnershipSnapshot {
    return {
      state: this.state,
      generation: this.generation,
      accountUserId: this.accountUserId,
      activeContinuousAuthorities: Number(this.foregroundOwned) + Number(this.backgroundOwned),
      maximumActiveContinuousAuthorities: this.maximumActiveContinuousAuthorities,
      staleCompletionCount: this.staleCompletionCount,
    };
  }

  private current(generation: number): boolean {
    return generation === this.generation;
  }

  private noteActiveCount(): void {
    this.maximumActiveContinuousAuthorities = Math.max(
      this.maximumActiveContinuousAuthorities,
      Number(this.foregroundOwned) + Number(this.backgroundOwned),
    );
  }

  private async stopForeground(): Promise<void> {
    this.foregroundOwned = false;
    await this.adapter.stopForeground();
  }

  private async stopBackground(force = false): Promise<void> {
    if (!force && this.backgroundOwnershipKnown && !this.backgroundOwned) return;
    this.backgroundOwned = false;
    await this.adapter.stopBackground();
    this.backgroundOwnershipKnown = true;
  }

  private async apply(generation: number): Promise<void> {
    const input = this.desired;
    const stale = async () => {
      if (this.current(generation)) return false;
      this.staleCompletionCount += 1;
      await this.stopForeground();
      await this.stopBackground(true);
      return true;
    };

    if (!input.accountUserId) {
      await this.stopForeground();
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = null;
      this.state = "suspended_no_account";
      return;
    }
    if (!input.foregroundCaptureEnabled) {
      await this.stopForeground();
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = input.accountUserId;
      this.state = "suspended_sharing_disabled";
      return;
    }
    if (input.lifecycleState === "active") {
      this.state = "transitioning_to_foreground";
      await this.stopBackground();
      if (await stale()) return;
      await this.adapter.startForeground(input.accountUserId);
      if (await stale()) return;
      this.foregroundOwned = true;
      this.backgroundOwned = false;
      this.accountUserId = input.accountUserId;
      this.state = "foreground_owned";
      this.noteActiveCount();
      return;
    }
    await this.stopForeground();
    if (await stale()) return;
    if (input.lifecycleState === "inactive") {
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = input.accountUserId;
      this.state = "suspended_inactive";
      return;
    }
    if (!input.backgroundConsentGranted) {
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = input.accountUserId;
      this.state = "suspended_consent_required";
      return;
    }
    if (!input.backgroundCaptureEnabled) {
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = input.accountUserId;
      this.state = "suspended_sharing_disabled";
      return;
    }
    this.state = "transitioning_to_background";
    const permissionGranted = await this.adapter.backgroundPermissionGranted();
    if (await stale()) return;
    if (!permissionGranted) {
      await this.stopBackground();
      if (!this.current(generation)) return;
      this.accountUserId = input.accountUserId;
      this.state = "suspended_no_permission";
      return;
    }
    if (this.backgroundOwned && this.accountUserId === input.accountUserId) {
      this.state = "background_owned";
      return;
    }
    const generationIdentity = `background-v1:${input.accountUserId}:${generation}`;
    await this.adapter.startBackground(input.accountUserId, generationIdentity);
    if (await stale()) return;
    this.backgroundOwned = true;
    this.backgroundOwnershipKnown = true;
    this.foregroundOwned = false;
    this.accountUserId = input.accountUserId;
    this.state = "background_owned";
    this.noteActiveCount();
  }
}

export type BackgroundBatchIngestionResult = Readonly<{
  deliveredCount: number;
  boundedCount: number;
  acceptedCount: number;
  rejectedCount: number;
  overflowCount: number;
  authorityState:
    | "accepted"
    | "no_authority"
    | "session_unavailable"
    | "account_mismatch"
    | "permission_unavailable"
    | "stale_authority";
}>;

export async function ingestBackgroundLocationBatch(input: Readonly<{
  locations: readonly NativeLocationObservationInput[];
  readAuthority(): Promise<BackgroundLocationAuthorityRecord | null>;
  currentSessionUserId(): Promise<string | null>;
  backgroundPermissionGranted(): Promise<boolean>;
  capture(
    accountUserId: string,
    observation: AcceptedCurrentLocationObservation,
    nowMs: number,
  ): boolean;
  nowMs?: number;
}>): Promise<BackgroundBatchIngestionResult> {
  const deliveredCount = input.locations.length;
  const bounded = [...input.locations]
    .sort((left, right) => Number(left.timestamp) - Number(right.timestamp))
    .slice(0, BACKGROUND_LOCATION_CAPTURE_POLICY.maximumLocationsPerTaskInvocation);
  const overflowCount = Math.max(0, deliveredCount - bounded.length);
  const empty = (authorityState: BackgroundBatchIngestionResult["authorityState"]): BackgroundBatchIngestionResult => ({
    deliveredCount,
    boundedCount: bounded.length,
    acceptedCount: 0,
    rejectedCount: bounded.length,
    overflowCount,
    authorityState,
  });
  const authority = await input.readAuthority();
  if (!authority) return empty("no_authority");
  const sessionUserId = await input.currentSessionUserId();
  if (!sessionUserId) return empty("session_unavailable");
  if (sessionUserId !== authority.accountUserId) return empty("account_mismatch");
  if (!await input.backgroundPermissionGranted()) return empty("permission_unavailable");
  const referenceNowMs = input.nowMs ?? Date.now();
  let acceptedCount = 0;
  let rejectedCount = 0;
  for (const nativeObservation of bounded) {
    const currentAuthority = await input.readAuthority();
    if (
      !currentAuthority
      || currentAuthority.accountUserId !== authority.accountUserId
      || currentAuthority.generationIdentity !== authority.generationIdentity
      || currentAuthority.captureSessionIdentity !== authority.captureSessionIdentity
    ) return {
      deliveredCount,
      boundedCount: bounded.length,
      acceptedCount,
      rejectedCount: rejectedCount + (bounded.length - acceptedCount - rejectedCount),
      overflowCount,
      authorityState: "stale_authority",
    };
    const candidate = normalizeCanonicalLocationObservation(nativeObservation);
    if (!candidate) {
      rejectedCount += 1;
      continue;
    }
    const assessment = assessLocationObservationWithinAge(
      candidate,
      BACKGROUND_LOCATION_CAPTURE_POLICY.maximumObservationAgeMs,
      referenceNowMs,
    );
    if (!assessment.accepted) {
      rejectedCount += 1;
      continue;
    }
    if (input.capture(authority.accountUserId, assessment.observation, referenceNowMs)) {
      acceptedCount += 1;
    } else {
      rejectedCount += 1;
    }
  }
  return {
    deliveredCount,
    boundedCount: bounded.length,
    acceptedCount,
    rejectedCount,
    overflowCount,
    authorityState: "accepted",
  };
}
