import { expect, test, type Page } from "@playwright/test";
import { readFile } from "node:fs/promises";
import type { Feature, LineString } from "geojson";
import { icons } from "lucide-react";

type NetworkSegment = Feature<
  LineString,
  { id: string; lengthMeters: number; from: string; to: string }
>;

async function publishedEdits() {
  return {
    names: JSON.parse(
      await readFile(
        new URL("../../../data/recorded-002/output/trail-names.geojson", import.meta.url),
        "utf8",
      ),
    ),
    landmarks: JSON.parse(
      await readFile(
        new URL("../../../data/recorded-002/output/landmarks.geojson", import.meta.url),
        "utf8",
      ),
    ),
  };
}

async function seedEditorStorage(
  page: Page,
  {
    names,
    landmarks,
    walks = [],
  }: { names: unknown; landmarks: unknown; walks?: { id: string }[] },
) {
  await page.goto("/");
  await page.evaluate(
    async ({ names, landmarks, walks }) => {
      localStorage.setItem("windstone-editor-names-v1", JSON.stringify(names));
      localStorage.setItem(
        "windstone-editor-landmarks-v1",
        JSON.stringify(landmarks),
      );
      if (!walks.length) return;
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("windstone-recorder", 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore("segments");
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const transaction = database.transaction("segments", "readwrite");
          for (const walk of walks)
            transaction.objectStore("segments").put(walk, walk.id);
          transaction.oncomplete = () => {
            database.close();
            resolve();
          };
          transaction.onerror = () => {
            database.close();
            reject(transaction.error);
          };
        };
      });
    },
    { names, landmarks, walks },
  );
}

async function storedRecordingIds(page: Page) {
  return page.evaluate(
    () =>
      new Promise<IDBValidKey[]>((resolve, reject) => {
        const request = indexedDB.open("windstone-recorder", 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const database = request.result;
          const keys = database
            .transaction("segments")
            .objectStore("segments")
            .getAllKeys();
          keys.onsuccess = () => {
            database.close();
            resolve(keys.result);
          };
          keys.onerror = () => {
            database.close();
            reject(keys.error);
          };
        };
      }),
  );
}

async function networkScreenPoint(
  page: Page,
  coordinate: number[],
  segments: NetworkSegment[],
) {
  const project = ([longitude, latitude]: number[]) => [
    (longitude + 180) / 360,
    0.5 -
      Math.log(Math.tan(Math.PI / 4 + (latitude * Math.PI) / 360)) /
        (2 * Math.PI),
  ];
  const points = segments.flatMap((segment) =>
    segment.geometry.coordinates.map(project),
  );
  const west = Math.min(...points.map(([horizontal]) => horizontal));
  const east = Math.max(...points.map(([horizontal]) => horizontal));
  const north = Math.min(...points.map(([, vertical]) => vertical));
  const south = Math.max(...points.map(([, vertical]) => vertical));
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const bounds = await page.locator(".viewer-map").boundingBox();
  if (!bounds) throw new Error("Map is not visible");
  const scale = Math.min(
    (bounds.width - 110) / (east - west),
    (bounds.height - 110) / (south - north),
    512 * 2 ** 17,
  );
  const [horizontal, vertical] = project(coordinate);
  return {
    x: bounds.x + bounds.width / 2 + (horizontal - (west + east) / 2) * scale,
    y: bounds.y + bounds.height / 2 + (vertical - (north + south) / 2) * scale,
  };
}

async function clickNetworkCoordinate(
  page: Page,
  coordinate: number[],
  segments: NetworkSegment[],
) {
  const point = await networkScreenPoint(page, coordinate, segments);
  await page.mouse.click(point.x, point.y);
}

async function landmarkRingPixels(
  page: Page,
  coordinate: number[],
  segments: NetworkSegment[],
) {
  const point = await networkScreenPoint(page, coordinate, segments);
  const bounds = await page.locator(".viewer-map").boundingBox();
  if (!bounds) throw new Error("Map is not visible");
  const screenshot = await page
    .locator(".viewer-map")
    .screenshot({ animations: "disabled", scale: "css" });
  return page.evaluate(
    async ({ source, horizontal, vertical }) => {
      const image = new Image();
      image.src = source;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = 64;
      canvas.height = 1;
      const context = canvas.getContext("2d")!;
      context.drawImage(
        image,
        horizontal - 32,
        Math.floor(vertical),
        64,
        1,
        0,
        0,
        64,
        1,
      );
      const pixels = context.getImageData(0, 0, 64, 1).data;
      let redPixels = 0;
      for (let offset = 0; offset < pixels.length; offset += 4) {
        if (
          Math.abs(pixels[offset] - 207) <= 5 &&
          Math.abs(pixels[offset + 1] - 90) <= 5 &&
          Math.abs(pixels[offset + 2] - 69) <= 5
        )
          redPixels++;
      }
      return redPixels;
    },
    {
      source: `data:image/png;base64,${screenshot.toString("base64")}`,
      horizontal: point.x - bounds.x,
      vertical: point.y - bounds.y,
    },
  );
}

async function trailSelectionPixels(
  page: Page,
  segment: NetworkSegment,
  network: NetworkSegment[],
) {
  const points = await Promise.all(
    segment.geometry.coordinates.map((coordinate) =>
      networkScreenPoint(page, coordinate, network),
    ),
  );
  const bounds = await page.locator(".viewer-map").boundingBox();
  if (!bounds) throw new Error("Map is not visible");
  const screenshot = await page.locator(".viewer-map").screenshot({
    scale: "css",
    style: ".viewer-selections { visibility: hidden; }",
  });
  return page.evaluate(async ({ source, points, bounds }) => {
    const image = new Image();
    image.src = source;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    const counts = [0, 0];
    const colors = [[207, 90, 69], [37, 139, 224]];
    for (let index = 1; index < points.length; index++) {
      const start = points[index - 1];
      const end = points[index];
      const length = Math.hypot(end.x - start.x, end.y - start.y);
      for (let step = 0; step < length; step++) {
        const horizontal = Math.round(start.x + (end.x - start.x) * step / length - bounds.x);
        const vertical = Math.round(start.y + (end.y - start.y) * step / length - bounds.y);
        if (horizontal < 0 || vertical < 0 || horizontal >= canvas.width || vertical >= canvas.height) continue;
        const offset = (vertical * canvas.width + horizontal) * 4;
        colors.forEach((color, colorIndex) => {
          if (color.every((value, channel) => Math.abs(pixels[offset + channel] - value) <= 10))
            counts[colorIndex]++;
        });
      }
    }
    return counts;
  }, {
    source: `data:image/png;base64,${screenshot.toString("base64")}`,
    points,
    bounds,
  });
}

