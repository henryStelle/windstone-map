import { icons, Search, X } from "lucide-react";
import { useDeferredValue, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";

const ICON_SETTINGS: Record<string, { id: string; label: string }> = {
  MapPin: { id: "pin", label: "Pin" },
  Pin: { id: "pin-tack", label: "Pin tack" },
  Fence: { id: "gate", label: "Gate" },
  TreePine: { id: "tree", label: "Tree" },
  Droplets: { id: "water", label: "Water" },
  House: { id: "home", label: "Building" },
  Car: { id: "parking", label: "Parking" },
  Info: { id: "info", label: "Information" },
  Binoculars: { id: "lookout", label: "Lookout" },
  Accessibility: { id: "accessible", label: "Accessible" },
};

export const LANDMARK_ICONS = Object.entries(icons)
  .map(([name, Icon]) => {
    const words = name
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
    return {
      id: ICON_SETTINGS[name]?.id ?? words.toLowerCase().replace(/ /g, "-"),
      label: ICON_SETTINGS[name]?.label ?? words,
      name,
      Icon,
    };
  })
  .sort((first, second) => first.label.localeCompare(second.label));

const ICONS_BY_ID = new Map(LANDMARK_ICONS.map((icon) => [icon.id, icon]));

export type LandmarkIconId = (typeof LANDMARK_ICONS)[number]["id"];

export function landmarkIcon(value: unknown) {
  return (
    (typeof value === "string" ? ICONS_BY_ID.get(value) : undefined) ??
    ICONS_BY_ID.get("pin")!
  );
}

export function LandmarkSymbol({
  icon,
  size = 18,
  className,
}: {
  icon?: string;
  size?: number;
  className?: string;
}) {
  const Icon = landmarkIcon(icon).Icon;
  return <Icon size={size} className={className} aria-hidden="true" />;
}

export function LandmarkIconPicker({
  value,
  onSelect,
  onClose,
}: {
  value: string;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const results = useRef<HTMLDivElement>(null);
  const headingId = useId();
  const [query, setQuery] = useState("");
  const search = useDeferredValue(query);
  const words = search.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = LANDMARK_ICONS.filter((icon) =>
    words.every((word) =>
      `${icon.label} ${icon.name} ${icon.id}`.toLowerCase().includes(word),
    ),
  );

  useEffect(() => {
    const previous = document.activeElement;
    const element = dialog.current!;
    element.showModal();
    input.current?.focus();
    return () => {
      element.close();
      if (previous instanceof HTMLElement) previous.focus();
    };
  }, []);

  useEffect(() => {
    if (results.current) results.current.scrollTop = 0;
  }, [search]);

  return createPortal(
    <dialog
      className="landmark-icon-dialog"
      ref={dialog}
      aria-labelledby={headingId}
      onKeyDownCapture={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          onClose();
        }
      }}
      onCancel={(event) => {
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <header>
        <h2 id={headingId}>Landmark icon</h2>
        <button
          type="button"
          className="viewer-icon-button"
          aria-label="Close icon picker"
          title="Close icon picker"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="landmark-icon-search">
        <Search size={18} aria-hidden="true" />
        <input
          ref={input}
          type="search"
          aria-label="Search icons"
          placeholder="Search icons"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </div>
      <output className="landmark-icon-count" aria-live="polite">
        {matches.length} icons
      </output>
      <div
        className="landmark-icon-results"
        role="group"
        aria-label="Icons"
        ref={results}
        aria-busy={query !== search}
      >
        {matches.map(({ id, label, Icon }) => (
          <button
            type="button"
            className="viewer-icon-button"
            key={id}
            title={label}
            aria-label={`${label} icon`}
            aria-pressed={value === id}
            onClick={() => onSelect(id)}
          >
            <Icon size={22} />
          </button>
        ))}
        {!matches.length && (
          <p className="landmark-icon-empty" role="status">
            No icons found.
          </p>
        )}
      </div>
    </dialog>,
    document.body,
  );
}

export async function loadLandmarkImages(ids: string[] = ["pin"]) {
  const requested = new Map(
    ids.map((id) => {
      const icon = landmarkIcon(id);
      return [icon.id, icon];
    }),
  );
  return Promise.all(
    [...requested.values()].map(async ({ id, Icon }) => {
      const image = new Image();
      image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(renderToStaticMarkup(<Icon size={24} color="#143225" strokeWidth={2} />))}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 72;
      canvas.height = 72;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Landmark icons are unavailable.");
      context.beginPath();
      context.arc(36, 36, 34, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, 0.85)";
      context.fill();
      context.drawImage(image, 12, 12, 48, 48);
      return { id: `landmark-${id}`, data: context.getImageData(0, 0, 72, 72) };
    }),
  );
}
