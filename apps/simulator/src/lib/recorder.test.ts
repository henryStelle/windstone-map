import { describe, expect, it } from "vitest";
import { appendPosition, unacknowledgedSegments } from "./useRecorder";
import ingestedJson from "../../../../data/ingested.json?raw";

function fix(timestamp: number, longitude = -76.116): GeolocationPosition {
  return {
    timestamp,
    coords: {
      longitude,
      latitude: 45.057,
      accuracy: 5,
      altitude: null,
      altitudeAccuracy: null,
      heading: null,
      speed: null,
      toJSON: () => ({}),
    },
    toJSON: () => ({}),
  };
}

describe("recorded fixes", () => {
  it("cleans up received IDs but never treats a download as ingestion", () => {
    const first = appendPosition(null, fix(1000));
    const acknowledgments = JSON.parse(ingestedJson) as { ingested: string[] };
    const received = { ...first, id: acknowledgments.ingested[0] };
    const exported = { ...first, id: "not-yet-ingested", exported: true };
    expect(unacknowledgedSegments([received, exported])).toEqual([exported]);
  });

  it("keeps aligned metadata and appends without mutating previous fixes", () => {
    const first = appendPosition(null, fix(1000));
    const next = appendPosition(first, fix(3000, -76.1159));
    expect(next.id).toBe(first.id);
    expect(first.coordinates).toHaveLength(1);
    expect(next.coordinates).toHaveLength(2);
    expect(next.times).toHaveLength(2);
    expect(next.accuracies).toEqual([5, 5]);
  });

  it("never joins across GPS gaps, repeated timestamps, or resumed segments", () => {
    const first = appendPosition(null, fix(1000));
    expect(appendPosition(first, fix(12000)).id).not.toBe(first.id);
    expect(appendPosition(first, fix(1000)).id).not.toBe(first.id);
    expect(appendPosition(null, fix(3000)).id).not.toBe(first.id);
    expect(() => appendPosition(first, fix(3000, NaN))).toThrow(
      "Invalid GPS fix",
    );
  });
});
