import type { FeatureCollection } from "geojson";
import {
  distance,
  lineSegments,
  projection,
  sampleSegments,
  SegmentIndex,
  type Point,
} from "./geometry.ts";

export function evaluateNetwork(
  predicted: FeatureCollection,
  truth: FeatureCollection,
  toleranceMeters = 5,
) {
  if (!Number.isFinite(toleranceMeters) || toleranceMeters <= 0)
    throw new Error("Tolerance must be positive.");
  const origin = truth.features.flatMap((feature) =>
    feature.geometry?.type === "LineString" ? feature.geometry.coordinates : [],
  );
  const { project } = projection(origin);
  const predictedSegments = lineSegments(predicted, project);
  const truthSegments = lineSegments(truth, project);
  const predictedIndex = new SegmentIndex(predictedSegments);
  const truthIndex = new SegmentIndex(truthSegments);
  const measure = (segments: typeof predictedSegments, index: SegmentIndex) => {
    const samples = sampleSegments(segments, 2).map((sample) => ({
      ...sample,
      error: index.nearestDistance(sample.point),
    }));
    const length = samples.reduce((sum, sample) => sum + sample.weight, 0);
    const supported = samples.reduce(
      (sum, sample) =>
        sum + (sample.error <= toleranceMeters ? sample.weight : 0),
      0,
    );
    const mean =
      length > 0
        ? samples.reduce(
            (sum, sample) => sum + sample.weight * sample.error,
            0,
          ) / length
        : null;
    let cumulative = 0;
    let p95: number | null = null;
    for (const sample of samples.sort(
      (first, second) => first.error - second.error,
    )) {
      cumulative += sample.weight;
      if (cumulative >= length * 0.95) {
        p95 = sample.error;
        break;
      }
    }
    return {
      length,
      supported,
      mean: mean !== null && Number.isFinite(mean) ? mean : null,
      p95: p95 !== null && Number.isFinite(p95) ? p95 : null,
    };
  };
  const accuracy = measure(predictedSegments, truthIndex);
  const coverage = measure(truthSegments, predictedIndex);
  const precision =
    accuracy.length > 0 ? accuracy.supported / accuracy.length : 0;
  const recall = coverage.length > 0 ? coverage.supported / coverage.length : 0;
  const predictedTopology = topology(predicted, project);
  const truthTopology = topology(truth, project);
  const junctionToleranceMeters = 10;
  const matches = new Map<number, number>();
  const match = (predictedIndex: number, visited: Set<number>): boolean => {
    const candidates = truthTopology.junctions
      .map((point, index) => ({
        index,
        distance: distance(point, predictedTopology.junctions[predictedIndex]),
      }))
      .filter((candidate) => candidate.distance <= junctionToleranceMeters)
      .sort((first, second) => first.distance - second.distance);
    for (const candidate of candidates) {
      if (visited.has(candidate.index)) continue;
      visited.add(candidate.index);
      const existing = matches.get(candidate.index);
      if (existing === undefined || match(existing, visited)) {
        matches.set(candidate.index, predictedIndex);
        return true;
      }
    }
    return false;
  };
  for (let index = 0; index < predictedTopology.junctions.length; index += 1)
    match(index, new Set());
  const junctionPrecision =
    predictedTopology.junctions.length > 0
      ? matches.size / predictedTopology.junctions.length
      : truthTopology.junctions.length === 0
        ? 1
        : 0;
  const junctionRecall =
    truthTopology.junctions.length > 0
      ? matches.size / truthTopology.junctions.length
      : 1;
  return {
    toleranceMeters,
    precision,
    recall,
    f1:
      precision + recall > 0
        ? (2 * precision * recall) / (precision + recall)
        : 0,
    meanErrorMeters: accuracy.mean,
    p95ErrorMeters: accuracy.p95,
    truthLengthMeters: coverage.length,
    mergedLengthMeters: accuracy.length,
    missingTruthMeters: coverage.length - coverage.supported,
    unsupportedMergedMeters: accuracy.length - accuracy.supported,
    topology: {
      junctionToleranceMeters,
      matchedJunctions: matches.size,
      truthJunctions: truthTopology.junctions.length,
      mergedJunctions: predictedTopology.junctions.length,
      junctionPrecision,
      junctionRecall,
      junctionF1:
        predictedTopology.junctions.length + truthTopology.junctions.length > 0
          ? (2 * matches.size) /
            (predictedTopology.junctions.length +
              truthTopology.junctions.length)
          : 1,
      truthComponents: truthTopology.components,
      mergedComponents: predictedTopology.components,
      truthEndpoints: truthTopology.endpoints,
      mergedEndpoints: predictedTopology.endpoints,
      truthCycles: truthTopology.cycles,
      mergedCycles: predictedTopology.cycles,
    },
  };
}

function topology(
  collection: FeatureCollection,
  project: (coordinate: number[]) => Point,
) {
  const nodes = new Map<
    string,
    { point: Point; degree: number; neighbors: Set<string> }
  >();
  let edges = 0;
  for (const feature of collection.features) {
    if (
      feature.geometry?.type !== "LineString" ||
      feature.geometry.coordinates.length < 2
    )
      continue;
    const coordinates = feature.geometry.coordinates;
    const first = coordinates[0];
    const last = coordinates.at(-1)!;
    const from = String(
      feature.properties?.from ??
        `${first[0].toFixed(8)},${first[1].toFixed(8)}`,
    );
    const to = String(
      feature.properties?.to ?? `${last[0].toFixed(8)},${last[1].toFixed(8)}`,
    );
    for (const [id, coordinate, other] of [
      [from, first, to],
      [to, last, from],
    ] as const) {
      const node = nodes.get(id) ?? {
        point: project([...coordinate]),
        degree: 0,
        neighbors: new Set<string>(),
      };
      node.degree += 1;
      node.neighbors.add(other);
      nodes.set(id, node);
    }
    edges += 1;
  }
  const seen = new Set<string>();
  let components = 0;
  for (const id of nodes.keys()) {
    if (seen.has(id)) continue;
    components += 1;
    const queue = [id];
    seen.add(id);
    while (queue.length > 0) {
      for (const neighbor of nodes.get(queue.pop()!)!.neighbors) {
        if (!seen.has(neighbor)) {
          seen.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
  }
  return {
    junctions: [...nodes.values()]
      .filter((node) => node.degree >= 3)
      .map((node) => node.point),
    endpoints: [...nodes.values()].filter((node) => node.degree === 1).length,
    components,
    cycles: edges - nodes.size + components,
  };
}
