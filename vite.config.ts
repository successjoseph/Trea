import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Firebase is imported straight from gstatic.com by URL in src/core/fb.js
// (see that file's header). Vite leaves absolute-URL imports untouched, so
// no extra config is needed to keep that working through the dev server
// and the production build.
export default defineConfig({
    plugins: [react()],
    server: {
        port: 5173
    },
    build: {
        outDir: 'dist',
        sourcemap: true
    }
});
