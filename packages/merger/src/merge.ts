import type { FeatureCollection, LineString, Position } from "geojson";
import simplify from "simplify-js";
import { distance, projection, type Point } from "./geometry.ts";

export interface MergeOptions {
  cellSizeMeters: number;
  bandwidthMeters: number;
  densityFraction: number;
  minSupport: number;
  maxAccuracyMeters: number;
  maxGapSeconds: number;
  minSegmentMeters: number;
  smoothingRadius: number;
  outputSmoothingMeters: number;
  pruneSpursMeters: number;
  junctionMergeMeters: number;
  simplifyMeters: number;
}

export const DEFAULT_OPTIONS: MergeOptions = {
  cellSizeMeters: 1.5,
  bandwidthMeters: 3,
  densityFraction: 0.4,
  minSupport: 2,
  maxAccuracyMeters: 25,
  maxGapSeconds: 10,
  minSegmentMeters: 10,
  smoothingRadius: 1,
  outputSmoothingMeters: 3,
  pruneSpursMeters: 12,
  junctionMergeMeters: 8,
  simplifyMeters: 1,
};

export interface TrailProperties {
  id: string;
  from: string;
  to: string;
  support: number;
  lengthMeters: number;
}

interface Run {
  id: string;
  points: Point[];
}
interface Edge {
  from: number;
  to: number;
  points: Point[];
  support: number;
}

export function mergeTraces(
  input: FeatureCollection,
  overrides: Partial<MergeOptions> = {},
) {
  const options = { ...DEFAULT_OPTIONS, ...overrides };
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`Invalid merge option: ${key}`);
  }
  if (
    options.cellSizeMeters === 0 ||
    options.bandwidthMeters === 0 ||
    options.maxAccuracyMeters === 0 ||
    options.maxGapSeconds === 0 ||
    options.minSupport < 2 ||
    options.densityFraction > 1 ||
    !Number.isInteger(options.smoothingRadius) ||
    !Number.isInteger(options.minSupport)
  ) {
    throw new Error(
      "Invalid merge resolution, support, smoothing, or density threshold.",
    );
  }
  const features = [...input.features].sort((first, second) => {
    const firstKey = String(first.properties?.id ?? first.id ?? "");
    const secondKey = String(second.properties?.id ?? second.id ?? "");
    return (
      firstKey.localeCompare(secondKey) ||
      JSON.stringify(first.geometry).localeCompare(
        JSON.stringify(second.geometry),
      )
    );
  });
  const origins = features.flatMap((feature) =>
    feature.geometry?.type === "LineString"
      ? feature.geometry.coordinates.filter(validCoordinate)
      : [],
  );
  const { project, unproject } = projection(origins);
  const runs: Run[] = [];
  const ingested: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();
  let duplicates = 0;
  let droppedFixes = 0;

  for (const feature of features) {
    const id = String(feature.properties?.id ?? feature.id ?? "");
    if (!id) throw new Error("Every trace must have a segment ID.");
    if (seen.has(id)) {
      duplicates += 1;
      continue;
    }
    seen.add(id);
    if (feature.geometry?.type !== "LineString") {
      rejected.push(id);
      continue;
    }
    const coordinates = feature.geometry.coordinates;
    const accuracies: unknown = feature.properties?.accuracies;
    const times: unknown = feature.properties?.times;
    if (
      (accuracies !== undefined &&
        (!Array.isArray(accuracies) ||
          accuracies.length !== coordinates.length)) ||
      (times !== undefined &&
        (!Array.isArray(times) || times.length !== coordinates.length))
    ) {
      rejected.push(id);
      continue;
    }
    const previousCount = runs.length;
    let points: Point[] = [];
    let previousTime: number | null = null;
    const finish = () => {
      const length = points
        .slice(1)
        .reduce((sum, point, index) => sum + distance(points[index], point), 0);
      if (points.length >= 2 && length >= options.minSegmentMeters) {
        runs.push({ id, points: smooth(points, options.smoothingRadius) });
      }
      points = [];
      previousTime = null;
    };
    for (let index = 0; index < coordinates.length; index += 1) {
      const accuracy = Array.isArray(accuracies) ? accuracies[index] : 10;
      const time = Array.isArray(times) ? Date.parse(times[index]) : null;
      if (
        !validCoordinate(coordinates[index]) ||
        typeof accuracy !== "number" ||
        !Number.isFinite(accuracy) ||
        accuracy <= 0 ||
        accuracy > options.maxAccuracyMeters ||
        (time !== null && !Number.isFinite(time))
      ) {
        droppedFixes += 1;
        finish();
        continue;
      }
      if (
        previousTime !== null &&
        time !== null &&
        (time <= previousTime ||
          time - previousTime > options.maxGapSeconds * 1_000)
      )
        finish();
      points.push(project(coordinates[index]));
      previousTime = time;
    }
    finish();
    if (runs.length > previousCount) ingested.push(id);
    else rejected.push(id);
  }

  const trails: FeatureCollection<LineString, TrailProperties> = {
    type: "FeatureCollection",
    features: [],
  };
  if (runs.length === 0)
    return {
      trails,
      ingested: { ingested, rejected },
      stats: {
        duplicates,
        droppedFixes,
        cleanedRuns: 0,
        nodes: 0,
        junctions: 0,
      },
      options,
    };
  const grid = rasterize(runs, options);
  const skeleton = skeletonize(grid.mask, grid.width, grid.height);
  const edges = extractEdges(skeleton, grid, options);
  const degrees = new Map<number, number>();
  for (const edge of edges) {
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  trails.features = edges.map((edge, index) => {
    const id = `edge-${String(index + 1).padStart(5, "0")}`;
    const points = simplify(
      smoothCenterline(edge.points, options.outputSmoothingMeters, options.cellSizeMeters)
        .map(([x, y]) => ({ x, y })),
      options.simplifyMeters,
      true,
    ).map(({ x, y }): Point => [x, y]);
    return {
      type: "Feature",
      id,
      properties: {
        id,
        from: `node-${edge.from}`,
        to: `node-${edge.to}`,
        support: edge.support,
        lengthMeters: points
          .slice(1)
          .reduce(
            (sum, point, pointIndex) =>
              sum + distance(points[pointIndex], point),
            0,
          ),
      },
      geometry: { type: "LineString", coordinates: points.map(unproject) },
    };
  });
  return {
    trails,
    ingested: { ingested, rejected },
    options,
    stats: {
      duplicates,
      droppedFixes,
      cleanedRuns: runs.length,
      nodes: degrees.size,
      junctions: [...degrees.values()].filter((degree) => degree >= 3).length,
    },
  };
}

