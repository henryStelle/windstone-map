import type { Feature, FeatureCollection, LineString, Point } from "geojson";
import type { TrailProperties } from "@windstone/merger";
import trailsJson from "../../../../data/trails.geojson?raw";
import landmarksJson from "../../../../data/landmarks.geojson?raw";

export type Trail = Feature<
  LineString,
  TrailProperties & { name?: string; names?: string[] }
>;
export interface NamedTrail {
  id: string;
  name: string;
  segments: Trail[];
  lengthMeters: number;
}
export const trails: FeatureCollection<LineString, Trail["properties"]> =
  JSON.parse(trailsJson);
export const landmarks: FeatureCollection<
  Point,
  { id?: string; name?: string; description?: string; icon?: string }
> = JSON.parse(landmarksJson);

export function formatDistance(meters: number): string {
  return meters >= 1000
    ? `${(meters / 1000).toFixed(1)} km`
    : `${Math.round(meters)} m`;
}

export function groupNamedTrails(segments: Trail[]): NamedTrail[] {
  const groups = new Map<string, Map<string, Trail>>();
  const labels = new Map<string, string>();
  for (const segment of segments) {
    const names = [
      segment.properties.name,
      ...(Array.isArray(segment.properties.names)
        ? segment.properties.names
        : []),
    ];
    for (const value of names) {
      if (typeof value !== "string") continue;
      const name = value.trim().replace(/\s+/g, " ");
      if (!name) continue;
      const id = name.normalize("NFKC").toLowerCase();
      const members = groups.get(id) ?? new Map<string, Trail>();
      members.set(segment.properties.id, segment);
      groups.set(id, members);
      if (!labels.has(id)) labels.set(id, name);
    }
  }
  return [...groups]
    .map(([id, members]) => ({
      id,
      name: labels.get(id)!,
      segments: [...members.values()],
      lengthMeters: [...members.values()].reduce(
        (sum, segment) => sum + segment.properties.lengthMeters,
        0,
      ),
    }))
    .sort((first, second) => first.name.localeCompare(second.name));
}

export const namedTrails = groupNamedTrails(trails.features);
