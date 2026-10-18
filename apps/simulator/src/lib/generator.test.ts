import { describe, expect, it } from "vitest";
import { generateWalks } from "./generator";
import type { TrailGraph } from "./graph";
import { walksFromGeoJson } from "./walks";

const graph: TrailGraph = {
  nodes: [
    { id: "a", coordinate: [-80, 35] },
    { id: "b", coordinate: [-79.999, 35] },
    { id: "c", coordinate: [-79.998, 35] },
    { id: "d", coordinate: [-79.999, 35.001] },
  ],
  edges: [
    { id: "ab", from: "a", to: "b" },
    { id: "bc", from: "b", to: "c" },
    { id: "bd", from: "b", to: "d" },
  ],
};

describe("generateWalks", () => {
  it("creates deterministic, partial, noisy trace fixtures", () => {
    const options = {
      count: 100,
      noiseMeters: 4,
      sampleSpacingMeters: 8,
      seed: "repeatable",
    };
    const first = generateWalks(graph, options);
    const second = generateWalks(graph, options);

    expect(first).toEqual(second);
    expect(first.features).toHaveLength(100);
    expect(
      first.features.every(
        (feature) => feature.geometry.coordinates.length > 2,
      ),
    ).toBe(true);
    expect(
      first.features.every(
        (feature) =>
          feature.properties.truthEdgeIds.length < graph.edges.length,
      ),
    ).toBe(true);
    expect(first.features[0].properties.times).toHaveLength(
      first.features[0].geometry.coordinates.length,
    );
    expect(first.features[0].properties.accuracies).toHaveLength(
      first.features[0].geometry.coordinates.length,
    );
  });
});

describe("walk imports", () => {
  const walks = generateWalks(graph, { count: 2, noiseMeters: 4, sampleSpacingMeters: 8, seed: "import" });

  it("preserves saved traces and metadata", () => {
    expect(walksFromGeoJson(walks)).toEqual(walks);
  });

  it("rejects malformed collections and missing segment IDs", () => {
    expect(() => walksFromGeoJson({ ...walks, type: "Feature" } as never)).toThrow("FeatureCollection");
    expect(() => walksFromGeoJson({ ...walks, features: [{ ...walks.features[0], id: undefined, properties: {} }] })).toThrow("segment ID");
    expect(() => walksFromGeoJson({ ...walks, features: [{ ...walks.features[0], geometry: { type: "LineString", coordinates: [[NaN, 45], [-76, 45]] } }] })).toThrow("valid GPS");
  });
});