function validCoordinate(coordinate: Position) {
  return (
    coordinate.length >= 2 &&
    Number.isFinite(coordinate[0]) &&
    Number.isFinite(coordinate[1]) &&
    Math.abs(coordinate[0]) <= 180 &&
    Math.abs(coordinate[1]) < 85
  );
}

function smooth(points: Point[], radius: number): Point[] {
  return points.map((point, index) => {
    if (index === 0 || index === points.length - 1 || radius === 0)
      return point;
    let total = 0;
    let sumX = 0;
    let sumY = 0;
    for (let offset = -radius; offset <= radius; offset += 1) {
      const neighbor =
        points[Math.max(0, Math.min(points.length - 1, index + offset))];
      if (distance(point, neighbor) > radius * 12) continue;
      const weight = radius + 1 - Math.abs(offset);
      total += weight;
      sumX += neighbor[0] * weight;
      sumY += neighbor[1] * weight;
    }
    return [sumX / total, sumY / total];
  });
}

function smoothCenterline(points: Point[], sigmaMeters: number, sampleSpacingMeters: number): Point[] {
  if (sigmaMeters === 0 || points.length < 3) return points;
  const stations = [0];
  for (let index = 1; index < points.length; index += 1) {
    stations.push(stations[index - 1] + distance(points[index - 1], points[index]));
  }
  const length = stations.at(-1)!;
  if (length === 0) return points;
  const steps = Math.max(1, Math.ceil(length / sampleSpacingMeters));
  const spacing = length / steps;
  const samples: Point[] = [points[0]];
  let segment = 1;
  for (let index = 1; index < steps; index += 1) {
    const station = index * spacing;
    while (segment < points.length - 1 && stations[segment] <= station) segment += 1;
    const fraction = (station - stations[segment - 1]) / (stations[segment] - stations[segment - 1]);
    const first = points[segment - 1];
    const second = points[segment];
    samples.push([first[0] + fraction * (second[0] - first[0]), first[1] + fraction * (second[1] - first[1])]);
  }
  samples.push(points.at(-1)!);
  const radius = Math.min(steps, Math.ceil(3 * sigmaMeters / spacing));
  return samples.map((point, index) => {
    if (index === 0 || index === samples.length - 1) return point;
    let total = 0;
    let sumX = 0;
    let sumY = 0;
    for (let neighbor = Math.max(0, index - radius); neighbor <= Math.min(steps, index + radius); neighbor += 1) {
      const weight = Math.exp(-0.5 * ((neighbor - index) * spacing / sigmaMeters) ** 2);
      total += weight;
      sumX += samples[neighbor][0] * weight;
      sumY += samples[neighbor][1] * weight;
    }
    return [sumX / total, sumY / total];
  });
}

