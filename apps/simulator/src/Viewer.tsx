import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  useState,
  type ReactNode,
} from "react";
import {
  ArrowUpRight,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Expand,
  Map as MapIcon,
  MapPin,
  Pencil,
  X,
} from "lucide-react";
import maplibregl from "maplibre-gl";
import type { FeatureCollection, LineString } from "geojson";
import "maplibre-gl/dist/maplibre-gl.css";
import {
  formatDistance,
  groupNamedTrails,
  landmarks,
  trails,
  type NamedTrail,
  type Trail,
} from "./lib/trails";
import { LandmarkSymbol, loadLandmarkImages } from "./lib/landmark-icons";
import "./Viewer.css";

interface ViewerProps {
  children?: ReactNode;
  segments?: Trail[];
  mapLandmarks?: typeof landmarks;
  highlightIds?: string[];
  onSegmentClick?: (id: string) => void;
  onLandmarkClick?: (id: string) => void;
  onMapClick?: (coordinate: [number, number]) => boolean;
  onMapReady?: (map: maplibregl.Map | null) => void;
  recordedWalks?: FeatureCollection<LineString>;
}

const EMPTY_RECORDINGS: FeatureCollection<LineString> = {
  type: "FeatureCollection",
  features: [],
};
const SELECTION_COLOR = "#cf5a45";
const SELECTION_WIDTH = 6;
const LANDMARK_RADIUS = 17;

type Selection =
  | { kind: "trail" | "segment"; id: string }
  | {
      kind: "landmark";
      id: string;
      name: string;
      description?: string;
      icon?: string;
    }
  | null;

