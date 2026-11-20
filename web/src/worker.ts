import { type AppEnv, handle } from "./app.ts";

/** Cloudflare Workers entry. `env.DB` is the D1 binding declared in wrangler.toml. */
export default {
  fetch(request: Request, env: AppEnv): Promise<Response> {
    return handle(request, env);
  },
};