function rasterize(runs: Run[], options: MergeOptions) {
  const cellSize = options.cellSizeMeters;
  const radius = Math.ceil((3 * options.bandwidthMeters) / cellSize);
  const padding = (radius + 3) * cellSize;
  const bounds = runs
    .flatMap((run) => run.points)
    .reduce(
      (box, point) => [
        Math.min(box[0], point[0]),
        Math.min(box[1], point[1]),
        Math.max(box[2], point[0]),
        Math.max(box[3], point[1]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity],
    );
  const minX = Math.floor((bounds[0] - padding) / cellSize) * cellSize;
  const minY = Math.floor((bounds[1] - padding) / cellSize) * cellSize;
  const width = Math.ceil((bounds[2] + padding - minX) / cellSize) + 1;
  const height = Math.ceil((bounds[3] + padding - minY) / cellSize) + 1;
  if (width * height > 4_000_000)
    throw new Error(
      "Trace extent is too large; split the area or increase cellSizeMeters.",
    );
  const density = new Float32Array(width * height);
  const support = new Uint32Array(width * height);
  const byTrace = new Map<string, Run[]>();
  for (const run of runs) {
    const group = byTrace.get(run.id) ?? [];
    group.push(run);
    byTrace.set(run.id, group);
  }
  for (const group of byTrace.values()) {
    const contribution = new Map<number, number>();
    for (const run of group) {
      for (let index = 1; index < run.points.length; index += 1) {
        const first = run.points[index - 1];
        const second = run.points[index];
        const count = Math.max(
          1,
          Math.ceil(distance(first, second) / cellSize),
        );
        for (let step = 0; step <= count; step += 1) {
          const pointX =
            (first[0] + ((second[0] - first[0]) * step) / count - minX) /
            cellSize;
          const pointY =
            (first[1] + ((second[1] - first[1]) * step) / count - minY) /
            cellSize;
          for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
            for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
              const cellX = Math.round(pointX) + offsetX;
              const cellY = Math.round(pointY) + offsetY;
              if (
                cellX < 1 ||
                cellY < 1 ||
                cellX >= width - 1 ||
                cellY >= height - 1
              )
                continue;
              const squaredDistance =
                ((cellX - pointX) ** 2 + (cellY - pointY) ** 2) * cellSize ** 2;
              const weight = Math.exp(
                -squaredDistance / (2 * options.bandwidthMeters ** 2),
              );
              if (weight < 0.01) continue;
              const cell = cellY * width + cellX;
              if (weight > (contribution.get(cell) ?? 0))
                contribution.set(cell, weight);
            }
          }
        }
      }
    }
    for (const [cell, weight] of contribution) {
      density[cell] += weight;
      if (weight >= 0.5) support[cell] += 1;
    }
  }
  const mask = new Uint8Array(width * height);
  for (let cellY = radius; cellY < height - radius; cellY += 1) {
    for (let cellX = radius; cellX < width - radius; cellX += 1) {
      const cell = cellY * width + cellX;
      if (support[cell] < options.minSupport) continue;
      let peak = density[cell];
      if (options.densityFraction > 0) {
        for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
          for (let offsetX = -radius; offsetX <= radius; offsetX += 1)
            peak = Math.max(peak, density[cell + offsetY * width + offsetX]);
        }
      }
      if (
        density[cell] >=
        Math.max(options.minSupport * 0.5, peak * options.densityFraction)
      )
        mask[cell] = 1;
    }
  }
  return { mask, width, height, support, density, minX, minY, cellSize };
}

