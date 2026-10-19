import type { FeatureCollection, LineString, MultiLineString, Point, Position } from "geojson";
import { groupNamedTrails, type Trail } from "./trails";
import { graphFromGeoJson } from "./graph";

export type NamesFile = FeatureCollection<MultiLineString, { name: string }>;
export type Landmarks = FeatureCollection<Point, { id: string; name: string; icon?: string; description?: string }>;

export function connectedSections(segments: Trail[], selectedIds: string[]): boolean {
  const selected = new Set(selectedIds);
  const graph = graphFromGeoJson({ type: "FeatureCollection", features: segments.filter((segment) => selected.has(segment.properties.id)) });
  if (!graph.edges.length) return false;
  const neighbors = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, new Set());
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, new Set());
    neighbors.get(edge.from)!.add(edge.to);
    neighbors.get(edge.to)!.add(edge.from);
  }
  const reached = new Set<string>();
  const pending = [graph.edges[0].from];
  while (pending.length) {
    const node = pending.pop()!;
    if (reached.has(node)) continue;
    reached.add(node);
    for (const neighbor of neighbors.get(node) ?? []) if (!reached.has(neighbor)) pending.push(neighbor);
  }
  return graph.nodes.every((node) => reached.has(node.id));
}

export function saveName(segments: Trail[], previousId: string | null, value: string, selectedIds: string[]): Trail[] {
  const name = value.trim().replace(/\s+/g, " ");
  const id = name.normalize("NFKC").toLowerCase();
  const selected = new Set(selectedIds);
  if (!name) throw new Error("Enter a trail name.");
  if (!selected.size || selectedIds.some((selectedId) => !segments.some((segment) => segment.properties.id === selectedId))) throw new Error("Select at least one trail section.");
  if (groupNamedTrails(segments).some((trail) => trail.id === id && id !== previousId)) throw new Error("That trail name already exists.");
  if (!connectedSections(segments, selectedIds)) throw new Error("Selected sections are disconnected. Select connecting sections before saving.");
  return segments.map((segment) => {
    const names = labels(segment).filter((label) => label.normalize("NFKC").toLowerCase() !== previousId);
    if (selected.has(segment.properties.id)) names.push(name);
    return { ...segment, properties: { ...segment.properties, name: undefined, names: [...new Set(names)] } };
  });
}

export function removeName(segments: Trail[], id: string): Trail[] {
  return segments.map((segment) => ({ ...segment, properties: { ...segment.properties, name: undefined, names: labels(segment).filter((name) => name.normalize("NFKC").toLowerCase() !== id) } }));
}

export function namesFile(segments: Trail[]): NamesFile {
  return { type: "FeatureCollection", features: groupNamedTrails(segments).map((trail) => ({ type: "Feature", properties: { name: trail.name }, geometry: { type: "MultiLineString", coordinates: trail.segments.map((segment) => segment.geometry.coordinates) } })) };
}

export function editsFile(segments: Trail[], landmarks: Landmarks, walks: FeatureCollection<LineString>) {
  return { format: "windstone-edits", version: 1, exportedAt: new Date().toISOString(), trailNames: namesFile(segments), landmarks, walks };
}

export function sameNames(first: Trail[], second: Trail[]): boolean {
  const sorted = (segments: Trail[]) => namesFile([...segments].sort((left, right) => left.properties.id.localeCompare(right.properties.id)));
  return stableJson(sorted(first)) === stableJson(sorted(second));
}

export function sameLandmarks(first: Landmarks, second: Landmarks): boolean {
  const sorted = (places: Landmarks) => places.features.map((feature) => ({ geometry: feature.geometry, properties: { ...feature.properties, icon: feature.properties.icon ?? "pin" } })).sort((left, right) => left.properties.id.localeCompare(right.properties.id));
  return stableJson(sorted(first)) === stableJson(sorted(second));
}

export function applyNames(segments: Trail[], value: unknown): { segments: Trail[]; unmatched: number } {
  const collection = asCollection(value);
  const names = new Map<string, Set<string>>();
  const known = new Set(segments.map((segment) => geometryKey(segment.geometry.coordinates)));
  let unmatched = 0;
  for (const feature of collection.features) {
    if (feature?.type !== "Feature" || typeof feature.properties?.name !== "string" || !feature.properties.name.trim() || feature.geometry?.type !== "MultiLineString" || !Array.isArray(feature.geometry.coordinates) || !feature.geometry.coordinates.length) throw new Error("Expected named MultiLineString features.");
    const name = feature.properties.name.trim().replace(/\s+/g, " ");
    for (const coordinates of feature.geometry.coordinates) {
      if (!Array.isArray(coordinates) || coordinates.length < 2 || !coordinates.every(validCoordinate)) throw new Error("Invalid trail coordinates.");
      const key = geometryKey(coordinates);
      if (!known.has(key)) { unmatched += 1; continue; }
      const assigned = names.get(key) ?? new Set<string>();
      assigned.add(name);
      names.set(key, assigned);
    }
  }
  return { segments: segments.map((segment) => ({ ...segment, properties: { ...segment.properties, name: undefined, names: [...(names.get(geometryKey(segment.geometry.coordinates)) ?? [])] } })), unmatched };
}

export function parseLandmarks(value: unknown): Landmarks {
  const collection = asCollection(value);
  const ids = new Set<string>();
  return { type: "FeatureCollection", features: collection.features.map((feature) => {
    if (feature?.type !== "Feature" || feature.geometry?.type !== "Point" || !validCoordinate(feature.geometry.coordinates) || typeof feature.properties?.name !== "string" || !feature.properties.name.trim()) throw new Error("Expected named landmark points.");
    const id = String(feature.properties.id ?? feature.id ?? crypto.randomUUID());
    if (ids.has(id)) throw new Error("Duplicate landmark ID.");
    ids.add(id);
    return { type: "Feature", id, geometry: { type: "Point", coordinates: feature.geometry.coordinates }, properties: { ...feature.properties, id, name: feature.properties.name.trim() } };
  }) };
}

export function downloadGeoJson(filename: string, value: unknown, contentType = "application/geo+json") {
  const url = URL.createObjectURL(new Blob([`${JSON.stringify(value, null, 2)}\n`], { type: contentType }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function asCollection(value: unknown): FeatureCollection {
  if (!value || typeof value !== "object" || !("type" in value) || value.type !== "FeatureCollection" || !("features" in value) || !Array.isArray(value.features)) throw new Error("Expected a GeoJSON FeatureCollection.");
  return value as FeatureCollection;
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([first], [second]) => first.localeCompare(second))) : item);
}

function labels(segment: Trail): string[] {
  return [segment.properties.name, ...(segment.properties.names ?? [])].filter((name): name is string => typeof name === "string" && name.trim().length > 0).map((name) => name.trim().replace(/\s+/g, " "));
}

function validCoordinate(value: unknown): value is Position {
  return Array.isArray(value) && value.length >= 2 && Number.isFinite(value[0]) && Number.isFinite(value[1]) && Math.abs(value[0]) <= 180 && Math.abs(value[1]) < 85;
}

function geometryKey(coordinates: Position[]): string {
  const rounded = coordinates.map((point) => [Number(point[0].toFixed(7)), Number(point[1].toFixed(7))]);
  const forward = JSON.stringify(rounded);
  const reverse = JSON.stringify([...rounded].reverse());
  return forward < reverse ? forward : reverse;
}