import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

// https://vite.dev/config/
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react(), VitePWA({
    registerType: 'autoUpdate',
    manifest: {
      name: 'Windstone Trails',
      short_name: 'Windstone',
      description: 'The Windstone trail network and landmarks.',
      theme_color: '#3a5422',
      background_color: '#edf2ed',
      display: 'standalone',
      start_url: './',
      icons: [{ src: 'windstone-logo.png', sizes: '256x256', type: 'image/png', purpose: 'any' }],
    },
    workbox: {
      globPatterns: ['**/*.{js,css,html,woff2,png,svg,webmanifest}'],
      maximumFileSizeToCacheInBytes: 3_000_000,
      navigateFallback: 'index.html',
      cleanupOutdatedCaches: true,
    },
  })],
})
