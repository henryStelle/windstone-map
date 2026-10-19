import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { FeatureCollection } from "geojson";
import { evaluateNetwork } from "./evaluate.ts";
import { mergeTraces } from "./merge.ts";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const { values } = parseArgs({
  options: {
    input: { type: "string", multiple: true },
    "traces-dir": { type: "string" },
    truth: { type: "string" },
    "out-dir": { type: "string" },
    benchmark: { type: "boolean" },
    help: { type: "boolean" },
  },
});

async function traceInputs(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return [];
      throw error;
    },
  );
  const paths = await Promise.all(
    entries
      .filter((entry) => !["rejected", "output", "source"].includes(entry.name))
      .map(async (entry) => {
        const path = resolve(directory, entry.name);
        if (entry.isDirectory()) return traceInputs(path);
        return entry.isFile() &&
          /\.(geojson|json)$/i.test(entry.name) &&
          !/^truth.*\.geojson$/i.test(entry.name)
          ? [path]
          : [];
      }),
  );
  return paths.flat().sort();
}

async function readCollection(path: string): Promise<FeatureCollection> {
  const collection = JSON.parse(await readFile(path, "utf8"));
  if (
    collection?.type !== "FeatureCollection" ||
    !Array.isArray(collection.features)
  )
    throw new Error(`Invalid GeoJSON: ${path}`);
  return collection;
}

async function merge() {
  if (values.help) {
    console.log(
      "Usage: pnpm merge [--input file.geojson ...] [--traces-dir directory] [--out-dir directory] [--truth truth.geojson] [--benchmark]\nDefaults to recordings/raw/ and publishes to production/. With no source files, resets trails, names, landmarks, acknowledgments, and the report to empty output. A custom --traces-dir defaults to its output/ subdirectory. Development fixtures require a separate --out-dir. Skips truth*.geojson and output/, source/, and rejected/ folders. Benchmarking requires --truth.",
    );
    return;
  }
  const tracesDir = resolve(
    values["traces-dir"] ?? resolve(root, "recordings/raw"),
  );
  const inputPaths =
    values.input?.map((path) => resolve(path)) ??
    (await traceInputs(tracesDir));
  const truthPath = values.truth ? resolve(values.truth) : null;
  if (values.benchmark && !truthPath)
    throw new Error("Provide --truth <truth.geojson> with --benchmark.");
  const production = resolve(root, "production");
  const output = values["out-dir"]
    ? resolve(values["out-dir"])
    : values["traces-dir"]
      ? resolve(tracesDir, "output")
      : production;
  if (
    output === production &&
    [...inputPaths, truthPath].some((path) => path?.startsWith(`${resolve(root, "data")}${sep}`))
  )
    throw new Error("Development fixtures cannot be published to production. Use a separate --out-dir.");
  console.log(
    `Reading ${inputPaths.length} trace ${inputPaths.length === 1 ? "file" : "files"}:`,
  );
  for (const path of inputPaths) console.log(`  ${relative(root, path)}`);
  const collections = await Promise.all(inputPaths.map(readCollection));
  const walks: FeatureCollection = {
    type: "FeatureCollection",
    features: collections.flatMap((collection) => collection.features),
  };
  const result = mergeTraces(walks);
  const truth = truthPath ? await readCollection(truthPath) : null;
  const report = {
    inputs: inputPaths.map((path) => relative(root, path)),
    options: result.options,
    stats: result.stats,
    score: truth ? evaluateNetwork(result.trails, truth) : null,
  };
  const files: Record<string, unknown> = {
    "trails.geojson": result.trails,
    "ingested.json": result.ingested,
    "merge-report.json": report,
  };
  if (inputPaths.length === 0) {
    const empty: FeatureCollection = { type: "FeatureCollection", features: [] };
    files["trail-names.geojson"] = empty;
    files["landmarks.geojson"] = empty;
  }
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
}

try {
  await merge();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
