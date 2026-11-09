// Local review server for the Port Exposure 3D map (no Electron, sample data only).
// Run: npm run stage:ports, then open http://127.0.0.1:5188/port-exposure-stage.html
import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@renderer': resolve(__dirname, 'src/renderer/src') } },
  plugins: [react(), tailwindcss()],
  server: { host: '127.0.0.1', port: 5188, strictPort: true },
  preview: { host: '127.0.0.1', port: 5189, strictPort: true },
  build: {
    outDir: resolve(__dirname, 'out/stage-review'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(__dirname, 'src/renderer/port-exposure-stage.html') }
  }
})
