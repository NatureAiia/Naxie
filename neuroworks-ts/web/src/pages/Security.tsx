import { useState, useEffect } from "react";
import { api, type SecurityStatus } from "../lib/api";
import { Loader2, Shield, Ban, AlertTriangle } from "lucide-react";

const KIND_LABEL: Record<string, string> = {
  "scanner-probe": "Scanner probe",
  "traversal": "Path traversal",
  "injection": "Injection attempt",
  "auth-failure-burst": "Auth-failure burst",
  "flood": "Request flood",
  "blocked-request": "Blocked request",
};

export function Security() {
  const [data, setData] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  function load() {
    api.securityEvents().then(setData).catch(() => {}).finally(() => setLoading(false));
  }
  useEffect(() => { load(); const i = setInterval(load, 5000); return () => clearInterval(i); }, []);

  async function unblock(ip: string) {
    setBusy(ip);
    try { await api.unblockIp(ip); load(); } catch { /* ignore */ } finally { setBusy(null); }
  }

  if (loading) return <div className="flex items-center justify-center h-64"><Loader2 className="animate-spin w-6 h-6" /></div>;

  const events = data?.events ?? [];
  const blocked = data?.blocked ?? [];
  const sevColor = (s: string) => s === "high" ? "text-coral-400" : s === "medium" ? "text-flame-400" : "text-cream-300/60";
  const sevDot = (s: string) => s === "high" ? "bg-coral-500" : s === "medium" ? "bg-flame-500" : "bg-cream-300/40";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Shield className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Security</h1>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Events (recent)</div>
          <div className="text-2xl font-bold">{events.length}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Currently blocked</div>
          <div className={`text-2xl font-bold ${blocked.length > 0 ? "text-coral-400" : ""}`}>{blocked.length}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Addresses watched</div>
          <div className="text-2xl font-bold">{data?.watching ?? 0}</div>
        </div>
      </div>

      {blocked.length > 0 && (
        <div className="bg-ink-900 rounded-lg border border-coral-500/30 p-4">
          <h2 className="font-semibold flex items-center gap-2 mb-3"><Ban className="w-4 h-4 text-coral-400" /> Blocked addresses</h2>
          <div className="space-y-1">
            {blocked.map(b => (
              <div key={b.ip} className="flex items-center justify-between text-sm py-1 border-b border-ink-800 last:border-0">
                <div><span className="font-mono text-cream-100">{b.ip}</span> <span className="text-xs text-cream-300/50 ml-2">score {b.score} · until {new Date(b.until).toLocaleTimeString()}</span></div>
                <button onClick={() => unblock(b.ip)} disabled={busy === b.ip} className="text-xs px-2.5 py-1 rounded-md border border-ink-700 text-cream-300 hover:text-cream-100 disabled:opacity-50">{busy === b.ip ? "…" : "Unblock"}</button>
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="bg-ink-900 rounded-lg border p-4">
        <h2 className="font-semibold flex items-center gap-2 mb-3"><AlertTriangle className="w-4 h-4" /> Recent events</h2>
        {events.length === 0 ? (
          <div className="text-center py-10 text-sm text-cream-300/50">No suspicious activity detected. The attack-detection watchdog logs scanner probes, traversal/injection attempts, auth-failure bursts, and floods here.</div>
        ) : (
          <div className="space-y-1">
            {events.slice(0, 100).map((e, i) => (
              <div key={i} className="flex items-start gap-3 text-xs py-1 border-b border-ink-800 last:border-0">
                <span className={`mt-1 inline-block w-1.5 h-1.5 rounded-full shrink-0 ${sevDot(e.severity)}`} />
                <span className="w-32 shrink-0 text-cream-300/50">{new Date(e.at).toLocaleString()}</span>
                <span className={`w-36 shrink-0 ${sevColor(e.severity)}`}>{KIND_LABEL[e.kind] ?? e.kind}{e.blocked ? " · blocked" : ""}</span>
                <span className="w-28 shrink-0 font-mono text-cream-300/60">{e.ip}</span>
                <span className="min-w-0 flex-1 text-cream-200 break-all">{e.path}{e.detail ? <span className="text-cream-300/50"> — {e.detail}</span> : null}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