test("viewer selections distinguish landmarks, unnamed segments and shared trails", async ({
  page,
}, testInfo) => {
  const network = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: NetworkSegment[] };
  const [shared, continuation, unnamed, placeSegment] = network.features;
  const placeCoordinate =
    placeSegment.geometry.coordinates[
      Math.floor(placeSegment.geometry.coordinates.length / 2)
    ];
  const names = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Meadow Loop" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            shared.geometry.coordinates,
            continuation.geometry.coordinates,
          ],
        },
      },
      {
        type: "Feature",
        properties: { name: "Shortcut" },
        geometry: {
          type: "MultiLineString",
          coordinates: [shared.geometry.coordinates],
        },
      },
    ],
  };
  const places = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "lookout",
        properties: {
          id: "lookout",
          name: "Lookout",
          description: "Above the meadow",
        },
        geometry: { type: "Point", coordinates: placeCoordinate },
      },
    ],
  };
  await page.addInitScript(
    ({ names, places }) => {
      localStorage.setItem("windstone-editor-names-v1", JSON.stringify(names));
      localStorage.setItem(
        "windstone-editor-landmarks-v1",
        JSON.stringify(places),
      );
    },
    { names, places },
  );
  await page.goto("/");
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.getByRole("button", { name: /^Meadow Loop/ }).click();
  const selection = page.locator(".viewer-selection");
  const expectSelectionAccent = async () => {
    await expect(selection.locator(".selection-line")).toBeVisible();
    const insets = await selection.evaluate((element) => {
      const panel = element.getBoundingClientRect();
      const line = element
        .querySelector(".selection-line")!
        .getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        top: line.top - panel.top,
        bottom: panel.bottom - line.bottom,
        expectedTop:
          parseFloat(style.paddingTop) + parseFloat(style.borderTopWidth),
        expectedBottom:
          parseFloat(style.paddingBottom) + parseFloat(style.borderBottomWidth),
      };
    });
    expect(insets.top).toBeCloseTo(insets.expectedTop, 1);
    expect(insets.bottom).toBeCloseTo(insets.expectedBottom, 1);
  };
  await expect(selection.locator("strong")).toHaveText("Meadow Loop");
  await expect(
    selection.getByText(/^(Landmark|Selected trail|Selected segment)$/i),
  ).toHaveCount(0);
  await expectSelectionAccent();
  await expect(selection.locator(":scope > div > :last-child")).toHaveClass(
    "viewer-selection-distance",
  );
  await page.locator(".viewer-map").click({ position: { x: 10, y: 10 } });
  await expect(selection).toHaveCount(0);
  await expect(page.locator('.trail-row[aria-pressed="true"]')).toHaveCount(0);
  await page.getByRole("button", { name: /^Meadow Loop/ }).click();
  const trailPosition = await selection.boundingBox();
  await page.getByRole("tab", { name: "Places" }).click();
  await page.getByRole("button", { name: "Lookout", exact: true }).click();
  await expect(selection.locator("strong")).toHaveText("Lookout");
  await expect(
    selection.getByText(/^(Landmark|Selected trail|Selected segment)$/i),
  ).toHaveCount(0);
  await expect(selection).toContainText("Above the meadow");
  await expectSelectionAccent();
  const landmarkPosition = await selection.boundingBox();
  expect(landmarkPosition?.x).toBe(trailPosition?.x);
  expect(landmarkPosition!.y + landmarkPosition!.height).toBeCloseTo(
    trailPosition!.y + trailPosition!.height,
    0,
  );
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const ringPixels = await landmarkRingPixels(
    page,
    placeCoordinate,
    network.features,
  );
  expect(ringPixels).toBeGreaterThanOrEqual(10);
  expect(ringPixels).toBeLessThanOrEqual(14);
  await page.screenshot({
    path: testInfo.outputPath("selected-landmark.png"),
    animations: "disabled",
  });
  await page.locator(".viewer-map").click({ position: { x: 10, y: 10 } });
  await expect(selection).toHaveCount(0);
  expect(
    await landmarkRingPixels(page, placeCoordinate, network.features),
  ).toBe(0);
  await expect(page.locator(".viewer-message")).toHaveCount(0);
  await page.getByRole("tab", { name: "Trails" }).click();
  await expect(
    page.getByRole("button", { name: /^Meadow Loop/ }),
  ).toHaveAttribute("aria-pressed", "false");
  await page
    .getByRole("button", { name: "Fit trail network", exact: true })
    .click();
  await clickNetworkCoordinate(
    page,
    unnamed.geometry.coordinates[
      Math.floor(unnamed.geometry.coordinates.length / 2)
    ],
    network.features,
  );
  await expect(selection.locator("strong")).toHaveText("Unnamed");
  await expect(
    selection.getByText(/^(Landmark|Selected trail|Selected segment)$/i),
  ).toHaveCount(0);
  await expectSelectionAccent();
  await expect(selection).toContainText(
    `${Math.round(unnamed.properties.lengthMeters)} m`,
  );
  await expect(selection.locator(":scope > div > :last-child")).toHaveClass(
    "viewer-selection-distance",
  );
  await expect(page.locator('.trail-row[aria-pressed="true"]')).toHaveCount(0);
  await page.locator(".viewer-map").click({ position: { x: 10, y: 10 } });
  await expect(selection).toHaveCount(0);
  await clickNetworkCoordinate(
    page,
    shared.geometry.coordinates[
      Math.floor(shared.geometry.coordinates.length / 2)
    ],
    network.features,
  );
  await expect(selection).toHaveCount(2);
  await expect(selection.locator("strong")).toHaveText(["Meadow Loop", "Shortcut"]);
  await expect(page.getByText("Part of:", { exact: true })).toHaveCount(0);
  await expect(
    selection.getByText("Trail segment", { exact: true }),
  ).toHaveCount(0);
  await expect(selection.getByRole("link")).toHaveCount(2);
  await expect(selection.getByRole("combobox")).toHaveCount(0);
  await expect(page.locator('.trail-row[aria-pressed="true"]')).toHaveCount(2);
  const swatches = selection.locator(".selection-line");
  await expect(swatches).toHaveCount(2);
  await expect(swatches.nth(0)).toHaveCSS("background-color", "rgb(207, 90, 69)");
  await expect(swatches.nth(1)).toHaveCSS("background-color", "rgb(37, 139, 224)");
  const sharedPixels = await trailSelectionPixels(page, shared, network.features);
  expect(sharedPixels[0]).toBeGreaterThan(5);
  expect(sharedPixels[1]).toBeGreaterThan(5);
  const continuationPixels = await trailSelectionPixels(page, continuation, network.features);
  expect(continuationPixels[0]).toBeGreaterThan(5);
  expect(continuationPixels[1]).toBe(0);
  const distance = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  await expect(selection.locator(".viewer-selection-distance")).toHaveText([
    distance(shared.properties.lengthMeters + continuation.properties.lengthMeters),
    distance(shared.properties.lengthMeters),
  ]);
  await page.screenshot({
    path: testInfo.outputPath("shared-segment.png"),
    animations: "disabled",
  });
  await selection.getByRole("link", { name: "Shortcut", exact: true }).click();
  await expect(selection.locator("strong")).toHaveText("Shortcut");
  await expect(page.getByRole("button", { name: /^Shortcut/ })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  const singleTrailPixels = await trailSelectionPixels(page, shared, network.features);
  expect(singleTrailPixels[0]).toBeGreaterThan(sharedPixels[0]);
  expect(singleTrailPixels[1]).toBe(0);
  await page
    .getByRole("button", { name: "Fit trail network", exact: true })
    .click();
  await clickNetworkCoordinate(page, placeCoordinate, network.features);
  await expect(selection.locator("strong")).toHaveText("Lookout");
  await expect(page.locator('.trail-row[aria-pressed="true"]')).toHaveCount(0);
  await page
    .getByRole("button", { name: "Clear selection", exact: true })
    .click();
  await expect(selection).toHaveCount(0);
});

