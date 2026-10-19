import { lazy, Suspense, useEffect } from "react";
import Viewer from "./Viewer";
import { useActiveDraft } from "./lib/drafts";

const Simulator =
  import.meta.env.DEV ||
  import.meta.env.MODE === "fixtures" ||
  import.meta.env.MODE === "test"
    ? lazy(() => import("./App"))
    : null;
const Editor = lazy(() => import("./Editor"));

export default function Routes() {
  const draft = useActiveDraft();
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  const isSimulator =
    Simulator !== null &&
    window.location.pathname.replace(/\/$/, "") === `${base}/simulator`;
  const isEditor =
    window.location.pathname.replace(/\/$/, "") === `${base}/editor`;
  useEffect(() => {
    document.title = isSimulator
      ? "Windstone Trace Lab"
      : isEditor
        ? "Trail Editor | Windstone"
        : "Windstone Trails";
  }, [isSimulator, isEditor]);
  return (
    <Suspense fallback={<div role="status">Loading map...</div>}>
      {isSimulator && Simulator ? (
        <Simulator />
      ) : isEditor ? (
        <Editor />
      ) : (
        <Viewer segments={draft.segments} mapLandmarks={draft.places} />
      )}
    </Suspense>
  );
}
