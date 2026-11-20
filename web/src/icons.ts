/**
 * Item icons, proxied from XIVAPI v2's asset endpoint.
 *
 * Why proxy instead of hotlinking: the CSP stays `img-src 'self'`, FC members' browsers never
 * contact a third party, and responses get long private caching. It is deliberately not an
 * open proxy: the only thing it can fetch is a game icon by numeric id.
 */

/** Game icon ids are 6-digit numbers. */
export const ICON_ID_PATTERN = /^[1-9][0-9]{0,5}$/;

const MAX_ICON_BYTES = 256 * 1024;

/**
 * XIVAPI's icon path convention (boilmaster `api1/value.rs`): ui/icon/{group:06}/{id:06}_hr1.tex
 * with group = floor(id / 1000) * 1000. `_hr1` is the high-resolution (80x80) variant.
 */
export function xivapiIconUrl(iconId: number): string {
  const pad = (n: number) => String(n).padStart(6, "0");
  const group = Math.floor(iconId / 1000) * 1000;
  return `https://v2.xivapi.com/api/asset?path=ui/icon/${pad(group)}/${pad(iconId)}_hr1.tex&format=png`;
}

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Fetches one icon as PNG. Upstream failures become 404/502 without leaking upstream bodies. */
export async function fetchIcon(iconId: number, fetcher: Fetcher): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetcher(xivapiIconUrl(iconId), {
      headers: { accept: "image/png", "user-agent": "fc-hub (+https://github.com/danny-mendoza1/fc-hub)" },
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return new Response(null, { status: 502 });
  }

  const type = upstream.headers.get("content-type") ?? "";
  if (!upstream.ok || !type.startsWith("image/png")) {
    await upstream.body?.cancel();
    return new Response(null, { status: upstream.status === 404 ? 404 : 502 });
  }

  const body = await upstream.arrayBuffer();
  if (body.byteLength > MAX_ICON_BYTES) return new Response(null, { status: 502 });
  return new Response(body, { status: 200, headers: { "content-type": "image/png" } });
}
