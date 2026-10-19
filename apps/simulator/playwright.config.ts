import { defineConfig } from "@playwright/test";

const production = process.env.PLAYWRIGHT_PRODUCTION === "1";
const port = production ? 5174 : 5173;
const baseURL = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: "./e2e",
  testMatch: production ? "**/production.pw.ts" : "**/viewer.pw.ts",
  fullyParallel: true,
  use: {
    baseURL,
    browserName: "chromium",
    reducedMotion: "reduce",
    screenshot: "only-on-failure",
  },
  projects: [
    { name: "desktop", use: { viewport: { width: 1440, height: 1000 } } },
    {
      name: "mobile",
      use: {
        viewport: { width: 390, height: 844 },
        isMobile: true,
        hasTouch: true,
      },
    },
  ],
  webServer: {
    command: `pnpm exec vite build --mode ${production ? "production" : "fixtures"} && pnpm preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI && !production,
    timeout: 60_000,
  },
});
