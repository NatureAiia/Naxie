import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Calendar, Play, Pause, Trash2, Plus, AlertTriangle, ArrowRight, Brain, CalendarPlus, Download, Volume2, Pencil, ChevronDown, Zap } from "lucide-react";
import { ReadAloud } from "../components/ReadAloud";
import { api, type Schedule, type ScheduleRun, type Template, type WeeklyImprovementStatus } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { DAY_LABELS, formatNext, formatCadence } from "../lib/scheduleFormat";
import { DaemonLoopToggles } from "../components/DaemonLoopToggles";
import { useVisibleInterval } from "../lib/useVisibleInterval";

// One-line plain-text excerpt of what a schedule actually runs. Ad-hoc
// (general-task) schedules otherwise render as the unhelpful
// "Runs Anything else (ad-hoc task)" with no hint of the real task.
function taskExcerpt(s: Schedule, maxLen = 140): string {
  const raw = s.templateId === "general-task" ? String((s.inputs as any)?.task ?? "") : "";
  const s2 = raw
    .replace(/\[(.*?)\]\(.*?\)/g, "$1")
    .replace(/[*_`~#]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s2) return "";
  if (s2.length <= maxLen) return s2;
  const cut = s2.slice(0, maxLen);
  const sp = cut.lastIndexOf(" ");
  return (sp > maxLen * 0.5 ? cut.slice(0, sp) : cut).trimEnd() + "…";
}

export function Schedules() {
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [err, setErr] = useState("");
  const [showCreate, setShowCreate] = useState(false);

  async function load() {
    try {
      const [s, t] = await Promise.all([api.listSchedules(), api.listTemplates({ includeHidden: true })]);
      setSchedules(s.schedules);
      setTemplates(t.templates);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    }
  }
  useVisibleInterval(load, 15000);

  async function togglePause(s: Schedule) {
    try { await api.updateSchedule(s.id, { enabled: !s.enabled }); await load(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function runNow(s: Schedule) {
    try {
      const r = await api.fireScheduleNow(s.id);
      showToast(`Fired "${s.name}" — job ${r.jobId.slice(0, 8)} running`, "success", 4000);
      await load();
    } catch (e: any) { setErr(e?.message ?? String(e)); }
  }
  async function remove(s: Schedule) {
    if (!confirm(`Delete schedule "${s.name}"? This cannot be undone.`)) return;
    try { await api.deleteSchedule(s.id); await load(); }
    catch (e: any) { setErr(e?.message ?? String(e)); }
  }

  return (
    <div className="space-y-5">
      <div className="flex items-baseline justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-cream-50">Schedules</h1>
          <p className="text-sm text-cream-300/70 mt-1">Recurring agent work runs on the cadence you choose. Manage automations here; use Planner for your personal tasks and calendar.</p>
        </div>
        <Button onClick={() => setShowCreate(o => !o)} variant={showCreate ? "subtle" : "primary"}>
          <span className="inline-flex items-center gap-1.5"><Plus size={14} /> {showCreate ? "Cancel" : "New schedule"}</span>
        </Button>
      </div>

      {err && (
        <div className="bg-coral-500/10 border border-coral-500/30 text-coral-300 text-sm rounded-md px-3 py-2 flex items-center gap-2">
          <AlertTriangle size={14} /> {err}
        </div>
      )}

      {showCreate && (
        <CreateScheduleForm
          templates={templates}
          schedules={schedules}
          onCreated={async () => { setShowCreate(false); await load(); }}
          onError={setErr}
        />
      )}

      <DailyRhythmCard schedules={schedules} />

      <WeeklyReflectCard />

      <Card title="Background loops">
        <p className="text-sm text-cream-300/60 mb-3">
          Turn off individual pieces of Naxie's org-daemon cycle without touching the others.
        </p>
        <DaemonLoopToggles />
      </Card>

      <Card title={`Active schedules (${schedules.length})`}>
        {schedules.length === 0 ? (
          <p className="text-sm text-cream-300/60">
            No schedules yet. Click <span className="text-cream-100">New schedule</span> above to set one up.
          </p>
        ) : (
          <div className="divide-y divide-ink-800">
            {schedules.map(s => (
              <ScheduleRow
                key={s.id}
                s={s}
                tpl={templates.find(t => t.id === s.templateId)}
                onChanged={load}
                onError={setErr}
                onRunNow={() => runNow(s)}
                onTogglePause={() => togglePause(s)}
                onRemove={() => remove(s)}
              />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ── One schedule row: view + inline edit + run history ─────────────────────
function ScheduleRow({ s, tpl, onChanged, onError, onRunNow, onTogglePause, onRemove }: {
  s: Schedule;
  tpl: Template | undefined;
  onChanged: () => Promise<void>;
  onError: (msg: string) => void;
  onRunNow: () => void;
  onTogglePause: () => void;
  onRemove: () => void;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(s.name);
  const [task, setTask] = useState(String((s.inputs as any)?.task ?? ""));
  const [voiceNote, setVoiceNote] = useState(s.deliver?.voiceNote === true);
  const [saving, setSaving] = useState(false);
  const [showRuns, setShowRuns] = useState(false);
  const [runs, setRuns] = useState<ScheduleRun[] | null>(null);
  const excerpt = taskExcerpt(s);
  const isAdHoc = s.templateId === "general-task";

  async function save() {
    if (!name.trim()) { onError("Name can't be blank."); return; }
    setSaving(true);
    try {
      const voiceDeliver = { ...(s.deliver ?? {}), ...(voiceNote ? { voiceNote: true as const } : {}) };
      if (!voiceNote) delete (voiceDeliver as any).voiceNote;
      await api.updateSchedule(s.id, {
        name: name.trim(),
        ...(isAdHoc ? { inputs: { ...(s.inputs as any), task } } : {}),
        deliver: Object.keys(voiceDeliver).length ? voiceDeliver : undefined as any,
      });
      setEditing(false);
      await onChanged();
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  async function toggleRuns() {
    const next = !showRuns;
    setShowRuns(next);
    if (next && runs === null) {
      try {
        const r = await api.getScheduleRuns(s.id);
        setRuns(r.runs);
      } catch (e: any) {
        onError(e?.message ?? String(e));
        setShowRuns(false);
      }
    }
  }

  return (
    <div className="py-4 first:pt-0 last:pb-0">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          {editing ? (
            <div className="space-y-2">
              <input
                type="text"
                value={name}
                onChange={e => setName(e.target.value)}
                className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-2 py-1 text-sm focus:outline-none"
                aria-label="Schedule name"
              />
              {isAdHoc && (
                <textarea
                  value={task}
                  onChange={e => setTask(e.target.value)}
                  rows={3}
                  className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-2 py-1 text-xs focus:outline-none"
                  aria-label="Task text"
                />
              )}
              <label className="flex items-center gap-2 text-[11px] text-cream-300/70 cursor-pointer">
                <input type="checkbox" checked={voiceNote} onChange={e => setVoiceNote(e.target.checked)} />
                Also send each run as a voice note (read-aloud)
              </label>
              <div className="flex items-center gap-2">
                <Button onClick={save} disabled={saving}>{saving ? "Saving…" : "Save"}</Button>
                <Button variant="ghost" onClick={() => { setEditing(false); setName(s.name); setTask(String((s.inputs as any)?.task ?? "")); }}>Cancel</Button>
              </div>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Calendar size={14} className={s.enabled ? "text-violet-400" : "text-cream-300/40"} />
                <span className="text-sm text-cream-50 font-medium truncate" title={s.name}>{s.name}</span>
                {!s.enabled && <span className="text-[10px] uppercase tracking-wider text-cream-300/50 bg-ink-850 border border-ink-700 rounded px-1.5 py-0.5">paused</span>}
                {s.deliver?.voiceNote && <span className="text-[10px] text-violet-300/80 bg-violet-500/10 rounded px-1.5 py-0.5" title="Each run is also sent as a voice note">voice</span>}
              </div>
              <div className="text-[11px] text-cream-300/70 flex flex-wrap items-center gap-x-3 gap-y-1">
                <span>{formatCadence(s.cadence)}</span>
                <span className="text-cream-300/40">·</span>
                <span title={excerpt || undefined}>Runs <span className="text-cream-100">{tpl?.title ?? s.templateId}</span>{excerpt && <span className="text-cream-300/70"> — “{excerpt}”</span>}</span>
                <span className="text-cream-300/40">·</span>
                <span>Telegram <span className="text-cream-100">{String(s.deliver?.telegramChatId ?? "default group/chat")}</span></span>
                <span className="text-cream-300/40">·</span>
                <span>Next: <span className="text-cream-100">{s.enabled ? formatNext(s.nextFireAt) : "paused"}</span></span>
                {s.fireCount > 0 && (
                  <><span className="text-cream-300/40">·</span>
                    <button type="button" onClick={() => void toggleRuns()} className="inline-flex items-center gap-0.5 hover:text-cream-100" title={showRuns ? "Hide run history" : "Show run history"}>
                      {s.fireCount} fire{s.fireCount === 1 ? "" : "s"} <ChevronDown size={11} className={showRuns ? "rotate-180" : ""} />
                    </button>
                  </>
                )}
              </div>
              {s.lastFiredAt && (
                <div className="text-[10px] text-cream-300/50 mt-1">
                  Last fired {new Date(s.lastFiredAt).toLocaleString()}
                  {s.lastJobId && (
                    <> · <Link to={`/tasks?focus=${s.lastJobId}`} className="text-violet-400 hover:text-violet-500">
                      job {s.lastJobId.slice(0, 8)} <ArrowRight size={10} className="inline" />
                    </Link></>
                  )}
                </div>
              )}
              {s.lastError && (
                <div className="text-[10px] text-coral-400 mt-1 flex items-start gap-1">
                  <AlertTriangle size={11} className="mt-0.5" /> Last fire failed: {s.lastError}
                </div>
              )}
              {showRuns && (
                <div className="mt-2 bg-ink-950 border border-ink-800 rounded-md px-3 py-2">
                  {runs === null ? (
                    <p className="text-[11px] text-cream-300/50">Loading runs…</p>
                  ) : runs.length === 0 ? (
                    <p className="text-[11px] text-cream-300/50">No recorded runs yet.</p>
                  ) : (
                    <ul className="divide-y divide-ink-800">
                      {runs.map(r => (
                        <li key={r.id} className="py-1.5 first:pt-0 last:pb-0 flex items-center justify-between gap-2 text-[11px]">
                          <span className="text-cream-200 truncate flex-1" title={r.title}>{r.title}</span>
                          <span className={r.status === "succeeded" ? "text-emerald-400" : r.status === "failed" || r.status === "rejected" ? "text-coral-400" : "text-cream-300/60"}>{r.status}</span>
                          <span className="text-cream-300/40 shrink-0">{new Date(r.startedAt).toLocaleString()}</span>
                          <Link to={`/tasks?focus=${r.id}`} className="text-violet-400 hover:text-violet-500 shrink-0">job {r.id.slice(0, 8)}</Link>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </>
          )}
        </div>
        {!editing && (
          <div className="flex items-center gap-1.5 shrink-0">
            <button
              type="button"
              onClick={onRunNow}
              className="text-cream-300/70 hover:text-cream-100 p-1.5 rounded hover:bg-ink-800"
              title="Run now (fires immediately, cadence unchanged)"
              aria-label="Run schedule now"
            >
              <Zap size={14} />
            </button>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="text-cream-300/70 hover:text-cream-100 p-1.5 rounded hover:bg-ink-800"
              title="Edit name and task"
              aria-label="Edit schedule"
            >
              <Pencil size={14} />
            </button>
            <a
              href={`/api/calendar/${encodeURIComponent(s.id)}/google`}
              target="_blank"
              rel="noreferrer"
              className="text-cream-300/70 hover:text-cream-100 p-1.5 rounded hover:bg-ink-800"
              title="Add next run to Google Calendar"
              aria-label="Add next run to Google Calendar"
            >
              <CalendarPlus size={14} />
            </a>
            <button
              type="button"
              onClick={onTogglePause}
              className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800"
              title={s.enabled ? "Pause schedule" : "Resume schedule"}
              aria-label={s.enabled ? "Pause schedule" : "Resume schedule"}
            >
              {s.enabled ? <Pause size={14} /> : <Play size={14} />}
            </button>
            <button
              type="button"
              onClick={onRemove}
              className="text-cream-300/70 hover:text-coral-400 p-1.5 rounded hover:bg-ink-800"
              title="Delete schedule"
              aria-label="Delete schedule"
            >
              <Trash2 size={14} />
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ── Daily Rhythm ──────────────────────────────────────────────────────────
// Naxie's actual daily cadence splits into two invisible systems: 4 hardwired
// background daemons (todo-brief/innovation-scan/weekly-rollup/reflection —
// setInterval ticks with no other HTTP surface) and user Schedules below.
// This unifies both into one list + a 24h tick strip so "what ran today"
// doesn't require checking four different places.
type RhythmRow = {
  id: string;
  name: string;
  kind: "system" | "custom";
  nextFireAt: number | null;
  lastLabel: string;
  error?: string;
  excerpt?: string;
};

function DailyRhythmCard({ schedules }: { schedules: Schedule[] }) {
  const [rows, setRows] = useState<RhythmRow[] | null>(null);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      const [refl, scan, todo, rollup, improve] = await Promise.all([
        api.listReflections().catch(() => null),
        api.listInnovationScans().catch(() => null),
        api.getTodoBriefStatus().catch(() => null),
        api.getWeeklyRollupStatus().catch(() => null),
        api.getWeeklyImprovementStatus().catch(() => null),
      ]);
      if (cancelled) return;
      const daemons: RhythmRow[] = [
        { id: "reflection", name: "Reflection journal", kind: "system", nextFireAt: refl?.nextFireAt ?? null, lastLabel: refl?.last?.date ? `Last ${refl.last.date}` : "Never run yet" },
        { id: "innovation-scan", name: "Innovation scan", kind: "system", nextFireAt: scan?.nextFireAt ?? null, lastLabel: scan?.last?.date ? `Last ${scan.last.date}` : "Never run yet" },
        { id: "todo-brief", name: "Todo brief", kind: "system", nextFireAt: todo?.nextFireAt ?? null, lastLabel: todo?.last?.date ? `Last ${todo.last.date}` : "Never run yet" },
        { id: "weekly-rollup", name: "Weekly rollup", kind: "system", nextFireAt: rollup?.nextFireAt ?? null, lastLabel: rollup?.last?.date ? `Last ${rollup.last.date}` : "Never run yet" },
        { id: "weekly-improvement", name: "Weekly Reflect (self-improvement)", kind: "system", nextFireAt: improve?.nextFireAt ?? null, lastLabel: improve?.last?.date ? `Last ${improve.last.date}` : "Never run yet" },
      ];
      setRows(daemons);
    }
    load();
    return () => { cancelled = true; };
  }, []);

  const customRows: RhythmRow[] = schedules.filter(s => s.enabled).map(s => ({
    id: s.id,
    name: s.name,
    kind: "custom",
    nextFireAt: s.nextFireAt ?? null,
    lastLabel: s.lastFiredAt ? `Last ${new Date(s.lastFiredAt).toLocaleDateString()}` : "Never fired yet",
    error: s.lastError,
    excerpt: taskExcerpt(s, 100),
  }));

  const all = [...(rows ?? []), ...customRows];
  const tickHours = new Map<number, RhythmRow[]>();
  for (const r of all) {
    if (!r.nextFireAt) continue;
    const h = new Date(r.nextFireAt).getHours();
    if (!tickHours.has(h)) tickHours.set(h, []);
    tickHours.get(h)!.push(r);
  }

  return (
    <Card
      title="Daily Rhythm"
      action={
        <a
          href="/api/calendar/export.ics"
          className="flex items-center gap-1.5 text-xs text-cream-300/70 hover:text-cream-100"
          title="Download today's agenda as a calendar file"
        >
          <Download size={12} /> Download .ics
        </a>
      }
    >
      <p className="text-xs text-cream-300/60 -mt-2 mb-3">
        System digests and custom schedule results go to the configured Telegram group or default chat. Custom schedules can override their destination above.
      </p>

      <div className="flex items-end gap-px mb-4" role="img" aria-label="24-hour cadence strip">
        {Array.from({ length: 24 }, (_, h) => {
          const hits = tickHours.get(h) ?? [];
          const hasError = hits.some(r => r.error);
          return (
            <div key={h} className="flex-1 flex flex-col items-center gap-1" title={hits.length ? `${h}:00 — ${hits.map(r => r.name).join(", ")}` : `${h}:00`}>
              <div className={`w-1.5 h-1.5 rounded-full ${hasError ? "bg-coral-400" : hits.length ? "bg-violet-400" : "bg-ink-800"}`} />
              {h % 6 === 0 && <span className="text-[9px] text-cream-300/40">{h}</span>}
            </div>
          );
        })}
      </div>

      {rows === null ? (
        <p className="text-xs text-cream-300/60">Loading daily rhythm…</p>
      ) : (
        <div className="divide-y divide-ink-800">
          {all.map(r => (
            <div key={r.id} className="py-2.5 first:pt-0 last:pb-0 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-cream-100 truncate" title={r.name}>{r.name}</span>
                  <span className={`text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full shrink-0 ${r.kind === "system" ? "bg-ink-850 border border-ink-700 text-cream-300/60" : "bg-violet-500/15 text-violet-300"}`}>
                    {r.kind === "system" ? "System" : "Custom"}
                  </span>
                </div>
                <div className="text-[11px] text-cream-300/60 mt-0.5">{r.lastLabel}{r.excerpt ? ` — “${r.excerpt}”` : ""}</div>
                {r.error && (
                  <div className="text-[10px] text-coral-400 mt-0.5 flex items-start gap-1">
                    <AlertTriangle size={10} className="mt-0.5" /> {r.error}
                  </div>
                )}
              </div>
              <div className="text-[11px] text-cream-300/70 shrink-0">Next: {formatNext(r.nextFireAt)}</div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

// ── Weekly Reflect ────────────────────────────────────────────────────────
// Naxie's weekly self-improvement review (server lib/weekly-improvement.ts):
// looks at the whole week and proposes schedules, code changes, MCP servers,
// CLI tools, skills and retrieval fixes — each one an approval card.
function WeeklyReflectCard() {
  const [status, setStatus] = useState<WeeklyImprovementStatus | null>(null);
  const [running, setRunning] = useState(false);
  const [reading, setReading] = useState<{ title: string; markdown: string } | null>(null);

  async function openReadAloud() {
    if (!status?.last) return;
    try {
      const r = await api.getWeeklyImprovementNote(status.last.date);
      setReading({ title: `Weekly Reflect — ${status.last.date}`, markdown: r.markdown });
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function load() {
    try { setStatus(await api.getWeeklyImprovementStatus()); } catch { /* leave as-is */ }
  }
  useEffect(() => { load(); }, []);

  async function runNow() {
    setRunning(true);
    try {
      const r = await api.runWeeklyImprovement();
      showToast(r.taskIds.length ? `${r.taskIds.length} new proposal(s) waiting in Agent Approvals` : "Review written — no new proposals", "success", 4000);
      await load();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setRunning(false);
    }
  }

  const last = status?.last;
  return (
    <Card title="Weekly Reflect">
      <div className="flex items-start justify-between gap-3">
        <p className="text-xs text-cream-300/60 -mt-2 mb-3 flex-1">
          Every week Naxie reviews her own work — reflections, failures, retrieval health, schedules and tools — and proposes
          what she should have next: schedules, code improvements, MCP servers, CLI tools, skills. Each proposal includes how
          we'd build it and waits for your approval.
        </p>
        <Button variant="subtle" onClick={() => void runNow()} disabled={running}>
          <span className="flex items-center gap-1.5"><Brain size={14} />{running ? "Reflecting…" : "Run now"}</span>
        </Button>
      </div>
      <div className="text-[11px] text-cream-300/70 flex flex-wrap gap-x-3 gap-y-1 mb-2">
        <span>Next: <span className="text-cream-100">{formatNext(status?.nextFireAt ?? null)}</span></span>
        {last && <><span className="text-cream-300/40">·</span><span>Last: <span className="text-cream-100">{last.date}</span>{last.modelUsed ? ` via ${last.modelUsed}` : ""}</span></>}
        {last && <><span className="text-cream-300/40">·</span><span className="font-mono text-cream-300/60">{last.path}</span></>}
      </div>
      {last?.parseFailed && (
        <div className="text-[11px] text-coral-400 mb-2 flex items-start gap-1">
          <AlertTriangle size={11} className="mt-0.5" /> The model's last answer couldn't be parsed — only stats and retrieval checks were filed.
        </div>
      )}
      {last && last.proposals.length > 0 ? (
        <ul className="divide-y divide-ink-800">
          {last.proposals.map((p, i) => (
            <li key={i} className="py-2 first:pt-0 last:pb-0 flex items-center gap-2 text-sm">
              <span className="text-[9px] uppercase tracking-wider px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300 shrink-0">{p.kind}</span>
              <span className="text-cream-100 truncate flex-1">{p.title}</span>
              <span className="text-[10px] text-cream-300/50 shrink-0">effort {p.effort}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-cream-300/60">{last ? "No proposals last run." : "Hasn't run yet — it fires Sundays after the weekly rollup, or click Run now."}</p>
      )}
      <div className="mt-3 flex items-center gap-4">
        {last && last.taskIds.length > 0 && (
          <Link to="/my-work" className="inline-flex items-center gap-1 text-xs text-violet-400 hover:text-violet-500">
            Review proposals <ArrowRight size={11} />
          </Link>
        )}
        {last && (
          <button type="button" onClick={() => void openReadAloud()} className="inline-flex items-center gap-1 text-xs text-cream-300/70 hover:text-cream-100">
            <Volume2 size={12} /> Read aloud
          </button>
        )}
      </div>
      {reading && <ReadAloud open onClose={() => setReading(null)} title={reading.title} markdown={reading.markdown} />}
    </Card>
  );
}

function CreateScheduleForm({ templates, schedules, onCreated, onError }: {
  templates: Template[];
  schedules: Schedule[];
  onCreated: () => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [name, setName] = useState("");
  const [templateId, setTemplateId] = useState("");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [submitting, setSubmitting] = useState(false);
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [deliverEmail, setDeliverEmail] = useState("");
  const [telegramChatId, setTelegramChatId] = useState("");
  const [voiceNote, setVoiceNote] = useState(false);
  const [chainTo, setChainTo] = useState<string[]>([]);

  const tpl = useMemo(() => templates.find(t => t.id === templateId), [templates, templateId]);

  function toggleDay(d: number) {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((a, b) => a - b));
  }

  function toggleChain(id: string) {
    setChainTo(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  }

  async function submit() {
    if (!name.trim() || !templateId) { onError("Name and template are required."); return; }
    setSubmitting(true);
    try {
      // Coerce inputs by declared type.
      const coerced: Record<string, unknown> = {};
      for (const i of tpl?.inputs ?? []) {
        const v = inputs[i.name];
        if (v === undefined || v === "") continue;
        if (i.type === "number") coerced[i.name] = Number(v);
        else if (i.type === "boolean") coerced[i.name] = v === "true";
        else coerced[i.name] = v;
      }
      await api.createSchedule({
        name: name.trim(),
        templateId,
        inputs: coerced,
        cadence: { daysOfWeek: days, hour, minute },
        enabled: true,
        ...((deliverEmail.trim() || telegramChatId.trim() || voiceNote) ? { deliver: { ...(deliverEmail.trim() ? { email: deliverEmail.trim() } : {}), ...(telegramChatId.trim() ? { telegramChatId: telegramChatId.trim() } : {}), ...(voiceNote ? { voiceNote: true as const } : {}) } } : {}),
        ...(chainTo.length ? { chainTo } : {}),
      });
      await onCreated();
      setName(""); setTemplateId(""); setInputs({}); setDeliverEmail(""); setTelegramChatId(""); setVoiceNote(false); setChainTo([]);
    } catch (e: any) {
      onError(e?.message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card title="Create a new schedule">
      <div className="space-y-4">
        <div>
          <label htmlFor="sched-name" className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Name</label>
          <input
            id="sched-name"
            type="text"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="e.g. Weekly project digest"
            className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-2 text-sm focus:outline-none placeholder:text-cream-300/40"
          />
        </div>

        <div>
          <label htmlFor="sched-template" className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Template to run</label>
          <select
            id="sched-template"
            value={templateId}
            onChange={e => { setTemplateId(e.target.value); setInputs({}); }}
            className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-2 text-sm focus:outline-none cursor-pointer"
          >
            <option value="">Pick a template...</option>
            {templates.map(t => (
              <option key={t.id} value={t.id}>{t.title} ({t.role})</option>
            ))}
          </select>
          {tpl && <div className="text-[11px] text-cream-300/60 mt-1">{tpl.description}</div>}
        </div>

        {tpl && tpl.inputs.length > 0 && (
          <div className="space-y-2 bg-ink-950 border border-ink-800 rounded-md p-3">
            <div className="text-[10px] uppercase tracking-wider text-cream-300/50">Template inputs</div>
            {tpl.inputs.map(input => (
              <div key={input.name}>
                <label htmlFor={`input-${input.name}`} className="block text-[11px] text-cream-200 mb-1">
                  {input.label}{input.required && <span className="text-coral-400 ml-1">*</span>}
                </label>
                {input.type === "boolean" ? (
                  <select
                    id={`input-${input.name}`}
                    value={inputs[input.name] ?? String(input.default ?? "false")}
                    onChange={e => setInputs(p => ({ ...p, [input.name]: e.target.value }))}
                    className="w-full bg-ink-900 border border-ink-800 focus:border-violet-500/60 rounded px-2 py-1 text-xs"
                  >
                    <option value="false">No</option>
                    <option value="true">Yes</option>
                  </select>
                ) : (
                  <input
                    id={`input-${input.name}`}
                    type={input.type === "number" ? "number" : "text"}
                    value={inputs[input.name] ?? (input.default !== undefined ? String(input.default) : "")}
                    onChange={e => setInputs(p => ({ ...p, [input.name]: e.target.value }))}
                    placeholder={(input as any).placeholder ?? ""}
                    className="w-full bg-ink-900 border border-ink-800 focus:border-violet-500/60 rounded px-2 py-1 text-xs"
                  />
                )}
              </div>
            ))}
          </div>
        )}

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Days to run</label>
          <div className="flex flex-wrap gap-1">
            {DAY_LABELS.map((d, i) => (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(i)}
                className={`text-xs px-3 py-1.5 rounded border ${days.includes(i) ? "bg-violet-500/15 border-violet-500/40 text-violet-200" : "bg-ink-950 border-ink-800 text-cream-300 hover:border-ink-700"}`}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="flex items-center gap-1 mt-1.5">
            <button type="button" onClick={() => setDays([1, 2, 3, 4, 5])} className="text-[10px] text-violet-400 hover:text-violet-500">Weekdays</button>
            <span className="text-cream-300/30">·</span>
            <button type="button" onClick={() => setDays([0, 6])} className="text-[10px] text-violet-400 hover:text-violet-500">Weekends</button>
            <span className="text-cream-300/30">·</span>
            <button type="button" onClick={() => setDays([0, 1, 2, 3, 4, 5, 6])} className="text-[10px] text-violet-400 hover:text-violet-500">Every day</button>
          </div>
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Time of day (server local)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              value={hour}
              onChange={e => setHour(Math.max(0, Math.min(23, Number(e.target.value))))}
              min={0}
              max={23}
              className="w-16 bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded px-2 py-1.5 text-sm text-center"
              aria-label="Hour (0-23)"
            />
            <span className="text-cream-300">:</span>
            <input
              type="number"
              value={minute}
              onChange={e => setMinute(Math.max(0, Math.min(59, Number(e.target.value))))}
              min={0}
              max={59}
              className="w-16 bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded px-2 py-1.5 text-sm text-center"
              aria-label="Minute (0-59)"
            />
            <span className="text-[11px] text-cream-300/50 ml-2">24-hour clock</span>
          </div>
        </div>

        <div>
          <label htmlFor="sched-telegram" className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Telegram destination override (optional)</label>
          <input
            id="sched-telegram"
            type="text"
            value={telegramChatId}
            onChange={e => setTelegramChatId(e.target.value)}
            placeholder="Leave blank for configured group/default chat"
            className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-2 text-sm focus:outline-none placeholder:text-cream-300/40"
          />
          <p className="text-[11px] text-cream-300/50 mt-1">Use a numeric user/group ID (group IDs commonly start with -100) or a public @channel username. The bot must be allowed to post there.</p>
        </div>

        <div>
          <label htmlFor="sched-email" className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Email the result to (optional)</label>
          <input
            id="sched-email"
            type="email"
            value={deliverEmail}
            onChange={e => setDeliverEmail(e.target.value)}
            placeholder="you@example.com — leave blank to keep results on the Tasks page"
            className="w-full bg-ink-950 border border-ink-800 focus:border-violet-500/60 rounded-md px-3 py-2 text-sm focus:outline-none placeholder:text-cream-300/40"
          />
          <p className="text-[11px] text-cream-300/50 mt-1">When set, the finished result is emailed to this address the moment the job completes (needs the email bridge configured).</p>
        </div>

        <div>
          <label className="flex items-center gap-2 text-xs text-cream-200 cursor-pointer">
            <input type="checkbox" checked={voiceNote} onChange={e => setVoiceNote(e.target.checked)} />
            Also send each run as a voice note (Naxie reads it aloud on Telegram)
          </label>
        </div>

        {schedules.length > 0 && (
          <div>
            <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Then run (optional)</label>
            <div className="flex flex-wrap gap-1">
              {schedules.map(s => (
                <button
                  key={s.id}
                  type="button"
                  onClick={() => toggleChain(s.id)}
                  className={`text-xs px-3 py-1.5 rounded border ${chainTo.includes(s.id) ? "bg-violet-500/15 border-violet-500/40 text-violet-200" : "bg-ink-950 border-ink-800 text-cream-300 hover:border-ink-700"}`}
                >
                  {s.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] text-cream-300/50 mt-1">When this schedule's job succeeds, the selected schedule(s) fire right away too — a manual chain instead of waiting for their own cadence.</p>
          </div>
        )}

        <div className="flex items-center gap-3 pt-2 border-t border-ink-800">
          <Button onClick={submit} disabled={submitting || !name.trim() || !templateId || days.length === 0}>
            {submitting ? "Creating..." : "Create schedule"}
          </Button>
          {tpl && days.length > 0 && (
            <span className="text-[11px] text-cream-300/60">
              Will run <span className="text-cream-100">{tpl.title}</span> at <span className="text-cream-100">{hour.toString().padStart(2, "0")}:{minute.toString().padStart(2, "0")}</span> on selected days.
            </span>
          )}
        </div>
      </div>
    </Card>
  );
}