function skeletonize(mask: Uint8Array, width: number, height: number) {
  const result = mask.slice();
  const foreground: number[] = [];
  for (let cell = width; cell < (height - 1) * width; cell += 1)
    if (result[cell]) foreground.push(cell);
  let changed = true;
  while (changed) {
    changed = false;
    for (let phase = 0; phase < 2; phase += 1) {
      const remove: number[] = [];
      for (const cell of foreground) {
        if (!result[cell]) continue;
        const neighbors = [
          result[cell - width],
          result[cell - width + 1],
          result[cell + 1],
          result[cell + width + 1],
          result[cell + width],
          result[cell + width - 1],
          result[cell - 1],
          result[cell - width - 1],
        ];
        const count = neighbors.reduce((sum, value) => sum + value, 0);
        if (count < 2 || count > 6) continue;
        let transitions = 0;
        for (let index = 0; index < 8; index += 1)
          if (!neighbors[index] && neighbors[(index + 1) % 8]) transitions += 1;
        if (transitions !== 1) continue;
        const [north, , east, , south, , west] = neighbors;
        if (
          phase === 0
            ? north * east * south === 0 && east * south * west === 0
            : north * east * west === 0 && north * south * west === 0
        )
          remove.push(cell);
      }
      for (const cell of remove) result[cell] = 0;
      if (remove.length > 0) changed = true;
    }
  }
  return result;
}

