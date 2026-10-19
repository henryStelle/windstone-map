import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import type { FeatureCollection, Position } from "geojson";

const root = fileURLToPath(new URL("../../../", import.meta.url));

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collection(value: unknown, label: string): FeatureCollection {
  if (
    !record(value) ||
    value.type !== "FeatureCollection" ||
    !Array.isArray(value.features)
  )
    throw new Error(`Invalid ${label}: expected a FeatureCollection.`);
  for (const feature of value.features) {
    if (
      !record(feature) ||
      feature.type !== "Feature" ||
      !record(feature.geometry) ||
      !record(feature.properties)
    )
      throw new Error(`Invalid ${label} feature.`);
  }
  return value as unknown as FeatureCollection;
}

function coordinate(value: unknown): value is Position {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1]) &&
    Math.abs(value[0]) <= 180 &&
    Math.abs(value[1]) <= 90
  );
}

function line(value: unknown): value is Position[] {
  return Array.isArray(value) && value.length >= 2 && value.every(coordinate);
}

function geometryKey(coordinates: Position[]): string {
  const points = coordinates.map((point) => [
    Number(point[0].toFixed(7)),
    Number(point[1].toFixed(7)),
  ]);
  return [
    JSON.stringify(points),
    JSON.stringify([...points].reverse()),
  ].sort()[0];
}

function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function uniqueId(value: unknown, ids: Set<string>, label: string) {
  if (typeof value !== "string" || !value.trim() || ids.has(value))
    throw new Error(`Invalid or duplicate ${label} ID.`);
  ids.add(value);
}

async function prepareEdits(input: string, dataDir: string, tracesDir: string) {
  const edits: unknown = JSON.parse(await readFile(input, "utf8"));
  if (
    !record(edits) ||
    edits.format !== "windstone-edits" ||
    edits.version !== 1 ||
    !timestamp(edits.exportedAt)
  )
    throw new Error(
      "Expected a version 1 Windstone edits bundle with an exportedAt timestamp.",
    );
  const names = collection(edits.trailNames, "trail names");
  const landmarks = collection(edits.landmarks, "landmarks");
  const walks = collection(edits.walks, "walks");
  const network: FeatureCollection = await readFile(
    resolve(dataDir, "trails.geojson"),
    "utf8",
  )
    .then((content) => collection(JSON.parse(content), "trail network"))
    .catch((error: unknown) => {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        return { type: "FeatureCollection", features: [] };
      throw error;
    });
  const known = new Set(
    network.features.map((feature) => {
      if (
        feature.geometry.type !== "LineString" ||
        !line(feature.geometry.coordinates)
      )
        throw new Error("Invalid trail network geometry.");
      return geometryKey(feature.geometry.coordinates);
    }),
  );
  const namedIds = new Set<string>();
  let sections = 0;
  for (const feature of names.features) {
    const name: unknown = feature.properties?.name;
    if (
      typeof name !== "string" ||
      !name.trim() ||
      feature.geometry.type !== "MultiLineString" ||
      !Array.isArray(feature.geometry.coordinates) ||
      !feature.geometry.coordinates.length ||
      !feature.geometry.coordinates.every(line)
    )
      throw new Error("Expected named MultiLineString features.");
    uniqueId(
      name.trim().replace(/\s+/g, " ").normalize("NFKC").toLowerCase(),
      namedIds,
      "trail name",
    );
    for (const coordinates of feature.geometry.coordinates) {
      if (!known.has(geometryKey(coordinates)))
        throw new Error(
          `Trail "${name}" contains a section that does not match the current map. No edits were saved.`,
        );
      sections += 1;
    }
  }
  const landmarkIds = new Set<string>();
  for (const feature of landmarks.features) {
    if (
      typeof feature.properties?.name !== "string" ||
      !feature.properties.name.trim() ||
      feature.geometry.type !== "Point" ||
      !coordinate(feature.geometry.coordinates)
    )
      throw new Error("Expected named landmark points.");
    uniqueId(feature.properties.id, landmarkIds, "landmark");
  }
  const walkIds = new Set<string>();
  for (const feature of walks.features) {
    const properties = feature.properties!;
    if (
      feature.geometry.type !== "LineString" ||
      !line(feature.geometry.coordinates)
    )
      throw new Error("Expected recorded LineString walks.");
    uniqueId(properties.id, walkIds, "walk");
    if (feature.id !== undefined && feature.id !== properties.id)
      throw new Error("Walk feature ID does not match its properties ID.");
    const count = feature.geometry.coordinates.length;
    if (
      !Array.isArray(properties.times) ||
      properties.times.length !== count ||
      !properties.times.every(timestamp) ||
      !Array.isArray(properties.accuracies) ||
      properties.accuracies.length !== count ||
      !properties.accuracies.every(
        (accuracy: unknown) =>
          typeof accuracy === "number" &&
          Number.isFinite(accuracy) &&
          accuracy > 0,
      ) ||
      !timestamp(properties.recordedAt)
    )
      throw new Error(
        "Walk timestamps and accuracies must match its coordinates.",
      );
    if (
      properties.times.some(
        (time: string, index: number) =>
          index > 0 &&
          Date.parse(time) <= Date.parse(properties.times[index - 1]),
      )
    )
      throw new Error("Walk timestamps must be strictly increasing.");
  }
  const outputs = new Map<string, string>([
    [
      resolve(dataDir, "trail-names.geojson"),
      `${JSON.stringify(names, null, 2)}\n`,
    ],
    [
      resolve(dataDir, "landmarks.geojson"),
      `${JSON.stringify(landmarks, null, 2)}\n`,
    ],
  ]);
  let rawPath: string | null = null;
  if (walks.features.length) {
    const hash = createHash("sha256")
      .update(JSON.stringify(walks))
      .digest("hex")
      .slice(0, 16);
    rawPath = resolve(tracesDir, `edits-${hash}.geojson`);
    outputs.set(rawPath, `${JSON.stringify(walks, null, 2)}\n`);
  }
  if (outputs.has(input))
    throw new Error("Output would overwrite the input edits bundle.");
  return {
    input,
    exportedAt: Date.parse(edits.exportedAt),
    names,
    landmarks,
    walks,
    sections,
    outputs,
    rawPath,
  };
}

