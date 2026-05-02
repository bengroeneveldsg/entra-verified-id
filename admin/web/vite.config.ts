import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// In Docker the build context root is /build, so shared-ui lives at /build/shared-ui.
// Locally (dev) the monorepo root is two levels up.
const sharedUiPath = process.env.SHARED_UI_PATH
  ? path.resolve(process.env.SHARED_UI_PATH, 'src')
  : path.resolve(__dirname, '../../shared-ui/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@entra-vid/shared-ui': sharedUiPath,
    },
  },
  server: {
    port: 3001,
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
