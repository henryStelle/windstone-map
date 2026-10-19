import { afterEach, describe, expect, it, vi } from "vitest";
import {
  applyNames,
  connectedSections,
  editsFile,
  namesFile,
  parseLandmarks,
  removeName,
  sameLandmarks,
  sameNames,
  saveName,
} from "./editing";
import type { FeatureCollection, LineString } from "geojson";
import { groupNamedTrails, landmarks, type Trail } from "./trails";
import {
  hasLocalMapEdits,
  LANDMARKS_KEY,
  loadActiveDraft,
  NAMES_KEY,
  persistLandmarks,
} from "./drafts";
import { published } from "./published";

afterEach(() => vi.unstubAllGlobals());

describe("editor files", () => {
  const segments: Trail[] = [
    {
      type: "Feature",
      properties: { id: "first", from: "start", to: "junction", support: 1, lengthMeters: 80 },
      geometry: { type: "LineString", coordinates: [[-76.116, 45.057], [-76.115, 45.057]] },
    },
    {
      type: "Feature",
      properties: { id: "second", from: "junction", to: "end", support: 1, lengthMeters: 80 },
      geometry: { type: "LineString", coordinates: [[-76.115, 45.057], [-76.114, 45.057]] },
    },
  ];
  const ids = segments.map((segment) => segment.properties.id);

  it("blocks disconnected sections for both new trails and updates without changing saved names", () => {
    const section = (id: string, from: string, to: string) => ({
      ...segments[0],
      properties: { ...segments[0].properties, id, from, to },
    });
    const network = [
      section("first", "start", "junction"),
      section("bridge", "junction", "far-junction"),
      section("last", "far-junction", "end"),
      section("branch", "junction", "branch-end"),
    ];
    expect(connectedSections(network, [])).toBe(false);
    expect(connectedSections(network, ["first"])).toBe(true);
    expect(connectedSections(network, ["first", "last"])).toBe(false);
    expect(
      connectedSections(network, ["first", "bridge", "last", "branch"]),
    ).toBe(true);
    expect(() => saveName(network, null, "Broken", ["first", "last"])).toThrow(
      "disconnected",
    );
    const saved = saveName(network, null, "Loop", ["first", "bridge", "last"]);
    expect(() => saveName(saved, "loop", "Renamed", ["first", "last"])).toThrow(
      "disconnected",
    );
    expect(groupNamedTrails(saved).map((trail) => trail.name)).toEqual([
      "Loop",
    ]);
  });

  it("compares snapshots independently of feature order, object keys and default icons", () => {
    const named = saveName(segments, null, "Loop", ids);
    expect(sameNames(named, [...named].reverse())).toBe(true);
    expect(sameNames(named, segments)).toBe(false);
    const places = parseLandmarks({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "gate", name: "Gate" },
          geometry: { type: "Point", coordinates: [-76.116, 45.057] },
        },
      ],
    });
    const explicitPin = {
      ...places,
      features: places.features.map((feature) => ({
        ...feature,
        properties: {
          name: feature.properties.name,
          icon: "pin",
          id: feature.properties.id,
        },
      })),
    };
    expect(sameLandmarks(places, explicitPin)).toBe(true);
    expect(
      sameLandmarks(places, {
        ...explicitPin,
        features: explicitPin.features.map((feature) => ({
          ...feature,
          properties: { ...feature.properties, icon: "water" },
        })),
      }),
    ).toBe(false);
  });

  it("removes acknowledged draft keys while retaining unsubmitted edits", () => {
    const storage = new Map<string, string>([
      [NAMES_KEY, JSON.stringify(namesFile(published.segments))],
      [LANDMARKS_KEY, JSON.stringify(landmarks)],
    ]);
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    });
    vi.stubGlobal("window", { dispatchEvent: vi.fn() });
    const draft = loadActiveDraft();
    expect(hasLocalMapEdits(draft.segments, draft.places)).toBe(false);
    expect(storage.size).toBe(0);
    const changed = {
      ...draft.places,
      features: [
        ...draft.places.features,
        {
          type: "Feature" as const,
          id: "new-place",
          properties: { id: "new-place", name: "New place", icon: "water" },
          geometry: { type: "Point" as const, coordinates: [-76.116, 45.057] },
        },
      ],
    };
    persistLandmarks(changed);
    expect(hasLocalMapEdits(draft.segments, changed)).toBe(true);
    expect(storage.has(LANDMARKS_KEY)).toBe(true);
    expect(loadActiveDraft().places).toEqual(changed);
  });

  it("bundles names, landmarks and full walk metadata in one versioned file", () => {
    const named = saveName(
      saveName(segments, null, "Loop", ids),
      null,
      "Shortcut",
      [ids[0]],
    );
    const landmarks = parseLandmarks({
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "gate", name: "Gate", icon: "gate" },
          geometry: { type: "Point", coordinates: [-76.116, 45.057] },
        },
      ],
    });
    const walks: FeatureCollection<LineString> = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          id: "walk-1",
          properties: {
            id: "walk-1",
            times: ["2026-10-18T12:00:00Z", "2026-10-18T12:00:02Z"],
            accuracies: [5, 6],
            recordedAt: "2026-10-18T12:00:00Z",
            device: "Windstone recorder",
          },
          geometry: {
            type: "LineString",
            coordinates: [
              [-76.116, 45.057],
              [-76.1159, 45.057],
            ],
          },
        },
      ],
    };
    const file = JSON.parse(JSON.stringify(editsFile(named, landmarks, walks)));
    expect(file).toMatchObject({
      format: "windstone-edits",
      version: 1,
      trailNames: namesFile(named),
      landmarks,
      walks,
    });
    expect(Number.isFinite(Date.parse(file.exportedAt))).toBe(true);
    expect(applyNames(segments, file.trailNames).unmatched).toBe(0);
    expect(
      editsFile(
        segments,
        { type: "FeatureCollection", features: [] },
        { type: "FeatureCollection", features: [] },
      ).walks.features,
    ).toEqual([]);
  });

  it("creates and removes overlapping names independently", () => {
    const shared = saveName(
      saveName(segments, null, "Loop", ids),
      null,
      "Shortcut",
      [ids[0]],
    );
    expect(groupNamedTrails(shared).map((trail) => trail.name)).toEqual([
      "Loop",
      "Shortcut",
    ]);
    expect(
      groupNamedTrails(removeName(shared, "loop"))[0].segments,
    ).toHaveLength(1);
    expect(() => saveName(shared, null, "Loop", ids)).toThrow("already exists");
    expect(() => saveName(segments, null, "", ids)).toThrow(
      "Enter a trail name",
    );
    expect(() => saveName(segments, null, "Loop", [])).toThrow(
      "Select at least one",
    );
  });

  it("round-trips names by geometry rather than unstable IDs", () => {
    const file = namesFile(
      saveName(saveName(segments, null, "Loop", ids), null, "Shortcut", [
        ids[0],
      ]),
    );
    const changed = segments.map((segment, index) => ({
      ...segment,
      properties: { ...segment.properties, id: `changed-${index}` },
      geometry: {
        ...segment.geometry,
        coordinates: [...segment.geometry.coordinates].reverse(),
      },
    }));
    const restored = applyNames(changed, JSON.parse(JSON.stringify(file)));
    expect(restored.unmatched).toBe(0);
    expect(
      groupNamedTrails(restored.segments).map((trail) => [
        trail.name,
        trail.segments.length,
      ]),
    ).toEqual([
      ["Loop", 2],
      ["Shortcut", 1],
    ]);
    expect(applyNames([], file).unmatched).toBe(3);
  });

  it("validates landmarks and preserves names and IDs", () => {
    const file = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          geometry: { type: "Point", coordinates: [-76.116, 45.057] },
          properties: { id: "gate", name: " Gate " },
        },
      ],
    };
    expect(parseLandmarks(file).features[0].properties).toEqual({
      id: "gate",
      name: "Gate",
    });
    expect(() =>
      parseLandmarks({
        ...file,
        features: [
          {
            ...file.features[0],
            geometry: { type: "Point", coordinates: [999, 45] },
          },
        ],
      }),
    ).toThrow("landmark");
    expect(() => parseLandmarks({})).toThrow("FeatureCollection");
  });
});
