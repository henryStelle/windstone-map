import { useEffect, useRef, useState, type ChangeEvent } from "react";
import type { FeatureCollection, LineString, Point } from "geojson";
import {
  ChevronLeft,
  ChevronRight,
  Download,
  FileUp,
  FolderOpen,
  GitFork,
  LocateFixed,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import maplibregl, {
  type GeoJSONSource,
  type MapMouseEvent,
} from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./Simulator.css";
import { generateWalks } from "./lib/generator";
import { walksFromGeoJson } from "./lib/walks";
import type { MergeRequest, MergeResponse, MergeSuccess } from "./lib/merge.worker";
import truthFixtureUrl from "../../../truth.geojson?url";
import walksFixtureUrl from "../../../walks-windstone-001.geojson?url";
import {
  connectNodes,
  EMPTY_GRAPH,
  graphFromGeoJson,
  graphToGeoJson,
  nearestNode,
  type Coordinate,
  type TrailGraph,
} from "./lib/graph";

const STORAGE_KEY = "windstone-truth-graph-v1";
const VIEW_KEY = "windstone-simulator-view-v1";
const DEFAULT_VIEW: { center: Coordinate; zoom: number } = {
  center: [-76.116129, 45.056998],
  zoom: 18,
};
const SNAP_DISTANCE_PX = 16;
const EMPTY_WALKS: FeatureCollection<LineString> = { type: "FeatureCollection", features: [] };

function App() {
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const graphRef = useRef<TrailGraph>(loadGraph());
  const activeNodeRef = useRef<string | null>(null);
  const historyRef = useRef<TrailGraph[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const walksInputRef = useRef<HTMLInputElement>(null);
  const mergeWorkerRef = useRef<Worker | null>(null);
  const editingTruthRef = useRef(true);
  const [graph, setGraph] = useState(graphRef.current);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);
  const [walks, setWalks] = useState<FeatureCollection<LineString>>(EMPTY_WALKS);
  const [editingTruth, setEditingTruth] = useState(true);
  const [mergeResult, setMergeResult] = useState<MergeSuccess | null>(null);
  const [isMerging, setIsMerging] = useState(false);
  const [isLoadingFixtures, setIsLoadingFixtures] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [visibility, setVisibility] = useState({ truth: true, walks: true, merged: true });
  const [walkView, setWalkView] = useState<"all" | "single">("all");
  const [selectedWalkIndex, setSelectedWalkIndex] = useState(0);
  const [walkCount, setWalkCount] = useState(300);
  const [noiseMeters, setNoiseMeters] = useState(5);
  const [seed, setSeed] = useState("windstone-001");
  const [mapReady, setMapReady] = useState(false);

  useEffect(() => {
    graphRef.current = graph;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(graph));
  }, [graph]);

  useEffect(() => {
    activeNodeRef.current = activeNodeId;
  }, [activeNodeId]);

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const savedView = loadView();
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      center: savedView.center,
      zoom: savedView.zoom,
      style: {
        version: 8,
        sources: {
          aerial: {
            type: "raster",
            tiles: [
              import.meta.env.VITE_RASTER_TILES_URL ||
                "https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}",
            ],
            tileSize: 256,
            attribution:
              'Imagery &copy; <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank" rel="noopener noreferrer">Esri and contributors</a>',
            maxzoom: 19,
          },
        },
        layers: [{ id: "aerial", type: "raster", source: "aerial" }],
      },
    });
    mapRef.current = map;
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    map.addControl(
      new maplibregl.GeolocateControl({
        positionOptions: { enableHighAccuracy: true },
      }),
      "top-right",
    );

    map.on("load", () => {
      addTrailLayers(map);
      setMapReady(true);
    });
    map.on("moveend", () => {
      const center = map.getCenter();
      localStorage.setItem(
        VIEW_KEY,
        JSON.stringify({
          center: [center.lng, center.lat],
          zoom: map.getZoom(),
        }),
      );
    });
    map.on("click", (event) => handleMapClick(map, event));

    return () => {
      mergeWorkerRef.current?.terminate();
      mergeWorkerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;
    const map = mapRef.current;
    (map.getSource("truth-edges") as GeoJSONSource).setData(
      graphToGeoJson(graph),
    );
    (map.getSource("truth-nodes") as GeoJSONSource).setData(
      nodesGeoJson(graph, activeNodeId),
    );
    const selectedWalk = walks.features[selectedWalkIndex];
    const visibleWalks: FeatureCollection<LineString> =
      walkView === "single"
        ? {
            type: "FeatureCollection",
            features: selectedWalk ? [selectedWalk] : [],
          }
        : walks;
    (map.getSource("simulated-walks") as GeoJSONSource).setData(visibleWalks);
    map.setPaintProperty(
      "simulated-walks",
      "line-opacity",
      walkView === "single" ? 0.95 : 0.2,
    );
    map.setPaintProperty(
      "simulated-walks",
      "line-width",
      walkView === "single" ? 3 : 1.2,
    );
    map.moveLayer(
      "simulated-walks",
      walkView === "single" ? "truth-nodes" : "truth-edges",
    );
    (map.getSource("merged-trails") as GeoJSONSource).setData(mergeResult?.result.trails ?? EMPTY_WALKS);
    map.setLayoutProperty("truth-edges", "visibility", visibility.truth ? "visible" : "none");
    map.setLayoutProperty("truth-nodes", "visibility", visibility.truth && editingTruth ? "visible" : "none");
    map.setLayoutProperty("simulated-walks", "visibility", visibility.walks ? "visible" : "none");
    map.setLayoutProperty("merged-trails", "visibility", visibility.merged ? "visible" : "none");
  }, [activeNodeId, editingTruth, graph, mapReady, mergeResult, selectedWalkIndex, visibility, walks, walkView]);

  function resetMerge() {
    mergeWorkerRef.current?.terminate();
    mergeWorkerRef.current = null;
    setMergeResult(null);
    setIsMerging(false);
    setError(null);
  }

  function replaceWalks(collection: FeatureCollection<LineString>) {
    resetMerge();
    setSelectedWalkIndex(0);
    setWalks(collection);
  }

  function setTruthEditing(enabled: boolean) {
    editingTruthRef.current = enabled;
    setEditingTruth(enabled);
    if (!enabled) setActiveNodeId(null);
    else setVisibility((current) => ({ ...current, truth: true }));
  }

  function runMerge() {
    if (walks.features.length === 0 || graph.edges.length === 0) return;
    resetMerge();
    setTruthEditing(false);
    setIsMerging(true);
    try {
      const worker = new Worker(new URL("./lib/merge.worker.ts", import.meta.url), { type: "module" });
      mergeWorkerRef.current = worker;
      worker.onmessage = (event: MessageEvent<MergeResponse>) => {
        if (mergeWorkerRef.current !== worker) return;
        if (event.data.ok) {
          setMergeResult(event.data.data);
          setVisibility((current) => ({ ...current, merged: true }));
        } else setError(event.data.error);
        setIsMerging(false);
        worker.terminate();
        mergeWorkerRef.current = null;
      };
      worker.onerror = (event) => {
        if (mergeWorkerRef.current !== worker) return;
        setError(event.message || "The merge worker failed.");
        setIsMerging(false);
        worker.terminate();
        mergeWorkerRef.current = null;
      };
      const request: MergeRequest = { walks, truth: graphToGeoJson(graph) };
      worker.postMessage(request);
    } catch (failure) {
      resetMerge();
      setError(failure instanceof Error ? failure.message : "Unable to start the merger.");
    }
  }

  function handleMapClick(map: maplibregl.Map, event: MapMouseEvent) {
    if (!editingTruthRef.current) return;
    const current = graphRef.current;
    const snapped = nearestNode(
      current.nodes,
      (coordinate) => map.project(coordinate),
      event.point,
      SNAP_DISTANCE_PX,
    );
    const active = activeNodeRef.current;
    let next = current;
    let nextNodeId: string;

    if (snapped) {
      nextNodeId = snapped.id;
    } else {
      nextNodeId = crypto.randomUUID();
      next = {
        ...next,
        nodes: [
          ...next.nodes,
          { id: nextNodeId, coordinate: [event.lngLat.lng, event.lngLat.lat] },
        ],
      };
    }

    if (active) next = connectNodes(next, active, nextNodeId);
    historyRef.current.push(current);
    setGraph(next);
    setActiveNodeId(nextNodeId);
    replaceWalks(EMPTY_WALKS);
  }

  function generate() {
    setTruthEditing(false);
    replaceWalks(
      generateWalks(graph, {
        count: walkCount,
        noiseMeters,
        sampleSpacingMeters: 6,
        seed,
      }),
    );
  }

  function undo() {
    const previous = historyRef.current.pop();
    if (!previous) return;
    setGraph(previous);
    setActiveNodeId(null);
    replaceWalks(EMPTY_WALKS);
  }

  function clear() {
    if (
      graph.nodes.length > 0 &&
      !window.confirm("Clear the entire truth network?")
    )
      return;
    historyRef.current.push(graph);
    setGraph(EMPTY_GRAPH);
    setActiveNodeId(null);
    replaceWalks(EMPTY_WALKS);
  }

  async function importTruth(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const imported = graphFromGeoJson(JSON.parse(await file.text()));
      historyRef.current.push(graph);
      setGraph(imported);
      setActiveNodeId(null);
      replaceWalks(EMPTY_WALKS);
    } catch {
      window.alert("That file is not valid GeoJSON.");
    } finally {
      event.target.value = "";
    }
  }

  const canGenerate = graph.edges.length > 0;

  async function importWalks(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      replaceWalks(walksFromGeoJson(JSON.parse(await file.text())));
      setTruthEditing(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Invalid walks GeoJSON.");
    } finally {
      event.target.value = "";
    }
  }

  async function loadProjectFixtures() {
    if ((graph.nodes.length > 0 || walks.features.length > 0) && !window.confirm("Replace the current truth and walks with the project fixtures?")) return;
    setIsLoadingFixtures(true);
    setError(null);
    setTruthEditing(false);
    try {
      const [truth, savedWalks] = await Promise.all([truthFixtureUrl, walksFixtureUrl].map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`Unable to load project fixtures (${response.status}).`);
        return response.json();
      }));
      const imported = graphFromGeoJson(truth);
      const importedWalks = walksFromGeoJson(savedWalks);
      if (imported.edges.length === 0) throw new Error("The project truth fixture has no trail edges.");
      historyRef.current.push(graph);
      setGraph(imported);
      replaceWalks(importedWalks);
      setVisibility({ truth: true, walks: true, merged: true });
      const bounds = new maplibregl.LngLatBounds();
      for (const node of imported.nodes) bounds.extend(node.coordinate);
      mapRef.current?.fitBounds(bounds, { padding: 48, maxZoom: 18, duration: 600 });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Unable to load project fixtures.");
    } finally {
      setIsLoadingFixtures(false);
    }
  }

  return (
    <main className="app-shell">
      <aside className="control-panel">
        <header className="brand-block">
          <div className="brand-mark">
            <GitFork size={20} strokeWidth={2.4} />
          </div>
          <div>
            <span className="eyebrow">Windstone Trails</span>
            <h1>Trace Lab</h1>
          </div>
        </header>

        <section className="truth-section">
          <div className="section-heading">
            <div>
              <span className="step-number">01</span>
              <h2>Truth network</h2>
            </div>
            <span className="metric">{graph.edges.length} edges</span>
          </div>
          <div className="active-status" data-active={Boolean(activeNodeId)}>
            <span className="status-dot" />
            {activeNodeId ? "Extending trail" : "Ready for a new trail"}
          </div>
          <div className="tool-row">
            <button
              className="icon-button"
              type="button"
              title="Edit truth"
              aria-label="Edit truth"
              aria-pressed={editingTruth}
              disabled={isLoadingFixtures}
              onClick={() => setTruthEditing(!editingTruth)}
            >
              <Pencil size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => setActiveNodeId(null)}
              disabled={!activeNodeId}
              title="Finish current trail"
            >
              <X size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={undo}
              disabled={historyRef.current.length === 0}
              title="Undo last point"
            >
              <RotateCcw size={18} />
            </button>
            <button
              className="icon-button danger"
              type="button"
              onClick={clear}
              disabled={graph.nodes.length === 0}
              title="Clear truth network"
            >
              <Trash2 size={18} />
            </button>
            <button
              className="icon-button"
              type="button"
              onClick={() => fileInputRef.current?.click()}
              title="Import truth GeoJSON"
            >
              <FileUp size={18} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".geojson,application/geo+json,application/json"
              hidden
              onChange={importTruth}
            />
          </div>
          <button className="secondary-button fixture-button" type="button" onClick={loadProjectFixtures} disabled={isLoadingFixtures}>
            <FolderOpen size={16} /> {isLoadingFixtures ? "Loading fixtures..." : "Load project fixtures"}
          </button>
        </section>

        <section className="generator-section">
          <div className="section-heading">
            <div>
              <span className="step-number">02</span>
              <h2>Walk generator</h2>
            </div>
            <span className="metric">{walks.features.length} traces</span>
          </div>
          <label className="field-label" htmlFor="walk-count">
            Walks <output>{walkCount}</output>
          </label>
          <input
            id="walk-count"
            type="range"
            min="50"
            max="1000"
            step="50"
            value={walkCount}
            onChange={(event) => setWalkCount(Number(event.target.value))}
          />
          <label className="field-label" htmlFor="noise">
            GPS noise <output>{noiseMeters} m</output>
          </label>
          <input
            id="noise"
            type="range"
            min="0"
            max="20"
            step="1"
            value={noiseMeters}
            onChange={(event) => setNoiseMeters(Number(event.target.value))}
          />
          <label className="field-label" htmlFor="seed">
            Seed
          </label>
          <input
            id="seed"
            className="text-input"
            value={seed}
            onChange={(event) => setSeed(event.target.value)}
          />
          <button
            className="primary-button"
            type="button"
            onClick={generate}
            disabled={!canGenerate || isLoadingFixtures}
          >
            <Play size={17} fill="currentColor" /> Generate walks
          </button>
          <button className="secondary-button fixture-button" type="button" onClick={() => walksInputRef.current?.click()} disabled={isLoadingFixtures}>
            <FileUp size={16} /> Import walks
          </button>
          <input ref={walksInputRef} type="file" accept=".geojson,application/geo+json,application/json" hidden onChange={importWalks} />
          <fieldset
            className="walk-view"
            disabled={walks.features.length === 0}
          >
            <legend className="field-label">Map walks</legend>
            <div className="walk-view-modes">
              <label>
                <input
                  type="radio"
                  name="walk-view"
                  value="all"
                  checked={walkView === "all"}
                  onChange={() => setWalkView("all")}
                />
                <span>All walks</span>
              </label>
              <label>
                <input
                  type="radio"
                  name="walk-view"
                  value="single"
                  checked={walkView === "single"}
                  onChange={() => setWalkView("single")}
                />
                <span>One walk</span>
              </label>
            </div>
            {walkView === "single" && (
              <>
                <label className="field-label" htmlFor="selected-walk">
                  Walk{" "}
                  <output>
                    {walks.features.length > 0 ? selectedWalkIndex + 1 : 0} /{" "}
                    {walks.features.length}
                  </output>
                </label>
                <div className="walk-navigation">
                  <button
                    className="icon-button"
                    type="button"
                    title="Previous walk"
                    aria-label="Previous walk"
                    disabled={selectedWalkIndex === 0}
                    onClick={() => setSelectedWalkIndex(selectedWalkIndex - 1)}
                  >
                    <ChevronLeft size={18} />
                  </button>
                  <select
                    id="selected-walk"
                    className="text-input"
                    value={walks.features.length > 0 ? selectedWalkIndex : ""}
                    onChange={(event) =>
                      setSelectedWalkIndex(Number(event.target.value))
                    }
                  >
                    {walks.features.length === 0 && (
                      <option value="">No walks</option>
                    )}
                    {walks.features.map((_, index) => (
                      <option key={index} value={index}>
                        Walk {index + 1}
                      </option>
                    ))}
                  </select>
                  <button
                    className="icon-button"
                    type="button"
                    title="Next walk"
                    aria-label="Next walk"
                    disabled={selectedWalkIndex >= walks.features.length - 1}
                    onClick={() => setSelectedWalkIndex(selectedWalkIndex + 1)}
                  >
                    <ChevronRight size={18} />
                  </button>
                </div>
              </>
            )}
          </fieldset>
        </section>

        <section className="merge-section" aria-busy={isMerging}>
          <div className="section-heading compact">
            <div><span className="step-number">03</span><h2>Merge comparison</h2></div>
            <span className="metric">{mergeResult ? `${mergeResult.result.trails.features.length} edges` : isMerging ? "Running" : "Not run"}</span>
          </div>
          <button className="primary-button merge-button" type="button" onClick={runMerge} disabled={!canGenerate || walks.features.length === 0 || isMerging || isLoadingFixtures}>
            <GitFork size={17} /> {isMerging ? "Merging..." : "Run merger"}
          </button>
          {error && <p className="error-message" role="alert">{error}</p>}
          <div aria-live="polite">
            {mergeResult && <>
              <dl className="merge-metrics">
                <div><dt>Mean error</dt><dd>{mergeResult.score.meanErrorMeters === null ? "N/A" : `${mergeResult.score.meanErrorMeters.toFixed(2)} m`}</dd></div>
                <div><dt>P95 error</dt><dd>{mergeResult.score.p95ErrorMeters === null ? "N/A" : `${mergeResult.score.p95ErrorMeters.toFixed(2)} m`}</dd></div>
                <div><dt>Coverage (5 m)</dt><dd>{(mergeResult.score.recall * 100).toFixed(1)}%</dd></div>
                <div><dt>Precision (5 m)</dt><dd>{(mergeResult.score.precision * 100).toFixed(1)}%</dd></div>
              </dl>
              <p className="merge-summary">Junctions (10 m): {mergeResult.score.topology.matchedJunctions}/{mergeResult.score.topology.truthJunctions} matched; {mergeResult.score.topology.mergedJunctions} found.</p>
              <p className="merge-summary">{mergeResult.result.ingested.ingested.length} accepted; {mergeResult.result.ingested.rejected.length} rejected; {(mergeResult.durationMs / 1000).toFixed(2)} s.</p>
              {mergeResult.result.trails.features.length === 0 && <p className="merge-summary">No supported trails.</p>}
            </>}
          </div>
        </section>

        <section className="export-section">
          <div className="section-heading compact">
            <div>
              <span className="step-number">04</span>
              <h2>Test fixtures</h2>
            </div>
          </div>
          <div className="export-grid">
            <button
              className="secondary-button"
              type="button"
              disabled={!canGenerate}
              onClick={() =>
                downloadJson("truth.geojson", graphToGeoJson(graph))
              }
            >
              <Download size={16} /> Truth
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={walks.features.length === 0}
              onClick={() => downloadJson(`walks-${seed}.geojson`, walks)}
            >
              <Download size={16} /> Walks
            </button>
          </div>
          <button className="secondary-button fixture-button" type="button" disabled={!mergeResult || isMerging} onClick={() => mergeResult && downloadJson("merged-trails.geojson", mergeResult.result.trails)}>
            <Download size={16} /> Merged network
          </button>
        </section>
      </aside>

      <section className="map-stage">
        <div ref={mapContainerRef} className="map" />
        <div className="map-caption">
          <LocateFixed size={14} />
          <span>
            {activeNodeId
              ? "Click to extend; choose an existing point to join"
              : editingTruth ? "Click a point to begin" : "Network comparison"}
          </span>
        </div>
        <div className="legend" aria-label="Map legend">
          <label><input type="checkbox" checked={visibility.truth} onChange={(event) => setVisibility({ ...visibility, truth: event.target.checked })} /><i className="legend-truth" /> Truth</label>
          <label><input type="checkbox" checked={visibility.walks} onChange={(event) => setVisibility({ ...visibility, walks: event.target.checked })} /><i className="legend-walk" /> Walks</label>
          <label><input type="checkbox" checked={visibility.merged} disabled={!mergeResult} onChange={(event) => setVisibility({ ...visibility, merged: event.target.checked })} /><i className="legend-merged" /> Merged</label>
        </div>
      </section>
    </main>
  );
}

