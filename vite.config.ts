import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The legacy dashboard continues to be served from /. Keeping this build under
// /next/ makes the migration reversible until it reaches feature parity.
export default defineConfig({
  root: 'src/client',
  base: '/next/',
  plugins: [react()],
  build: { outDir: '../public/next', emptyOutDir: true }
});