test("shared trail selections show separate full-length cards and colored overlaps", async ({ page }, testInfo) => {
  const network = JSON.parse(await readFile(
    new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
    "utf8",
  )) as { features: NetworkSegment[] };
  const [shared, continuation] = network.features;
  await seedEditorStorage(page, {
    names: {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Meadow Loop" },
          geometry: { type: "MultiLineString", coordinates: [shared.geometry.coordinates, continuation.geometry.coordinates] },
        },
        {
          type: "Feature",
          properties: { name: "Shortcut" },
          geometry: { type: "MultiLineString", coordinates: [shared.geometry.coordinates] },
        },
      ],
    },
    landmarks: { type: "FeatureCollection", features: [] },
  });
  await page.reload();
  await clickNetworkCoordinate(page, shared.geometry.coordinates[Math.floor(shared.geometry.coordinates.length / 2)], network.features);
  const cards = page.locator(".viewer-selection");
  await expect(cards).toHaveCount(2);
  await expect(cards.locator("strong")).toHaveText(["Meadow Loop", "Shortcut"]);
  await expect(page.getByText("Part of:", { exact: true })).toHaveCount(0);
  const distance = (meters: number) => meters >= 1000 ? `${(meters / 1000).toFixed(1)} km` : `${Math.round(meters)} m`;
  await expect(cards.locator(".viewer-selection-distance")).toHaveText([
    distance(shared.properties.lengthMeters + continuation.properties.lengthMeters),
    distance(shared.properties.lengthMeters),
  ]);
  await expect(cards.nth(0).locator(".selection-line")).toHaveCSS("background-color", "rgb(207, 90, 69)");
  await expect(cards.nth(1).locator(".selection-line")).toHaveCSS("background-color", "rgb(37, 139, 224)");
  const firstBounds = await cards.nth(0).boundingBox();
  const secondBounds = await cards.nth(1).boundingBox();
  expect(firstBounds!.y + firstBounds!.height).toBeLessThan(secondBounds!.y);
  const sharedPixels = await trailSelectionPixels(page, shared, network.features);
  expect(sharedPixels[0]).toBeGreaterThan(5);
  expect(sharedPixels[1]).toBeGreaterThan(5);
  const continuationPixels = await trailSelectionPixels(page, continuation, network.features);
  expect(continuationPixels[0]).toBeGreaterThan(5);
  expect(continuationPixels[1]).toBe(0);
  await page.screenshot({ path: testInfo.outputPath("shared-trail-cards.png"), animations: "disabled" });
  await page.getByRole("button", { name: "Clear Meadow Loop selection", exact: true }).click();
  await expect(cards).toHaveCount(1);
  await expect(cards.locator("strong")).toHaveText("Shortcut");
  await expect(page.locator('.trail-row[aria-pressed="true"]')).toHaveCount(1);
  const remainingPixels = await trailSelectionPixels(page, shared, network.features);
  expect(remainingPixels[0]).toBeGreaterThan(sharedPixels[0]);
  expect(remainingPixels[1]).toBe(0);
  await page.getByRole("button", { name: "Clear selection", exact: true }).click();
  await expect(cards).toHaveCount(0);
  const clearedPixels = await trailSelectionPixels(page, shared, network.features);
  expect(clearedPixels).toEqual([0, 0]);
});

