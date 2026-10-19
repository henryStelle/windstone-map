import { expect, test } from "@playwright/test";
import { readFile } from "node:fs/promises";

test("production ignores demo drafts and excludes simulator datasets", async ({
  page,
}, testInfo) => {
  const network = JSON.parse(
    await readFile(
      new URL("../../../production/trails.geojson", import.meta.url),
      "utf8",
    ),
  );
  const landmarks = JSON.parse(
    await readFile(
      new URL("../../../production/landmarks.geojson", import.meta.url),
      "utf8",
    ),
  );
  const requestedFixtures: string[] = [];
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (/\/(truth|walks)[^/]*\.geojson/.test(request.url()))
      requestedFixtures.push(request.url());
  });
  await page.addInitScript(() => {
    localStorage.setItem(
      "windstone-editor-landmarks-v1",
      JSON.stringify({
        type: "FeatureCollection",
        features: [
          {
            type: "Feature",
            geometry: { type: "Point", coordinates: [-76.116, 45.057] },
            properties: {
              id: "dev-place",
              name: "Development landmark",
              icon: "tent",
            },
          },
        ],
      }),
    );
    localStorage.setItem(
      "windstone-editor-names-v1",
      "invalid development names",
    );
  });
  await page.goto("/");
  await expect(
    page.getByRole("heading", { name: "Windstone Trails", exact: true }),
  ).toBeVisible();
  const length = network.features.reduce(
    (sum: number, feature: { properties: { lengthMeters: number } }) =>
      sum + feature.properties.lengthMeters,
    0,
  );
  const formatted =
    length >= 1000
      ? `${(length / 1000).toFixed(1)} km`
      : `${Math.round(length)} m`;
  await expect(page.locator(".viewer-network")).toHaveText(
    `${formatted} of mapped trails`,
  );
  await page.getByRole("tab", { name: /^Places/ }).click();
  await expect(page.locator("#places-tab span")).toHaveText(
    String(landmarks.features.length),
  );
  if (landmarks.features.length === 0)
    await expect(
      page.getByText("No landmarks added yet.", { exact: true }),
    ).toBeVisible();
  await expect(
    page.getByText("Development landmark", { exact: true }),
  ).toHaveCount(0);
  await page.screenshot({
    path: testInfo.outputPath("production-map.png"),
    animations: "disabled",
  });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(
    await page.evaluate(() => innerWidth),
  );

  await page.goto("/simulator");
  await expect(page).toHaveTitle("Windstone Trails");
  await expect(page.getByLabel("Test dataset", { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Trace Lab", exact: true }),
  ).toHaveCount(0);
  await expect(page.locator("#places-tab span")).toHaveText(
    String(landmarks.features.length),
  );
  expect(requestedFixtures).toEqual([]);
  expect(errors).toEqual([]);
});
