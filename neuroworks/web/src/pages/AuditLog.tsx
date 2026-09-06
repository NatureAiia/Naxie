import { useState, useEffect } from "react";
import { api, type SecurityStatus } from "../lib/api";
import { Loader2, ScrollText, Search, AlertTriangle, Info, AlertCircle, Shield, Ban } from "lucide-react";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";

// Merged trail — audit events (agent actions) + security events (attack
// detection), one filterable table with a type switch, plus the blocked-IP
// list/unblock action folded in from the old Security.tsx.

const KIND_LABEL: Record<string, string> = {
  "scanner-probe": "Scanner probe",
  "traversal": "Path traversal",
  "injection": "Injection attempt",
  "auth-failure-burst": "Auth-failure burst",
  "flood": "Request flood",
  "blocked-request": "Blocked request",
};

// Normalised row shape both event kinds are mapped into, so one list/table
// can render either side without a bunch of conditional branches per field.
type TrailRow = {
  id: string;
  kind: "audit" | "security";
  ts: string;
  level: "info" | "warn" | "error";
  actor: string;
  headline: string;
  detail?: string;
  jobId?: string;
  ip?: string;
  blocked?: boolean;
};

function auditToRow(e: any): TrailRow {
  return {
    id: e.id ?? `audit-${e.ts}-${e.actor}-${e.action}`,
    kind: "audit",
    ts: e.ts,
    level: e.level === "error" || e.level === "warn" ? e.level : "info",
    actor: e.actor,
    headline: `${e.action} on ${e.target}`,
    detail: e.detail,
    jobId: e.jobId,
  };
}

function securityToRow(e: any, i: number): TrailRow {
  return {
    id: `security-${e.at}-${e.ip}-${i}`,
    kind: "security",
    ts: e.at,
    level: e.severity === "high" ? "error" : e.severity === "medium" ? "warn" : "info",
    actor: e.ip,
    headline: `${KIND_LABEL[e.kind] ?? e.kind}${e.blocked ? " · blocked" : ""}`,
    detail: [e.path, e.detail].filter(Boolean).join(" — ") || undefined,
    ip: e.ip,
    blocked: e.blocked,
  };
}

