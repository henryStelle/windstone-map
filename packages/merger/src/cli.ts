import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { FeatureCollection } from "geojson";
import { evaluateNetwork } from "./evaluate.ts";
import { mergeTraces } from "./merge.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    input: { type: "string", multiple: true },
    truth: { type: "string" },
    "out-dir": { type: "string" },
    benchmark: { type: "boolean" },
  },
});

async function readCollection(path: string): Promise<FeatureCollection> {
  const collection = JSON.parse(await readFile(path, "utf8"));
  if (
    collection?.type !== "FeatureCollection" ||
    !Array.isArray(collection.features)
  )
    throw new Error(`Invalid GeoJSON: ${path}`);
  return collection;
}

try {
  const inputPaths = values.input?.map((path) => resolve(path)) ?? [
    resolve(root, "walks-windstone-001.geojson"),
  ];
  const truthPath = values.truth
    ? resolve(values.truth)
    : values.input
      ? null
      : resolve(root, "truth.geojson");
  const collections = await Promise.all(inputPaths.map(readCollection));
  const walks: FeatureCollection = {
    type: "FeatureCollection",
    features: collections.flatMap((collection) => collection.features),
  };
  const output = values["out-dir"]
    ? resolve(values["out-dir"])
    : resolve(root, "data");
  const result = mergeTraces(walks);
  const truth = truthPath ? await readCollection(truthPath) : null;
  const report = {
    inputs: inputPaths.map((path) => path.slice(root.length)),
    options: result.options,
    stats: result.stats,
    score: truth ? evaluateNetwork(result.trails, truth) : null,
  };
  const files: Record<string, unknown> = {
    "trails.geojson": result.trails,
    "ingested.json": result.ingested,
    "merge-report.json": report,
  };
  if (values.benchmark) {
    if (!truth)
      throw new Error("A truth collection is required for benchmarking.");
    files["merge-benchmark.json"] = {
      raw: evaluateNetwork(walks, truth),
      merged: report.score,
    };
  }
  for (const name of Object.keys(files)) {
    if ([...inputPaths, truthPath].includes(resolve(output, name)))
      throw new Error("Output would overwrite an input file.");
  }
  await mkdir(output, { recursive: true });
  for (const [name, value] of Object.entries(files))
    await writeFile(
      resolve(output, name),
      `${JSON.stringify(value, null, 2)}\n`,
    );
  console.log(
    `Merged ${result.ingested.ingested.length} segments into ${result.trails.features.length} trail edges in ${output}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
