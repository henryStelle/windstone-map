# Test Datasets

This directory contains development data only. Each immediate subdirectory is a test set:

```text
data/
  windstone-001/
    truth.geojson
    walks.geojson
  recorded-002/
    truth.geojson
    walks.geojson
    source/                  original editor export
    output/                  generated map, report, names, and acknowledgments
```

At the top level of each set, `truth*.geojson` files form the truth network.
Every other GeoJSON file is a walk collection. Multiple truth and walk files
are combined automatically, with no manifest or external links. Nested files
are not inputs. Each set must contain both truth and walks.

The simulator's Test dataset selector discovers these same files. Load a set
to inspect its walks, edit or clear truth without losing walks, then download
the corrected truth into that set as `truth.geojson`.

The paired merger tests require more than 90% length-weighted truth coverage
within 10 m, because the recorded reference is approximate. They also report
strict 5 m coverage and precision. The simulation has separate 5 m accuracy
regressions. Normal smoothing applies even with only one walk.

```sh
pnpm --filter @windstone/merger exec vitest run src/merge.test.ts
pnpm merge --traces-dir data/recorded-002 --out-dir data/recorded-002/output
pnpm merge --traces-dir data/windstone-001 --truth data/windstone-001/truth.geojson --out-dir data/windstone-001/output --benchmark
```

Development, unit tests, and explicit `fixtures` builds use `recorded-002/output`
as demonstration data. Normal builds and GitHub Pages use only `production/`
and exclude the simulator and its datasets. Production defaults for ingest and
merge use `recordings/exports/`, `recordings/raw/`, and `production/`; see
[production/README.md](../production/README.md). Dev inputs require explicit
separate outputs and cannot be published through the production defaults.
The archived editor export contains named sections from an older map snapshot;
its dry-run currently rejects the unmatched "Crane Walk" section. It is retained
unchanged as source test data, not a validated import for the saved output map.
