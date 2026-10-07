import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  plugins: [react(), nodePolyfills({ include: ['buffer', 'process', 'crypto', 'stream', 'util'], globals: { Buffer: true, process: true } })],
  // Served under /app/ by the same Worker as the landing page (landing at /).
  base: '/app/',
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, outDir: 'dist/app' },
});
