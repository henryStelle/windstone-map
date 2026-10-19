import type { FeatureCollection, LineString } from "geojson";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { evaluateNetwork } from "./evaluate.ts";
import { mergeTraces } from "./merge.ts";
import { generateWalks } from "../../../apps/simulator/src/lib/generator.ts";
import { graphFromGeoJson } from "../../../apps/simulator/src/lib/graph.ts";

function lines(coordinates: number[][][]): FeatureCollection<LineString> {
  return {
    type: "FeatureCollection",
    features: coordinates.map((line) => ({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: line },
    })),
  };
}

describe("network evaluation", () => {
  const truth = lines([
    [
      [0, 0],
      [0.001, 0],
    ],
  ]);

  it("scores identical geometry perfectly regardless of segmentation or direction", () => {
    const predicted = lines([
      [
        [0.001, 0],
        [0.0005, 0],
      ],
      [
        [0.0005, 0],
        [0, 0],
      ],
    ]);
    const score = evaluateNetwork(predicted, truth);
    expect(score.precision).toBe(1);
    expect(score.recall).toBe(1);
    expect(score.meanErrorMeters).toBeCloseTo(0);
  });

  it("penalizes missing trails, extraneous trails, and positional offsets", () => {
    expect(
      evaluateNetwork(
        lines([
          [
            [0, 0],
            [0.0005, 0],
          ],
        ]),
        truth,
      ).recall,
    ).toBeLessThan(0.6);
    expect(
      evaluateNetwork(
        lines([
          [
            [0, 0],
            [0.001, 0],
          ],
          [
            [0, 0.001],
            [0.001, 0.001],
          ],
        ]),
        truth,
      ).precision,
    ).toBeCloseTo(0.5);
    expect(
      evaluateNetwork(
        lines([
          [
            [0, 0.0001],
            [0.001, 0.0001],
          ],
        ]),
        truth,
      ).f1,
    ).toBe(0);
  });

  it("handles empty predictions without reporting perfect accuracy", () => {
    const score = evaluateNetwork(lines([]), truth);
    expect(score.f1).toBe(0);
    expect(score.meanErrorMeters).toBeNull();
    expect(score.missingTruthMeters).toBeCloseTo(score.truthLengthMeters);
  });

  it("reports disconnected crossings even when positional scores are perfect", () => {
    const connected = lines([
      [
        [0, 0],
        [0.001, 0],
      ],
      [
        [0.001, 0],
        [0.002, 0],
      ],
      [
        [0.001, -0.001],
        [0.001, 0],
      ],
      [
        [0.001, 0],
        [0.001, 0.001],
      ],
    ]);
    const crossing = lines([
      [
        [0, 0],
        [0.002, 0],
      ],
      [
        [0.001, -0.001],
        [0.001, 0.001],
      ],
    ]);
    const score = evaluateNetwork(crossing, connected);
    expect(score.f1).toBeCloseTo(1);
    expect(score.topology.truthJunctions).toBe(1);
    expect(score.topology.matchedJunctions).toBe(0);
    expect(score.topology.mergedComponents).toBe(2);
  });
});

function traces(coordinates: number[][][]): FeatureCollection<LineString> {
  const collection = lines(coordinates);
  collection.features.forEach((feature, index) => {
    feature.id = `trace-${index}`;
    feature.properties = { id: feature.id };
  });
  return collection;
}

