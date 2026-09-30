import { useEffect, useState } from "react";
import { marked } from "marked";
import { api } from "../lib/api";
import { Card } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";

// Daily Reports — three tabs: Reflections (what ran), Innovation Scan
// (what's new in tech), and MD System Audit (Naxie's managing-director scan
// of every file / feature / page — what needs improving, what's dormant,
// what's useless). Same tab-toggle pattern used elsewhere (see MyWork.tsx).

type ReflectionMeta = { date: string; path: string; preview: string; stats?: any };

export function DailyReports() {
  const [tab, setTab] = useState<"reflections" | "innovation-scan" | "system-audit">("reflections");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-cream-100">Daily Reports</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          What your organization did each day, what Naxie is improving as MD, and what she is learning about the wider world.
        </p>
      </div>
      <div className="flex items-center gap-1 border-b border-ink-800 overflow-x-auto">
        {([["reflections", "Reflections"], ["innovation-scan", "Innovation Scan"], ["system-audit", "🏢 MD System Audit"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id as any)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors whitespace-nowrap ${
              tab === id ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "reflections" ? <ReflectionsTab /> : tab === "innovation-scan" ? <InnovationScanTab /> : <SystemAuditTab />}
    </div>
  );
}

function ReflectionsTab() {
  const [list, setList] = useState<ReflectionMeta[]>([]);
  const reportList = useLoadMore(list);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listReflections()
      .then(r => {
        setList(r.reflections);
        if (!selected && r.reflections.length > 0) setSelected(r.reflections[0].date);
      })
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!selected) return;
    setBody("");
    api.getReflection(selected)
      .then(r => setBody(r.body.replace(/^---[\s\S]*?---\n+/, "")))
      .catch(e => setBody(`_Couldn't load this report: ${String(e?.message ?? e)}_`));
  }, [selected]);

  const reflectNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runReflection(24);
      setSelected(r.date);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-cream-300/70">
          Successes, failures, and the lessons the system took from them.
        </p>
        <button
          onClick={reflectNow}
          disabled={running}
          className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {running ? "Reflecting…" : "Reflect now"}
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-2">
          {loading && <div className="text-sm text-cream-300/60">Loading reports…</div>}
          {!loading && list.length === 0 && (
            <Card title="No reports yet">
              <p className="text-sm text-cream-300/70">
                The nightly reflection runs at ~2 AM and writes its first report after a day of
                activity. Or press <span className="text-cream-100">Reflect now</span> to generate
                one for the last 24 hours.
              </p>
            </Card>
          )}
          {reportList.visible.map(r => (
            <button
              key={r.date}
              onClick={() => setSelected(r.date)}
              className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                selected === r.date
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-cream-100/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium text-cream-100">{r.date}</div>
              {r.stats?.totalTasks !== undefined && (
                <div className="text-xs text-cream-300/60 mt-0.5">
                  {r.stats.totalTasks} tasks · {r.stats.successRate !== undefined ? `${Math.round(Number(r.stats.successRate) * 100)}% success` : ""}
                </div>
              )}
              <div className="text-xs text-cream-300/50 mt-1 line-clamp-2">{r.preview}</div>
            </button>
          ))}
          <LoadMoreButton state={reportList} noun="reports" />
        </div>

        <div>
          {selected ? (
            <Card title={`Report — ${selected}`}>
              {body
                ? <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                : <div className="text-sm text-cream-300/60">Loading…</div>}
            </Card>
          ) : (
            !loading && list.length > 0 && <div className="text-sm text-cream-300/60">Pick a report on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function InnovationScanTab() {
  const [list, setList] = useState<ReflectionMeta[]>([]);
  const scanList = useLoadMore(list);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listInnovationScans()
      .then(r => {
        setList(r.scans);
        if (!selected && r.scans.length > 0) setSelected(r.scans[0].date);
      })
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!selected) return;
    setBody("");
    api.getInnovationScan(selected)
      .then(r => setBody(r.body.replace(/^---[\s\S]*?---\n+/, "")))
      .catch(e => setBody(`_Couldn't load this scan: ${String(e?.message ?? e)}_`));
  }, [selected]);

  const scanNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runInnovationScan();
      setSelected(r.date);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-cream-300/70">
          How we're fixing our own weak spots, and what's new and interesting in AI/tech.
        </p>
        <button
          onClick={scanNow}
          disabled={running}
          className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {running ? "Scanning…" : "Scan now"}
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-2">
          {loading && <div className="text-sm text-cream-300/60">Loading scans…</div>}
          {!loading && list.length === 0 && (
            <Card title="No scans yet">
              <p className="text-sm text-cream-300/70">
                The nightly innovation scan runs a few hours after reflection and writes its first
                digest once there's enough data to learn from. Or press{" "}
                <span className="text-cream-100">Scan now</span> to generate one immediately.
              </p>
            </Card>
          )}
          {scanList.visible.map(r => (
            <button
              key={r.date}
              onClick={() => setSelected(r.date)}
              className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                selected === r.date
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-cream-100/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium text-cream-100">{r.date}</div>
              {r.stats?.targetedCount !== undefined && (
                <div className="text-xs text-cream-300/60 mt-0.5">
                  {r.stats.targetedCount} weak spot{r.stats.targetedCount === "1" ? "" : "s"} · {r.stats.repoCount ?? 0} repos · {r.stats.newsCount ?? 0} news
                </div>
              )}
              <div className="text-xs text-cream-300/50 mt-1 line-clamp-2">{r.preview}</div>
            </button>
          ))}
          <LoadMoreButton state={scanList} noun="scans" />
        </div>

        <div>
          {selected ? (
            <Card title={`Scan — ${selected}`}>
              {body
                ? <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                : <div className="text-sm text-cream-300/60">Loading…</div>}
            </Card>
          ) : (
            !loading && list.length > 0 && <div className="text-sm text-cream-300/60">Pick a scan on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function HealthSparkline({ data }: { data: { date: string; healthScore: number }[] }) {
  if (!data.length) return <div className="text-xs text-cream-300/40">No history yet</div>;
  const max = 100, min = 0;
  const w = 200, h = 40;
  const points = data.map((d, i) => {
    const x = (i / Math.max(1, data.length - 1)) * w;
    const y = h - ((d.healthScore - min) / (max - min)) * h;
    return `${x},${y}`;
  }).join(" ");
  return (
    <div className="flex items-end gap-1">
      <svg width={w} height={h} className="bg-ink-900 rounded border border-ink-800">
        <polyline fill="none" stroke="#10b981" strokeWidth="1.5" points={points} />
        {data.map((d, i) => {
          const x = (i / Math.max(1, data.length - 1)) * w;
          const y = h - ((d.healthScore - min) / (max - min)) * h;
          return <circle key={d.date} cx={x} cy={y} r={2} fill={d.healthScore >= 80 ? "#10b981" : d.healthScore >= 60 ? "#f59e0b" : "#ef4444"} />;
        })}
      </svg>
      <div className="text-[10px] text-cream-300/50 ml-1">{data[0]?.date} → {data[data.length - 1]?.date}<br />{data[data.length - 1]?.healthScore}/100 now</div>
    </div>
  );
}

function SystemAuditTab() {
  const [list, setList] = useState<ReflectionMeta[]>([]);
  const auditList = useLoadMore(list);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [trend, setTrend] = useState<{ date: string; healthScore: number }[]>([]);
  const [blocked, setBlocked] = useState<any[]>([]);
  const [hygiene, setHygiene] = useState<any>(null);
  const [deadCode, setDeadCode] = useState<any[]>([]);
  const [merges, setMerges] = useState<any[]>([]);
  const [intHealth, setIntHealth] = useState<any[]>([]);
  const [voiceRunning, setVoiceRunning] = useState(false);

  const load = () => {
    setLoading(true);
    api.listSystemAudits()
      .then(r => {
        setList(r.audits);
        if (!selected && r.audits.length > 0) setSelected(r.audits[0].date);
      })
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
    api.systemAuditHealthTrend().then(r => setTrend(r.trend)).catch(() => {});
    api.orgTasks({ status: "blocked" as any }).then(r => setBlocked((r.tasks ?? []).slice(0, 5))).catch(() => {});
    api.systemAuditVaultHygiene().then(setHygiene).catch(() => {});
    api.systemAuditDeadCode().then(r => setDeadCode(r.deadCode ?? [])).catch(() => {});
    api.systemAuditPersonaMerges().then(r => setMerges(r.merges ?? [])).catch(() => {});
    api.systemAuditIntegrationHealth().then(r => setIntHealth(r.health ?? [])).catch(() => {});
  };
  useEffect(load, []);

  useEffect(() => {
    if (!selected) return;
    setBody("");
    api.getSystemAudit(selected)
      .then(r => setBody(r.body.replace(/^---[\s\S]*?---\n+/, "")))
      .catch(e => setBody(`_Couldn't load this audit: ${String(e?.message ?? e)}_`));
  }, [selected]);

  const auditNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runSystemAudit();
      setSelected(r.date);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };
  const voiceNow = async () => {
    setVoiceRunning(true);
    try { await api.systemAuditVoiceBriefing(); } catch (e: any) { setError(String(e?.message ?? e)); } finally { setVoiceRunning(false); }
  };
  const architectPr = async (finding: string) => {
    try { await api.systemAuditArchitectPr(finding); } catch (e: any) { setError(String(e?.message ?? e)); }
  };
  const resolveBlocked = async (id: string, approved: boolean) => {
    try { await api.resolveOrgTaskApproval(id, approved); load(); } catch (e: any) { setError(String(e?.message ?? e)); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-cream-300/70">
          Naxie as Managing Director — every file, feature & page, scanned daily. What needs improving, what's dormant, what's useless.
        </p>
        <div className="flex gap-2 shrink-0">
          <button onClick={voiceNow} disabled={voiceRunning} className="rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-3 py-2 text-xs font-medium text-white">{voiceRunning ? "Briefing…" : "🎙️ Voice briefing"}</button>
          <button onClick={auditNow} disabled={running} className="rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white">{running ? "Auditing…" : "Run MD Audit now"}</button>
        </div>
      </div>
      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
        <Card title="Health trend (30d)"><HealthSparkline data={trend} /></Card>
        <Card title="Vault hygiene">{hygiene ? <div className="text-xs space-y-1 text-cream-300/70"><div>{hygiene.totalNotes} notes · {hygiene.duplicates?.length ?? 0} dup groups · {hygiene.staleNotes?.length ?? 0} stale &gt;180d</div>{hygiene.duplicates?.slice(0, 2).map((d: any) => <div key={d.hash} className="truncate">{d.hash}: {d.files.slice(0, 2).join(", ")}</div>)}</div> : <div className="text-xs text-cream-300/40">Loading…</div>}</Card>
        <Card title="Integrations">{intHealth.length ? <div className="space-y-1">{intHealth.slice(0, 3).map((h: any) => <div key={h.id} className={`text-xs ${h.ok ? "text-emerald-300" : "text-red-300"}`}>{h.ok ? "✓" : "✗"} {h.label} — {h.detail.slice(0, 60)}</div>)}</div> : <div className="text-xs text-cream-300/40">No integrations / all healthy</div>}</Card>
      </div>

      {(blocked.length > 0 || deadCode.length > 0 || merges.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          {blocked.length > 0 && (
            <Card title={`Blocked triage (${blocked.length})`}>
              <div className="space-y-2">
                {blocked.map((t: any) => (
                  <div key={t.id} className="flex items-center justify-between gap-2 text-xs">
                    <span className="truncate text-cream-200">{t.title.slice(0, 40)}</span>
                    <span className="flex gap-1 shrink-0">
                      <button onClick={() => resolveBlocked(t.id, true)} className="px-2 py-1 rounded bg-emerald-600 text-white">Resolve</button>
                      <button onClick={() => resolveBlocked(t.id, false)} className="px-2 py-1 rounded bg-ink-700 text-cream-300">Archive</button>
                    </span>
                  </div>
                ))}
              </div>
            </Card>
          )}
          {deadCode.length > 0 && (
            <Card title={`Dead-code (${deadCode.length})`}>
              <div className="text-xs text-cream-300/70 space-y-1">
                {deadCode.slice(0, 4).map((d: any) => <div key={d.file} className="truncate">{d.file} — {d.reason.slice(0, 50)}</div>)}
                <button onClick={() => architectPr(`dead-code: ${deadCode[0]?.file}`)} className="text-violet-300 hover:text-violet-200 text-[11px]">→ Architect PR for top hit</button>
              </div>
            </Card>
          )}
          {merges.length > 0 && (
            <Card title={`Persona merges (${merges.length})`}>
              <div className="text-xs text-cream-300/70 space-y-1">
                {merges.slice(0, 3).map((m: any) => <div key={m.a + m.b}>{m.a} ↔ {m.b} — {Math.round(m.similarity * 100)}%</div>)}
                <button onClick={() => architectPr(`persona-merge: ${merges[0]?.a} + ${merges[0]?.b}`)} className="text-violet-300 hover:text-violet-200 text-[11px]">→ Architect PR to merge top pair</button>
              </div>
            </Card>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-2">
          {loading && <div className="text-sm text-cream-300/60">Loading audits…</div>}
          {!loading && list.length === 0 && (
            <Card title="No MD audits yet">
              <p className="text-sm text-cream-300/70">
                The MD system audit runs daily at ~7 AM and writes its first report after the next cycle.
                Or press <span className="text-cream-100">Run MD Audit now</span> to generate one immediately.
              </p>
            </Card>
          )}
          {auditList.visible.map(r => (
            <button
              key={r.date}
              onClick={() => setSelected(r.date)}
              className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                selected === r.date
                  ? "border-emerald-500/60 bg-emerald-500/10"
                  : "border-cream-100/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium text-cream-100">{r.date}</div>
              {r.stats?.healthScore !== undefined && (
                <div className="text-xs mt-0.5">
                  <span className={`px-1.5 py-0.5 rounded text-[11px] font-medium ${
                    Number(r.stats.healthScore) >= 80 ? "bg-emerald-500/20 text-emerald-300" :
                    Number(r.stats.healthScore) >= 60 ? "bg-amber-500/20 text-amber-300" :
                    "bg-red-500/20 text-red-300"
                  }`}>{r.stats.healthScore}/100</span>
                  <span className="text-cream-300/60 ml-2">{r.stats.dormantCount ?? 0} dormant · {r.stats.uselessCount ?? 0} useless</span>
                </div>
              )}
              <div className="text-xs text-cream-300/50 mt-1 line-clamp-2">{r.preview}</div>
            </button>
          ))}
          <LoadMoreButton state={auditList} noun="audits" />
        </div>

        <div>
          {selected ? (
            <Card title={`MD Audit — ${selected}`}>
              {body
                ? <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                : <div className="text-sm text-cream-300/60">Loading…</div>}
            </Card>
          ) : (
            !loading && list.length > 0 && <div className="text-sm text-cream-300/60">Pick an audit on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}
