import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

interface CachedFile {
  mtimeMs: number;
  size: number;
  body: Uint8Array<ArrayBuffer>;
  etag: string;
}

/**
 * Node stand-in for the Cloudflare assets binding: serves files from `root`, maps "/" to
 * index.html, and refuses anything that resolves outside `root` (path traversal).
 *
 * Like Cloudflare's asset server it sends an ETag and answers a matching `If-None-Match` with 304,
 * so a reload revalidates index.html without downloading it again. Files are kept in memory and
 * re-read only when their modification time or size changes (e.g. after `npm run build`).
 */
export function diskAssets(root: string): { fetch(request: Request): Promise<Response> } {
  const base = resolve(root);
  const files = new Map<string, CachedFile>();

  async function load(file: string): Promise<CachedFile> {
    const info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
    const hit = files.get(file);
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit;
    const body = new Uint8Array(await readFile(file));
    const entry = {
      mtimeMs: info.mtimeMs,
      size: info.size,
      body,
      etag: `"${createHash("sha256").update(body).digest("base64url").slice(0, 27)}"`,
    };
    files.set(file, entry);
    return entry;
  }

  return {
    async fetch(request: Request): Promise<Response> {
      const { pathname } = new URL(request.url);
      const relative = decodeURIComponent(pathname === "/" ? "/index.html" : pathname);
      const file = resolve(base, `.${relative}`);
      // Also refuses Cloudflare's config files (_headers), which its asset server never serves either.
      if ((file !== base && !file.startsWith(base + sep)) || relative.startsWith("/_")) {
        return new Response("Not found", { status: 404 });
      }

      let entry: CachedFile;
      try {
        entry = await load(file);
      } catch {
        return new Response("Not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
      }
      const type = CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
      const headers = { "content-type": type, etag: entry.etag };
      const ifNoneMatch = request.headers.get("if-none-match");
      if (ifNoneMatch?.split(",").some((tag) => tag.trim() === entry.etag)) return new Response(null, { status: 304, headers });
      return new Response(request.method === "HEAD" ? null : entry.body, { headers });
    },
  };
}
