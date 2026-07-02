import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: 'dist',
    sourcemap: false,
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom', 'react-router-dom'],
          mui: ['@mui/material', '@mui/icons-material'],
        },
      },
    },
  },
  base: '/',
  define: {
    // Injected at build time via env var; falls back to origin at runtime
    __API_BASE__: JSON.stringify(process.env.API_URL ?? ''),
    // Root public domain for this deployment; used to resolve a SAML app ID
    // from a subdomain (e.g. "<appId>.<PUBLIC_DOMAIN>"). Never hardcoded.
    __BASE_DOMAIN__: JSON.stringify(process.env.PUBLIC_DOMAIN ?? ''),
  },
});
