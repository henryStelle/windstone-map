# Trail Map PWA: Plan (v0)

A simple, offline-capable map of the trails at the non-profit, with a few landmarks. Contributors record walks in the PWA; a merge algorithm turns the raw traces into a trail map. No backend in v0: static site on GitHub Pages, data committed to the repo.

## Current Test Setup

Production starts empty under `production/`; see [production/README.md](production/README.md).
Development datasets live in `data/<test-set>/`;
see [data/README.md](data/README.md). Each set contains `truth*.geojson` plus walk
GeoJSON files. Generated demonstration data lives in `data/recorded-002/output/`,
and its original editor export is archived under `data/recorded-002/source/`.
The development simulator discovers these folders automatically and preserves
walks when truth is edited, cleared, undone, or imported. It and its datasets
are excluded from production builds. Production CLI defaults use
`recordings/exports/`, `recordings/raw/`, and `production/`. The ingestion Action
below is planned; the current Pages workflow tests and deploys committed output.

## Goals and non-goals

**Goals**

- View the trails and a few landmarks on a minimal map, offline.
- Record a walk in the PWA (screen on) with no extra app required.
- Merge many noisy, partially overlapping traces into a clean trail graph, automatically detecting junctions.
- Keep raw traces and the merged map in git.

**Non-goals (v0)**