for (const kind of ["trails", "landmarks"] as const) {
  test(`selecting visible ${kind} preserves the camera and offscreen selections are fitted`, async ({
    page,
  }) => {
    const network = JSON.parse(
      await readFile(
        new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
        "utf8",
      ),
    ) as { features: NetworkSegment[] };
    const coordinates = network.features.flatMap(
      (segment) => segment.geometry.coordinates,
    );
    const center = [
      (Math.min(...coordinates.map(([longitude]) => longitude)) +
        Math.max(...coordinates.map(([longitude]) => longitude))) /
        2,
      (Math.min(...coordinates.map(([, latitude]) => latitude)) +
        Math.max(...coordinates.map(([, latitude]) => latitude))) /
        2,
    ];
    const names = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { name: "Whole network" },
          geometry: {
            type: "MultiLineString",
            coordinates: network.features.map(
              (segment) => segment.geometry.coordinates,
            ),
          },
        },
      ],
    };
    const places = {
      type: "FeatureCollection",
      features: [
        {
          type: "Feature",
          properties: { id: "center", name: "Center point" },
          geometry: { type: "Point", coordinates: center },
        },
      ],
    };
    await page.addInitScript(
      ({ names, places }) => {
        localStorage.setItem(
          "windstone-editor-names-v1",
          JSON.stringify(names),
        );
        localStorage.setItem(
          "windstone-editor-landmarks-v1",
          JSON.stringify(places),
        );
      },
      { names, places },
    );
    await page.goto("/");
    const map = page.locator(".viewer-map");
    await expect(map).toHaveAttribute("aria-busy", "false");
    await map.evaluate((element) => {
      element.setAttribute("data-camera-moves", "0");
      new MutationObserver(() => {
        if (element.getAttribute("aria-busy") === "true") {
          element.setAttribute(
            "data-camera-moves",
            String(Number(element.getAttribute("data-camera-moves")) + 1),
          );
        }
      }).observe(element, { attributes: true, attributeFilter: ["aria-busy"] });
    });
    await page
      .getByRole("tab", { name: kind === "trails" ? "Trails" : "Places" })
      .click();
    const targetName = kind === "trails" ? "Whole network" : "Center point";
    const target = page.getByRole("button", {
      name: new RegExp(`^${targetName}`),
    });
    await target.click();
    await expect(page.locator(".viewer-selection strong")).toHaveText(
      targetName,
    );
    if (kind === "trails")
      await expect(target).toHaveAttribute("aria-pressed", "true");
    await expect(map).toHaveAttribute("data-camera-moves", "0");

    const bounds = await map.boundingBox();
    if (!bounds) throw new Error("Map is not visible");
    await page.mouse.move(
      bounds.x + bounds.width * 0.125,
      bounds.y + bounds.height * 0.35,
    );
    await page.mouse.down();
    await page.mouse.move(
      bounds.x + bounds.width * 0.875,
      bounds.y + bounds.height * 0.35,
      { steps: 12 },
    );
    await page.mouse.up();
    await expect(map).toHaveAttribute("aria-busy", "false");
    await map.evaluate((element) =>
      element.setAttribute("data-camera-moves", "0"),
    );
    await target.click();
    await expect(map).toHaveAttribute("data-camera-moves", "1");
    await expect(map).toHaveAttribute("aria-busy", "false");

    await map.evaluate((element) =>
      element.setAttribute("data-camera-moves", "0"),
    );
    await target.click();
    await expect(map).toHaveAttribute("data-camera-moves", "0");
  });
}

test("minimum zoom stays one level below the network view after resizing", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const map = page.locator(".viewer-map");
  await expect(map).toHaveAttribute("aria-busy", "false");
  const zoomOut = page.getByRole("button", { name: "Zoom out", exact: true });
  const expectZoomLimit = async () => {
    await expect
      .poll(() =>
        map.evaluate((element) => {
          const canvas = element.querySelector("canvas")!;
          return (
            canvas.clientWidth === element.clientWidth &&
            canvas.clientHeight === element.clientHeight
          );
        }),
      )
      .toBe(true);
    await page
      .getByRole("button", { name: "Fit trail network", exact: true })
      .click();
    await expect(map).toHaveAttribute("aria-busy", "false");
    await expect(zoomOut).toBeEnabled();
    await zoomOut.click();
    await expect(zoomOut).toBeDisabled();
    await expect(map).toHaveAttribute("aria-busy", "false");
  };
  await expectZoomLimit();
  if (testInfo.project.name === "mobile") {
    await page
      .getByRole("button", { name: "Collapse map panel", exact: true })
      .click();
    await expectZoomLimit();
  }
  await page.setViewportSize(
    testInfo.project.name === "mobile"
      ? { width: 320, height: 700 }
      : { width: 1180, height: 800 },
  );
  await expectZoomLimit();
});

