import namesJson from "@map-data/trail-names.geojson?raw";
import { applyNames } from "./editing";
import { trails } from "./trails";

const names = JSON.parse(namesJson);
export const published =
  names.features.length > 0
    ? applyNames(trails.features, names)
    : { segments: trails.features, unmatched: 0 };
