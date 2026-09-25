import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Parts Receiving · Lane Check',
        short_name: 'Lane Check',
        description: 'Parts receiving and lane-check for multi-stop delivery',
        theme_color: '#1a1a1a',
        background_color: '#1a1a1a',
        display: 'standalone',
        start_url: '/',
        scope: '/',
        icons: [
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any'
          },
          {
            src: 'icon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'maskable'
          }
        ]
      },
      workbox: {
        // App shell + JS/CSS chunks (pdfjs, zxing, workers) for offline after first load.
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff,woff2,mjs}'],
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [/^\/api/],
        cleanupOutdatedCaches: true,
        clientsClaim: true
      },
      devOptions: {
        enabled: false
      }
    })
  ],
  server: {
    host: true, // expose to LAN — useful for testing camera on phone
    port: 5173
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