test("mobile panel collapses manually and after a deliberate user zoom", async ({
  page,
}, testInfo) => {
  await page.goto("/");
  const map = page.locator(".viewer-map");
  await expect(map).toHaveAttribute("aria-busy", "false");
  const collapse = page.getByRole("button", {
    name: "Collapse map panel",
    exact: true,
  });
  if (testInfo.project.name !== "mobile") {
    await expect(collapse).toBeHidden();
    await page.getByRole("button", { name: "Zoom in", exact: true }).click();
    await expect(page.getByRole("tablist")).toBeVisible();
    return;
  }
  const expandedHeight = await map.evaluate((element) => element.clientHeight);
  await collapse.click();
  const expand = page.getByRole("button", {
    name: "Expand map panel",
    exact: true,
  });
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByRole("tablist")).toBeHidden();
  await expect(page.locator(".viewer-network")).toBeHidden();
  await expect(
    page.getByRole("heading", { name: "Windstone Trails" }),
  ).toBeVisible();
  await expect(
    page.getByRole("img", { name: "Windstone Farm Community" }),
  ).toBeVisible();
  await expect(
    page
      .locator(".viewer-footer")
      .getByRole("link", { name: "Esri and contributors" }),
  ).toBeVisible();
  await expect
    .poll(() => map.evaluate((element) => element.clientHeight))
    .toBeGreaterThan(expandedHeight + 100);
  await expect
    .poll(() =>
      page
        .locator(".maplibregl-canvas")
        .evaluate((canvas) => canvas.clientHeight),
    )
    .toBeGreaterThan(expandedHeight + 100);
  await page.screenshot({
    path: testInfo.outputPath("mobile-collapsed.png"),
    animations: "disabled",
  });
  await expand.click();
  await expect(page.getByRole("tablist")).toBeVisible();
  await expect
    .poll(() => map.evaluate((element) => element.clientHeight))
    .toBe(expandedHeight);
  await page
    .getByRole("button", { name: "Fit trail network", exact: true })
    .click();
  await expect(map).toHaveAttribute("aria-busy", "false");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await page.locator(".maplibregl-canvas").hover();
  await page.mouse.wheel(0, -10);
  await page.screenshot({
    path: testInfo.outputPath("mobile-small-zoom.png"),
    animations: "disabled",
  });
  await expect(map).toHaveAttribute("aria-busy", "false");
  await expect(collapse).toHaveAttribute("aria-expanded", "true");
  await page.getByRole("button", { name: "Zoom in", exact: true }).click();
  await expect(expand).toHaveAttribute("aria-expanded", "false");
  await expect(map).toHaveAttribute("aria-busy", "false");
  await expand.click();
  await expect(page.getByRole("tablist")).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    320,
  );
  await expect(collapse).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("mobile-expanded-narrow.png"),
    animations: "disabled",
  });
  await page.goto("/editor");
  await page
    .getByRole("button", { name: "Collapse map panel", exact: true })
    .click();
  await expect(page.locator(".viewer-editor")).toBeHidden();
  await expect(
    page.getByRole("link", { name: "Map", exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Expand map panel", exact: true })
    .click();
  await expect(page.locator(".viewer-editor")).toBeVisible();
});

test("public map omits unnamed segments from the list", async ({
  page,
}, testInfo) => {
  const names = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trail-names.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: { properties: { name: string } }[] };
  const landmarks = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/landmarks.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: { properties: { name: string } }[] };
  const errors: string[] = [];
  const imageryRequests: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (request.url().includes("World_Imagery/MapServer/tile/"))
      imageryRequests.push(request.url());
  });
  await page.goto("/");
  await expect(page).toHaveTitle("Windstone Trails");
  const favicon = page.locator('head link[rel="icon"]');
  await expect(favicon).toHaveAttribute("href", "/windstone-favicon.png");
  expect(
    await favicon.evaluate(async (link: HTMLLinkElement) => {
      const image = new Image();
      image.src = link.href;
      await image.decode();
      return [image.naturalWidth, image.naturalHeight];
    }),
  ).toEqual([32, 32]);
  const logo = page.getByRole("img", { name: "Windstone Farm Community" });
  await expect(logo).toBeVisible();
  expect(
    await logo.evaluate(
      (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
    ),
  ).toBe(true);
  await expect(
    page.getByRole("heading", { name: "Windstone Trails" }),
  ).toHaveCSS("font-family", /Cormorant Garamond/);
  await expect(page.locator(".trail-row")).toHaveCount(names.features.length);
  for (const feature of names.features)
    await expect(
      page.locator(".trail-row").filter({ hasText: feature.properties.name }),
    ).toHaveCount(1);
  await expect(page.locator('a[href*="simulator"]')).toHaveCount(0);
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  expect(imageryRequests.length).toBeGreaterThan(0);
  await expect(
    page
      .locator(".viewer-footer")
      .getByRole("link", { name: "Esri and contributors" }),
  ).toBeVisible();
  await expect(page.locator(".viewer-footer")).toHaveCSS(
    "background-color",
    "rgb(255, 255, 255)",
  );
  await expect(
    page
      .locator(".viewer-footer")
      .getByRole("link", { name: "Esri and contributors" }),
  ).toHaveCSS("color", "rgb(20, 50, 37)");
  await expect(
    page.getByRole("link", { name: "Editor", exact: true }),
  ).toHaveAttribute("href", "/editor");
  await expect(
    page.locator(".viewer-map-stage .maplibregl-ctrl-attrib"),
  ).toHaveCount(0);
  await expect(page.locator(".network-count, .viewer-map-label")).toHaveCount(
    0,
  );
  await expect(
    page.locator(".maplibregl-ctrl-scale, .viewer-map-key"),
  ).toHaveCount(0);
  if (!names.features.length)
    await expect(page.getByText("No named trails yet.")).toBeVisible();
  await page.getByRole("tab", { name: "Places" }).click();
  await expect(page.locator(".trail-row")).toHaveCount(
    landmarks.features.length,
  );
  for (const feature of landmarks.features)
    await expect(
      page.locator(".trail-row").filter({ hasText: feature.properties.name }),
    ).toHaveCount(1);
  if (!landmarks.features.length)
    await expect(page.getByText("No landmarks added yet.")).toBeVisible();
  await page.getByRole("tab", { name: "Trails" }).click();
  await page.getByRole("button", { name: "Fit trail network" }).click();
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scrollWidth: document.documentElement.scrollWidth,
    mapHeight: document.querySelector(".viewer-map")!.clientHeight,
  }));
  expect(layout.scrollWidth).toBe(layout.width);
  expect(layout.mapHeight).toBeGreaterThan(250);
  await page.screenshot({
    path: testInfo.outputPath("viewer.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("simulator is available only through its direct route", async ({
  page,
}) => {
  await page.goto("/simulator");
  await expect(page).toHaveTitle("Windstone Trace Lab");
  await expect(
    page.getByRole("heading", { name: "Truth network" }),
  ).toBeVisible();
  const edit = page.getByRole("button", { name: "Edit truth", exact: true });
  await expect(edit).toHaveAttribute("aria-pressed", "true");
  await edit.click();
  await expect(edit).toHaveAttribute("aria-pressed", "false");
});

