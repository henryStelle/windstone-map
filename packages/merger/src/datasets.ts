export interface TestDataset {
  id: string;
  truth: string[];
  walks: string[];
}

export function discoverDatasets(paths: string[]): TestDataset[] {
  const datasets = new Map<string, TestDataset>();
  for (const path of [...paths].sort()) {
    const parts = path.split("/");
    if (parts.length !== 2 || !/\.geojson$/i.test(parts[1])) continue;
    const [id, filename] = parts;
    const dataset = datasets.get(id) ?? { id, truth: [], walks: [] };
    if (/^truth.*\.geojson$/i.test(filename)) dataset.truth.push(path);
    else dataset.walks.push(path);
    datasets.set(id, dataset);
  }

  return [...datasets.values()].filter(
    (dataset) => dataset.truth.length > 0 || dataset.walks.length > 0,
  );
}