function extractEdges(
  mask: Uint8Array,
  grid: ReturnType<typeof rasterize>,
  options: MergeOptions,
): Edge[] {
  const { width, height, cellSize, minX, minY, support } = grid;
  const adjacency = new Map<number, number[]>();
  const point = (cell: number): Point => [
    minX + (cell % width) * cellSize,
    minY + Math.floor(cell / width) * cellSize,
  ];
  for (let cell = width; cell < (height - 1) * width; cell += 1) {
    if (!mask[cell]) continue;
    const neighbors: number[] = [];
    for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
      for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
        if (!offsetX && !offsetY) continue;
        const next = cell + offsetY * width + offsetX;
        if (
          !mask[next] ||
          (offsetX &&
            offsetY &&
            (mask[cell + offsetX] || mask[cell + offsetY * width]))
        )
          continue;
        neighbors.push(next);
      }
    }
    adjacency.set(cell, neighbors);
  }
  const nodeOf = new Map<number, number>();
  const nodePoints = new Map<number, Point>();
  const critical = new Set(
    [...adjacency]
      .filter(([, neighbors]) => neighbors.length !== 2)
      .map(([cell]) => cell),
  );
  const addNode = (start: number) => {
    const node = start;
    const queue = [start];
    const cells: number[] = [];
    nodeOf.set(start, node);
    while (queue.length > 0) {
      const cell = queue.pop()!;
      cells.push(cell);
      for (const neighbor of adjacency.get(cell) ?? []) {
        if (!critical.has(neighbor) || nodeOf.has(neighbor)) continue;
        nodeOf.set(neighbor, node);
        queue.push(neighbor);
      }
    }
    const coordinates = cells.map(point);
    nodePoints.set(node, [
      coordinates.reduce((sum, coordinate) => sum + coordinate[0], 0) /
        cells.length,
      coordinates.reduce((sum, coordinate) => sum + coordinate[1], 0) /
        cells.length,
    ]);
  };
  for (const cell of critical) if (!nodeOf.has(cell)) addNode(cell);
  const visited = new Set<string>();
  let edges: Edge[] = [];
  const linkKey = (first: number, second: number) =>
    first < second ? `${first}:${second}` : `${second}:${first}`;
  const trace = (start: number, next: number) => {
    const cells = [start];
    let previous = start;
    let current = next;
    visited.add(linkKey(start, next));
    while (true) {
      cells.push(current);
      if (nodeOf.has(current)) break;
      const following = (adjacency.get(current) ?? []).find(
        (neighbor) => neighbor !== previous,
      );
      if (following === undefined || visited.has(linkKey(current, following)))
        break;
      visited.add(linkKey(current, following));
      previous = current;
      current = following;
    }
    const from = nodeOf.get(start)!;
    const to = nodeOf.get(current);
    if (to === undefined || (from === to && cells.length <= 3)) return;
    edges.push({
      from,
      to,
      points: [
        nodePoints.get(from)!,
        ...cells.slice(1, -1).map(point),
        nodePoints.get(to)!,
      ],
      support: Math.min(...cells.map((cell) => support[cell])),
    });
  };
  for (const [cell, neighbors] of adjacency) {
    if (!nodeOf.has(cell)) continue;
    for (const neighbor of neighbors) {
      if (
        nodeOf.get(neighbor) === nodeOf.get(cell) ||
        visited.has(linkKey(cell, neighbor))
      )
        continue;
      trace(cell, neighbor);
    }
  }
  for (const [cell, neighbors] of adjacency) {
    if (
      neighbors.length !== 2 ||
      neighbors.every((neighbor) => visited.has(linkKey(cell, neighbor)))
    )
      continue;
    if (!nodeOf.has(cell)) {
      critical.add(cell);
      addNode(cell);
    }
    trace(cell, neighbors[0]);
  }
  let changed = true;
  while (changed) {
    changed = false;
    const degrees = new Map<number, number>();
    for (const edge of edges)
      for (const node of [edge.from, edge.to])
        degrees.set(node, (degrees.get(node) ?? 0) + 1);
    edges = edges.filter((edge) => {
      const length = edge.points
        .slice(1)
        .reduce(
          (sum, coordinate, index) =>
            sum + distance(edge.points[index], coordinate),
          0,
        );
      const leaf =
        (degrees.get(edge.from) === 1 && degrees.get(edge.to)! > 1) ||
        (degrees.get(edge.to) === 1 && degrees.get(edge.from)! > 1);
      const remove =
        edge.support < options.minSupport ||
        (leaf && length < options.pruneSpursMeters);
      if (remove) changed = true;
      return !remove;
    });
    const shortLink = edges.find(
      (edge) =>
        edge.from !== edge.to &&
        degrees.get(edge.from)! >= 3 &&
        degrees.get(edge.to)! >= 3 &&
        edge.points
          .slice(1)
          .reduce(
            (sum, coordinate, index) =>
              sum + distance(edge.points[index], coordinate),
            0,
          ) <= options.junctionMergeMeters,
    );
    if (shortLink) {
      const first = shortLink.points[0];
      const last = shortLink.points.at(-1)!;
      const center: Point = [
        (first[0] + last[0]) / 2,
        (first[1] + last[1]) / 2,
      ];
      edges = edges
        .filter((edge) => edge !== shortLink)
        .map((edge) => {
          const from = edge.from === shortLink.to ? shortLink.from : edge.from;
          const to = edge.to === shortLink.to ? shortLink.from : edge.to;
          const points = [...edge.points];
          if (from === shortLink.from) points[0] = center;
          if (to === shortLink.from) points[points.length - 1] = center;
          return { ...edge, from, to, points };
        });
      changed = true;
      continue;
    }
    for (const [node, degree] of degrees) {
      if (degree !== 2) continue;
      const incident = edges.filter(
        (edge) => edge.from === node || edge.to === node,
      );
      if (
        incident.length !== 2 ||
        incident.some((edge) => edge.from === edge.to)
      )
        continue;
      const [first, second] = incident;
      const firstPoints =
        first.to === node ? first.points : [...first.points].reverse();
      const secondPoints =
        second.from === node ? second.points : [...second.points].reverse();
      edges = edges.filter((edge) => edge !== first && edge !== second);
      edges.push({
        from: first.from === node ? first.to : first.from,
        to: second.from === node ? second.to : second.from,
        points: [...firstPoints, ...secondPoints.slice(1)],
        support: Math.min(first.support, second.support),
      });
      changed = true;
    }
  }
  return edges.sort(
    (first, second) => first.from - second.from || first.to - second.to,
  );
}
