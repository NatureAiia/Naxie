// Production-safe relay to the separate naxionai/backend (FastAPI, Python)
// service that hosts Naxie's personal Google/Microsoft/local-folder
// connectors. In `pnpm dev`, vite.config.ts's own proxy sends "/naxie-api/*"
// straight to naxionai — but a built/served app (SERVE_WEB=1) has no Vite
// dev server in front of it, so that path 404s against this Express app
// unless something here forwards it. This route is that forward: same
// "/naxie-api" prefix web/src/lib/naxieApi.ts already calls, rewritten onto
// naxionai's "/api" prefix, so the web client needs zero changes.
//
// This does NOT start or supervise the naxionai process — it must already be
// running at config.naxionBaseUrl. Standing up process supervision for a
// second backend is a bigger, separate decision (see docs/naxie-architecture.md
// §2.0/§9 on always-on-service sign-off) and is deliberately out of scope here.

import { Router } from "express";
import { config } from "../config.js";

export const naxieConnectorsRouter = Router();

// Exported for testing — pure string rewrite, no I/O.
export function toNaxionUrl(baseUrl: string, originalUrl: string): string {
  const rest = originalUrl.replace(/^\/naxie-api/, "");
  return `${baseUrl}/api${rest}`;
}

naxieConnectorsRouter.use(async (req, res) => {
  const target = toNaxionUrl(config.naxionBaseUrl, req.originalUrl);
  try {
    const upstream = await fetch(target, {
      method: req.method,
      headers: { "Content-Type": "application/json" },
      body: req.method === "GET" || req.method === "HEAD" ? undefined : JSON.stringify(req.body ?? {}),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await upstream.text();
    res.status(upstream.status);
    res.setHeader("Content-Type", upstream.headers.get("content-type") ?? "application/json");
    res.send(text);
  } catch (e: any) {
    res.status(502).json({
      detail: `naxionai backend is not reachable at ${config.naxionBaseUrl} — start it separately for personal connectors to work. (${e?.message ?? e})`,
    });
  }
});
