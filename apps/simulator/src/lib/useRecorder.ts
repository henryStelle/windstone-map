import { useEffect, useRef, useState } from "react";
import { createStore, delMany, set, values } from "idb-keyval";
import type { FeatureCollection, LineString } from "geojson";
import ingestedJson from "../../../../data/ingested.json?raw";

const store = createStore("windstone-recorder", "segments");
const acknowledgments = JSON.parse(ingestedJson) as {
  ingested: string[];
  rejected: string[];
};
const acknowledgedIds = new Set([
  ...acknowledgments.ingested,
  ...acknowledgments.rejected,
]);

export interface RecordedSegment {
  id: string;
  coordinates: [number, number][];
  times: string[];
  accuracies: number[];
  recordedAt: string;
  exported: boolean;
}

export function unacknowledgedSegments(
  segments: RecordedSegment[],
): RecordedSegment[] {
  return segments.filter((segment) => !acknowledgedIds.has(segment.id));
}

export function appendPosition(
  current: RecordedSegment | null,
  position: GeolocationPosition,
): RecordedSegment {
  const { longitude, latitude, accuracy } = position.coords;
  if (
    ![longitude, latitude, accuracy, position.timestamp].every(
      Number.isFinite,
    ) ||
    accuracy <= 0 ||
    Math.abs(longitude) > 180 ||
    Math.abs(latitude) > 90
  )
    throw new Error("Invalid GPS fix.");
  const time = new Date(position.timestamp).toISOString();
  const previousTime = current ? Date.parse(current.times.at(-1)!) : null;
  const segment =
    current &&
    previousTime !== null &&
    position.timestamp > previousTime &&
    position.timestamp - previousTime <= 10_000
      ? current
      : {
          id: crypto.randomUUID(),
          coordinates: [],
          times: [],
          accuracies: [],
          recordedAt: time,
          exported: false,
        };
  return {
    ...segment,
    coordinates: [...segment.coordinates, [longitude, latitude]],
    times: [...segment.times, time],
    accuracies: [...segment.accuracies, accuracy],
    exported: false,
  };
}

export function useRecorder() {
  const [status, setStatus] = useState<"idle" | "recording" | "paused">("idle");
  const [segments, setSegments] = useState<RecordedSegment[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [accuracy, setAccuracy] = useState<number | null>(null);
  const watch = useRef<number | null>(null);
  const current = useRef<RecordedSegment | null>(null);
  const active = useRef(false);
  const mounted = useRef(false);
  const writes = useRef<Promise<void>>(Promise.resolve());
  const wake = useRef<WakeLockSentinel | null>(null);

  function pause() {
    active.current = false;
    if (watch.current !== null) navigator.geolocation.clearWatch(watch.current);
    watch.current = null;
    current.current = null;
    void wake.current?.release().catch(() => {});
    wake.current = null;
    if (mounted.current) setStatus("paused");
  }

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void values<RecordedSegment>(store)
      .then(async (saved) => {
        const received = saved.filter((segment) =>
          acknowledgedIds.has(segment.id),
        );
        if (received.length)
          await delMany(
            received.map((segment) => segment.id),
            store,
          );
        if (!cancelled) {
          setSegments(unacknowledgedSegments(saved));
          setLoaded(true);
        }
      })
      .catch(() => {
        if (!cancelled) setError("Local recording storage is unavailable.");
      });
    const visibility = () => {
      if (document.hidden && active.current) pause();
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      cancelled = true;
      mounted.current = false;
      active.current = false;
      if (watch.current !== null)
        navigator.geolocation.clearWatch(watch.current);
      watch.current = null;
      current.current = null;
      void wake.current?.release().catch(() => {});
      wake.current = null;
      document.removeEventListener("visibilitychange", visibility);
    };
  }, []);

  function start() {
    if (active.current) return;
    if (!loaded) {
      setError("Local recordings are still loading.");
      return;
    }
    if (!navigator.geolocation) {
      setError("GPS recording is unavailable in this browser.");
      return;
    }
    if (document.hidden) {
      setError("Return to the map before recording.");
      return;
    }
    active.current = true;
    current.current = null;
    setError(null);
    setStatus("recording");
    void navigator.storage?.persist?.().catch(() => {});
    if (navigator.wakeLock)
      void navigator.wakeLock
        .request("screen")
        .then((lock) => {
          if (active.current) wake.current = lock;
          else void lock.release();
        })
        .catch(() => {});
    watch.current = navigator.geolocation.watchPosition(
      (position) => {
        if (!active.current) return;
        let snapshot: RecordedSegment;
        try {
          snapshot = appendPosition(current.current, position);
        } catch {
          setError("A GPS fix was invalid and was not saved.");
          current.current = null;
          return;
        }
        current.current = snapshot;
        setAccuracy(position.coords.accuracy);
        writes.current = writes.current
          .then(async () => {
            await set(snapshot.id, snapshot, store);
            if (mounted.current)
              setSegments((previous) => [
                ...previous.filter((segment) => segment.id !== snapshot.id),
                snapshot,
              ]);
          })
          .catch(() => {
            pause();
            if (mounted.current)
              setError(
                "Recording paused: a GPS fix could not be saved. Free device storage before resuming.",
              );
          });
      },
      (failure) => {
        if (!active.current) return;
        pause();
        setError(
          failure.code === 1
            ? "Location permission was denied."
            : "GPS signal is unavailable. Recording paused.",
        );
      },
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15_000 },
    );
  }

  async function stop() {
    pause();
    setStatus("idle");
    await writes.current;
  }

  async function exportWalks(): Promise<FeatureCollection<LineString>> {
    if (active.current) throw new Error("Stop recording before exporting.");
    await writes.current;
    const saved = unacknowledgedSegments(
      await values<RecordedSegment>(store),
    ).filter((segment) => segment.coordinates.length >= 2);
    const collection: FeatureCollection<LineString> = {
      type: "FeatureCollection",
      features: saved.map((segment) => ({
        type: "Feature",
        id: segment.id,
        properties: {
          id: segment.id,
          times: segment.times,
          accuracies: segment.accuracies,
          recordedAt: segment.recordedAt,
          device: "Windstone recorder",
        },
        geometry: { type: "LineString", coordinates: segment.coordinates },
      })),
    };
    await Promise.all(
      saved.map((segment) =>
        set(segment.id, { ...segment, exported: true }, store),
      ),
    );
    if (mounted.current) setSegments(await values<RecordedSegment>(store));
    return collection;
  }

  return {
    status,
    segments,
    loaded,
    accuracy,
    error,
    start,
    pause,
    stop,
    exportWalks,
  };
}
