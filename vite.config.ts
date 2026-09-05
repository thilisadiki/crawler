import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Express serves the supported dashboard at /app. Compiled assets retain the
// protected /next/ base path; / is the public product homepage.
export default defineConfig({
  root: 'src/client',
  base: '/next/',
  plugins: [react()],
  build: { outDir: '../public/next', emptyOutDir: true }
});