- Directions or routing.
- Background recording (browsers can't do this; see Recorder limits).
- Any server, database, or Cloudflare account.
- Editing names on mobile (names are edited on a computer).

## Architecture

```
PWA (GitHub Pages)
  ├─ viewer: trails.geojson + landmarks.geojson
  └─ recorder: IndexedDB -> export GeoJSON (download / share)
                                   │ (maintainer or contributor adds file)
                                   ▼
Repo
  ├─ recordings/raw/*.geojson    production raw recordings, never edited
  ├─ production/trails.geojson   merged output (generated)
  ├─ production/trail-names.geojson named trail geometry from editor exports
  ├─ production/landmarks.geojson landmarks from editor exports
  └─ production/ingested.json    generated: ingested + rejected segment IDs
                                   │
Planned GitHub Action (on changes to recordings/raw/)
  └─ runs merge -> opens PR with regenerated production/ files
```

The PR reviews the merged map diff. That is the quality gate.

## Recorder

**Limits.** Browsers suspend geolocation when the screen locks or the page is hidden, and iOS has no background location for web apps. The recorder is foreground-only by design. Trails are short and edits are rare, so this is acceptable.

**Behavior**

- Request a Wake Lock on start; re-request on `visibilitychange` (it is released when the page is hidden).
- `watchPosition` with `enableHighAccuracy: true`. Write every fix to IndexedDB immediately: time, lat, lon, accuracy, heading (if present).
- End the current segment and start a new one if the page is hidden, the tab is suspended, or there is a gap of more than ~10 s between fixes. The merge must never draw a line across a gap.
- Big "recording" indicator with point count and current accuracy. On return after a lock, show "Recording paused" and offer resume.
- Tips on the record screen: dim brightness, close other apps, install to the home screen (more reliable on iOS).
- Call `navigator.storage.persist()` and encourage installing, because Safari can evict IndexedDB for unused sites.

## Segment lifecycle

Many walks may be recorded over many days before a single export. Each segment is tracked individually.

1. **Recording:** a segment gets a random ID (`crypto.randomUUID()`) when it starts. Every fix is written to IndexedDB as it arrives.
2. **Saved:** the segment is closed and waits locally. State: _on this device_.
3. **Exported:** included in a download or share. This only sets a flag. Nothing is deleted. State: _exported_.
4. **Ingested:** the merge Action records the segment's ID in `data/ingested.json`. The PWA fetches this file on load. State: _received_.
5. **Deleted:** only segments listed as ingested (or rejected) are removed from IndexedDB.

With no server in v0, the published site is the acknowledgment.

**Behavior to design for**

- **Long delay:** ingestion appears only after commit, PR merge, and Pages deploy, possibly days later. The "My walks" list shows each segment's state.
- **Manual override:** a "Delete anyway" option with a clear warning.
- **Offline:** if `ingested.json` can't be fetched, keep everything and check again next time.
- **Rejected traces:** the Action also writes rejected IDs to `ingested.json` under a `rejected` key, so the PWA can clear them too.
- **Nudges:** remind the user when they have un-exported segments.

`data/ingested.json` shape:

```json
{ "ingested": ["<uuid>", "..."], "rejected": ["<uuid>", "..."] }
```

## Export format

- One GeoJSON `FeatureCollection` per export, one `LineString` feature per segment.
- Each feature: `id` (the segment UUID) and properties holding per-point `times` and `accuracies` arrays (same length as the coordinates), plus `recordedAt` and `device` note.
- An export may contain many walks over many days. Exports can safely overlap; the merge dedupes by segment ID.
- Filename: `YYYY-MM-DD-HHMM-<random>.geojson`.
- Delivery: **Download** button, plus **Share** (`navigator.share` with a file) on mobile. Optional secondary GPX export.
- Optional GPX/GeoJSON **import** button (small file input) to bootstrap from existing tracks. Imported tracks get generated segment IDs.

Maintainers (or contributors via GitHub's web upload) place files in `traces/raw/`.

## Ingest editor edits

The editor's **Download edits** action creates one version 1 `windstone-edits` JSON bundle containing `trailNames`, `landmarks`, and `walks` GeoJSON collections.

Place production `windstone-edits*.json` bundles in `recordings/exports/`, then run:

```sh
pnpm ingest:edits --dry-run
pnpm ingest:edits
pnpm merge
```

Without file arguments, ingestion scans `recordings/exports/` for `windstone-edits*.json`. It validates every discovered bundle before writing anything. Named sections must match `production/trails.geojson`, allowing reversed geometry and rounding coordinates to seven decimal places. A missing or empty map is valid for first recordings without named trails. Unmatched sections, invalid landmarks, duplicate IDs, and malformed walk metadata abort the entire batch. Missing bundles also stop without changing production data.

Names and landmarks replace their production collections, including deletions. When multiple bundles are supplied, the newest `exportedAt` timestamp determines the snapshot, while walks from every bundle are retained. Recorded walks retain all metadata in content-addressed files under `recordings/raw/`; repeated imports do not create duplicate files. Input bundles are left unchanged. Explicit file paths still work (`pnpm ingest:edits file.json other-file.json`). Use `--input-dir`, `--data-dir`, and `--traces-dir` to target other directories. Development bundles require explicit separate outputs.

Ingestion does not regenerate trail geometry or mark walks as merged. `pnpm merge` reads walk collections from `recordings/raw/`, excluding `truth*.geojson` and the `output/`, `source/`, and `rejected/` directories. It prints the files used, then writes the generated map, acknowledgment IDs, and report to `production/`. If no walk files exist, it creates or resets trails, names, landmarks, acknowledgment IDs, and the report to empty output. Invalid source files still fail without changing existing output. Keep historical walks because merging rebuilds the whole network each time. Files under `data/` cannot be published to production outputs.

Use `--traces-dir` to change the discovery directory, repeat `--input` to choose files explicitly, or use `--out-dir` for a separate output directory. Merging no longer silently uses the simulator fixtures or evaluates against simulator truth. To run the original fixture benchmark explicitly:

```sh
pnpm merge --traces-dir data/windstone-001 --truth data/windstone-001/truth.geojson --benchmark
```

## Merge algorithm

Runs offline in Python or Node and from the Action. It rebuilds the whole map from all raw traces on every run. This avoids order dependence, and the algorithm can be improved later without migrating data. Trails are short, so performance isn't a concern.

**Pipeline**

1. **Clean:** dedupe by segment ID, drop low-accuracy fixes, drop segments that are too short, smooth lightly.
2. **Match/cluster (heading-aware):** merge stretches that agree in both position (within a tolerance scaled by accuracy / local jitter) and direction. Heading awareness stops crossing paths from being fused.
3. **Junction detection:** a junction is where traces run together then diverge and stay apart for a minimum distance. Require minimum support (at least k traces on each branch) so a single wanderer doesn't create a fork.
4. **Split into edges** at junctions and endpoints. Average geometry from supporting traces.
5. **Prune:** edges with fewer than 2 supporting segments are dropped (or flagged).
6. **Simplify and export** `data/trails.geojson`.

**Inspiration:** incremental trace-to-graph matching (Cao & Krumm; Ahmed & Wenk), KDE + skeletonization (Biagioni & Eriksson), Fréchet-distance clustering, and the MapConstruction project that bundles several of these. A density/skeleton first pass followed by trace-matching refinement is a good fallback if the simple approach struggles.

**Trail-specific caveats:** open areas where walkers wander create wide fuzzy paths; data is sparse, so support thresholds matter; no lane structure to worry about.

## Names and landmarks

- `data/landmarks.geojson`: named points published from editor exports.
- `data/trail-names.geojson`: names edited on a computer, attached by exact segment geometry rather than unstable edge IDs. Ingestion rejects geometry that no longer matches. Tolerant geometry anchors that survive regeneration remain a future improvement.
- **Create trail** and **Update trail** explicitly save both the name and selected sections; changing a selection does not autosave. Saving is blocked unless the selected sections form one connected component through graph junctions.
- Landmarks have an optional `icon` property chosen through the editor's searchable, scrollable Lucide catalogue. The edit-icon button opens the picker; choosing an icon does not save until **Save landmark** is clicked. Map icons have a padded, borderless white circular background at 85% opacity and an invisible tap target. Missing or unknown icons display as a pin. Saving retains other landmark properties.
- Published names and landmarks are compared with local drafts. Matching draft keys are removed; unsubmitted changes remain. **Download edits** is disabled when no saved map changes or unacknowledged walks remain. Downloading alone does not acknowledge a walk: only IDs in `data/ingested.json` under `ingested` or `rejected` are removed from IndexedDB.

## Viewer

- MapLibre or Leaflet on a blank background (no tiles): trail lines, names, landmarks. Small, fast, fully offline.
- Service worker caches the app shell and `data/*.geojson`.
- Optional later: cached OSM/satellite tiles for context.

## GitHub Action

- Trigger: changes under `traces/raw/`.
- Steps: run merge, regenerate `data/trails.geojson` and `data/ingested.json`, open a PR.
- PR summary: new edges, new junctions, unmatched names, rejected/duplicate segments, and optionally a preview image.
- Rejection workflow: to reject a bad trace, move it to `traces/rejected/` (or list its IDs) in the PR; the Action adds those IDs to `rejected`.

## Phases

1. **Viewer:** hand-made GeoJSON, landmarks, manifest, service worker.
2. **Recorder:** wake lock, segmenting, IndexedDB, segment lifecycle, "My walks" list, download/share. Test on real walks on iOS and Android, locked and unlocked.
3. **Merge algorithm:** offline, tuned on real recorded traces. This decides whether the rest is worth it, so do it before the automation.
4. **Action:** merge on push, `ingested.json`, PR.
5. **Names:** `names.json` with anchors that survive re-merging.

## Later (not v0)

- Cloudflare Worker + D1 behind the same export format: submit button, moderation (`pending` / `approved` / `rejected`), instant acknowledgment instead of waiting on Pages.
- Capacitor wrapper for background recording, only if foreground-only proves painful.
- Basemap tiles.

## Open questions

- Which junction support threshold (k) and divergence distance work on the real trails? Tune in phase 3.
- Who owns the maintainer workflow of adding files to `traces/raw/`?
- Do we want GPX export in v0 or only GeoJSON?
