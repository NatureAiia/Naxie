// WhatsApp Cloud API sender (Meta official) — ported by BEHAVIOR from
// naxionai/backend/whatsapp_client.py (built from scratch there — unlike
// Telegram, neither stack had a real WhatsApp bridge to port at the time).
//
// Distinct from the Baileys device bridge (lib/whatsapp-bridge.ts): Baileys
// emulates a linked device (QR pairing, ban risk, triage-only inbound); this
// uses Meta's Cloud API (phone_number_id + access token, no linked phone, no
// QR, vendor-supported). Both send paths stay available — the agent picks per
// task. Inbound Meta webhook (api/whatsapp_webhook.py) is deliberately NOT
// ported: it needs a public HTTPS endpoint Meta can reach, which conflicts
// with this server's loopback + origin-guard trust model; Baileys remains the
// inbound path.
//
// SSRF posture (same as the Python original's origin-locked httpx pattern):
// the destination origin is a hardcoded constant — no caller-supplied URL ever
// reaches fetch. Only the recipient phone number and message text vary.

import { config } from "../config.js";

const GRAPH_API_VERSION = "v19.0";
const GRAPH_API_ORIGIN = "https://graph.facebook.com";

export function whatsappCloudConfigured(): boolean {
  return config.whatsappCloudEnabled;
}

function normalizePhone(to: string): string | null {
  const digits = to.replace(/[^\d]/g, "");
  if (digits.length < 7 || digits.length > 15) return null;
  return digits;
}

export async function sendWhatsAppCloudMessage(
  to: string,
  text: string,
): Promise<{ ok: boolean; error?: string; messageId?: string }> {
  if (!config.whatsappPhoneNumberId || !config.whatsappAccessToken) {
    return { ok: false, error: "WhatsApp Cloud API not configured — set WHATSAPP_PHONE_NUMBER_ID / WHATSAPP_ACCESS_TOKEN" };
  }
  const recipient = normalizePhone(to);
  if (!recipient) return { ok: false, error: "to must be a phone number (7-15 digits, country code + number)" };
  const body = text.trim().slice(0, 4096);
  if (!body) return { ok: false, error: "text is required" };
  const url = `${GRAPH_API_ORIGIN}/${GRAPH_API_VERSION}/${encodeURIComponent(config.whatsappPhoneNumberId)}/messages`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.whatsappAccessToken}`,
      },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to: recipient,
        type: "text",
        text: { body },
      }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (e: any) {
    return { ok: false, error: `whatsapp cloud send failed: ${e?.message ?? e}` };
  }
  if (!res.ok) {
    const detail = (await res.text().catch(() => "")).slice(0, 300);
    return { ok: false, error: `WhatsApp Cloud send failed: HTTP ${res.status} — ${detail}` };
  }
  const data: any = await res.json().catch(() => ({}));
  const messageId = data?.messages?.[0]?.id;
  return { ok: true, ...(messageId ? { messageId: String(messageId) } : {}) };
}