async function ingest() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      "input-dir": { type: "string" },
      "data-dir": { type: "string" },
      "traces-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      help: { type: "boolean" },
    },
  });
  if (values.help) {
    console.log(
      "Usage: pnpm ingest:edits [file.json ...] [--dry-run] [--input-dir directory] [--data-dir directory] [--traces-dir directory]\nDefaults to recordings/exports/ bundles, production/ map data, and recordings/raw/ walks. Development fixtures require a separate --data-dir and --traces-dir. All walks are preserved; the newest export supplies names and landmarks.",
    );
    return;
  }
  const production = resolve(root, "production");
  const inputDir = resolve(
    values["input-dir"] ?? resolve(root, "recordings/exports"),
  );
  const inputs = positionals.length
    ? positionals.map((path) => resolve(path))
    : (
        await readdir(inputDir, { withFileTypes: true }).catch(
          (error: unknown) => {
            if (
              error instanceof Error &&
              "code" in error &&
              error.code === "ENOENT"
            )
              return [];
            throw error;
          },
        )
      )
        .filter(
          (entry) =>
            entry.isFile() && /^windstone-edits.*\.json$/i.test(entry.name),
        )
        .map((entry) => resolve(inputDir, entry.name))
        .sort();
  if (!inputs.length)
    throw new Error(
      `No Windstone edit bundles found in ${inputDir}. Add windstone-edits*.json files or provide explicit file paths. No edits were saved.`,
    );
  const dataDir = resolve(values["data-dir"] ?? production);
  const tracesDir = resolve(
    values["traces-dir"] ?? resolve(root, "recordings/raw"),
  );
  if (
    inputs.some((path) => path.startsWith(`${resolve(root, "data")}${sep}`)) &&
    (dataDir === production || tracesDir === resolve(root, "recordings/raw"))
  )
    throw new Error(
      "Development fixtures cannot be ingested into production. Use separate --data-dir and --traces-dir.",
    );
  const batches = await Promise.all(
    inputs.map((input) => prepareEdits(input, dataDir, tracesDir)),
  );
  batches.sort(
    (first, second) =>
      first.exportedAt - second.exportedAt ||
      first.input.localeCompare(second.input),
  );
  const outputs = new Map<string, string>();
  const rawPaths = new Set<string>();
  for (const batch of batches) {
    for (const [path, content] of batch.outputs) outputs.set(path, content);
    if (batch.rawPath) rawPaths.add(batch.rawPath);
  }
  if (inputs.some((input) => outputs.has(input)))
    throw new Error("Output would overwrite an input edits bundle.");
  for (const batch of batches) {
    console.log(
      `${values["dry-run"] ? "Validated" : "Ingesting"} ${batch.names.features.length} trail names (${batch.sections} sections), ${batch.landmarks.features.length} landmarks, ${batch.walks.features.length} recorded walks from ${batch.input}.`,
    );
  }
  if (batches.length > 1)
    console.log(
      `Using names and landmarks from the newest export: ${batches.at(-1)!.input}.`,
    );
  if (values["dry-run"]) return;
  await mkdir(dataDir, { recursive: true });
  if (rawPaths.size) await mkdir(tracesDir, { recursive: true });
  for (const rawPath of rawPaths) {
    const content = outputs.get(rawPath)!;
    try {
      await writeFile(rawPath, content, { flag: "wx" });
    } catch (error) {
      if (
        !(error instanceof Error) ||
        !("code" in error) ||
        error.code !== "EEXIST" ||
        (await readFile(rawPath, "utf8")) !== content
      )
        throw error;
    }
    outputs.delete(rawPath);
    console.log(`Preserved recorded walks in ${rawPath}.`);
  }
  for (const [path, content] of outputs) await writeFile(path, content);
  console.log(`Saved published names and landmarks in ${dataDir}.`);
}

try {
  await ingest();
} catch (error) {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
}