function addTrailLayers(map: maplibregl.Map) {
  map.addSource("simulated-walks", { type: "geojson", data: EMPTY_WALKS });
  map.addLayer({
    id: "simulated-walks",
    type: "line",
    source: "simulated-walks",
    paint: { "line-color": "#62d5e8", "line-width": 1.2, "line-opacity": 0.2 },
  });
  map.addSource("truth-edges", {
    type: "geojson",
    data: graphToGeoJson(EMPTY_GRAPH),
  });
  map.addLayer({
    id: "truth-edges",
    type: "line",
    source: "truth-edges",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ffcf4a", "line-width": 4, "line-opacity": 0.95 },
  });
  map.addSource("merged-trails", { type: "geojson", data: EMPTY_WALKS });
  map.addLayer({
    id: "merged-trails", type: "line", source: "merged-trails",
    layout: { "line-cap": "round", "line-join": "round" },
    paint: { "line-color": "#ff7299", "line-width": 3, "line-opacity": 1, "line-dasharray": [3, 1.5] },
  });
  map.addSource("truth-nodes", {
    type: "geojson",
    data: nodesGeoJson(EMPTY_GRAPH, null),
  });
  map.addLayer({
    id: "truth-nodes",
    type: "circle",
    source: "truth-nodes",
    paint: {
      "circle-radius": ["case", ["get", "active"], 7, 5],
      "circle-color": ["case", ["get", "active"], "#ffffff", "#ffcf4a"],
      "circle-stroke-color": "#162320",
      "circle-stroke-width": 2,
    },
  });
}

function nodesGeoJson(
  graph: TrailGraph,
  activeNodeId: string | null,
): FeatureCollection<Point> {
  return {
    type: "FeatureCollection",
    features: graph.nodes.map((node) => ({
      type: "Feature",
      properties: { id: node.id, active: node.id === activeNodeId },
      geometry: { type: "Point", coordinates: node.coordinate },
    })),
  };
}

function loadGraph(): TrailGraph {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored ? JSON.parse(stored) : EMPTY_GRAPH;
  } catch {
    return EMPTY_GRAPH;
  }
}

function loadView(): { center: Coordinate; zoom: number } {
  try {
    const stored = localStorage.getItem(VIEW_KEY);
    return stored ? JSON.parse(stored) : DEFAULT_VIEW;
  } catch {
    return DEFAULT_VIEW;
  }
}

function downloadJson(filename: string, data: unknown) {
  const blob = new Blob([`${JSON.stringify(data, null, 2)}\n`], {
    type: "application/geo+json",
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

export default App;
