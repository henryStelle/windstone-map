import type { FeatureCollection, LineString } from "geojson";

export function walksFromGeoJson(
  collection: FeatureCollection,
): FeatureCollection<LineString> {
  if (
    collection?.type !== "FeatureCollection" ||
    !Array.isArray(collection.features)
  )
    throw new Error("Expected a GeoJSON FeatureCollection.");
  return {
    type: "FeatureCollection",
    features: collection.features.map((feature) => {
      const id = feature.properties?.id ?? feature.id;
      if (
        (typeof id !== "string" && typeof id !== "number") ||
        String(id).length === 0
      )
        throw new Error("Every walk must have a segment ID.");
      if (
        feature.geometry?.type !== "LineString" ||
        feature.geometry.coordinates.length < 2 ||
        !feature.geometry.coordinates.every(
          (coordinate) =>
            Array.isArray(coordinate) &&
            coordinate.length >= 2 &&
            Number.isFinite(coordinate[0]) &&
            Number.isFinite(coordinate[1]) &&
            Math.abs(coordinate[0]) <= 180 &&
            Math.abs(coordinate[1]) < 85,
        )
      ) {
        throw new Error(
          "Every walk must be a LineString with valid GPS coordinates.",
        );
      }
      return {
        ...feature,
        geometry: feature.geometry,
        properties: { ...feature.properties, id: String(id) },
      };
    }),
  };
}