describe("trace merging", () => {
  const line = [
    [0, 0],
    [0.001, 0],
  ];

  it("merges overlapping and reversed walks without truth labels", () => {
    const input = traces([
      line,
      [...line].reverse(),
      [
        [0.0002, 0.00001],
        [0.0008, 0.00001],
      ],
    ]);
    const result = mergeTraces(input);
    const score = evaluateNetwork(result.trails, lines([line]));
    expect(result.trails.features).toHaveLength(1);
    expect(score.precision).toBeGreaterThan(0.99);
    expect(score.recall).toBeGreaterThan(0.9);
  });

  it("deduplicates segments, is input-order independent, and requires independent support", () => {
    const input = traces([line, [...line].reverse()]);
    const forward = mergeTraces(input);
    expect(
      mergeTraces({ ...input, features: [...input.features].reverse() }).trails,
    ).toEqual(forward.trails);
    const duplicate = mergeTraces({
      ...input,
      features: [input.features[0], input.features[0]],
    });
    expect(duplicate.stats.duplicates).toBe(1);
    expect(duplicate.trails.features).toHaveLength(0);
  });

  it("never draws across a recording gap or a low-accuracy fix", () => {
    const coordinates = [
      [0, 0],
      [0.0004, 0],
      [0.002, 0],
      [0.0024, 0],
    ];
    const input = traces([coordinates, coordinates]);
    for (const feature of input.features)
      feature.properties = {
        ...feature.properties,
        times: [
          "2025-01-01T00:00:00Z",
          "2025-01-01T00:00:02Z",
          "2025-01-01T00:01:00Z",
          "2025-01-01T00:01:02Z",
        ],
      };
    const result = mergeTraces(input);
    expect(result.trails.features).toHaveLength(2);
    expect(
      result.trails.features.every(
        (feature) => feature.properties.lengthMeters < 60,
      ),
    ).toBe(true);
    for (const feature of input.features)
      feature.properties!.accuracies = [5, 5, 100, 5];
    const filtered = mergeTraces(input);
    expect(filtered.stats.droppedFixes).toBe(2);
    expect(filtered.trails.features).toHaveLength(1);
  });

  it("preserves a supported loop and rejects malformed metadata", () => {
    const loop = [
      [0, 0],
      [0.001, 0],
      [0.001, 0.001],
      [0, 0.001],
      [0, 0],
    ];
    const result = mergeTraces(traces([loop, [...loop].reverse()]));
    expect(
      evaluateNetwork(result.trails, lines([loop])).recall,
    ).toBeGreaterThan(0.85);
    expect(
      result.trails.features.some(
        (feature) => feature.properties.from === feature.properties.to,
      ),
    ).toBe(true);
    const malformed = traces([line]);
    malformed.features[0].properties!.accuracies = [5];
    expect(mergeTraces(malformed).ingested.rejected).toEqual(["trace-0"]);
    expect(mergeTraces(lines([])).trails.features).toHaveLength(0);
  });

  it("collapses nearby raster junctions at a supported four-way intersection", () => {
    const horizontal = [
      [0, 0.001],
      [0.002, 0.001],
    ];
    const vertical = [
      [0.001, 0],
      [0.001, 0.002],
    ];
    const result = mergeTraces(
      traces([horizontal, horizontal, vertical, vertical]),
    );
    expect(result.stats.junctions).toBe(1);
    expect(result.trails.features).toHaveLength(4);
  });
});

