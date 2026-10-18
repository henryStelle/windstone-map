import type { Feature, FeatureCollection, LineString, Position } from "geojson";

export type Coordinate = [longitude: number, latitude: number];

export interface TrailNode {
  id: string;
  coordinate: Coordinate;
}

export interface TrailEdge {
  id: string;
  from: string;
  to: string;
}

export interface TrailGraph {
  nodes: TrailNode[];
  edges: TrailEdge[];
}

export const EMPTY_GRAPH: TrailGraph = { nodes: [], edges: [] };

export function connectNodes(
  graph: TrailGraph,
  from: string,
  to: string,
): TrailGraph {
  if (
    from === to ||
    graph.edges.some(
      (edge) =>
        (edge.from === from && edge.to === to) ||
        (edge.from === to && edge.to === from),
    )
  ) {
    return graph;
  }

  return {
    ...graph,
    edges: [...graph.edges, { id: crypto.randomUUID(), from, to }],
  };
}

export function graphToGeoJson(
  graph: TrailGraph,
): FeatureCollection<LineString> {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const features = graph.edges.flatMap<Feature<LineString>>((edge) => {
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) return [];

    return [
      {
        type: "Feature",
        id: edge.id,
        properties: { id: edge.id, from: edge.from, to: edge.to },
        geometry: {
          type: "LineString",
          coordinates: [from.coordinate, to.coordinate],
        },
      },
    ];
  });

  return { type: "FeatureCollection", features };
}

export function graphFromGeoJson(collection: FeatureCollection): TrailGraph {
  const nodes = new Map<string, TrailNode>();
  const edges: TrailEdge[] = [];

  for (const feature of collection.features) {
    if (
      feature.geometry?.type !== "LineString" ||
      feature.geometry.coordinates.length < 2
    )
      continue;

    const properties = feature.properties ?? {};
    const first = feature.geometry.coordinates[0] as Position;
    const last = feature.geometry.coordinates.at(-1) as Position;
    const from =
      typeof properties.from === "string"
        ? properties.from
        : coordinateId(first);
    const to =
      typeof properties.to === "string" ? properties.to : coordinateId(last);

    nodes.set(from, { id: from, coordinate: [first[0], first[1]] });
    nodes.set(to, { id: to, coordinate: [last[0], last[1]] });
    edges.push({
      id:
        typeof properties.id === "string" ? properties.id : crypto.randomUUID(),
      from,
      to,
    });
  }

  return { nodes: [...nodes.values()], edges };
}

export function nearestNode<T extends { x: number; y: number }>(
  nodes: TrailNode[],
  project: (coordinate: Coordinate) => T,
  point: T,
  threshold: number,
): TrailNode | undefined {
  let nearest: TrailNode | undefined;
  let nearestDistance = threshold;

  for (const node of nodes) {
    const projected = project(node.coordinate);
    const distance = Math.hypot(projected.x - point.x, projected.y - point.y);
    if (distance <= nearestDistance) {
      nearest = node;
      nearestDistance = distance;
    }
  }

  return nearest;
}

function coordinateId(position: Position): string {
  return `node-${position[0].toFixed(7)}-${position[1].toFixed(7)}`;
}
