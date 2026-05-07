import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true, // expose to LAN — useful for testing camera on phone
    port: 5173
  },
  build: {
    outDir: 'dist',
    sourcemap: false
  }
})