describe("output smoothing", () => {
  it("reduces zigzags on a noisy straight trail without moving its graph endpoints", () => {
    const truth = lines([
      [
        [0, 0],
        [0.004, 0.001],
      ],
    ]);
    const walks = generateWalks(graphFromGeoJson(truth), {
      count: 25,
      noiseMeters: 5,
      sampleSpacingMeters: 6,
      seed: "smoothing-straight",
    });
    const original = mergeTraces(walks, { outputSmoothingMeters: 0 });
    const smoothed = mergeTraces(walks);
    const turning = (collection: FeatureCollection<LineString>) =>
      collection.features.reduce((sum, feature) => {
        const coordinates = feature.geometry.coordinates;
        for (let index = 1; index < coordinates.length - 1; index += 1) {
          const before = coordinates[index - 1];
          const point = coordinates[index];
          const after = coordinates[index + 1];
          const firstX = point[0] - before[0];
          const firstY = point[1] - before[1];
          const secondX = after[0] - point[0];
          const secondY = after[1] - point[1];
          sum += Math.abs(
            Math.atan2(
              firstX * secondY - firstY * secondX,
              firstX * secondX + firstY * secondY,
            ),
          );
        }
        return sum;
      }, 0);
    expect(original.trails.features).toHaveLength(1);
    expect(turning(original.trails)).toBeGreaterThan(0);
    expect(turning(smoothed.trails)).toBeLessThan(
      turning(original.trails) * 0.7,
    );
    expect(smoothed.stats).toEqual(original.stats);
    for (const [index, feature] of smoothed.trails.features.entries()) {
      const before = original.trails.features[index];
      expect(feature.properties.from).toBe(before.properties.from);
      expect(feature.properties.to).toBe(before.properties.to);
      expect(feature.geometry.coordinates[0]).toEqual(
        before.geometry.coordinates[0],
      );
      expect(feature.geometry.coordinates.at(-1)).toEqual(
        before.geometry.coordinates.at(-1),
      );
      expect(feature.properties.lengthMeters).toBeLessThan(
        before.properties.lengthMeters,
      );
    }
    expect(evaluateNetwork(smoothed.trails, truth).f1).toBeGreaterThan(0.99);
  });

  it("preserves shared junctions and improves saved-network geometry", () => {
    const truth = JSON.parse(
      readFileSync(new URL("../../../truth.geojson", import.meta.url), "utf8"),
    );
    const walks = JSON.parse(
      readFileSync(
        new URL("../../../walks-windstone-001.geojson", import.meta.url),
        "utf8",
      ),
    );
    const original = mergeTraces(walks, { outputSmoothingMeters: 0 });
    const smoothed = mergeTraces(walks);
    expect(smoothed.stats).toEqual(original.stats);
    for (const [index, feature] of smoothed.trails.features.entries()) {
      const before = original.trails.features[index];
      expect(feature.geometry.coordinates[0]).toEqual(
        before.geometry.coordinates[0],
      );
      expect(feature.geometry.coordinates.at(-1)).toEqual(
        before.geometry.coordinates.at(-1),
      );
    }
    expect(
      evaluateNetwork(smoothed.trails, truth).meanErrorMeters,
    ).toBeLessThan(evaluateNetwork(original.trails, truth).meanErrorMeters!);
  });
});

describe("root fixture accuracy", () => {
  const truth: FeatureCollection = JSON.parse(
    readFileSync(new URL("../../../truth.geojson", import.meta.url), "utf8"),
  );
  const fixture: FeatureCollection = JSON.parse(
    readFileSync(
      new URL("../../../walks-windstone-001.geojson", import.meta.url),
      "utf8",
    ),
  );

  it("recovers the source network without using simulator labels", () => {
    const clean = {
      ...fixture,
      features: fixture.features.map((feature) => ({
        ...feature,
        properties: {
          id: feature.properties!.id,
          times: feature.properties!.times,
          accuracies: feature.properties!.accuracies,
        },
      })),
    };
    const result = mergeTraces(clean);
    const score = evaluateNetwork(result.trails, truth);
    expect(result.trails).toEqual(mergeTraces(fixture).trails);
    expect(score.f1).toBeGreaterThan(0.99);
    expect(score.meanErrorMeters).toBeLessThan(1);
    expect(score.topology.junctionF1).toBeGreaterThanOrEqual(0.8);
    expect(score.topology.mergedComponents).toBe(
      score.topology.truthComponents,
    );
  });

  it("generalizes to a different walk and noise seed on the same network", () => {
    const walks = generateWalks(graphFromGeoJson(truth), {
      count: 300,
      noiseMeters: 5,
      sampleSpacingMeters: 6,
      seed: "merge-validation-002",
    });
    const score = evaluateNetwork(mergeTraces(walks).trails, truth);
    expect(score.f1).toBeGreaterThan(0.99);
    expect(score.meanErrorMeters).toBeLessThan(1);
    expect(score.topology.junctionF1).toBeGreaterThanOrEqual(0.8);
  });
});
