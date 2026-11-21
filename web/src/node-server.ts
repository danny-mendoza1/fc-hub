import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";
import { type AppEnv, handle } from "./app.ts";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Text bodies worth compressing. Images (PNG, WebP) are compressed already. */
const COMPRESSIBLE = /^(text\/|application\/json|image\/svg\+xml)/;
const MIN_COMPRESS_BYTES = 1024;

/**
 * Compresses a response body for the client's Accept-Encoding, as Cloudflare does in front of the
 * Worker. Without it, a self-hosted server sends JSON like "Items in common" at full size.
 * Returns null when the body should go as is.
 */
export async function compressBody(
  body: Uint8Array,
  contentType: string | null,
  acceptEncoding: string | null,
): Promise<{ encoding: "br" | "gzip"; body: Uint8Array } | null> {
  if (body.byteLength < MIN_COMPRESS_BYTES || !COMPRESSIBLE.test(contentType ?? "")) return null;
  const accepted = new Set((acceptEncoding ?? "").split(",").map((e) => e.split(";")[0]?.trim().toLowerCase()));
  if (accepted.has("br")) {
    // Quality 5: most of brotli's gain at a fraction of the CPU of the default 11.
    return { encoding: "br", body: await brotli(body, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }) };
  }
  if (accepted.has("gzip")) return { encoding: "gzip", body: await gzipAsync(body) };
  return null;
}

/** Serves the app over Node's http module (the Docker image, local dev, and the browser tests). */
export function startServer(env: AppEnv, port: number, host: string, onListening?: () => void): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const response = await handle(toRequest(req), env);
      const headers = Object.fromEntries(response.headers);
      let body: Uint8Array = new Uint8Array(await response.arrayBuffer());
      if (!response.headers.has("content-encoding")) {
        const compressed = await compressBody(body, response.headers.get("content-type"), req.headers["accept-encoding"] ?? null);
        if (compressed) {
          body = compressed.body;
          headers["content-encoding"] = compressed.encoding;
          headers.vary = "accept-encoding";
        }
      }
      res.writeHead(response.status, headers);
      res.end(body);
    } catch (error) {
      console.error(error);
      res.writeHead(500).end();
    }
  });
  server.listen(port, host, onListening);
  return server;
}

function toRequest(req: IncomingMessage): Request {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const headers = new Headers();
  for (const [key, value] of Object.entries(req.headers)) {
    if (Array.isArray(value)) {
      for (const v of value) headers.append(key, v);
    } else if (value !== undefined) {
      headers.set(key, value);
    }
  }
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, {
    method: req.method,
    headers,
    body: hasBody ? (Readable.toWeb(req) as ReadableStream<Uint8Array>) : undefined,
    // Required by Node's fetch implementation when streaming a request body.
    ...(hasBody ? { duplex: "half" } : {}),
  } as RequestInit);
}
