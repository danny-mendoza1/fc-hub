# ADR 0003: React + Vite + CSS Modules for the web client

- **Status:** Accepted. Amends [ADR 0002](0002-zero-dependency-backend.md) for the browser client only; the API keeps zero runtime dependencies.
- **Date:** 2026-11-20

## Context

The first UI was ~300 lines of framework-free JavaScript, which suited one search page. The roadmap isn't one page: nested owner → section → item accordions come next, then Wondrous Tails and duty-unlock comparisons across members. Those are many interdependent, stateful views, where hand-written DOM code gets hard to change safely.

## Decision

- **React 19 + TypeScript (`.tsx`)** for the client in `web/client/`. Components own their state; views are `SearchView`, `OverviewView` and `LoginView`, built from small shared pieces (`ItemCard`, `Bits`).
- **Vite** builds it into `web/dist/`, served by the Worker's assets binding (Cloudflare) or `src/static.ts` (Node). `npm run dev:ui` gives hot reload against the API on `:8787`.
- **CSS Modules** (built into Vite): one `*.module.css` per component plus a small `global.css` of theme tokens and base element styles. Still plain CSS, scoped per component.
- **Shared types:** the client imports response types from `web/src/api-types.ts` (type-only, erased at build), so UI/API drift fails the type check.
- Only `react` and `react-dom` ship to the browser (~73 KB gzipped for the whole UI). Everything else is build tooling. Dependabot opens grouped weekly update PRs.

## Security posture (unchanged)

- Vite emits external, content-hashed files with no inline scripts, so the strict CSP (`script-src 'self'`, no `unsafe-inline`) still holds. A test checks the built `index.html`.
- React escapes rendered text by default. `dangerouslySetInnerHTML` is not used and shouldn't be.
- Hashed `/assets/*` are served `immutable`; `index.html` is `no-cache` so deploys show up immediately. (Amended 2026-11-21: on Cloudflare these are served by the asset server without the Worker, with headers from a generated `_headers` file; see `web/src/security-headers.ts`.)

## Consequences

- There's now a build step: CI runs `npm ci → typecheck → build → test`, and `npm run deploy` builds before `wrangler deploy`.
- A small set of third-party packages to keep current (Dependabot).
- Future UI features are written as components with local state and typed API calls.
