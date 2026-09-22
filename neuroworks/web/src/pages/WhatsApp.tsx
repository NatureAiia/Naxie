import { useEffect, useRef, useState } from "react";
import { MessageCircle, RefreshCw, Inbox, AlertTriangle, ShieldCheck } from "lucide-react";
import { api, type WhatsAppBridgeStatus } from "../lib/api";
import { Card, Button, StatusDot, showToast } from "../components/Card";

// WhatsApp Bridge — status + QR pairing panel for the Baileys-based bridge
// (server/src/lib/whatsapp-bridge.ts) that connects Naxie to the Variety &
// Co business number. Sits between Extensions and Connectors in the nav:
// it's not an Extensions-catalog entry, and it's not a token/secret like a
// Connectors credential — it's a QR-paired device session, closer in shape
// to the Hermes Bridge status panel than either of those pages.
//
// Deliberately thin: pairing state lives entirely on the server
// (lib/whatsapp-bridge.ts). This page polls status and offers one action
// (reconnect/rescan) — it never lets you configure anything, because the
// only thing to configure here (the paired phone) is the session itself.

function relTime(iso?: string): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60); if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60); if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

export function WhatsApp() {
  const [status, setStatus] = useState<WhatsAppBridgeStatus | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  async function refresh() {
    try { setStatus(await api.whatsappStatus()); } catch { /* server may be mid-restart during reconnect */ }
  }

  useEffect(() => {
    void refresh();
    // Poll fairly often — a fresh QR frame appears within a few seconds of
    // pairing starting, and Baileys rotates an unscanned QR periodically, so
    // this keeps the on-page code from ever going stale.
    pollRef.current = setInterval(refresh, 3000);
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, []);

  async function reconnect() {
    if (!confirm("Reconnect WhatsApp? This ends the current session and generates a new QR code to scan — the phone currently linked will need to re-pair.")) return;
    setReconnecting(true);
    try {
      await api.whatsappReconnect();
      showToast("WhatsApp session reset — scan the new QR code below", "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setReconnecting(false);
      void refresh();
    }
  }

  const connected = status?.connected ?? false;
  const running = status?.running ?? false;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><MessageCircle size={24} /> WhatsApp</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Naxie's WhatsApp bridge for the Variety &amp; Co business number, via an unofficial linked-device
          connection (Baileys) — not Meta's paid Cloud API. It's <span className="text-cream-200">triage-only</span>:
          inbound messages become a CRM contact and a Telegram notification with Respond/Ignore, and Naxie only
          drafts or sends a reply once you approve it. Sending is paced with human-like typing delays to avoid
          looking automated to WhatsApp's spam detection.
        </p>
      </div>

      <Card title="Connection">
        <div className="space-y-4">
          <div className="flex items-center justify-between flex-wrap gap-3">
            <StatusDot
              ok={connected ? true : running ? "pending" : false}
              label={connected
                ? `Connected${status?.phoneNumber ? ` as ${status.phoneNumber}` : ""}`
                : running ? "Waiting for pairing…" : "Not running"}
            />
            <Button variant="subtle" onClick={reconnect} disabled={reconnecting}>
              <RefreshCw size={14} className={reconnecting ? "animate-spin" : ""} /> {connected ? "Rescan / re-pair" : "Generate new QR"}
            </Button>
          </div>

          <div className="grid grid-cols-2 tablet:grid-cols-4 gap-3 text-xs">
            <div className="bg-ink-800/60 rounded-lg p-3">
              <div className="text-cream-300/60">Messages processed</div>
              <div className="text-cream-100 text-lg font-medium">{status?.processed ?? 0}</div>
            </div>
            <div className="bg-ink-800/60 rounded-lg p-3">
              <div className="text-cream-300/60 flex items-center gap-1"><Inbox size={11} /> Pending triage</div>
              <div className="text-cream-100 text-lg font-medium">{status?.pendingTriage ?? 0}</div>
            </div>
            <div className="bg-ink-800/60 rounded-lg p-3">
              <div className="text-cream-300/60">Started</div>
              <div className="text-cream-100">{status?.startedAt ? relTime(status.startedAt) : "—"}</div>
            </div>
            <div className="bg-ink-800/60 rounded-lg p-3">
              <div className="text-cream-300/60">Last error</div>
              <div className={status?.lastError ? "text-coral-400" : "text-cream-100"}>{status?.lastError ?? "none"}</div>
            </div>
          </div>

          {!connected && status?.qrDataUrl && (
            <div className="flex flex-col items-center gap-3 py-4 border-t border-ink-800">
              <p className="text-sm text-cream-200 text-center max-w-sm">
                Open WhatsApp on <span className="text-cream-50">+263716031399</span> → Settings → Linked Devices →
                Link a Device, and scan this code.
              </p>
              <img src={status.qrDataUrl} alt="WhatsApp pairing QR code" width={240} height={240} className="rounded-lg border border-ink-700 bg-white p-2" />
              {status.qrUpdatedAt && <p className="text-[11px] text-cream-300/50">Refreshed {relTime(status.qrUpdatedAt)}</p>}
            </div>
          )}

          {!connected && running && !status?.qrDataUrl && (
            <div className="flex items-center gap-2 text-sm text-cream-300/70 py-2 border-t border-ink-800">
              <RefreshCw size={14} className="animate-spin" /> Waiting for the server to generate a QR code…
            </div>
          )}

          {!running && (
            <div className="flex items-start gap-2 text-sm text-amber-300 bg-amber-500/10 border border-amber-500/20 rounded-lg p-3">
              <AlertTriangle size={16} className="shrink-0 mt-0.5" />
              <div>
                The bridge isn't running — either <code className="text-xs">NEUROWORKS_WHATSAPP_INBOUND=0</code> is set,
                the server hasn't started it yet, or it's logged out. Try Generate new QR, or check the server logs.
              </div>
            </div>
          )}
        </div>
      </Card>

      <Card title="How this stays safe">
        <ul className="text-sm text-cream-300/80 space-y-2">
          <li className="flex gap-2"><ShieldCheck size={15} className="shrink-0 mt-0.5 text-leaf-400" /> Every inbound message is triaged — Naxie never auto-replies to a customer without your sign-off.</li>
          <li className="flex gap-2"><ShieldCheck size={15} className="shrink-0 mt-0.5 text-leaf-400" /> Outbound sends (<code className="text-xs">whatsapp.send</code>, <code className="text-xs">whatsapp.broadcast</code>) are approval-gated, same as email.</li>
          <li className="flex gap-2"><ShieldCheck size={15} className="shrink-0 mt-0.5 text-leaf-400" /> Broadcasts are capped at 40 recipients per run with randomized delays — no instant mass blast.</li>
        </ul>
      </Card>
    </div>
  );
}