test("simulator loads datasets and retains walks while correcting truth", async ({ page }, testInfo) => {
  page.on("dialog", (dialog) => dialog.accept());
  await page.goto("/simulator");
  const map = page.getByRole("region", { name: "Trail simulator map" });
  await expect(map).toHaveAttribute("aria-busy", "false");
  const truthCount = page.locator(".truth-section .metric");
  const walkCount = page.locator(".generator-section .metric");
  const selector = page.getByLabel("Test dataset", { exact: true });
  await selector.selectOption("windstone-001");
  await page.getByRole("button", { name: "Load test dataset", exact: true }).click();
  await expect(truthCount).toHaveText("105 edges");
  await expect(walkCount).toHaveText("300 traces");

  await selector.selectOption("recorded-002");
  await page.getByRole("button", { name: "Load test dataset", exact: true }).click();
  await expect(truthCount).toHaveText("4 edges");
  await expect(walkCount).toHaveText("5 traces");
  await expect(page.getByRole("button", { name: "Edit truth", exact: true }))
    .toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Run merger", exact: true }).click();
  await expect(page.locator(".merge-metrics")).toBeVisible();

  await page.getByRole("button", { name: "Clear truth network", exact: true }).click();
  await expect(truthCount).toHaveText("0 edges");
  await expect(walkCount).toHaveText("5 traces");
  await expect(page.locator(".merge-metrics")).toHaveCount(0);
  await expect(page.getByRole("checkbox", { name: "Walks", exact: true })).toBeChecked();
  await map.screenshot({ path: testInfo.outputPath("walks-without-truth.png"), animations: "disabled" });

  const canvas = map.locator("canvas");
  const bounds = await canvas.boundingBox();
  if (!bounds) throw new Error("Simulator map is not visible");
  await canvas.click({ position: { x: bounds.width * 0.35, y: bounds.height * 0.4 } });
  await canvas.click({ position: { x: bounds.width * 0.65, y: bounds.height * 0.6 } });
  await expect(truthCount).toHaveText("1 edges");
  await expect(walkCount).toHaveText("5 traces");
  await page.getByRole("button", { name: "Undo last point", exact: true }).click();
  await expect(truthCount).toHaveText("0 edges");
  await expect(walkCount).toHaveText("5 traces");

  await page.locator('.truth-section input[type="file"]').setInputFiles({
    name: "truth.geojson",
    mimeType: "application/geo+json",
    buffer: await readFile(new URL("../../../data/recorded-002/truth.geojson", import.meta.url)),
  });
  await expect(truthCount).toHaveText("4 edges");
  await expect(walkCount).toHaveText("5 traces");
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "Truth", exact: true }).click();
  expect((await downloadEvent).suggestedFilename()).toBe("truth.geojson");
  await map.screenshot({ path: testInfo.outputPath("dataset-truth-and-walks.png"), animations: "disabled" });
});

test("installed map reloads with no network", async ({ page, context }) => {
  const names = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trail-names.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: { properties: { name: string } }[] };
  await page.goto("/");
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  await expect
    .poll(() =>
      page.evaluate(() => Boolean(navigator.serviceWorker.controller)),
    )
    .toBe(true);
  await context.setOffline(true);
  await page.reload();
  await expect(page).toHaveTitle("Windstone Trails");
  await expect(page.locator(".trail-row")).toHaveCount(names.features.length);
  await expect(page.locator(".viewer-footer")).toHaveAttribute(
    "aria-label",
    "Offline trail map",
  );
  expect(
    await page
      .getByRole("img", { name: "Windstone Farm Community" })
      .evaluate(
        (image: HTMLImageElement) => image.complete && image.naturalWidth > 0,
      ),
  ).toBe(true);
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  for (const feature of names.features)
    await expect(
      page.locator(".trail-row").filter({ hasText: feature.properties.name }),
    ).toHaveCount(1);
  if (!names.features.length)
    await expect(page.getByText("No named trails yet.")).toBeVisible();
  await page.getByRole("button", { name: "Fit trail network" }).click();
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
});

test("one editor download includes names, landmarks and recorded walks", async ({
  page,
}, testInfo) => {
  const network = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: NetworkSegment[] };
  const names = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Farm Loop" },
        geometry: {
          type: "MultiLineString",
          coordinates: network.features
            .slice(0, 2)
            .map((feature) => feature.geometry.coordinates),
        },
      },
    ],
  };
  const landmarks = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        id: "gate",
        properties: { id: "gate", name: "Farm gate", icon: "gate" },
        geometry: { type: "Point", coordinates: [-76.116, 45.057] },
      },
    ],
  };
  const walk = {
    id: "walk-1",
    coordinates: [
      [-76.116, 45.057],
      [-76.1159, 45.057],
    ],
    times: ["2026-10-18T12:00:00Z", "2026-10-18T12:00:02Z"],
    accuracies: [5, 6],
    recordedAt: "2026-10-18T12:00:00Z",
    exported: false,
  };
  await seedEditorStorage(page, { names, landmarks, walks: [walk] });
  await page.goto("/editor");
  const button = page.getByRole("button", {
    name: "Download edits",
    exact: true,
  });
  await expect(button).toBeVisible();
  await expect(button).toHaveCount(1);
  await expect(
    page.getByRole("button", {
      name: /Download (names|landmarks|walks)|Import/,
    }),
  ).toHaveCount(0);
  await expect(page.locator('input[type="file"]')).toHaveCount(0);
  if (testInfo.project.name === "desktop") {
    await page.getByRole("tab", { name: "Trails", exact: true }).click();
    await expect(button).toBeVisible();
  }
  await page.getByRole("tab", { name: "Places", exact: true }).click();
  await expect(button).toBeVisible();
  await page.getByRole("tab", { name: "Record", exact: true }).click();
  await expect(page.getByText("2 saved points", { exact: true })).toBeVisible();
  await expect(button).toBeVisible();
  const downloaded = page.waitForEvent("download");
  await button.click();
  const download = await downloaded;
  expect(download.suggestedFilename()).toMatch(/^windstone-edits-.*\.json$/);
  const path = await download.path();
  if (!path) throw new Error("Edits download was not saved");
  const bundle = JSON.parse(await readFile(path, "utf8"));
  expect(bundle).toMatchObject({
    format: "windstone-edits",
    version: 1,
    trailNames: names,
    landmarks,
  });
  expect(bundle.walks.features).toHaveLength(1);
  expect(bundle.walks.features[0]).toMatchObject({
    id: walk.id,
    properties: {
      id: walk.id,
      times: walk.times,
      accuracies: walk.accuracies,
      recordedAt: walk.recordedAt,
    },
    geometry: { type: "LineString", coordinates: walk.coordinates },
  });
  expect(Number.isFinite(Date.parse(bundle.exportedAt))).toBe(true);
  await expect(page.getByText("Exported", { exact: true })).toBeVisible();
  await expect(button).toBeEnabled();
  await page.screenshot({
    path: testInfo.outputPath("download-edits.png"),
    animations: "disabled",
  });
});

