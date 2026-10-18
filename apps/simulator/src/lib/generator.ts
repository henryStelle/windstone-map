import type { Feature, FeatureCollection, LineString } from "geojson";
import type { Coordinate, TrailEdge, TrailGraph } from "./graph";

export interface GenerateOptions {
  count: number;
  noiseMeters: number;
  sampleSpacingMeters: number;
  seed: string;
}

interface WalkProperties {
  id: string;
  times: string[];
  accuracies: number[];
  recordedAt: string;
  device: string;
  truthEdgeIds: string[];
  seed: string;
}

export type WalkCollection = FeatureCollection<LineString, WalkProperties>;

export function generateWalks(
  graph: TrailGraph,
  options: GenerateOptions,
): WalkCollection {
  if (graph.edges.length === 0)
    return { type: "FeatureCollection", features: [] };

  const random = mulberry32(hashSeed(options.seed));
  const features: Array<Feature<LineString, WalkProperties>> = [];

  for (let index = 0; index < options.count; index += 1) {
    const path = choosePath(graph, random);
    if (path.coordinates.length < 2) continue;

    const sampled = densify(path.coordinates, options.sampleSpacingMeters);
    const coordinates = sampled.map((coordinate) =>
      addNoise(coordinate, options.noiseMeters, random),
    );
    const startedAt = new Date(Date.UTC(2025, 0, 1, 12, 0, index)).getTime();
    const id = `${slug(options.seed)}-${String(index + 1).padStart(4, "0")}`;

    features.push({
      type: "Feature",
      id,
      properties: {
        id,
        times: coordinates.map((_, pointIndex) =>
          new Date(startedAt + pointIndex * 2_000).toISOString(),
        ),
        accuracies: coordinates.map(() =>
          round(Math.max(1, options.noiseMeters * (0.75 + random())), 1),
        ),
        recordedAt: new Date(startedAt).toISOString(),
        device: "Windstone simulator",
        truthEdgeIds: path.edgeIds,
        seed: options.seed,
      },
      geometry: { type: "LineString", coordinates },
    });
  }

  return { type: "FeatureCollection", features };
}

function choosePath(graph: TrailGraph, random: () => number) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, TrailEdge[]>();
  for (const edge of graph.edges) {
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge]);
  }

  const connectedNodes = graph.nodes.filter((node) => adjacency.has(node.id));
  let current = connectedNodes[Math.floor(random() * connectedNodes.length)];
  const coordinates: Coordinate[] = [current.coordinate];
  const edgeIds: string[] = [];
  const used = new Set<string>();
  const maximum =
    graph.edges.length > 2 ? graph.edges.length - 1 : graph.edges.length;
  const target = Math.max(1, Math.ceil(maximum * (0.2 + random() * 0.6)));

  while (edgeIds.length < target) {
    const candidates = (adjacency.get(current.id) ?? []).filter(
      (edge) => !used.has(edge.id),
    );
    if (candidates.length === 0) break;

    const edge = candidates[Math.floor(random() * candidates.length)];
    const nextId = edge.from === current.id ? edge.to : edge.from;
    const next = nodes.get(nextId);
    if (!next) break;

    used.add(edge.id);
    edgeIds.push(edge.id);
    coordinates.push(next.coordinate);
    current = next;
  }

  return { coordinates, edgeIds };
}

function densify(
  coordinates: Coordinate[],
  spacingMeters: number,
): Coordinate[] {
  const result: Coordinate[] = [];
  for (let index = 1; index < coordinates.length; index += 1) {
    const from = coordinates[index - 1];
    const to = coordinates[index];
    const steps = Math.max(
      1,
      Math.ceil(distanceMeters(from, to) / spacingMeters),
    );
    for (let step = 0; step < steps; step += 1) {
      const fraction = step / steps;
      result.push([
        from[0] + (to[0] - from[0]) * fraction,
        from[1] + (to[1] - from[1]) * fraction,
      ]);
    }
  }
  result.push(coordinates.at(-1)!);
  return result;
}

function addNoise(
  coordinate: Coordinate,
  sigmaMeters: number,
  random: () => number,
): Coordinate {
  const angle = random() * Math.PI * 2;
  const radius = gaussian(random) * sigmaMeters;
  const latitudeRadians = (coordinate[1] * Math.PI) / 180;
  return [
    coordinate[0] +
      (Math.cos(angle) * radius) / (111_320 * Math.cos(latitudeRadians)),
    coordinate[1] + (Math.sin(angle) * radius) / 110_540,
  ];
}

function distanceMeters(from: Coordinate, to: Coordinate): number {
  const latitude = (((from[1] + to[1]) / 2) * Math.PI) / 180;
  const x = (((to[0] - from[0]) * Math.PI) / 180) * Math.cos(latitude);
  const y = ((to[1] - from[1]) * Math.PI) / 180;
  return Math.hypot(x, y) * 6_371_000;
}

function gaussian(random: () => number): number {
  const first = Math.max(Number.EPSILON, random());
  const second = random();
  return Math.sqrt(-2 * Math.log(first)) * Math.cos(2 * Math.PI * second);
}

function hashSeed(seed: string): number {
  let hash = 2_166_136_261;
  for (const character of seed) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return hash >>> 0;
}

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let value = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value;
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "") || "walk"
  );
}

function round(value: number, decimals: number): number {
  const scale = 10 ** decimals;
  return Math.round(value * scale) / scale;
}
