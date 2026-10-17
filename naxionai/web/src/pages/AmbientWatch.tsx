import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Radar, BellRing, BellOff, Moon, Mail, Trash2, FlaskConical, RefreshCw, AlertTriangle } from "lucide-react";
import { api, type AmbientConfig, type AmbientEvent, type AmbientSource } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { ToggleRow } from "../components/ToggleRow";
import { useVisibleInterval } from "../lib/useVisibleInterval";

const SOURCE_LABELS: Record<AmbientSource, string> = {
  job: "Jobs finishing",
  schedule: "Schedules firing",
  calendar: "Planner reminders",
  github: "New commits",
  email: "Email triage",
  webhook: "Webhook deliveries",
  flow: "Flow runs",
};

const SOURCE_HINTS: Record<AmbientSource, string> = {
  job: "Failed runs and handoffs push; finishes stay in the feed.",
  schedule: "Misfires push; clean fires stay in the feed.",
  calendar: "Reminders due within 30 min + overdue Planner tasks.",
  github: "New commits on watched repos — feed only, morning digest.",
  email: "Mail needing triage pushes so it doesn't sit unseen.",
  webhook: "Failing deliveries push; dead letters break quiet hours.",
  flow: "Failed automation runs push.",
};

function ago(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const SEV_STYLE: Record<AmbientEvent["severity"], string> = {
  info: "bg-ink-700 text-cream-300/70",
  attention: "bg-amber-500/15 text-amber-300",
  urgent: "bg-coral-500/15 text-coral-300",
};

export function AmbientWatch() {
  const [cfg, setCfg] = useState<AmbientConfig | null>(null);
  const [events, setEvents] = useState<AmbientEvent[]>([]);
  const [counts, setCounts] = useState({ total: 0, last24h: 0, pushed: 0, deferred: 0 });
  const [engine, setEngine] = useState<{ lastRunAt?: string; lastError?: string } | null>(null);
  const [emailCfg, setEmailCfg] = useState(false);
  const [err, setErr] = useState("");
  const [filter, setFilter] = useState<"" | AmbientSource>("");
  const [busy, setBusy] = useState(false);
  const [testTo, setTestTo] = useState("");

  const load = useCallback(async () => {
    try {
      const [s, e, c] = await Promise.all([
        api.ambientStatus(),
        api.ambientEvents({ limit: 50 }),
        api.ambientConfig().catch(() => null),
      ]);
      setCounts(s.counts);
      setEngine(s.engine);
      setEmailCfg(s.email?.configured ?? false);
      setEvents(e.events);
      if (c) setCfg(c.config);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }, []);
  useVisibleInterval(load, 10000);
  useEffect(() => { void load(); }, [load]);

  async function patch(p: Partial<AmbientConfig>) {
    const prev = cfg;
    if (prev) setCfg({ ...prev, ...p });
    try {
      const r = await api.updateAmbientConfig(p);
      setCfg(r.config);
    } catch (e: any) {
      if (prev) setCfg(prev);
      showToast(e?.message ?? String(e), "error");
    }
  }

  async function testNudge() {
    setBusy(true);
    try {
      const r = await api.testAmbient();
      showToast(
        r.event.notified.length ? `Nudge sent via ${r.event.notified.join(", ")}` : "Recorded — check quiet hours / channels",
        "success", 4000,
      );
      await load();
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  async function sendTestEmail() {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(testTo.trim())) { showToast("Enter a valid address first", "error"); return; }
    setBusy(true);
    try {
      await api.sendTestEmail(testTo.trim());
      showToast(`Test email sent to ${testTo.trim()}`, "success", 4000);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }

  const watching = cfg?.enabled ?? false;
  const shown = filter ? events.filter(e => e.source === filter) : events;

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3">
            <Radar size={24} /> Ambient Watch
          </h1>
          <p className="text-sm text-cream-300/70 mt-1 max-w-2xl">
            A background watcher that notices things — a job finishing, a schedule firing,
            a reminder coming due — and decides on its own whether to bring it to you.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-full border ${watching ? "bg-leaf-500/10 border-leaf-500/30 text-leaf-300" : "bg-ink-800 border-ink-700 text-cream-300/60"}`}>
            {watching ? <BellRing size={13} /> : <BellOff size={13} />}
            {watching ? "Watching" : "Paused"}
          </span>
          {cfg && (
            <Button variant="subtle" onClick={() => void patch({ enabled: !cfg.enabled })}>
              {cfg.enabled ? "Pause" : "Resume"}
            </Button>
          )}
        </div>
      </div>

      {err && (
        <div className="bg-coral-500/10 border border-coral-500/30 text-coral-300 text-sm rounded-md px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      <div className="grid grid-cols-2 tablet:grid-cols-4 gap-3">
        {[
          ["Last 24h", String(counts.last24h)],
          ["Pushed to you", String(counts.pushed)],
          ["Held for quiet hours", String(counts.deferred)],
          ["Engine", engine?.lastRunAt ? `tick ${ago(engine.lastRunAt)}` : engine ? "armed" : "—"],
        ].map(([label, value]) => (
          <Card key={label} className="!p-0">
            <div className="px-4 py-3">
              <div className="text-[11px] uppercase tracking-wider text-cream-300/50">{label}</div>
              <div className="text-lg text-cream-50 font-medium mt-0.5">{value}</div>
            </div>
          </Card>
        ))}
      </div>
      {engine?.lastError && (
        <div className="text-xs text-coral-400 flex items-center gap-1.5">
          <AlertTriangle size={12} /> Watcher engine error: {engine.lastError}
        </div>
      )}

      <div className="grid gap-5 desktop:grid-cols-2 desktop:items-start">
        <Card title="What it's allowed to notice">
          {!cfg ? (
            <div className="text-sm text-cream-300/60">Loading…</div>
          ) : (
            <div className="space-y-3">
              {(Object.keys(SOURCE_LABELS) as AmbientSource[]).map(s => (
                <div key={s}>
                  <ToggleRow
                    label={SOURCE_LABELS[s]}
                    checked={cfg.sources[s]}
                    onChange={v => void patch({ sources: { ...cfg.sources, [s]: v } })}
                  />
                  <div className="text-[11px] text-cream-300/45 mt-0.5">{SOURCE_HINTS[s]}</div>
                </div>
              ))}
              <p className="text-[11px] text-cream-300/50 pt-2 border-t border-ink-800">
                Relevance is rule-based today (failures, handoffs and overdue items push; everything else stays
                in the feed + digest). The judge is one function on the server, ready for an LLM scorer later.
              </p>
            </div>
          )}
        </Card>

        <div className="space-y-5">
          <Card title="How it may reach you">
            {!cfg ? (
              <div className="text-sm text-cream-300/60">Loading…</div>
            ) : (
              <div className="space-y-3">
                <ToggleRow label="Desktop toast" checked={cfg.channels.toast} onChange={v => void patch({ channels: { ...cfg.channels, toast: v } })} />
                <ToggleRow label="Telegram message" checked={cfg.channels.telegram} onChange={v => void patch({ channels: { ...cfg.channels, telegram: v } })} />
                <ToggleRow
                  label={`Email${emailCfg ? "" : " (not configured yet)"}`}
                  checked={cfg.channels.email}
                  onChange={v => void patch({ channels: { ...cfg.channels, email: v } })}
                />
                <div>
                  <label htmlFor="ambient-email-to" className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">
                    Email nudges go to
                  </label>
                  <input
                    id="ambient-email-to"
                    type="email"
                    defaultValue={cfg.emailTo ?? ""}
                    key={cfg.emailTo ?? "empty"}
                    onBlur={e => { if (e.target.value.trim() !== (cfg.emailTo ?? "")) void patch({ emailTo: e.target.value.trim() || undefined as any }); }}
                    placeholder="blank = your own account address"
                    className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-2 text-sm focus:outline-none placeholder:text-cream-300/40"
                  />
                </div>
                <div className="pt-2 border-t border-ink-800 space-y-2">
                  <div className="flex items-center gap-2 text-xs text-cream-200">
                    <Moon size={13} className="text-cream-300/60" />
                    <ToggleRow
                      label="Quiet hours (attention waits for the digest)"
                      checked={!!cfg.quietHours}
                      onChange={v => void patch({ quietHours: v ? { start: "22:00", end: "07:00" } : null })}
                    />
                  </div>
                  {cfg.quietHours && (
                    <div className="flex items-center gap-2 text-xs">
                      <input
                        type="time" value={cfg.quietHours.start}
                        onChange={e => void patch({ quietHours: { ...cfg.quietHours!, start: e.target.value } })}
                        className="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-cream-100"
                        aria-label="Quiet hours start"
                      />
                      <span className="text-cream-300/50">to</span>
                      <input
                        type="time" value={cfg.quietHours.end}
                        onChange={e => void patch({ quietHours: { ...cfg.quietHours!, end: e.target.value } })}
                        className="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-cream-100"
                        aria-label="Quiet hours end"
                      />
                      <span className="text-cream-300/50">urgent always breaks through</span>
                    </div>
                  )}
                </div>
                <div className="pt-2 border-t border-ink-800 space-y-2">
                  <ToggleRow
                    label="Morning digest (everything from the last 24h)"
                    checked={cfg.digest.enabled}
                    onChange={v => void patch({ digest: { ...cfg.digest, enabled: v } })}
                  />
                  {cfg.digest.enabled && (
                    <div className="flex items-center gap-2 text-xs">
                      <span className="text-cream-300/60">Send at</span>
                      <input
                        type="number" min={0} max={23} value={cfg.digest.hour}
                        onChange={e => void patch({ digest: { ...cfg.digest, hour: Number(e.target.value) } })}
                        className="w-14 bg-ink-950 border border-ink-800 rounded px-2 py-1 text-center text-cream-100"
                        aria-label="Digest hour"
                      />
                      <span className="text-cream-300">:</span>
                      <input
                        type="number" min={0} max={59} value={cfg.digest.minute}
                        onChange={e => void patch({ digest: { ...cfg.digest, minute: Number(e.target.value) } })}
                        className="w-14 bg-ink-950 border border-ink-800 rounded px-2 py-1 text-center text-cream-100"
                        aria-label="Digest minute"
                      />
                    </div>
                  )}
                </div>
                <div className="flex items-center gap-2 pt-2">
                  <Button variant="subtle" onClick={() => void testNudge()} disabled={busy}>
                    <span className="inline-flex items-center gap-1.5"><FlaskConical size={13} /> Send test nudge</span>
                  </Button>
                  <Button variant="ghost" onClick={() => { void api.runAmbientScan().then(() => load()); }}>
                    <span className="inline-flex items-center gap-1.5"><RefreshCw size={13} /> Scan now</span>
                  </Button>
                </div>
              </div>
            )}
          </Card>

          <Card
            title="Email wiring"
            action={
              <span className={`text-[11px] px-2 py-0.5 rounded-full ${emailCfg ? "bg-leaf-500/15 text-leaf-300" : "bg-amber-500/15 text-amber-300"}`}>
                {emailCfg ? "outbound ready" : "not configured"}
              </span>
            }
          >
            <p className="text-xs text-cream-300/60 mb-3">
              Urgent nudges and the digest send by email; inbound mail lands in triage and becomes an
              Ambient event. Needs <code className="text-cream-200">NAXION_EMAIL_USER</code> + app password
              (Gmail IMAP/SMTP) and/or <code className="text-cream-200">NAXION_MAILJET_API_KEY</code> +
              secret (outbound). <Link to="/connectors" className="text-violet-400 hover:text-violet-300">Connectors →</Link>
            </p>
            <div className="flex items-center gap-2">
              <div className="relative flex-1">
                <Mail size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-cream-300/40" />
                <input
                  type="email" value={testTo} onChange={e => setTestTo(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md pl-9 pr-3 py-2 text-sm focus:outline-none placeholder:text-cream-300/40"
                  aria-label="Test email recipient"
                />
              </div>
              <Button variant="subtle" onClick={() => void sendTestEmail()} disabled={busy || !emailCfg}>
                Send test
              </Button>
            </div>
            {!emailCfg && (
              <p className="text-[11px] text-amber-300/80 mt-2">Outbound isn't configured, so email nudges are held — toast/Telegram still work.</p>
            )}
          </Card>
        </div>
      </div>

      <Card
        title={`Noticed lately · ${shown.length}`}
        action={
          <div className="flex items-center gap-2">
            <select
              value={filter} onChange={e => setFilter(e.target.value as "" | AmbientSource)}
              className="bg-ink-950 border border-ink-800 rounded px-2 py-1 text-xs text-cream-200 cursor-pointer"
              aria-label="Filter by source"
            >
              <option value="">All sources</option>
              {(Object.keys(SOURCE_LABELS) as AmbientSource[]).map(s => (
                <option key={s} value={s}>{SOURCE_LABELS[s]}</option>
              ))}
            </select>
            <button
              type="button" onClick={() => { if (confirm("Clear the Ambient feed? This cannot be undone.")) void api.clearAmbientEvents().then(() => load()); }}
              className="text-cream-300/60 hover:text-coral-400 p-1.5 rounded hover:bg-ink-800"
              title="Clear feed" aria-label="Clear feed"
            >
              <Trash2 size={14} />
            </button>
          </div>
        }
      >
        {shown.length === 0 ? (
          <div className="text-center py-8 text-cream-300/60 text-sm">
            Nothing noticed yet. Leave the watcher on and live your life — failures, handoffs,
            reminders and triage mail will land here, and the loud ones will find you.
          </div>
        ) : (
          <div className="divide-y divide-ink-800">
            {shown.map(e => (
              <div key={e.id} className="py-3 first:pt-0 last:pb-0 flex items-start gap-3">
                <span className={`mt-0.5 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${SEV_STYLE[e.severity]}`}>
                  {e.severity}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="text-sm text-cream-100">{e.title}</div>
                  {e.detail && <div className="text-xs text-cream-300/60 mt-0.5 break-words">{e.detail}</div>}
                  <div className="text-[11px] text-cream-300/45 mt-1 flex flex-wrap items-center gap-x-2">
                    <span>{SOURCE_LABELS[e.source]}</span>
                    <span>·</span><span>{ago(e.at)}</span>
                    {e.notified.length > 0 && <><span>·</span><span>sent via {e.notified.join(", ")}</span></>}
                    {e.judgeNote && <><span>·</span><span className="font-mono">{e.judgeNote}</span></>}
                    {e.link?.jobId && <><span>·</span><Link to={`/runs/${e.link.jobId}`} className="text-violet-400 hover:text-violet-300">job →</Link></>}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
