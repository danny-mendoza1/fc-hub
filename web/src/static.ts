import { readFile } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/**
 * Node stand-in for the Cloudflare assets binding: serves files from `root`, maps "/" to
 * index.html, and refuses anything that resolves outside `root` (path traversal).
 */
export function diskAssets(root: string): { fetch(request: Request): Promise<Response> } {
  const base = resolve(root);
  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      const file = resolve(base, "." + relative);
      if (file !== base && !file.startsWith(base + sep)) {
        return new Response("Not found", { status: 404 });
      }

      try {
        const body = await readFile(file);
        const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
        return new Response(request.method === "HEAD" ? null : body, { headers: { "content-type": type } });
      } catch {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
    },
  };
}