export function AuditLog() {
  const [type, setType] = useState<"all" | "audit" | "security">("all");
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [security, setSecurity] = useState<SecurityStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  const [level, setLevel] = useState("");
  const [actor, setActor] = useState("");
  const [action, setAction] = useState("");
  const [role, setRole] = useState("");

  const loadAudit = () => {
    api.queryAudit({ limit: 100, level: level || undefined, actor: actor || undefined, action: action || undefined, role: role || undefined })
      .then(r => { setAuditEvents(r.events); setAuditTotal(r.total); })
      .catch(() => {});
  };
  const loadSecurity = () => {
    api.securityEvents().then(setSecurity).catch(() => {});
  };
  const loadAll = () => {
    setLoading(true);
    Promise.all([loadAudit(), loadSecurity()]).finally(() => setLoading(false));
  };
  useEffect(() => { loadAll(); const i = setInterval(loadSecurity, 5000); return () => clearInterval(i); }, []);

  async function unblock(ip: string) {
    setBusy(ip);
    try { await api.unblockIp(ip); loadSecurity(); } catch { /* ignore */ } finally { setBusy(null); }
  }

  const securityEvents = security?.events ?? [];
  const blocked = security?.blocked ?? [];

  const rows: TrailRow[] = [
    ...(type !== "security" ? auditEvents.map(auditToRow) : []),
    ...(type !== "audit" ? securityEvents.map(securityToRow) : []),
  ].sort((a, b) => (b.ts ?? "").localeCompare(a.ts ?? ""));
  const rowList = useLoadMore(rows);

  const levelIcon = (lvl: string) => {
    switch (lvl) {
      case "error": return <AlertCircle className="w-4 h-4 text-coral-400" />;
      case "warn": return <AlertTriangle className="w-4 h-4 text-flame-400" />;
      default: return <Info className="w-4 h-4 text-violet-400" />;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <ScrollText className="w-6 h-6" />
        <h1 className="text-2xl font-bold">Audit &amp; Security Log</h1>
        <span className="text-sm text-cream-300/60 ml-auto">{auditTotal} audit events · {securityEvents.length} security events</span>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Audit events</div>
          <div className="text-2xl font-bold">{auditTotal}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Currently blocked</div>
          <div className={`text-2xl font-bold ${blocked.length > 0 ? "text-coral-400" : ""}`}>{blocked.length}</div>
        </div>
        <div className="bg-ink-900 rounded-lg border p-4">
          <div className="text-xs text-cream-300/60">Addresses watched</div>
          <div className="text-2xl font-bold">{security?.watching ?? 0}</div>
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

      <div className="flex flex-wrap gap-3 items-end">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-cream-300/60">Type</label>
          <select value={type} onChange={e => setType(e.target.value as any)} className="text-sm border rounded px-2 py-1 bg-ink-900">
            <option value="all">All</option>
            <option value="audit">Agent actions</option>
            <option value="security">Security events</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-cream-300/60">Level</label>
          <select value={level} onChange={e => setLevel(e.target.value)} className="text-sm border rounded px-2 py-1 bg-ink-900">
            <option value="">All</option>
            <option value="info">Info</option>
            <option value="warn">Warning</option>
            <option value="error">Error</option>
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-cream-300/60">Actor</label>
          <input value={actor} onChange={e => setActor(e.target.value)} placeholder="Filter by actor..." className="text-sm border rounded px-2 py-1 bg-ink-900 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-cream-300/60">Action</label>
          <input value={action} onChange={e => setAction(e.target.value)} placeholder="Filter by action..." className="text-sm border rounded px-2 py-1 bg-ink-900 w-40" />
        </div>
        <div className="flex flex-col gap-1">
          <label className="text-xs text-cream-300/60">Role</label>
          <select value={role} onChange={e => setRole(e.target.value)} className="text-sm border rounded px-2 py-1 bg-ink-900">
            <option value="">All</option>
            <option value="scheduler">Scheduler</option>
            <option value="researcher">Researcher</option>
            <option value="executor">Executor</option>
            <option value="admin">Admin</option>
            <option value="architect">Architect</option>
          </select>
        </div>
        <button onClick={loadAudit} className="flex items-center gap-2 text-sm px-3 py-1.5 rounded bg-violet-500 text-white hover:bg-violet-600">
          <Search className="w-4 h-4" /> Search
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center h-32"><Loader2 className="animate-spin w-6 h-6" /></div>
      ) : rows.length === 0 ? (
        <p className="text-sm text-cream-300/60">No events found.</p>
      ) : (
        <div className="bg-ink-900 rounded-lg border overflow-hidden">
          <div className="divide-y">
            {rowList.visible.map((e) => (
              <div key={e.id} className="p-3 flex items-start gap-3 hover:bg-ink-800/40 dark:hover:bg-ink-800/50">
                <div className="mt-0.5">{e.kind === "security" ? <Shield className="w-4 h-4 text-flame-400" /> : levelIcon(e.level)}</div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{e.actor}</span>
                    <span className="text-xs text-cream-300/50">{e.ts ? new Date(e.ts).toLocaleString() : ""}</span>
                    <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-ink-800 text-cream-300/60">{e.kind === "security" ? "security" : "agent"}</span>
                    {e.blocked && <span className="text-xs px-1.5 py-0.5 rounded bg-coral-500/15 text-coral-300">blocked</span>}
                  </div>
                  <div className="text-sm mt-0.5">{e.headline}</div>
                  {e.detail && <div className="text-xs text-cream-300/60 mt-0.5 truncate">{e.detail}</div>}
                  {e.jobId && <div className="text-xs text-cream-300/50 mt-0.5 font-mono">job: {e.jobId}</div>}
                  {e.kind === "security" && e.ip && blocked.some(b => b.ip === e.ip) && (
                    <button onClick={() => unblock(e.ip!)} disabled={busy === e.ip} className="mt-1 text-[11px] px-2 py-0.5 rounded border border-ink-700 text-cream-300 hover:text-cream-100 disabled:opacity-50">
                      {busy === e.ip ? "…" : `Unblock ${e.ip}`}
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <LoadMoreButton state={rowList} noun="events" className="pb-3" />
        </div>
      )}
    </div>
  );
}
