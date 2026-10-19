import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./ingest-edits.ts", import.meta.url));
const mergeScript = fileURLToPath(new URL("./cli.ts", import.meta.url));
const coordinates = [
  [-76.116, 45.057],
  [-76.1159, 45.057],
];
const empty = { type: "FeatureCollection", features: [] };
const fixture = () => ({
  format: "windstone-edits",
  version: 1,
  exportedAt: "2026-10-18T12:00:03Z",
  trailNames: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Farm Loop" },
        geometry: { type: "MultiLineString", coordinates: [coordinates] },
      },
    ],
  },
  landmarks: {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "gate",
        properties: { id: "gate", name: "Gate", icon: "gate" },
        geometry: { type: "Point", coordinates: coordinates[0] },
      },
    ],
  },
  walks: {
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
        geometry: { type: "LineString", coordinates },
      },
    ],
  },
});

describe("edit ingestion and trace merge CLIs", () => {
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
    await writeFile(
      join(data, "trails.geojson"),
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            properties: { id: "edge-1" },
            geometry: { type: "LineString", coordinates },
          },
        ],
      }),
    );
    await writeFile(join(data, "trail-names.geojson"), JSON.stringify(empty));
    await writeFile(join(data, "landmarks.geojson"), JSON.stringify(empty));
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  const invoke = (files: string[], ...args: string[]) =>
    spawnSync(
      process.execPath,
      [script, ...files, "--data-dir", data, "--traces-dir", traces, ...args],
      { encoding: "utf8" },
    );
  const run = (...args: string[]) => invoke([input], ...args);
  const discover = (...args: string[]) =>
    invoke([], "--input-dir", directory, ...args);
  const merge = (...args: string[]) =>
    spawnSync(
      process.execPath,
      [
        mergeScript,
        "--traces-dir",
        join(directory, "traces"),
        "--out-dir",
        join(directory, "merged"),
        ...args,
      ],
      { encoding: "utf8" },
    );
  const saved = async (name: string) =>
    JSON.parse(await readFile(join(data, name), "utf8"));

  it("ingests and merges the first production recording without an existing map", async () => {
    const bundle = fixture();
    bundle.trailNames.features = [];
    bundle.walks.features[0].geometry.coordinates = [
      coordinates[0],
      [-76.115, 45.057],
    ];
    data = join(directory, "new-production");
    await writeFile(input, JSON.stringify(bundle));
    const dryRun = run("--dry-run");
    expect(dryRun.status, dryRun.stderr).toBe(0);
    await expect(readdir(data)).rejects.toMatchObject({ code: "ENOENT" });
    const ingested = run();
    expect(ingested.status, ingested.stderr).toBe(0);
    expect(await saved("landmarks.geojson")).toEqual(bundle.landmarks);
    const merged = merge("--out-dir", data);
    expect(merged.status, merged.stderr).toBe(0);
    expect((await saved("trails.geojson")).features).toHaveLength(1);
    expect(await saved("ingested.json")).toEqual({
      ingested: ["walk-1"],
      rejected: [],
    });
    expect((await saved("merge-report.json")).inputs).toHaveLength(1);
    expect(await readdir(traces)).toHaveLength(1);
    expect(JSON.parse(await readFile(input, "utf8"))).toEqual(bundle);
    const repeated = run();
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(await readdir(traces)).toHaveLength(1);
  });

  it("refuses to publish development fixtures to production by default", () => {
    const walk = fileURLToPath(
      new URL("../../../data/recorded-002/walks.geojson", import.meta.url),
    );
    const result = spawnSync(process.execPath, [mergeScript, "--input", walk], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Development fixtures cannot be published");
    const bundle = fileURLToPath(
      new URL(
        "../../../data/recorded-002/source/windstone-edits-2026-10-19T01-12-10-347Z.json",
        import.meta.url,
      ),
    );
    const ingestion = spawnSync(process.execPath, [script, bundle], {
      encoding: "utf8",
    });
    expect(ingestion.status).toBe(1);
    expect(ingestion.stderr).toContain(
      "Development fixtures cannot be ingested",
    );
  });

  it("discovers edit bundles without explicit input files", async () => {
    const bundle = fixture();
    await writeFile(
      join(directory, "windstone-edits-2026-10-18T12-00-03-000Z.json"),
      JSON.stringify(bundle),
    );
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ private: true }),
    );
    const result = discover();
    expect(result.status, result.stderr).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(bundle.trailNames);
    expect(await saved("landmarks.geojson")).toEqual(bundle.landmarks);
    expect(await readdir(traces)).toHaveLength(1);
  });

  it("preserves every bundle's walks but publishes the newest snapshot by export time", async () => {
    const older = fixture();
    const newer = fixture();
    newer.exportedAt = "2026-10-18T13:00:00Z";
    newer.trailNames.features[0].properties.name = "New Loop";
    newer.landmarks.features[0].properties.name = "New Gate";
    newer.walks.features[0].id = "walk-2";
    newer.walks.features[0].properties.id = "walk-2";
    const olderPath = join(directory, "windstone-edits-z.json");
    const newerPath = join(directory, "windstone-edits-a.json");
    await writeFile(olderPath, JSON.stringify(older));
    await writeFile(newerPath, JSON.stringify(newer));
    const dryRun = discover("--dry-run");
    expect(dryRun.status, dryRun.stderr).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(empty);
    await expect(readdir(traces)).rejects.toMatchObject({ code: "ENOENT" });
    const result = discover();
    expect(result.status, result.stderr).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(newer.trailNames);
    expect(await saved("landmarks.geojson")).toEqual(newer.landmarks);
    const files = await readdir(traces);
    expect(files).toHaveLength(2);
    const preserved = await Promise.all(
      files.map(async (name) =>
        JSON.parse(await readFile(join(traces, name), "utf8")),
      ),
    );
    expect(
      preserved
        .flatMap((collection) =>
          collection.features.map((feature: { id: string }) => feature.id),
        )
        .sort(),
    ).toEqual(["walk-1", "walk-2"]);
    const repeated = invoke([newerPath, olderPath]);
    expect(repeated.status, repeated.stderr).toBe(0);
    expect(await readdir(traces)).toEqual(files);
    expect(await saved("trail-names.geojson")).toEqual(newer.trailNames);
    expect(JSON.parse(await readFile(olderPath, "utf8"))).toEqual(older);
    expect(JSON.parse(await readFile(newerPath, "utf8"))).toEqual(newer);
  });

  it("rejects a discovered batch before writing if any bundle is invalid", async () => {
    await writeFile(
      join(directory, "windstone-edits-a.json"),
      JSON.stringify(fixture()),
    );
    await writeFile(
      join(directory, "windstone-edits-b.json"),
      JSON.stringify({ ...fixture(), version: 2 }),
    );
    const result = discover();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("version 1 Windstone edits");
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
    await expect(readdir(traces)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports missing discovered bundles without changing published files", async () => {
    const result = discover();
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("No Windstone edit bundles found");
    expect(await saved("trail-names.geojson")).toEqual(empty);
    expect(await saved("landmarks.geojson")).toEqual(empty);
  });

  it("merges discovered traces including ingested walks while excluding rejected files", async () => {
    await writeFile(input, JSON.stringify(fixture()));
    expect(run().status).toBe(0);
    const additional = fixture().walks;
    additional.features[0].id = "walk-2";
    additional.features[0].properties.id = "walk-2";
    await writeFile(
      join(directory, "traces", "loose.json"),
      JSON.stringify(additional),
    );
    await mkdir(join(directory, "traces", "rejected"));
    await writeFile(
      join(directory, "traces", "rejected", "bad.geojson"),
      "not JSON",
    );
    const result = merge();
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      await readFile(join(directory, "merged", "merge-report.json"), "utf8"),
    );
    expect(report.inputs).toHaveLength(2);
    expect(
      report.inputs.some((path: string) =>
        /raw\/edits-.*\.geojson$/.test(path),
      ),
    ).toBe(true);
    expect(
      report.inputs.some((path: string) => path.endsWith("loose.json")),
    ).toBe(true);
    expect(report.score).toBeNull();
    const received = JSON.parse(
      await readFile(join(directory, "merged", "ingested.json"), "utf8"),
    );
    expect([...received.ingested, ...received.rejected].sort()).toEqual([
      "walk-1",
      "walk-2",
    ]);
    expect(await saved("trail-names.geojson")).toEqual(fixture().trailNames);
  });

  it("does not treat truth, generated output, or source bundles as walks", async () => {
    const dataset = join(directory, "traces");
    await mkdir(dataset);
    await writeFile(
      join(dataset, "walks.geojson"),
      JSON.stringify(fixture().walks),
    );
    await writeFile(join(dataset, "truth-corrected.geojson"), "not walk JSON");
    for (const folder of ["output", "source", "rejected"]) {
      await mkdir(join(dataset, folder));
      await writeFile(
        join(dataset, folder, "not-walks.geojson"),
        "not walk JSON",
      );
    }
    const result = merge();
    expect(result.status, result.stderr).toBe(0);
    const received = JSON.parse(
      await readFile(join(directory, "merged", "ingested.json"), "utf8"),
    );
    expect([...received.ingested, ...received.rejected]).toEqual(["walk-1"]);
    const report = JSON.parse(
      await readFile(join(directory, "merged", "merge-report.json"), "utf8"),
    );
    expect(report.inputs).toHaveLength(1);
    expect(report.inputs[0]).toMatch(/walks\.geojson$/);
  });

  it.each(["missing", "empty"])(
    "resets every published data file when the source directory is %s",
    async (source) => {
      const output = join(directory, "merged");
      if (source === "empty") await mkdir(join(directory, "traces"));
      await mkdir(output);
      for (const name of [
        "trails.geojson",
        "trail-names.geojson",
        "landmarks.geojson",
        "ingested.json",
        "merge-report.json",
      ])
        await writeFile(join(output, name), "stale production data");
      const result = merge();
      expect(result.status, result.stderr).toBe(0);
      for (const name of [
        "trails.geojson",
        "trail-names.geojson",
        "landmarks.geojson",
      ])
        expect(JSON.parse(await readFile(join(output, name), "utf8"))).toEqual(
          empty,
        );
      expect(
        JSON.parse(await readFile(join(output, "ingested.json"), "utf8")),
      ).toEqual({ ingested: [], rejected: [] });
      expect(
        JSON.parse(await readFile(join(output, "merge-report.json"), "utf8")),
      ).toMatchObject({
        inputs: [],
        stats: { cleanedRuns: 0, nodes: 0, junctions: 0 },
        score: null,
      });
    },
  );

  it("creates all empty published files when neither sources nor output exist", async () => {
    const result = merge();
    expect(result.status, result.stderr).toBe(0);
    expect((await readdir(join(directory, "merged"))).sort()).toEqual([
      "ingested.json",
      "landmarks.geojson",
      "merge-report.json",
      "trail-names.geojson",
      "trails.geojson",
    ]);
    expect(
      JSON.parse(
        await readFile(join(directory, "merged", "trails.geojson"), "utf8"),
      ),
    ).toEqual(empty);
  });

  it("does not clear existing output when source files are invalid", async () => {
    const output = join(directory, "merged");
    await mkdir(output);
    await mkdir(traces, { recursive: true });
    await writeFile(join(output, "trails.geojson"), "existing map");
    await writeFile(join(traces, "broken.geojson"), "not JSON");
    const result = merge();
    expect(result.status).toBe(1);
    expect(await readFile(join(output, "trails.geojson"), "utf8")).toBe(
      "existing map",
    );
    expect(await readdir(output)).toEqual(["trails.geojson"]);
  });

  it("keeps explicit merge inputs independent of discovered trace files", async () => {
    await mkdir(traces, { recursive: true });
    await writeFile(join(traces, "bad.geojson"), "not JSON");
    const explicit = join(directory, "explicit.geojson");
    await writeFile(explicit, JSON.stringify(fixture().walks));
    const result = merge("--input", explicit);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(
      await readFile(join(directory, "merged", "merge-report.json"), "utf8"),
    );
    expect(report.inputs).toHaveLength(1);
    expect(report.inputs[0]).toMatch(/explicit\.geojson$/);
  });

  it("publishes edits and preserves recorded metadata without duplicating repeated imports", async () => {
    const bundle = fixture();
    await writeFile(input, JSON.stringify(bundle));
    expect(run().status).toBe(0);
    expect(await saved("trail-names.geojson")).toEqual(bundle.trailNames);
    expect(await saved("landmarks.geojson")).toEqual(bundle.landmarks);
    const files = await readdir(traces);
    expect(files).toHaveLength(1);
    expect(JSON.parse(await readFile(join(traces, files[0]), "utf8"))).toEqual(
      bundle.walks,
    );
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
    bundle.trailNames.features[0].geometry.coordinates = [
      [
        [-77, 45],
        [-77.001, 45],
      ],
    ];
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
    bundle.trailNames.features[0].geometry.coordinates = [
      [...coordinates].reverse(),
    ];
    bundle.walks.features = [];
    await writeFile(input, JSON.stringify(bundle));
    expect(run().status).toBe(0);
    await writeFile(
      input,
      JSON.stringify({ ...bundle, trailNames: empty, landmarks: empty }),
    );
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
