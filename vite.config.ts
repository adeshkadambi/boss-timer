import { defineConfig } from 'vite';

const host = process.env.TAURI_DEV_HOST;

// Multi-page: one HTML entry per window.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**', '**/design/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_'],
  build: {
    // WKWebView (macOS) and WebKitGTK (Linux). color-mix() needs Safari 16.2+ / WebKitGTK 2.40+.
    target: 'safari16',
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    rollupOptions: {
      input: {
        main: 'index.html',
        timer: 'timer.html',
      },
    },
  },
});
