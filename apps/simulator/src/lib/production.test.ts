import { afterEach, describe, expect, it, vi } from "vitest";
import trailsJson from "../../../../production/trails.geojson?raw";
import landmarksJson from "../../../../production/landmarks.geojson?raw";
import namesJson from "../../../../production/trail-names.geojson?raw";
import ingestedJson from "../../../../production/ingested.json?raw";
import { trails, landmarks } from "./trails";
import { published } from "./published";
import { applyNames, parseLandmarks } from "./editing";
import { LANDMARKS_KEY, NAMES_KEY, loadActiveDraft } from "./drafts";
import { RECORDER_DATABASE } from "./storage";
import { appendPosition, unacknowledgedSegments } from "./useRecorder";

afterEach(() => vi.unstubAllGlobals());

describe.runIf(import.meta.env.MODE === "production")(
  "production isolation",
  () => {
    it("loads only the production map, landmarks, and trail names", () => {
      expect(trails).toEqual(JSON.parse(trailsJson));
      expect(landmarks).toEqual(JSON.parse(landmarksJson));
      expect(published).toEqual(
        applyNames(trails.features, JSON.parse(namesJson)),
      );
    });

    it("ignores browser-saved development landmarks and names without deleting them", () => {
      const storage = new Map([
        [
          "windstone-editor-landmarks-v1",
          JSON.stringify({
            type: "FeatureCollection",
            features: [
              {
                type: "Feature",
                geometry: { type: "Point", coordinates: [-76.116, 45.057] },
                properties: { id: "dev-place", name: "Development landmark" },
              },
            ],
          }),
        ],
        ["windstone-editor-names-v1", "invalid development names"],
      ]);
      vi.stubGlobal("localStorage", {
        getItem: (key: string) => storage.get(key) ?? null,
        removeItem: (key: string) => storage.delete(key),
      });
      expect(NAMES_KEY).not.toBe("windstone-editor-names-v1");
      expect(LANDMARKS_KEY).not.toBe("windstone-editor-landmarks-v1");
      expect(RECORDER_DATABASE).not.toBe("windstone-recorder");
      expect(loadActiveDraft()).toEqual({
        segments: published.segments,
        places: parseLandmarks(landmarks),
        warning:
          published.unmatched > 0
            ? `${published.unmatched} named sections no longer match this map.`
            : null,
      });
      expect(storage.size).toBe(2);
    });

    it("acknowledges recordings using production IDs only", () => {
      const recorded = appendPosition(null, {
        timestamp: 1000,
        coords: { longitude: -76.116, latitude: 45.057, accuracy: 5 },
      } as GeolocationPosition);
      const acknowledgments: { ingested: string[]; rejected: string[] } =
        JSON.parse(ingestedJson);
      const received = new Set([
        ...acknowledgments.ingested,
        ...acknowledgments.rejected,
      ]);
      const recordings = [
        recorded,
        ...[...received].map((id) => ({ ...recorded, id })),
      ];
      expect(unacknowledgedSegments(recordings)).toEqual(
        recordings.filter((segment) => !received.has(segment.id)),
      );
    });
  },
);
