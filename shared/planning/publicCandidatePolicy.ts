import {
  isCanonicalPlanningCoordinate,
  type CanonicalPlanningCoordinate,
} from "./resolvedPairPlanning.ts";

const EARTH_RADIUS_METERS = 6_371_008.8;

export const LEGACY_AREA_CANDIDATE_CAP = 21;
export const REMOTE_TOTAL_CANDIDATE_CAP = 12;
export const REMOTE_PUBLIC_PROVIDER_LIMIT = 10;
export const PUBLIC_PROVIDER_RADIUS_CAP_METERS = 20_000;

export type PublicPlanningCategory =
  | "bar"
  | "restaurant"
  | "cafe"
  | "food"
  | "quiet"
  | "late_night";

export type PublicCandidatePolicyVariant = "legacy_local_area" | "remote_public_provider";

export type PublicCandidateSearchPolicy = Readonly<{
  variant: PublicCandidatePolicyVariant;
  spreadMeters: number;
  searchRadiusMeters: number;
  providerRadiusMeters: number;
  candidateCap: number;
  publicProviderLimit: number;
  searchMode: "nearby" | "text";
  query?: string;
  categoryCode?: "FD6" | "CE7";
  includedPrimaryType?: "restaurant" | "cafe" | "bar";
}>;

export type PublicCandidateSearchPolicyResult =
  | Readonly<{ kind: "READY"; policy: PublicCandidateSearchPolicy }>
  | Readonly<{ kind: "INVALID_INPUT"; reason: "INVALID_SPREAD" | "INVALID_VARIANT" | "INVALID_CATEGORY" }>;

export function calculatePlanningDistanceMeters(
  left: CanonicalPlanningCoordinate,
  right: CanonicalPlanningCoordinate,
): number {
  if (!isCanonicalPlanningCoordinate(left) || !isCanonicalPlanningCoordinate(right)) {
    return Number.POSITIVE_INFINITY;
  }
  const radians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = radians(right.latitude - left.latitude);
  const longitudeDelta = radians(right.longitude - left.longitude);
  const leftLatitude = radians(left.latitude);
  const rightLatitude = radians(right.latitude);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const value = sinLatitude * sinLatitude
    + Math.cos(leftLatitude) * Math.cos(rightLatitude) * sinLongitude * sinLongitude;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(value)));
}

export function calculateMaximumPlanningSpreadMeters(
  coordinates: readonly CanonicalPlanningCoordinate[],
): number {
  if (!Array.isArray(coordinates) || coordinates.some((coordinate) => !isCanonicalPlanningCoordinate(coordinate))) {
    return Number.POSITIVE_INFINITY;
  }
  let maximum = 0;
  for (let left = 0; left < coordinates.length; left += 1) {
    for (let right = left + 1; right < coordinates.length; right += 1) {
      maximum = Math.max(maximum, calculatePlanningDistanceMeters(coordinates[left]!, coordinates[right]!));
    }
  }
  return maximum;
}

function isCategory(value: unknown): value is PublicPlanningCategory {
  return value === "bar"
    || value === "restaurant"
    || value === "cafe"
    || value === "food"
    || value === "quiet"
    || value === "late_night";
}

export function createPublicCandidateSearchPolicy(input: Readonly<{
  variant: PublicCandidatePolicyVariant;
  spreadMeters: number;
  category?: PublicPlanningCategory;
}>): PublicCandidateSearchPolicyResult {
  if (!Number.isFinite(input.spreadMeters) || input.spreadMeters < 0) {
    return { kind: "INVALID_INPUT", reason: "INVALID_SPREAD" };
  }
  if (input.variant !== "legacy_local_area" && input.variant !== "remote_public_provider") {
    return { kind: "INVALID_INPUT", reason: "INVALID_VARIANT" };
  }
  if (input.category !== undefined && !isCategory(input.category)) {
    return { kind: "INVALID_INPUT", reason: "INVALID_CATEGORY" };
  }

  if (input.variant === "legacy_local_area") {
    const searchRadiusMeters = Math.max(3_000, Math.min(25_000, input.spreadMeters * 0.65));
    return Object.freeze({
      kind: "READY",
      policy: Object.freeze({
        variant: input.variant,
        spreadMeters: input.spreadMeters,
        searchRadiusMeters,
        providerRadiusMeters: searchRadiusMeters,
        candidateCap: LEGACY_AREA_CANDIDATE_CAP,
        publicProviderLimit: LEGACY_AREA_CANDIDATE_CAP,
        searchMode: "text",
      }),
    });
  }

  const searchRadiusMeters = Math.max(3_000, Math.min(50_000, input.spreadMeters * 0.75));
  const includedPrimaryType = input.category === "restaurant" || input.category === "food"
    ? "restaurant"
    : input.category === "cafe" || input.category === "quiet"
      ? "cafe"
      : input.category === "bar" || input.category === "late_night"
        ? "bar"
        : undefined;
  const categoryCode = input.category === "restaurant" || input.category === "food"
    ? "FD6" as const
    : input.category === "cafe"
      ? "CE7" as const
      : undefined;
  const query = includedPrimaryType || categoryCode ? undefined : "restaurant cafe bar";
  return Object.freeze({
    kind: "READY",
    policy: Object.freeze({
      variant: input.variant,
      spreadMeters: input.spreadMeters,
      searchRadiusMeters,
      providerRadiusMeters: Math.min(PUBLIC_PROVIDER_RADIUS_CAP_METERS, searchRadiusMeters),
      candidateCap: REMOTE_TOTAL_CANDIDATE_CAP,
      publicProviderLimit: REMOTE_PUBLIC_PROVIDER_LIMIT,
      searchMode: query ? "text" : "nearby",
      ...(query ? { query } : {}),
      ...(categoryCode ? { categoryCode } : {}),
      ...(includedPrimaryType ? { includedPrimaryType } : {}),
    }),
  });
}

export function isCanonicalPublicCandidateSearchPolicy(
  value: unknown,
  requiredVariant?: PublicCandidatePolicyVariant,
): value is PublicCandidateSearchPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const policy = value as PublicCandidateSearchPolicy;
    if (requiredVariant && policy.variant !== requiredVariant) return false;
    const categories: readonly (PublicPlanningCategory | undefined)[] = [
      undefined, "bar", "restaurant", "cafe", "food", "quiet", "late_night",
    ];
    return categories.some((category) => {
      const result = createPublicCandidateSearchPolicy({
        variant: policy.variant,
        spreadMeters: policy.spreadMeters,
        ...(category ? { category } : {}),
      });
      if (result.kind !== "READY") return false;
      const expected = result.policy;
      const actualKeys = Object.keys(policy).sort();
      const expectedKeys = Object.keys(expected).sort();
      return actualKeys.length === expectedKeys.length
        && actualKeys.every((key, index) => key === expectedKeys[index])
        && actualKeys.every((key) => policy[key as keyof PublicCandidateSearchPolicy] === expected[key as keyof PublicCandidateSearchPolicy]);
    });
  } catch {
    return false;
  }
}
