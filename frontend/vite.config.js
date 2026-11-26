import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// https://vite.dev/config/
//
// Local development:
// - Vite dev server proxies /api and /socket.io to the local backend to avoid CORS issues.
//
// Production deployment (Vercel frontend -> Render backend):
// - The Vercel build runs in the browser against a different origin than Render, so the
//   frontend must call the backend's absolute URL via VITE_API_URL (see frontend/.env.example).
// - Set VITE_API_URL in Vercel Project Settings -> Environment Variables (build-time for Vite).
// - Backend must allow the Vercel frontend origin via FRONTEND_URL/CORS_ORIGIN on Render.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
    },
  },
})
