# Production Map

Only this directory supplies map data to normal builds and GitHub Pages.
It starts with empty trails, trail names, landmarks, and acknowledgment IDs.
Development datasets remain under `data/` and are not included in production
bundles. Production also uses separate browser draft keys and a separate
recording database; existing development storage is left untouched.

## First Recordings

For an editor export, put the downloaded `windstone-edits*.json` file in
`recordings/exports/`, then run from the repository root:

```sh
pnpm ingest:edits --dry-run
pnpm ingest:edits
pnpm merge
pnpm test
pnpm --filter @windstone/simulator test:production
pnpm build
```

Ingest validates every bundle before writing, preserves full walk metadata in
content-addressed files under `recordings/raw/`, and updates production names
and landmarks from the newest export. An empty or missing trail network is
valid for first recordings with no named trails. Names must still match known
trail geometry. Repeat imports do not duplicate raw walks. Dry runs never write.

Alternatively, put recorded walk FeatureCollections directly into
`recordings/raw/` and run `pnpm merge`; ingest is only for editor export bundles.
Merge rebuilds the network from all raw recordings, even with only one walk,
and writes trails, acknowledgment IDs, and its report here. Keep historical
raw recordings. With no source files (including a missing raw directory),
`pnpm merge` succeeds and creates or resets trails, trail names, landmarks,
acknowledgment IDs, and the merge report to empty output. Invalid source files
still fail without changing existing output. Ingest with no export bundles
fails without changing map data.

GitHub Actions tests and builds the committed production map; it does not run
ingest or merge automatically. Publish the recordings and generated production
files through the normal main-branch deployment. These local changes do not
change an already deployed site until that deployment occurs.

## Development

`pnpm dev` enables the simulator and demo map. An explicit
`pnpm --filter @windstone/simulator exec vite build --mode fixtures` makes a
fixture preview for browser tests; do not deploy it. Normal `pnpm build` excludes
the simulator and has a build guard rejecting any bundled `data/` modules.
The Pages workflow runs production-mode data-isolation regressions as well.

Development CLI work requires explicit fixture paths and separate outputs:

```sh
pnpm merge --traces-dir data/recorded-002 --out-dir data/recorded-002/output
pnpm ingest:edits --input-dir data/recorded-002/source --data-dir data/recorded-002/output --traces-dir data/recorded-002 --dry-run
```

The archived development export can fail name validation against its saved
map snapshot. It is not production input. Commands refuse to publish files
from `data/` to production paths.