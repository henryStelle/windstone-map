# Trail Map PWA: Plan (v0)

A simple, offline-capable map of the trails at the non-profit, with a few landmarks. Contributors record walks in the PWA; a merge algorithm turns the raw traces into a trail map. No backend in v0: static site on GitHub Pages, data committed to the repo.

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
  ├─ traces/raw/*.geojson        raw exports, never edited
  ├─ data/trails.geojson         merged output (generated)
  ├─ data/names.json             hand-edited, anchored names
  ├─ data/landmarks.geojson      hand-edited
  └─ data/ingested.json          generated: ingested + rejected segment IDs
                                   │
GitHub Action (on changes to traces/raw/)
  └─ runs merge -> opens PR with regenerated data/ files
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
2. **Saved:** the segment is closed and waits locally. State: *on this device*.
3. **Exported:** included in a download or share. This only sets a flag. Nothing is deleted. State: *exported*.
4. **Ingested:** the merge Action records the segment's ID in `data/ingested.json`. The PWA fetches this file on load. State: *received*.
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

- `data/landmarks.geojson`: hand-edited points.
- `data/names.json`: names edited on a computer. Because merged geometry is regenerated, edge IDs are unstable. Each name stores a few anchor coordinates (or a short polyline) and is re-attached to the nearest merged edge on each run. Names that no longer match anything are flagged in the PR summary.

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
