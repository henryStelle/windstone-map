import { describe, expect, it } from "vitest";
import { formatDistance, groupNamedTrails, landmarks, trails, type Trail } from "./trails";

describe("published trail map", () => {
  it("loads the entire generated network without requiring names", () => {
    expect(trails.features.length).toBeGreaterThan(0);
    expect(trails.features.every((trail) => trail.geometry.coordinates.length >= 2 && trail.properties.lengthMeters > 0)).toBe(true);
    expect(landmarks.type).toBe("FeatureCollection");
  });

  it("formats trail lengths at readable units", () => {
    expect(formatDistance(42.4)).toBe("42 m");
    expect(formatDistance(8575)).toBe("8.6 km");
  });

  it("lists names once across segments and supports overlapping named routes", () => {
    const segment = (id: string, lengthMeters: number, names?: string[], name?: string): Trail => ({
      ...trails.features[0], properties: { ...trails.features[0].properties, id, lengthMeters, names, name },
    });
    const shared = segment("shared", 40, ["Meadow Loop", "Shortcut", " meadow   loop "]);
    const continuation = segment("continuation", 60, ["Meadow Loop"]);
    const unnamed = segment("unnamed", 100);
    const legacy = segment("legacy", 20, undefined, "Meadow Loop");
    const groups = groupNamedTrails([shared, continuation, unnamed, shared, legacy]);
    expect(groups.map((trail) => trail.name)).toEqual(["Meadow Loop", "Shortcut"]);
    expect(groups[0].segments.map((trail) => trail.properties.id)).toEqual(["shared", "continuation", "legacy"]);
    expect(groups[0].lengthMeters).toBe(120);
    expect(groups[1].segments).toEqual([shared]);
    expect(groups[1].lengthMeters).toBe(40);
  });

  it("does not invent names for unnamed or blank-name segments", () => {
    const blank = { ...trails.features[0], properties: { ...trails.features[0].properties, name: "  ", names: ["", "  "] } };
    expect(groupNamedTrails([blank])).toEqual([]);
  });
});