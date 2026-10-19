import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import Viewer from "./Viewer";
import { icons } from "lucide-react";
import { LANDMARK_ICONS, landmarkIcon, LandmarkSymbol } from "./lib/landmark-icons";

vi.mock("maplibre-gl", () => ({ default: {} }));
vi.mock("./lib/trails", async (importOriginal) => {
  const original = await importOriginal<typeof import("./lib/trails")>();
  const segment = (id: string, lengthMeters: number, names?: string[]) => ({
    ...original.trails.features[0],
    properties: { ...original.trails.features[0].properties, id, lengthMeters, names },
  });
  const features = [segment("shared", 40, ["Meadow Loop", "Shortcut"]), segment("continuation", 60, ["Meadow Loop"]), segment("unnamed", 300)];
  return { ...original, trails: { ...original.trails, features }, namedTrails: original.groupNamedTrails(features) };
});

afterEach(() => vi.unstubAllGlobals());

describe("named trail list", () => {
  it("supports the complete installed icon catalogue and preserves legacy IDs", () => {
    expect(LANDMARK_ICONS).toHaveLength(Object.keys(icons).length);
    expect(new Set(LANDMARK_ICONS.map((icon) => icon.id)).size).toBe(LANDMARK_ICONS.length);
    expect(landmarkIcon("water").Icon).toBe(icons.Droplets);
    expect(landmarkIcon("camera").Icon).toBe(icons.Camera);
    expect(landmarkIcon("pin").Icon).toBe(icons.MapPin);
    expect(landmarkIcon("pin-tack").Icon).toBe(icons.Pin);
    expect(landmarkIcon("unknown-icon").id).toBe("pin");
    expect(renderToStaticMarkup(<LandmarkSymbol icon="camera" />)).toContain("lucide-camera");
  });

  it("renders each name once, combining segments and omitting unnamed rows", () => {
    vi.stubGlobal("navigator", { onLine: true });
    const html = renderToStaticMarkup(<Viewer />);
    expect(html.match(/class="trail-row"/g)).toHaveLength(2);
    expect(html.match(/>Meadow Loop</g)).toHaveLength(1);
    expect(html.match(/>Shortcut</g)).toHaveLength(1);
    expect(html).toContain("<small>100 m</small>");
    expect(html).toContain("<small>40 m</small>");
    expect(html).toContain("400 m");
    expect(html).not.toContain("Trail 1");
    expect(html).not.toContain("Search trails");
  });
});