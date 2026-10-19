import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

// https://vite.dev/config/
export default defineConfig(({ mode }) => {
  const useFixtures = ["development", "test", "fixtures"].includes(mode);
  const fixtureDirectory = fileURLToPath(new URL("../../data/", import.meta.url));
  return {
  base: process.env.BASE_PATH || "/",
  resolve: {
    alias: {
      "@map-data": fileURLToPath(new URL(
        useFixtures ? "../../data/recorded-002/output/" : "../../production/",
        import.meta.url,
      )),
    },
  },
  plugins: [
    react(),
    {
      name: "exclude-development-data",
      generateBundle(_options, bundle) {
        if (useFixtures) return;
        for (const output of Object.values(bundle)) {
          if (output.type !== "chunk") continue;
          for (const id of Object.keys(output.modules)) {
            if (id.startsWith(fixtureDirectory))
              this.error(`Development dataset in production build: ${id}`);
          }
        }
      },
    },
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "Windstone Trails",
        short_name: "Windstone",
        description: "The Windstone trail network and landmarks.",
        theme_color: "#3a5422",
        background_color: "#edf2ed",
        display: "standalone",
        start_url: "./",
        icons: [
          {
            src: "windstone-logo.png",
            sizes: "256x256",
            type: "image/png",
            purpose: "any",
          },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,woff2,png,svg,webmanifest}"],
        maximumFileSizeToCacheInBytes: 3_000_000,
        navigateFallback: "index.html",
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  };
});
