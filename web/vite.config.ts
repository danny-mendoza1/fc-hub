import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { staticHeadersFile } from "./src/security-headers.ts";

/** Writes dist/_headers, so UI files Cloudflare serves without the Worker get the app's headers. */
function cloudflareHeaders(): Plugin {
  return {
    name: "fc-hub-cloudflare-headers",
    apply: "build",
    generateBundle() {
      this.emitFile({ type: "asset", fileName: "_headers", source: staticHeadersFile() });
    },
  };
}

// The React UI lives in client/ and builds into dist/, which the Worker (assets binding) and the
// Node server (src/static.ts) serve. The API itself is unaffected by this build.
export default defineConfig({
  root: "client",
  publicDir: "public",
  plugins: [react(), cloudflareHeaders()],
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
