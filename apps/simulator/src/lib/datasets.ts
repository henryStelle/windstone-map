import type { FeatureCollection } from "geojson";
import { discoverDatasets } from "../../../../packages/merger/src/datasets";
import { graphFromGeoJson } from "./graph";
import { walksFromGeoJson } from "./walks";

const files = import.meta.glob<string>("../../../../data/*/*.geojson", {
  query: "?url",
  import: "default",
  eager: true,
});
const urls = new Map(
  Object.entries(files).map(([path, url]) => [
    path.replace("../../../../data/", ""),
    url,
  ]),
);

export const TEST_DATASETS = discoverDatasets([...urls.keys()]);

export async function loadTestDataset(id: string) {
  const dataset = TEST_DATASETS.find((entry) => entry.id === id);
  if (!dataset) throw new Error(`Unknown test dataset: ${id}`);
  const readCollections = async (
    paths: string[],
  ): Promise<FeatureCollection> => {
    const collections = await Promise.all(
      paths.map(async (path) => {
        const response = await fetch(urls.get(path)!);
        if (!response.ok)
          throw new Error(`Unable to load ${path} (${response.status}).`);
        const collection: FeatureCollection = await response.json();
        if (
          collection?.type !== "FeatureCollection" ||
          !Array.isArray(collection.features)
        )
          throw new Error(`Invalid GeoJSON collection: ${path}`);
        return collection;
      }),
    );
    return {
      type: "FeatureCollection",
      features: collections.flatMap((collection) => collection.features),
    };
  };
  const [truth, walks] = await Promise.all([
    readCollections(dataset.truth),
    readCollections(dataset.walks),
  ]);
  const graph = graphFromGeoJson(truth);
  if (graph.edges.length === 0)
    throw new Error(`${id}: truth has no trail edges.`);
  return { graph, walks: walksFromGeoJson(walks) };
}
