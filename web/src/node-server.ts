import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { type AppEnv, handle } from "./app.ts";

/** Serves the app over Node's http module (the Docker image, local dev, and the browser tests). */
export function startServer(env: AppEnv, port: number, host: string, onListening?: () => void): Server {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const response = await handle(toRequest(req), env);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
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
