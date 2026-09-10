import { Router } from "express";
import {
  buildAuthorizeUrl, handleCallback, listConnections, removeConnection, refreshConnection,
  type OauthPlatform,
} from "../lib/oauth-connectors.js";
import { config } from "../config.js";
import { logAudit } from "../lib/audit-log.js";

// Google / Microsoft OAuth connectors — native port of
// naxionai/backend/api/{google,microsoft}_connector.py. Route shapes match
// the Python originals (/authorize, /callback, /, /:id, /:id/refresh) so the
// registered OAuth apps' redirect URIs only need repointing at this server's
// port, not reconfiguring end-to-end.

export const oauthConnectorsRouter = Router();

// Literal "google"/"microsoft" segments (not a `:platform` wildcard) — this
// router is mounted at /api/connectors alongside routes/connectors.ts's
// generic custom-connector CRUD (/api/connectors/:id, .../:id/refresh isn't
// one of its routes, but /:id and /:id/call are). Mounting THIS router first
// in index.ts means these exact literal paths are claimed before the generic
// `:id` router ever sees them; anything else falls through unaffected.
const PLATFORMS: OauthPlatform[] = ["google", "microsoft"];

for (const platform of PLATFORMS) {
  oauthConnectorsRouter.get(`/${platform}/authorize`, (_req, res) => {
    try {
      res.json({ authorize_url: buildAuthorizeUrl(platform) });
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });

  // Hit directly by the browser after the provider's consent screen — no
  // Authorization header, so this can't depend on session auth. Always
  // redirects back to the web app rather than returning JSON, matching how a
  // browser-driven OAuth callback behaves.
  oauthConnectorsRouter.get(`/${platform}/callback`, async (req, res) => {
    const redirectBase = `${config.naxieWebUrl.replace(/\/$/, "")}/connectors`;
    const { code, state, error } = req.query as Record<string, string | undefined>;
    if (error) return res.redirect(`${redirectBase}?error=${encodeURIComponent(error)}`);
    if (!code || !state) return res.redirect(`${redirectBase}?error=missing_code_or_state`);
    try {
      await handleCallback(platform, code, state);
      logAudit({ level: "info", actor: "system", action: "oauth.connect", target: platform, detail: "connected", result: "success" });
      res.redirect(`${redirectBase}?connected=${platform}`);
    } catch (e: any) {
      logAudit({ level: "warn", actor: "system", action: "oauth.connect", target: platform, detail: String(e?.message ?? e), result: "failure" });
      res.redirect(`${redirectBase}?error=${encodeURIComponent(String(e?.message ?? e).slice(0, 120))}`);
    }
  });

  oauthConnectorsRouter.get(`/${platform}`, (_req, res) => {
    res.json({ connections: listConnections(platform) });
  });

  oauthConnectorsRouter.delete(`/${platform}/:id`, (req, res) => {
    const ok = removeConnection(String(req.params.id));
    if (!ok) return res.status(404).json({ error: "connection not found" });
    logAudit({ level: "warn", actor: "system", action: "oauth.disconnect", target: String(req.params.id), detail: platform, result: "success" });
    res.json({ status: "deleted" });
  });

  oauthConnectorsRouter.post(`/${platform}/:id/refresh`, async (req, res) => {
    try {
      const c = await refreshConnection(String(req.params.id));
      res.json(c);
    } catch (e: any) {
      res.status(400).json({ error: String(e?.message ?? e) });
    }
  });
}
