import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The React UI lives in client/ and builds into dist/, which the Worker (assets binding) and the
// Node server (src/static.ts) serve. The API itself is unaffected by this build.
export default defineConfig({
  root: "client",
  publicDir: "public",
  plugins: [react()],
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    // Keep every asset a real file: the CSP allows same-origin files, not inlined blobs.
    assetsInlineLimit: 0,
  },
  css: {
    modules: { localsConvention: "camelCaseOnly" },
  },
  server: {
    // `npm run dev:ui` (HMR) talks to the API from `npm start` on :8787.
    proxy: { "/api": "http://localhost:8787" },
  },
});
