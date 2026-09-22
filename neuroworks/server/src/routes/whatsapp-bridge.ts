import { Router } from "express";
import { getWhatsAppBridgeStatus, resetAndReconnectWhatsApp, pendingTriageCount } from "../lib/whatsapp-bridge.js";

// WhatsApp Bridge status/pairing panel — read-only status + a one-click
// rescan for the Baileys bridge (lib/whatsapp-bridge.ts). Lives between
// Extensions and Connectors in the nav: it's neither an Extensions-catalog
// entry nor a token-based Connectors credential — it's a QR-paired device
// session, closer in shape to Hermes Bridge's own status panel
// (routes/hermes-bridge.ts) than to either of those pages.

export const whatsappBridgeRouter = Router();

whatsappBridgeRouter.get("/status", (_req, res) => {
  res.json({ ...getWhatsAppBridgeStatus(), pendingTriage: pendingTriageCount() });
});

// Tears down the live session, deletes the saved credentials, and restarts
// the bridge so a fresh QR gets generated — same action as asking Naxie to
// "reconnect WhatsApp" (whatsapp.reconnect primitive), exposed here as a
// button for when the operator is already on this page.
whatsappBridgeRouter.post("/reconnect", async (_req, res) => {
  const r = await resetAndReconnectWhatsApp();
  if (!r.ok) return res.status(500).json({ error: r.error });
  res.json({ ok: true });
});