test("received drafts and recordings are cleared and downloads are disabled", async ({
  page,
}) => {
  const published = await publishedEdits();
  const acknowledgments = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/ingested.json", import.meta.url),
      "utf8",
    ),
  ) as { ingested: string[] };
  const walk = {
    id: acknowledgments.ingested[0],
    coordinates: [
      [-76.116, 45.057],
      [-76.1159, 45.057],
    ],
    times: ["2026-10-18T12:00:00Z", "2026-10-18T12:00:02Z"],
    accuracies: [5, 6],
    recordedAt: "2026-10-18T12:00:00Z",
    exported: true,
  };
  await seedEditorStorage(page, { ...published, walks: [walk] });
  await page.goto("/editor");
  await expect
    .poll(() =>
      page.evaluate(() => [
        localStorage.getItem("windstone-editor-names-v1"),
        localStorage.getItem("windstone-editor-landmarks-v1"),
      ]),
    )
    .toEqual([null, null]);
  await expect.poll(() => storedRecordingIds(page)).toEqual([]);
  await expect(
    page.getByRole("button", { name: "Download edits", exact: true }),
  ).toBeDisabled();
  await page.getByRole("tab", { name: "Record", exact: true }).click();
  await expect(page.getByText("0 saved points", { exact: true })).toBeVisible();
});

test("unreceived recordings alone keep downloads enabled even after export", async ({
  page,
}) => {
  const published = await publishedEdits();
  const walk = {
    id: "still-on-device",
    coordinates: [
      [-76.116, 45.057],
      [-76.1159, 45.057],
    ],
    times: ["2026-10-18T12:00:00Z", "2026-10-18T12:00:02Z"],
    accuracies: [5, 6],
    recordedAt: "2026-10-18T12:00:00Z",
    exported: true,
  };
  await seedEditorStorage(page, { ...published, walks: [walk] });
  await page.goto("/editor");
  await expect(
    page.getByRole("button", { name: "Download edits", exact: true }),
  ).toBeEnabled();
  expect(await storedRecordingIds(page)).toEqual([walk.id]);
  expect(
    await page.evaluate(() => [
      localStorage.getItem("windstone-editor-names-v1"),
      localStorage.getItem("windstone-editor-landmarks-v1"),
    ]),
  ).toEqual([null, null]);
});

test("landmark icons are explicitly saved and visible in the public preview", async ({
  page,
}, testInfo) => {
  const published = await publishedEdits();
  const place = published.landmarks.features[0];
  const icon = place.properties.icon === "camera" ? "tent" : "camera";
  const label = icon === "camera" ? "Camera icon" : "Tent icon";
  const iconClass = icon === "camera" ? ".lucide-camera" : ".lucide-tent";
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/editor");
  const download = page.getByRole("button", {
    name: "Download edits",
    exact: true,
  });
  await expect(download).toBeDisabled();
  await page.getByRole("tab", { name: "Places", exact: true }).click();
  await page
    .getByRole("button", { name: place.properties.name, exact: true })
    .click();
  const editIcon = page.getByRole("button", {
    name: "Edit landmark icon",
    exact: true,
  });
  await editIcon.click();
  const dialog = page.getByRole("dialog", {
    name: "Landmark icon",
    exact: true,
  });
  const search = dialog.getByRole("searchbox", {
    name: "Search icons",
    exact: true,
  });
  await expect(search).toBeFocused();
  await expect(
    dialog
      .getByRole("group", { name: "Icons", exact: true })
      .getByRole("button"),
  ).toHaveCount(Object.keys(icons).length);
  const results = dialog.locator(".landmark-icon-results");
  expect(
    await results.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  await results.getByRole("button").last().scrollIntoViewIfNeeded();
  expect(
    await results.evaluate((element) => element.scrollTop),
  ).toBeGreaterThan(0);
  await expect(search).toBeVisible();
  await search.fill("zzzz-no-matching-icon");
  await expect(
    dialog.getByText("No icons found.", { exact: true }),
  ).toBeVisible();
  await search.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(editIcon).toBeFocused();
  await editIcon.click();
  await expect(search).toHaveValue("");
  await search.fill(icon);
  await expect(
    dialog.getByRole("button", { name: label, exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("landmark-icon-picker.png"),
    animations: "disabled",
  });
  await dialog.getByRole("button", { name: label, exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.locator(".editor-icon-preview").locator(iconClass),
  ).toHaveCount(1);
  expect(
    await page.evaluate(() =>
      localStorage.getItem("windstone-editor-landmarks-v1"),
    ),
  ).toBeNull();
  await expect(download).toBeDisabled();
  await page
    .getByRole("button", { name: "Save landmark", exact: true })
    .click();
  await expect(download).toBeEnabled();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("windstone-editor-landmarks-v1")!),
  );
  expect(
    saved.features.find(
      (feature: { properties: { id: string } }) =>
        feature.properties.id === place.properties.id,
    ).properties,
  ).toEqual({ ...place.properties, icon });
  await page.getByRole("link", { name: "Map", exact: true }).click();
  await page.getByRole("tab", { name: "Places" }).click();
  const row = page.getByRole("button", {
    name: place.properties.name,
    exact: true,
  });
  await expect(row.locator(iconClass)).toHaveCount(1);
  await row.click();
  await expect(
    page.locator(".viewer-selection").locator(iconClass),
  ).toHaveCount(1);
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await expect(page.locator(".viewer-message")).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("landmark-icon-preview.png"),
    animations: "disabled",
  });
  expect(errors).toEqual([]);
});

