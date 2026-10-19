import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./ingest-edits.ts", import.meta.url));
const coordinates = [[-76.116, 45.057], [-76.1159, 45.057]];
const empty = { type: "FeatureCollection", features: [] };
const fixture = () => ({
  format: "windstone-edits", version: 1, exportedAt: "2026-10-18T12:00:03Z",
  trailNames: { type: "FeatureCollection", features: [{ type: "Feature", properties: { name: "Farm Loop" }, geometry: { type: "MultiLineString", coordinates: [coordinates] } }] },
  landmarks: { type: "FeatureCollection", features: [{ type: "Feature", id: "gate", properties: { id: "gate", name: "Gate", icon: "gate" }, geometry: { type: "Point", coordinates: coordinates[0] } }] },
  walks: { type: "FeatureCollection", features: [{ type: "Feature", id: "walk-1", properties: { id: "walk-1", times: ["2026-10-18T12:00:00Z", "2026-10-18T12:00:02Z"], accuracies: [5, 6], recordedAt: "2026-10-18T12:00:00Z", device: "Windstone recorder" }, geometry: { type: "LineString", coordinates } }] },
});

describe("edits ingestion CLI", () => {
  let directory: string;
  let data: string;
  let traces: string;
  let input: string;

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "windstone-edits-"));
    data = join(directory, "data");
    traces = join(directory, "traces", "raw");
    input = join(directory, "edits.json");
    await mkdir(data);
    await writeFile(join(data, "trails.geojson"), JSON.stringify({ type: "FeatureCollection", features: [{ type: "Feature", properties: { id: "edge-1" }, geometry: { type: "LineString", coordinates } }] }));
    await writeFile(join(data, "trail-names.geojson"), JSON.stringify(empty));
    await writeFile(join(data, "landmarks.geojson"), JSON.stringify(empty));
  });
  afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

  const run = (...args: string[]) => spawnSync(process.execPath, [script, input, "--data-dir", data, "--traces-dir", traces, ...args], { encoding: "utf8" });
  const saved = async (name: string) => JSON.parse(await readFile(join(data, name), "utf8"));

  it("publishes edits and preserves recorded metadata without duplicating repeated imports", async () => {
    const bundle = fixture();
    await writeFile(input, JSON.stringify(bundle));
    expect(run().status).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(bundle.trailNames);
    expect(await saved("landmarks.geojson")).toEqual(bundle.landmarks);
    const files = await readdir(traces);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(traces, files[0]), "utf8"))).toEqual(bundle.walks);
    expect(run().status).toBe(0);
    expect(await readdir(traces)).toEqual(files);
    expect(JSON.parse(await readFile(input, "utf8"))).toEqual(bundle);
  });

  it("supports dry runs without writing published files or creating trace directories", async () => {
    await writeFile(input, JSON.stringify(fixture()));
    const result = run("--dry-run");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Validated 1 trail names");
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
    await expect(readdir(traces)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unmatched sections before changing any published data", async () => {
    const bundle = fixture();
    bundle.trailNames.features[0].geometry.coordinates = [[[-77, 45], [-77.001, 45]]];
    await writeFile(input, JSON.stringify(bundle));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("does not match the current map");
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
    await expect(readdir(traces)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects invalid recording metadata and duplicate landmark IDs before writing", async () => {
    const bundle = fixture();
    bundle.walks.features[0].properties.accuracies = [5];
    await writeFile(input, JSON.stringify(bundle));
    expect(run().stderr).toContain("must match its coordinates");
    const duplicate = fixture();
    duplicate.landmarks.features.push(duplicate.landmarks.features[0]);
    await writeFile(input, JSON.stringify(duplicate));
    expect(run().stderr).toContain("duplicate landmark ID");
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
  });

  it("accepts reversed matching geometry and empty snapshots without creating raw traces", async () => {
    const bundle = fixture();
    bundle.trailNames.features[0].geometry.coordinates = [[...coordinates].reverse()];
    bundle.walks.features = [];
    await writeFile(input, JSON.stringify(bundle));
    expect(run().status).toBe(0);
    await writeFile(input, JSON.stringify({ ...bundle, trailNames: empty, landmarks: empty }));
    expect(run().status).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
    await expect(readdir(traces)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects unsupported versions", async () => {
    await writeFile(input, JSON.stringify({ ...fixture(), version: 2 }));
    const result = run();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version 1 Windstone edits");
    expect(await saved("trail-names.geojson")).toEqual(empty);
  });
});