export default function Viewer({
  children,
  segments = trails.features,
  mapLandmarks = landmarks,
  highlightIds,
  onSegmentClick,
  onLandmarkClick,
  onMapClick,
  onMapReady,
  recordedWalks = EMPTY_RECORDINGS,
}: ViewerProps = {}) {
  const mapContainer = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const attributionContainer = useRef<HTMLDivElement>(null);
  const zoomBaseline = useRef<number | null>(null);
  const panelContentId = useId();
  const [panelCollapsed, setPanelCollapsed] = useState(false);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<"trails" | "places">("trails");
  const [offline, setOffline] = useState(!navigator.onLine);
  const [message, setMessage] = useState<string | null>(null);
  const [mapBusy, setMapBusy] = useState(true);
  const namedTrails = groupNamedTrails(segments);
  const selectedId = selection?.kind === "trail" ? selection.id : null;
  const selected = namedTrails.find((trail) => trail.id === selectedId);
  const selectedSegment =
    selection?.kind === "segment"
      ? segments.find((segment) => segment.properties.id === selection.id)
      : undefined;
  const choices = selectedSegment
    ? namedTrails.filter((trail) =>
        trail.segments.some(
          (segment) => segment.properties.id === selectedSegment.properties.id,
        ),
      )
    : [];
  const totalLength = trails.features.reduce(
    (sum, trail) => sum + trail.properties.lengthMeters,
    0,
  );
  const ready = useEffectEvent((map: maplibregl.Map | null) =>
    onMapReady?.(map),
  );
  const clickMap = useEffectEvent((event: maplibregl.MapMouseEvent) => {
    if (onMapClick?.([event.lngLat.lng, event.lngLat.lat])) return;
    const map = mapRef.current;
    if (!map?.getLayer("trail-hit-target")) return;
    const features = map.queryRenderedFeatures(event.point, {
      layers: ["selected-landmark", "landmarks", "trail-hit-target"],
    });
    const landmark = features.find(
      (feature) =>
        feature.layer.id === "landmarks" ||
        feature.layer.id === "selected-landmark",
    );
    if (landmark) {
      const id = String(landmark.properties.id ?? landmark.id ?? "");
      if (onLandmarkClick) {
        setSelection(null);
        onLandmarkClick(id);
      } else
        setSelection({
          kind: "landmark",
          id,
          name: landmark.properties.name || "Landmark",
          description: landmark.properties.description,
          icon: landmark.properties.icon,
        });
      return;
    }
    const id = features.find(
      (feature) => feature.layer.id === "trail-hit-target",
    )?.properties.id;
    if (typeof id !== "string") {
      setSelection(null);
      return;
    }
    if (onSegmentClick) {
      onSegmentClick(id);
      return;
    }
    const matches = namedTrails.filter((trail) =>
      trail.segments.some((segment) => segment.properties.id === id),
    );
    setSelection(
      matches.length === 1
        ? { kind: "trail", id: matches[0].id }
        : { kind: "segment", id },
    );
    if (matches.length > 0) setTab("trails");
  });

  useEffect(() => {
    const updateNetwork = () => {
      const disconnected = !navigator.onLine;
      setOffline(disconnected);
      const map = mapRef.current;
      if (map?.getLayer("aerial"))
        map.setLayoutProperty(
          "aerial",
          "visibility",
          disconnected ? "none" : "visible",
        );
    };
    window.addEventListener("online", updateNetwork);
    window.addEventListener("offline", updateNetwork);
    return () => {
      window.removeEventListener("online", updateNetwork);
      window.removeEventListener("offline", updateNetwork);
    };
  }, []);

  useEffect(() => {
    if (!mapContainer.current) return;
    const map = new maplibregl.Map({
      container: mapContainer.current,
      center: [-76.116129, 45.056998],
      zoom: 15,
      attributionControl: false,
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
            maxzoom: 19,
            attribution:
              'Imagery &copy; <a href="https://www.arcgis.com/home/item.html?id=10df2279f9684e4a9f6a7f08febac2a9" target="_blank" rel="noopener noreferrer">Esri and contributors</a>',
          },
        },
        layers: [
          {
            id: "background",
            type: "background",
            paint: { "background-color": "#edf2ed" },
          },
          {
            id: "aerial",
            type: "raster",
            source: "aerial",
            layout: { visibility: navigator.onLine ? "visible" : "none" },
          },
        ],
      },
    });
    mapRef.current = map;
    const loadingIcons = new Set<string>();
    map.on("styleimagemissing", ({ id }) => {
      if (!id.startsWith("landmark-") || loadingIcons.has(id)) return;
      loadingIcons.add(id);
      void loadLandmarkImages([id.slice("landmark-".length)])
        .then((images) => {
          if (mapRef.current !== map || map.hasImage(id)) return;
          map.addImage(id, images[0].data, { pixelRatio: 2 });
        })
        .catch(() => {
          if (mapRef.current === map)
            setMessage("A landmark icon could not be loaded.");
        });
    });
    zoomBaseline.current = map.getZoom();
    const mobile = window.matchMedia("(max-width: 580px)");
    const resetPanel = () => {
      setPanelCollapsed(false);
      zoomBaseline.current = map.getZoom();
    };
    mobile.addEventListener("change", resetPanel);
    map.on("zoom", (event) => {
      const zoom = map.getZoom();
      if (!event.originalEvent || !mobile.matches) {
        zoomBaseline.current = zoom;
        return;
      }
      zoomBaseline.current = Math.min(zoomBaseline.current ?? zoom, zoom);
      if (zoom - zoomBaseline.current >= 0.75) {
        setPanelCollapsed(true);
        zoomBaseline.current = zoom;
      }
    });
    const updateMinZoom = () => {
      const bounds = networkBounds();
      if (!bounds) return;
      const camera = map.cameraForBounds(bounds, { padding: 55, maxZoom: 17 });
      if (camera?.zoom !== undefined) map.setMinZoom(camera.zoom - 1);
    };
    const resizeObserver = new ResizeObserver(() => {
      map.resize();
      updateMinZoom();
    });
    resizeObserver.observe(mapContainer.current);
    ready(map);
    map.addControl(
      new maplibregl.AttributionControl({ compact: false }),
      "bottom-right",
    );
    const attribution = map
      .getContainer()
      .querySelector(".maplibregl-ctrl-attrib");
    if (attribution && attributionContainer.current)
      attributionContainer.current.append(attribution);
    map.on("movestart", () => setMapBusy(true));
    map.on("idle", () => setMapBusy(false));
    map.addControl(
      new maplibregl.NavigationControl({ showCompass: false }),
      "top-right",
    );
    const geolocate = new maplibregl.GeolocateControl({
      positionOptions: { enableHighAccuracy: true },
      trackUserLocation: true,
      showAccuracyCircle: true,
    });
    map.addControl(geolocate, "top-right");
    geolocate.on("geolocate", () => setMessage(null));
    geolocate.on("error", (event: { code?: number }) => {
      setMessage(
        event.code === 1
          ? "Location permission was denied."
          : "Your location is currently unavailable.",
      );
    });
    map.on("load", () => {
      map.addSource("trails", { type: "geojson", data: trails });
      map.addLayer({
        id: "trail-casing",
        type: "line",
        source: "trails",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#183d30", "line-width": 7 },
      });
      map.addLayer({
        id: "trails",
        type: "line",
        source: "trails",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#ffe08a", "line-width": 3 },
      });
      map.addLayer({
        id: "trail-hit-target",
        type: "line",
        source: "trails",
        paint: { "line-width": 16, "line-opacity": 0 },
      });
      map.addLayer({
        id: "selected-trail",
        type: "line",
        source: "trails",
        filter: ["==", ["get", "id"], ""],
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": SELECTION_COLOR, "line-width": SELECTION_WIDTH },
      });
      map.addSource("recorded-walks", { type: "geojson", data: recordedWalks });
      map.addLayer({
        id: "recorded-walks",
        type: "line",
        source: "recorded-walks",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#62d5e8", "line-width": 4 },
      });
      map.addSource("landmarks", { type: "geojson", data: mapLandmarks });
      map.addLayer({
        id: "landmarks",
        type: "circle",
        source: "landmarks",
        paint: { "circle-radius": 18, "circle-opacity": 0 },
      });
      map.addLayer({
        id: "selected-landmark",
        type: "circle",
        source: "landmarks",
        filter: ["==", ["get", "id"], ""],
        paint: {
          "circle-radius": LANDMARK_RADIUS,
          "circle-opacity": 0,
          "circle-stroke-color": SELECTION_COLOR,
          "circle-stroke-width": SELECTION_WIDTH,
          "circle-pitch-scale": "viewport",
        },
      });
      void loadLandmarkImages()
        .then((images) => {
          if (mapRef.current !== map) return;
          for (const image of images)
            map.addImage(image.id, image.data, { pixelRatio: 2 });
          map.addLayer(
            {
              id: "landmark-icons",
              type: "symbol",
              source: "landmarks",
              layout: {
                "icon-image": [
                  "concat",
                  "landmark-",
                  ["coalesce", ["get", "icon"], "pin"],
                ],
                "icon-allow-overlap": true,
                "icon-ignore-placement": true,
              },
            },
            "selected-landmark",
          );
        })
        .catch(() => {
          if (mapRef.current === map)
            setMessage("Landmark icons could not be loaded.");
        });
      const bounds = networkBounds();
      if (bounds)
        map.fitBounds(bounds, { padding: 55, duration: 0, maxZoom: 17 });
      updateMinZoom();
    });
    map.on("click", (event) => clickMap(event));
    map.on("mouseenter", "trails", () => {
      map.getCanvas().style.cursor = "pointer";
    });
    map.on("mouseleave", "trails", () => {
      map.getCanvas().style.cursor = "";
    });
    return () => {
      resizeObserver.disconnect();
      mobile.removeEventListener("change", resetPanel);
      map.remove();
      mapRef.current = null;
      ready(null);
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const segmentIds =
      highlightIds ??
      selected?.segments.map((segment) => segment.properties.id) ??
      (selectedSegment ? [selectedSegment.properties.id] : []);
    const landmarkIds = selection?.kind === "landmark" ? [selection.id] : [];
    const select = () => {
      if (map.getLayer("selected-trail"))
        map.setFilter("selected-trail", [
          "in",
          ["get", "id"],
          ["literal", segmentIds],
        ]);
      if (map.getLayer("selected-landmark"))
        map.setFilter("selected-landmark", [
          "in",
          ["to-string", ["coalesce", ["get", "id"], ["id"], ""]],
          ["literal", landmarkIds],
        ]);
    };
    if (map.getLayer("selected-trail")) select();
    else map.once("load", select);
    return () => {
      map.off("load", select);
    };
  }, [highlightIds, segments, selection]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      (
        map.getSource("landmarks") as maplibregl.GeoJSONSource | undefined
      )?.setData(mapLandmarks);
    };
    if (map.getSource("landmarks")) update();
    else map.once("load", update);
    return () => {
      map.off("load", update);
    };
  }, [mapLandmarks]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const update = () => {
      (
        map.getSource("recorded-walks") as maplibregl.GeoJSONSource | undefined
      )?.setData(recordedWalks);
    };
    if (map.getSource("recorded-walks")) update();
    else map.once("load", update);
    return () => {
      map.off("load", update);
    };
  }, [recordedWalks]);

  function selectTrail(trail: NamedTrail) {
    setSelection({ kind: "trail", id: trail.id });
    const map = mapRef.current;
    if (!map) return;
    const canvas = map.getCanvas();
    const entirelyVisible = trail.segments.every((segment) =>
      segment.geometry.coordinates.every(([longitude, latitude]) => {
        const point = map.project([longitude, latitude]);
        return (
          point.x >= 0 &&
          point.x <= canvas.clientWidth &&
          point.y >= 0 &&
          point.y <= canvas.clientHeight
        );
      }),
    );
    if (entirelyVisible) return;
    const bounds = new maplibregl.LngLatBounds();
    for (const segment of trail.segments)
      for (const coordinate of segment.geometry.coordinates)
        bounds.extend([coordinate[0], coordinate[1]]);
    map.fitBounds(bounds, { padding: 75, maxZoom: 18, duration: 500 });
  }

  function selectLandmark(
    landmark: (typeof landmarks.features)[number],
    index: number,
  ) {
    setSelection({
      kind: "landmark",
      id: String(landmark.properties.id ?? landmark.id ?? index),
      name: landmark.properties.name || `Place ${index + 1}`,
      description: landmark.properties.description,
      icon: landmark.properties.icon,
    });
    const map = mapRef.current;
    if (!map) return;
    const center: [number, number] = [
      landmark.geometry.coordinates[0],
      landmark.geometry.coordinates[1],
    ];
    const point = map.project(center);
    const canvas = map.getCanvas();
    const radius = LANDMARK_RADIUS + SELECTION_WIDTH;
    if (
      point.x >= radius &&
      point.x <= canvas.clientWidth - radius &&
      point.y >= radius &&
      point.y <= canvas.clientHeight - radius
    )
      return;
    map.flyTo({ center, zoom: 17 });
  }

  return (
    <main
      className={`trail-viewer${panelCollapsed ? " viewer-panel-collapsed" : ""}`}
    >
      <aside className="viewer-panel">
        <header className="viewer-header">
          <div className="viewer-brand">
            <img
              className="viewer-mark"
              src={`${import.meta.env.BASE_URL}windstone-logo.png`}
              alt="Windstone Farm Community"
              width="46"
              height="46"
            />
            <div className="viewer-brand-title">
              <span className="viewer-eyebrow">
                {children ? "Map editor" : "Explore Windstone"}
              </span>
              <h1>Windstone Trails</h1>
            </div>
            <button
              type="button"
              className="viewer-icon-button viewer-panel-toggle"
              aria-label={
                panelCollapsed ? "Expand map panel" : "Collapse map panel"
              }
              title={panelCollapsed ? "Expand map panel" : "Collapse map panel"}
              aria-expanded={!panelCollapsed}
              aria-controls={panelContentId}
              onClick={() => {
                zoomBaseline.current = mapRef.current?.getZoom() ?? null;
                setPanelCollapsed(!panelCollapsed);
              }}
            >
              {panelCollapsed ? (
                <ChevronUp size={21} />
              ) : (
                <ChevronDown size={21} />
              )}
            </button>
          </div>
        </header>
        <div className="viewer-panel-content" id={panelContentId}>
          <div className="viewer-network">
            <span className="network-dot" />
            {formatDistance(totalLength)} of mapped trails
          </div>
          {children ? (
            <div className="viewer-editor">{children}</div>
          ) : (
            <>
              <div
                className="viewer-tabs"
                role="tablist"
                aria-label="Map collections"
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "trails"}
                  aria-controls="trail-list"
                  id="trails-tab"
                  onClick={() => setTab("trails")}
                >
                  Trails <span>{namedTrails.length}</span>
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={tab === "places"}
                  aria-controls="place-list"
                  id="places-tab"
                  onClick={() => setTab("places")}
                >
                  Places <span>{mapLandmarks.features.length}</span>
                </button>
              </div>
              {tab === "trails" ? (
                <div
                  className="viewer-collection"
                  role="tabpanel"
                  id="trail-list"
                  aria-labelledby="trails-tab"
                >
                  <div className="viewer-list">
                    {namedTrails.length === 0 && (
                      <p className="viewer-empty">No named trails yet.</p>
                    )}
                    {namedTrails.map((trail) => (
                      <button
                        className="trail-row"
                        type="button"
                        key={trail.id}
                        aria-pressed={selectedId === trail.id}
                        onClick={() => selectTrail(trail)}
                      >
                        <span className="trail-row-icon">
                          <ArrowUpRight size={19} />
                        </span>
                        <span className="trail-row-name">
                          {trail.name}
                          <small>{formatDistance(trail.lengthMeters)}</small>
                        </span>
                        <ChevronRight size={16} />
                      </button>
                    ))}
                  </div>
                </div>
              ) : (
                <div
                  className="viewer-collection"
                  role="tabpanel"
                  id="place-list"
                  aria-labelledby="places-tab"
                >
                  {mapLandmarks.features.length === 0 ? (
                    <div className="viewer-empty">
                      <MapPin size={25} />
                      <p>No landmarks added yet.</p>
                    </div>
                  ) : (
                    <div className="viewer-list">
                      {mapLandmarks.features.map((landmark, index) => (
                        <button
                          className="trail-row"
                          type="button"
                          key={String(landmark.id ?? index)}
                          onClick={() => selectLandmark(landmark, index)}
                        >
                          <LandmarkSymbol icon={landmark.properties.icon} />
                          <span className="trail-row-name">
                            {landmark.properties.name || `Place ${index + 1}`}
                          </span>
                          <ChevronRight size={16} />
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        <footer
          className="viewer-footer"
          aria-label={offline ? "Offline trail map" : "Map attribution"}
        >
          <div ref={attributionContainer} />
          <a
            className="viewer-editor-link"
            href={
              children
                ? import.meta.env.BASE_URL
                : `${import.meta.env.BASE_URL}editor`
            }
            title={children ? "View map" : "Open editor"}
          >
            {children ? <MapIcon size={14} /> : <Pencil size={14} />}
            <span>{children ? "Map" : "Editor"}</span>
          </a>
        </footer>
      </aside>

      <section className="viewer-map-stage" aria-label="Trail network">
        <div className="viewer-map" ref={mapContainer} aria-busy={mapBusy} />
        <div className="viewer-map-tools">
          <button
            type="button"
            className="viewer-icon-button"
            title="Fit trail network"
            aria-label="Fit trail network"
            onClick={() => {
              const bounds = networkBounds();
              if (bounds)
                mapRef.current?.fitBounds(bounds, {
                  padding: 55,
                  duration: 500,
                });
            }}
          >
            <Expand size={19} />
          </button>
        </div>
        {(selected || selectedSegment || selection?.kind === "landmark") && (
          <div className="viewer-selection" aria-live="polite">
            <span className="selection-line" aria-hidden="true" />
            {selection?.kind === "landmark" && (
              <LandmarkSymbol
                icon={selection.icon}
                className="selection-landmark"
                size={24}
              />
            )}
            <div>
              {choices.length < 2 && (
                <strong>
                  {selection?.kind === "landmark"
                    ? selection.name
                    : (selected?.name ?? "Unnamed")}
                </strong>
              )}
              {selection?.kind === "landmark" && selection.description && (
                <p className="viewer-selection-description">
                  {selection.description}
                </p>
              )}
              {choices.length > 1 && (
                <div className="viewer-trail-memberships">
                  <span className="viewer-eyebrow">Part of:</span>
                  <ul>
                    {choices.map((trail) => (
                      <li key={trail.id}>
                        <a
                          href={`#trail=${encodeURIComponent(trail.id)}`}
                          onClick={(event) => {
                            event.preventDefault();
                            selectTrail(trail);
                          }}
                        >
                          {trail.name}
                        </a>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {selection?.kind !== "landmark" && (
                <span className="viewer-selection-distance">
                  {formatDistance(
                    selected?.lengthMeters ??
                      selectedSegment?.properties.lengthMeters ??
                      0,
                  )}
                </span>
              )}
            </div>
            <button
              type="button"
              className="viewer-icon-button"
              aria-label="Clear selection"
              title="Clear selection"
              onClick={() => setSelection(null)}
            >
              <X size={17} />
            </button>
          </div>
        )}
        {message && (
          <div className="viewer-message" role="status">
            <span>{message}</span>
            <button
              type="button"
              aria-label="Dismiss message"
              title="Dismiss message"
              onClick={() => setMessage(null)}
            >
              <X size={16} />
            </button>
          </div>
        )}
      </section>
    </main>
  );
}

function networkBounds() {
  if (trails.features.length === 0) return null;
  const bounds = new maplibregl.LngLatBounds();
  for (const trail of trails.features)
    for (const coordinate of trail.geometry.coordinates)
      bounds.extend([coordinate[0], coordinate[1]]);
  return bounds;
}
