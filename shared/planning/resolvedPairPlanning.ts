export type CanonicalPlanningCoordinate = Readonly<{
  latitude: number;
  longitude: number;
}>;

export type SphericalPlanningCentroidResult =
  | Readonly<{
      kind: "READY";
      coordinate: CanonicalPlanningCoordinate;
      inputCount: number;
      algorithm: "spherical_vector_centroid";
    }>
  | Readonly<{
      kind: "INVALID_INPUT";
      reason: "COORDINATES_REQUIRED" | "INVALID_COORDINATE";
      invalidIndex?: number;
    }>;

export type ResolvedPairPlanningSeed = Readonly<{
  originCount: 2;
  searchOrigin: CanonicalPlanningCoordinate;
  algorithm: "spherical_vector_centroid";
}>;

export type ResolvedPairPlanningSeedResult =
  | Readonly<{ kind: "READY"; seed: ResolvedPairPlanningSeed }>
  | Extract<SphericalPlanningCentroidResult, { kind: "INVALID_INPUT" }>;

export function isCanonicalPlanningCoordinate(value: unknown): value is CanonicalPlanningCoordinate {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  try {
    const coordinate = value as Partial<CanonicalPlanningCoordinate>;
    return Number.isFinite(coordinate.latitude)
      && Number.isFinite(coordinate.longitude)
      && Number(coordinate.latitude) >= -90
      && Number(coordinate.latitude) <= 90
      && Number(coordinate.longitude) >= -180
      && Number(coordinate.longitude) <= 180;
  } catch {
    return false;
  }
}

/**
 * Canonical meeting-planning geometry. Operation order intentionally preserves
 * the legacy mobile spherical/vector centroid, including its finite but
 * mathematically non-unique exact-antipodal result.
 */
export function calculateSphericalPlanningCentroid(
  coordinates: readonly CanonicalPlanningCoordinate[],
): SphericalPlanningCentroidResult {
  if (!Array.isArray(coordinates) || coordinates.length === 0) {
    return { kind: "INVALID_INPUT", reason: "COORDINATES_REQUIRED" };
  }
  const invalidIndex = coordinates.findIndex((coordinate) => !isCanonicalPlanningCoordinate(coordinate));
  if (invalidIndex !== -1) return { kind: "INVALID_INPUT", reason: "INVALID_COORDINATE", invalidIndex };

  const sum = coordinates.reduce(
    (value, coordinate) => {
      const latitude = (coordinate.latitude * Math.PI) / 180;
      const longitude = (coordinate.longitude * Math.PI) / 180;
      return {
        x: value.x + Math.cos(latitude) * Math.cos(longitude),
        y: value.y + Math.cos(latitude) * Math.sin(longitude),
        z: value.z + Math.sin(latitude),
      };
    },
    { x: 0, y: 0, z: 0 },
  );
  const longitude = Math.atan2(sum.y, sum.x);
  const hypotenuse = Math.sqrt(sum.x * sum.x + sum.y * sum.y);
  const latitude = Math.atan2(sum.z, hypotenuse);
  return Object.freeze({
    kind: "READY",
    coordinate: Object.freeze({
      latitude: (latitude * 180) / Math.PI,
      longitude: (longitude * 180) / Math.PI,
    }),
    inputCount: coordinates.length,
    algorithm: "spherical_vector_centroid",
  });
}

export function createResolvedPairPlanningSeed(input: Readonly<{
  first: CanonicalPlanningCoordinate;
  second: CanonicalPlanningCoordinate;
}>): ResolvedPairPlanningSeedResult {
  const centroid = calculateSphericalPlanningCentroid([input.first, input.second]);
  if (centroid.kind !== "READY") return centroid;
  return Object.freeze({
    kind: "READY",
    seed: Object.freeze({
      originCount: 2,
      searchOrigin: centroid.coordinate,
      algorithm: centroid.algorithm,
    }),
  });
}
