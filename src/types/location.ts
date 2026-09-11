/** Provider-neutral coordinate contract extracted from the canonical shared
 * product types so this selected public slice does not pull in unrelated UI,
 * social, or fixture models. */
export type GeoCoordinate = {
  latitude: number;
  longitude: number;
};
