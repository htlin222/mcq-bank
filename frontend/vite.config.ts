import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        // Local dev only — the Worker accepts this when
        // CF_ACCESS_TEAM_DOMAIN === 'localhost' (see .dev.vars).
        headers: { 'X-Dev-Email': 'ppoiu87@gmail.com' },
      },
      '/img': {
        target: 'http://localhost:8787',
        changeOrigin: true,
        headers: { 'X-Dev-Email': 'ppoiu87@gmail.com' },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: true,
  },
});
