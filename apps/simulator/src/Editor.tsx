import { useEffect, useRef, useState } from "react";
import {
  Check,
  Circle,
  Download,
  MapPin,
  MapPinPlus,
  Pause,
  Pencil,
  Play,
  Plus,
  Square,
  Trash2,
  X,
} from "lucide-react";
import type maplibregl from "maplibre-gl";
import Viewer from "./Viewer";
import {
  connectedSections,
  downloadGeoJson,
  editsFile,
  removeName,
  saveName,
  type Landmarks,
} from "./lib/editing";
import { formatDistance, groupNamedTrails, type Trail } from "./lib/trails";
import {
  hasLocalMapEdits,
  loadActiveDraft,
  persistLandmarks,
  persistNames,
} from "./lib/drafts";
import {
  LandmarkIconPicker,
  LandmarkSymbol,
  landmarkIcon,
  type LandmarkIconId,
} from "./lib/landmark-icons";
import { useRecorder } from "./lib/useRecorder";
import "./Editor.css";

const NAMING_MEDIA = "(min-width: 761px) and (pointer: fine)";

interface LandmarkDraft {
  id: string;
  name: string;
  coordinate: [number, number];
  icon: LandmarkIconId;
}

export default function Editor() {
  const [draft, setDraft] = useState(loadActiveDraft);
  const [canName, setCanName] = useState(
    () => matchMedia(NAMING_MEDIA).matches,
  );
  const [mode, setMode] = useState<"names" | "places" | "record">(() =>
    matchMedia(NAMING_MEDIA).matches ? "names" : "places",
  );
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [editingName, setEditingName] = useState<string | null>(null);
  const [placing, setPlacing] = useState(false);
  const [point, setPoint] = useState<LandmarkDraft | null>(null);
  const [iconPickerOpen, setIconPickerOpen] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [downloading, setDownloading] = useState(false);
  const map = useRef<maplibregl.Map | null>(null);
  const recorder = useRecorder();
  const named = groupNamedTrails(draft.segments);
  const selectionConnected = connectedSections(draft.segments, selectedIds);
  const pendingEdits =
    hasLocalMapEdits(draft.segments, draft.places) ||
    recorder.segments.some((segment) => segment.coordinates.length >= 2);
  const canDownload =
    recorder.loaded &&
    pendingEdits &&
    recorder.status !== "recording" &&
    !downloading;

  useEffect(() => {
    const media = matchMedia(NAMING_MEDIA);
    const change = () => {
      setCanName(media.matches);
      if (!media.matches) {
        setMode("places");
        setSelectedIds([]);
      }
    };
    media.addEventListener("change", change);
    return () => media.removeEventListener("change", change);
  }, []);

  function updateSegments(segments: Trail[]) {
    setDraft((previous) => ({ ...previous, segments, warning: null }));
    try {
      persistNames(segments);
    } catch {
      setNotice("Draft saving is unavailable. Download edits before leaving.");
    }
  }

  function updatePlaces(places: Landmarks) {
    setDraft((previous) => ({ ...previous, places }));
    try {
      persistLandmarks(places);
    } catch {
      setNotice("Draft saving is unavailable. Download edits before leaving.");
    }
  }

  function newTrail() {
    setEditingName(null);
    setName("");
    setSelectedIds([]);
  }

  function saveTrail() {
    if (!canName) return;
    try {
      setNotice(null);
      updateSegments(saveName(draft.segments, editingName, name, selectedIds));
      newTrail();
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to save trail name.",
      );
    }
  }

  function savePoint() {
    if (!point || !point.name.trim()) return;
    setNotice(null);
    updatePlaces({
      type: "FeatureCollection",
      features: [
        ...draft.places.features.filter(
          (feature) => feature.properties.id !== point.id,
        ),
        {
          type: "Feature",
          id: point.id,
          properties: {
            ...draft.places.features.find(
              (feature) => feature.properties.id === point.id,
            )?.properties,
            id: point.id,
            name: point.name.trim(),
            icon: point.icon,
          },
          geometry: { type: "Point", coordinates: point.coordinate },
        },
      ],
    });
    setPlacing(false);
  }

  function editPoint(id: string) {
    const feature = draft.places.features.find(
      (item) => item.properties.id === id,
    );
    if (!feature) return;
    setMode("places");
    setPlacing(false);
    setPoint({
      id,
      name: feature.properties.name,
      coordinate: [
        feature.geometry.coordinates[0],
        feature.geometry.coordinates[1],
      ],
      icon: landmarkIcon(feature.properties.icon).id,
    });
  }

  async function downloadEdits() {
    if (!canDownload) return;
    setDownloading(true);
    setNotice(null);
    try {
      const walks = await recorder.exportWalks();
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      downloadGeoJson(
        `windstone-edits-${stamp}.json`,
        editsFile(draft.segments, draft.places, walks),
        "application/json",
      );
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "Unable to download edits.",
      );
    } finally {
      setDownloading(false);
    }
  }

  return (
    <Viewer
      segments={draft.segments}
      mapLandmarks={draft.places}
      highlightIds={canName && mode === "names" ? selectedIds : []}
      recordedWalks={{
        type: "FeatureCollection",
        features: recorder.segments
          .filter((segment) => segment.coordinates.length >= 2)
          .map((segment) => ({
            type: "Feature",
            properties: { id: segment.id },
            geometry: { type: "LineString", coordinates: segment.coordinates },
          })),
      }}
      onMapReady={(instance) => {
        map.current = instance;
      }}
      onSegmentClick={(id) => {
        if (canName && mode === "names")
          setSelectedIds((previous) =>
            previous.includes(id)
              ? previous.filter((selected) => selected !== id)
              : [...previous, id],
          );
      }}
      onMapClick={(coordinate) => {
        if (mode !== "places" || !placing) return false;
        setPoint((previous) => ({
          id: previous?.id ?? crypto.randomUUID(),
          name: previous?.name ?? "",
          coordinate,
          icon: previous?.icon ?? "pin",
        }));
        setPlacing(false);
        return true;
      }}
      onLandmarkClick={editPoint}
    >
      <div
        className="editor-toolbar"
        title={
          recorder.status === "recording"
            ? "Pause recording before downloading edits"
            : pendingEdits
              ? undefined
              : "No local changes"
        }
      >
        <button
          className="editor-primary"
          disabled={!canDownload}
          onClick={() => void downloadEdits()}
        >
          <Download size={16} />
          Download edits
        </button>
      </div>
      <div className="editor-tabs" role="tablist" aria-label="Editor tools">
        {canName && (
          <button
            role="tab"
            aria-selected={mode === "names"}
            onClick={() => {
              setMode("names");
              setPlacing(false);
            }}
          >
            <Pencil size={15} />
            Trails
          </button>
        )}
        <button
          role="tab"
          aria-selected={mode === "places"}
          onClick={() => setMode("places")}
        >
          <MapPin size={15} />
          Places
        </button>
        <button
          role="tab"
          aria-selected={mode === "record"}
          onClick={() => {
            setMode("record");
            setPlacing(false);
          }}
        >
          <Circle size={15} />
          Record
        </button>
      </div>
      {(notice || draft.warning) && (
        <p className="editor-notice" role="status">
          {notice || draft.warning}
        </p>
      )}
      {mode === "names" && canName && (
        <section className="editor-section" aria-label="Trail naming">
          <div className="editor-heading">
            <h2>Trail names</h2>
            <button
              className="viewer-icon-button"
              title="New trail name"
              aria-label="New trail name"
              onClick={newTrail}
            >
              <Plus size={17} />
            </button>
          </div>
          <div className="editor-selection-tools">
            <output aria-live="polite">{selectedIds.length} selected</output>
            <button
              className="viewer-icon-button"
              title="Clear selected sections"
              aria-label="Clear selected sections"
              onClick={() => setSelectedIds([])}
            >
              <X size={17} />
            </button>
          </div>
          <label className="editor-label" htmlFor="trail-name">
            Trail name
          </label>
          <input
            className="editor-input"
            id="trail-name"
            maxLength={120}
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          {selectedIds.length > 0 && !selectionConnected && (
            <p className="editor-notice" role="alert">
              Selected sections are disconnected. Select connecting sections
              before saving.
            </p>
          )}
          <div className="editor-actions">
            <button
              className="editor-primary"
              title="Save trail name and selected sections"
              onClick={saveTrail}
              disabled={!name.trim() || !selectionConnected}
            >
              <Check size={16} />
              {editingName ? "Update trail" : "Create trail"}
            </button>
            {editingName && (
              <button
                className="viewer-icon-button"
                aria-label="Delete trail name"
                title="Delete trail name"
                onClick={() => {
                  if (window.confirm("Delete this trail name?")) {
                    updateSegments(removeName(draft.segments, editingName));
                    setEditingName(null);
                    setName("");
                    setSelectedIds([]);
                  }
                }}
              >
                <Trash2 size={17} />
              </button>
            )}
          </div>
          <div className="editor-saved-list">
            {named.map((trail) => (
              <button
                className="trail-row"
                key={trail.id}
                aria-pressed={editingName === trail.id}
                onClick={() => {
                  setEditingName(trail.id);
                  setName(trail.name);
                  setSelectedIds(
                    trail.segments.map((segment) => segment.properties.id),
                  );
                }}
              >
                <span className="trail-row-name">
                  {trail.name}
                  <small>{formatDistance(trail.lengthMeters)}</small>
                </span>
                <Pencil size={15} />
              </button>
            ))}
          </div>
        </section>
      )}
      {mode === "places" && (
        <section className="editor-section" aria-label="Landmark editing">
          <div className="editor-heading">
            <h2>Landmarks</h2>
            <button
              className="viewer-icon-button"
              aria-label="New landmark"
              title="New landmark"
              onClick={() => {
                setPoint(null);
                setPlacing(true);
              }}
            >
              <Plus size={17} />
            </button>
          </div>
          <button
            className="editor-secondary"
            aria-pressed={placing}
            onClick={() => setPlacing(!placing)}
          >
            <MapPinPlus size={16} />
            {placing
              ? "Placing landmark"
              : point
                ? "Move landmark"
                : "Place landmark"}
          </button>
          {point && (
            <>
              <label className="editor-label" htmlFor="landmark-name">
                Landmark name
              </label>
              <input
                className="editor-input"
                id="landmark-name"
                maxLength={120}
                value={point.name}
                onChange={(event) =>
                  setPoint({ ...point, name: event.target.value })
                }
              />
              <div className="editor-icon-picker">
                <span>Icon</span>
                <div className="editor-icon-preview">
                  <LandmarkSymbol icon={point.icon} size={24} />
                  <button
                    type="button"
                    className="viewer-icon-button"
                    title="Edit landmark icon"
                    aria-label="Edit landmark icon"
                    onClick={() => setIconPickerOpen(true)}
                  >
                    <Pencil size={17} />
                  </button>
                </div>
              </div>
              {iconPickerOpen && (
                <LandmarkIconPicker
                  value={point.icon}
                  onSelect={(icon) => {
                    setPoint({ ...point, icon });
                    setIconPickerOpen(false);
                  }}
                  onClose={() => setIconPickerOpen(false)}
                />
              )}
              <div className="editor-actions">
                <button
                  className="editor-primary"
                  disabled={!point.name.trim()}
                  onClick={savePoint}
                >
                  <Check size={16} />
                  Save landmark
                </button>
                {draft.places.features.some(
                  (feature) => feature.properties.id === point.id,
                ) && (
                  <button
                    className="viewer-icon-button"
                    title="Delete landmark"
                    aria-label="Delete landmark"
                    onClick={() => {
                      if (window.confirm("Delete this landmark?")) {
                        updatePlaces({
                          ...draft.places,
                          features: draft.places.features.filter(
                            (feature) => feature.properties.id !== point.id,
                          ),
                        });
                        setPoint(null);
                      }
                    }}
                  >
                    <Trash2 size={17} />
                  </button>
                )}
              </div>
            </>
          )}
          <div className="editor-saved-list">
            {draft.places.features.map((feature) => (
              <button
                className="trail-row"
                key={feature.properties.id}
                onClick={() => {
                  editPoint(feature.properties.id);
                  map.current?.flyTo({
                    center: [
                      feature.geometry.coordinates[0],
                      feature.geometry.coordinates[1],
                    ],
                    zoom: 17,
                  });
                }}
              >
                <LandmarkSymbol icon={feature.properties.icon} size={16} />
                <span className="trail-row-name">
                  {feature.properties.name}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}
      {mode === "record" && (
        <section className="editor-section" aria-label="Walk recording">
          <div className="editor-heading">
            <h2>
              {recorder.status === "recording"
                ? "Recording"
                : recorder.status === "paused"
                  ? "Recording paused"
                  : "Walk recorder"}
            </h2>
            <span
              className="recording-dot"
              data-recording={recorder.status === "recording"}
            />
          </div>
          <div className="editor-record-metrics" aria-live="polite">
            <span>
              {recorder.segments.reduce(
                (sum, segment) => sum + segment.coordinates.length,
                0,
              )}{" "}
              saved points
            </span>
            <span>
              {recorder.accuracy === null
                ? "No GPS fix"
                : `${Math.round(recorder.accuracy)} m accuracy`}
            </span>
          </div>
          {recorder.error && (
            <p className="editor-notice" role="alert">
              {recorder.error}
            </p>
          )}
          <div className="editor-actions">
            {recorder.status !== "recording" ? (
              <button className="editor-primary" onClick={recorder.start}>
                {recorder.status === "paused" ? (
                  <Play size={16} />
                ) : (
                  <Circle size={16} />
                )}{" "}
                {recorder.status === "paused"
                  ? "Resume recording"
                  : "Start recording"}
              </button>
            ) : (
              <button className="editor-primary" onClick={recorder.pause}>
                <Pause size={16} />
                Pause recording
              </button>
            )}
            {recorder.status !== "idle" && (
              <button
                className="viewer-icon-button"
                title="Stop recording"
                aria-label="Stop recording"
                onClick={() => void recorder.stop()}
              >
                <Square size={16} />
              </button>
            )}
          </div>
          <div className="editor-saved-list">
            {recorder.segments.map((segment) => (
              <div className="editor-record-row" key={segment.id}>
                <span>
                  {new Date(segment.recordedAt).toLocaleString()}
                  <small>{segment.coordinates.length} points</small>
                </span>
                <span>{segment.exported ? "Exported" : "On this device"}</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </Viewer>
  );
}