test("trail changes require an explicit save and disconnected sections cannot be saved", async ({
  page,
}, testInfo) => {
  test.skip(
    testInfo.project.name !== "desktop",
    "Trail naming is desktop-only.",
  );
  const network = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
      "utf8",
    ),
  ) as { features: NetworkSegment[] };
  const [first, second] = network.features;
  const nodes = new Set([
    first.properties.from,
    first.properties.to,
    second.properties.from,
    second.properties.to,
  ]);
  const separate = network.features.find(
    (segment) =>
      !nodes.has(segment.properties.from) && !nodes.has(segment.properties.to),
  );
  if (!separate) throw new Error("A separate test segment is required");
  const middle = (segment: NetworkSegment) => {
    const coordinates = segment.geometry.coordinates;
    const index = Math.floor((coordinates.length - 1) / 2);
    return [
      (coordinates[index][0] + coordinates[index + 1][0]) / 2,
      (coordinates[index][1] + coordinates[index + 1][1]) / 2,
    ];
  };
  const names = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Old Loop" },
        geometry: {
          type: "MultiLineString",
          coordinates: [
            first.geometry.coordinates,
            second.geometry.coordinates,
          ],
        },
      },
    ],
  };
  await seedEditorStorage(page, {
    names,
    landmarks: { type: "FeatureCollection", features: [] },
  });
  await page.goto("/editor");
  await expect(page.locator(".viewer-map")).toHaveAttribute(
    "aria-busy",
    "false",
  );
  await page.getByRole("button", { name: /^Old Loop/ }).click();
  await page.getByLabel("Trail name", { exact: true }).fill("Updated Loop");
  await clickNetworkCoordinate(page, middle(separate), network.features);
  await expect(page.getByRole("alert")).toHaveText(
    "Selected sections are disconnected. Select connecting sections before saving.",
  );
  await expect(
    page.getByRole("button", { name: "Update trail", exact: true }),
  ).toBeDisabled();
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("windstone-editor-names-v1")!),
    ),
  ).toEqual(names);
  await clickNetworkCoordinate(page, middle(separate), network.features);
  await clickNetworkCoordinate(page, middle(second), network.features);
  await expect(page.locator(".editor-selection-tools output")).toHaveText(
    "1 selected",
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(
    await page.evaluate(() =>
      JSON.parse(localStorage.getItem("windstone-editor-names-v1")!),
    ),
  ).toEqual(names);
  await page.getByRole("button", { name: "Update trail", exact: true }).click();
  const saved = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("windstone-editor-names-v1")!),
  );
  expect(saved.features[0].properties.name).toBe("Updated Loop");
  expect(saved.features[0].geometry.coordinates).toEqual([
    first.geometry.coordinates,
  ]);
  await page
    .getByLabel("Trail name", { exact: true })
    .fill("Disconnected new trail");
  await clickNetworkCoordinate(page, middle(first), network.features);
  await clickNetworkCoordinate(page, middle(separate), network.features);
  await expect(
    page.getByRole("button", { name: "Create trail", exact: true }),
  ).toBeDisabled();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.screenshot({
    path: testInfo.outputPath("disconnected-trail.png"),
    animations: "disabled",
  });
});

test("naming controls omit select-all and reset only after successful saves", async ({
  page,
}, testInfo) => {
  const network = JSON.parse(
    await readFile(
      new URL("../../../data/recorded-002/output/trails.geojson", import.meta.url),
      "utf8",
    ),
  );
  const coordinates = network.features
    .slice(0, 2)
    .map(
      (feature: { geometry: { coordinates: number[][] } }) =>
        feature.geometry.coordinates,
    );
  const naming = {
    type: "FeatureCollection",
    features: [
      {
        type: "Feature",
        properties: { name: "Old Loop" },
        geometry: { type: "MultiLineString", coordinates },
      },
      {
        type: "Feature",
        properties: { name: "Existing Name" },
        geometry: { type: "MultiLineString", coordinates: [coordinates[0]] },
      },
    ],
  };
  await page.addInitScript(
    (names) =>
      localStorage.setItem("windstone-editor-names-v1", JSON.stringify(names)),
    naming,
  );
  await page.goto("/editor");
  await expect(
    page.getByRole("button", { name: "Select all sections", exact: true }),
  ).toHaveCount(0);
  if (testInfo.project.name === "mobile") {
    await expect(page.getByLabel("Trail name", { exact: true })).toHaveCount(0);
    return;
  }
  await page.getByRole("button", { name: /^Old Loop/ }).click();
  const input = page.getByLabel("Trail name", { exact: true });
  const selection = page.locator(".editor-selection-tools output");
  await expect(selection).toHaveText("2 selected");
  await input.fill("Existing Name");
  await page.getByRole("button", { name: "Update trail", exact: true }).click();
  await expect(page.getByText("That trail name already exists.")).toBeVisible();
  await expect(input).toHaveValue("Existing Name");
  await expect(selection).toHaveText("2 selected");
  await input.fill("Farm Loop");
  await page.getByRole("button", { name: "Update trail", exact: true }).click();
  await expect(page.getByRole("button", { name: /^Farm Loop/ })).toHaveCount(1);
  await expect(page.getByRole("button", { name: /^Old Loop/ })).toHaveCount(0);
  await expect(input).toHaveValue("");
  await expect(selection).toHaveText("0 selected");
  await expect(
    page.getByRole("button", { name: "Create trail", exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole("button", { name: "Delete trail name", exact: true }),
  ).toHaveCount(0);
  await page.getByRole("button", { name: /^Farm Loop/ }).click();
  await page
    .getByRole("button", { name: "New trail name", exact: true })
    .click();
  await expect(input).toHaveValue("");
  await expect(selection).toHaveText("0 selected");
  await expect(page.getByRole("button", { name: /^Farm Loop/ })).toHaveCount(1);
});
