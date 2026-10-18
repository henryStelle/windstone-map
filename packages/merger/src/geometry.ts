import type { FeatureCollection, Position } from "geojson";

export type Point = [number, number];
export type Segment = [Point, Point];

export function projection(coordinates: Position[]) {
  const origin = coordinates[0] ?? [0, 0];
  const latitudeScale = (6_371_008.8 * Math.PI) / 180;
  const longitudeScale = latitudeScale * Math.cos((origin[1] * Math.PI) / 180);
  return {
    project: (coordinate: Position): Point => [
      (coordinate[0] - origin[0]) * longitudeScale,
      (coordinate[1] - origin[1]) * latitudeScale,
    ],
    unproject: (point: Point): Point => [
      origin[0] + point[0] / longitudeScale,
      origin[1] + point[1] / latitudeScale,
    ],
  };
}

export function distance(first: Point, second: Point): number {
  return Math.hypot(first[0] - second[0], first[1] - second[1]);
}

export function segmentDistance(
  point: Point,
  [first, second]: Segment,
): number {
  const deltaX = second[0] - first[0];
  const deltaY = second[1] - first[1];
  const squaredLength = deltaX * deltaX + deltaY * deltaY;
  const fraction =
    squaredLength === 0
      ? 0
      : Math.max(
          0,
          Math.min(
            1,
            ((point[0] - first[0]) * deltaX + (point[1] - first[1]) * deltaY) /
              squaredLength,
          ),
        );
  return Math.hypot(
    point[0] - first[0] - fraction * deltaX,
    point[1] - first[1] - fraction * deltaY,
  );
}

export function lineSegments(
  collection: FeatureCollection,
  project: (coordinate: Position) => Point,
): Segment[] {
  return collection.features.flatMap((feature) => {
    if (feature.geometry?.type !== "LineString") return [];
    const coordinates = feature.geometry.coordinates.map(project);
    return coordinates
      .slice(1)
      .map((point, index): Segment => [coordinates[index], point])
      .filter(([first, second]) => distance(first, second) > 0);
  });
}

export function sampleSegments(segments: Segment[], spacing: number) {
  return segments.flatMap(([first, second]) => {
    const length = distance(first, second);
    const count = Math.max(1, Math.ceil(length / spacing));
    return Array.from({ length: count }, (_, index) => {
      const fraction = (index + 0.5) / count;
      return {
        point: [
          first[0] + fraction * (second[0] - first[0]),
          first[1] + fraction * (second[1] - first[1]),
        ] as Point,
        weight: length / count,
      };
    });
  });
}

export class SegmentIndex {
  private cells = new Map<string, Segment[]>();
  private cellSize = 20;
  private maxCell = 0;

  constructor(segments: Segment[]) {
    for (const segment of segments) {
      const [first, second] = segment;
      const minX = Math.floor(Math.min(first[0], second[0]) / this.cellSize);
      const maxX = Math.floor(Math.max(first[0], second[0]) / this.cellSize);
      const minY = Math.floor(Math.min(first[1], second[1]) / this.cellSize);
      const maxY = Math.floor(Math.max(first[1], second[1]) / this.cellSize);
      this.maxCell = Math.max(
        this.maxCell,
        Math.abs(minX),
        Math.abs(maxX),
        Math.abs(minY),
        Math.abs(maxY),
      );
      for (let cellY = minY; cellY <= maxY; cellY += 1) {
        for (let cellX = minX; cellX <= maxX; cellX += 1) {
          const key = `${cellX},${cellY}`;
          const bucket = this.cells.get(key) ?? [];
          bucket.push(segment);
          this.cells.set(key, bucket);
        }
      }
    }
  }

  nearestDistance(point: Point): number {
    if (this.cells.size === 0) return Infinity;
    const cellX = Math.floor(point[0] / this.cellSize);
    const cellY = Math.floor(point[1] / this.cellSize);
    let nearest = Infinity;
    const limit = this.maxCell + Math.max(Math.abs(cellX), Math.abs(cellY)) + 1;
    for (let radius = 0; radius <= limit; radius += 1) {
      for (let offsetY = -radius; offsetY <= radius; offsetY += 1) {
        for (let offsetX = -radius; offsetX <= radius; offsetX += 1) {
          if (Math.max(Math.abs(offsetX), Math.abs(offsetY)) !== radius)
            continue;
          const bucket =
            this.cells.get(`${cellX + offsetX},${cellY + offsetY}`) ?? [];
          for (const segment of bucket)
            nearest = Math.min(nearest, segmentDistance(point, segment));
        }
      }
      const boundary = Math.min(
        point[0] - (cellX - radius) * this.cellSize,
        (cellX + radius + 1) * this.cellSize - point[0],
        point[1] - (cellY - radius) * this.cellSize,
        (cellY + radius + 1) * this.cellSize - point[1],
      );
      if (nearest <= boundary) break;
    }
    return nearest;
  }
}
