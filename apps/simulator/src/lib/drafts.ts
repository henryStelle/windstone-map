import { useEffect, useState } from "react";
import {
  applyNames,
  namesFile,
  parseLandmarks,
  sameLandmarks,
  sameNames,
  type Landmarks,
} from "./editing";
import { landmarks, trails, type Trail } from "./trails";
import { published } from "./published";
import { EDITOR_STORAGE_PREFIX } from "./storage";

export const NAMES_KEY = `${EDITOR_STORAGE_PREFIX}-names-v1`;
export const LANDMARKS_KEY = `${EDITOR_STORAGE_PREFIX}-landmarks-v1`;
const DRAFT_EVENT = "windstone-edits-changed";

export function hasLocalMapEdits(
  segments: Trail[],
  places: Landmarks,
): boolean {
  return (
    !sameNames(segments, published.segments) ||
    !sameLandmarks(places, parseLandmarks(landmarks))
  );
}

export function loadActiveDraft() {
  let segments = published.segments;
  let places = parseLandmarks(landmarks);
  let warning =
    published.unmatched > 0
      ? `${published.unmatched} named sections no longer match this map.`
      : null;
  try {
    const saved = localStorage.getItem(NAMES_KEY);
    if (saved) {
      const restored = applyNames(trails.features, JSON.parse(saved));
      segments = restored.segments;
      if (restored.unmatched)
        warning = `${restored.unmatched} saved named sections no longer match this map.`;
      else if (sameNames(segments, published.segments))
        localStorage.removeItem(NAMES_KEY);
    }
  } catch {
    warning = "Some locally saved trail names could not be restored.";
  }
  try {
    const saved = localStorage.getItem(LANDMARKS_KEY);
    if (saved) {
      places = parseLandmarks(JSON.parse(saved));
      if (sameLandmarks(places, parseLandmarks(landmarks)))
        localStorage.removeItem(LANDMARKS_KEY);
    }
  } catch {
    warning = "Some locally saved landmarks could not be restored.";
  }
  return { segments, places, warning };
}

export function persistNames(segments: Trail[]) {
  if (sameNames(segments, published.segments))
    localStorage.removeItem(NAMES_KEY);
  else localStorage.setItem(NAMES_KEY, JSON.stringify(namesFile(segments)));
  window.dispatchEvent(new Event(DRAFT_EVENT));
}

export function persistLandmarks(places: Landmarks) {
  if (sameLandmarks(places, parseLandmarks(landmarks)))
    localStorage.removeItem(LANDMARKS_KEY);
  else localStorage.setItem(LANDMARKS_KEY, JSON.stringify(places));
  window.dispatchEvent(new Event(DRAFT_EVENT));
}

export function useActiveDraft() {
  const [draft, setDraft] = useState(loadActiveDraft);
  useEffect(() => {
    const refresh = () => setDraft(loadActiveDraft());
    window.addEventListener("storage", refresh);
    window.addEventListener(DRAFT_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener("storage", refresh);
      window.removeEventListener(DRAFT_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, []);
  return draft;
}
