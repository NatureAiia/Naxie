import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, ChevronRight, CalendarDays, Users, Briefcase, AlertTriangle, Lock, X, Plus } from "lucide-react";
import { api, type Schedule, type Cadence } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { departmentColor } from "../lib/departmentColor";
import { formatCadence, formatNext, DAY_LABELS } from "../lib/scheduleFormat";
import { stashNaxiePrompt } from "../lib/resultActions";

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

// Format a Date as its LOCAL calendar day. Using toISOString() here would
// convert to UTC and shift the date by the timezone offset (e.g. local midnight
// in UTC+2 becomes the previous day) — the classic calendar off-by-one.
function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
function todayLocal(): Date { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
function startOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth(), 1); }
function endOfMonth(d: Date): Date { return new Date(d.getFullYear(), d.getMonth() + 1, 0); }

function cadenceMatchesDate(c: Cadence, d: Date): boolean {
  if (c.once) return c.once === ymd(d);
  const days = c.daysOfWeek.length === 0 ? [0, 1, 2, 3, 4, 5, 6] : c.daysOfWeek;
  return days.includes(d.getDay());
}

type PersonaLite = { id: string; name: string; department?: string };
type DeptLite = { id: string; name: string; color?: string };
const GENERAL_DEPT: DeptLite = { id: "general", name: "General", color: "violet" };

// Activity + Routines calendar — the operator's "what did we actually do /
// what's coming up" view. DONE mode (default) shows completed job activity,
// colored per department; ROUTINES mode overlays every schedule's projected
// fire dates for the visible month instead (pure client-side date math off
// each schedule's own cadence — no new endpoint needed for that part).
// Click a day → right-hand agenda panel (meetings/activity/events/scheduled)
// plus, now, a "Schedule for <date>" popup to create a new one-off or
// recurring task straight from the grid.
export function CalendarPage() {
  const [anchor, setAnchor] = useState(todayLocal());
  const [selected, setSelected] = useState(todayLocal());
  const [activity, setActivity] = useState<{ date: string; jobs: any[] }[]>([]);
  const [agenda, setAgenda] = useState<{ date: string; activity: any[]; meetings: any[]; meetingsError?: string; schedules: any[]; events?: { date: string; title: string; subject: string }[]; externalEvents?: { summary: string; start?: string; end?: string; account: string; source: "google" | "microsoft" }[]; conflicts?: { eventA: { summary: string }; eventB: { summary: string }; overlapMinutes: number }[] } | null>(null);
  const [loading, setLoading] = useState(false);
  const [personas, setPersonas] = useState<PersonaLite[]>([]);
  const [departments, setDepartments] = useState<DeptLite[]>([]);
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [view, setView] = useState<"done" | "notdone" | "routines">("done");
  const [deptFilter] = useState<string>("all");
  const [scheduling, setScheduling] = useState<Date | null>(null);

  const monthStart = startOfMonth(anchor);
  const monthEnd = endOfMonth(anchor);
  // Fetch the visible window (the prev/next month bleed into the grid; pad
  // the request by ~10 days each side so the bleed cells show counts too).
  const fetchFrom = new Date(monthStart); fetchFrom.setDate(fetchFrom.getDate() - 10);
  const fetchTo = new Date(monthEnd); fetchTo.setDate(fetchTo.getDate() + 10);

  function loadSchedules() {
    api.listSchedules().then(r => setSchedules(r.schedules)).catch(() => {});
  }

  useEffect(() => {
    api.listPersonas().then(r => setPersonas(r.personas)).catch(() => {});
    api.listDepartments().then(r => setDepartments(r.departments)).catch(() => {});
    loadSchedules();
  }, []);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    api.calendarActivity(ymd(fetchFrom), ymd(fetchTo))
      .then(r => { if (alive) setActivity(r.days); })
      .catch(() => {})
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.getFullYear(), anchor.getMonth()]);

  useEffect(() => {
    let alive = true;
    api.calendarAgenda(ymd(selected)).then(r => { if (alive) setAgenda(r); }).catch(() => {});
    return () => { alive = false; };
  }, [selected]);

  // Build the month grid: 6 rows × 7 columns starting from the Sunday of
  // the week containing monthStart. Some cells are "out of month" — render
  // them dimmer so the eye scans the active month.
  const grid = useMemo(() => {
    const cells: Date[] = [];
    const first = new Date(monthStart);
    const dow = first.getDay();
    first.setDate(first.getDate() - dow);
    for (let i = 0; i < 42; i++) {
      const d = new Date(first); d.setDate(first.getDate() + i);
      cells.push(d);
    }
    return cells;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [anchor.getFullYear(), anchor.getMonth()]);

  // personaName -> department. Jobs (both in-memory and persisted) only
  // reliably carry a persona NAME, not id, so the join happens on name —
  // names are the app's display handle and are effectively unique.
  const deptByPersonaName = useMemo(() => {
    const byId = new Map(departments.map(d => [d.id, d as DeptLite]));
    const m = new Map<string, DeptLite>();
    for (const p of personas) {
      const dept = p.department ? byId.get(p.department) : undefined;
      m.set(p.name, dept ?? GENERAL_DEPT);
    }
    return m;
  }, [personas, departments]);

  const dayMap = useMemo(() => {
    const m = new Map<string, any[]>();
    for (const d of activity) m.set(d.date, d.jobs);
    return m;
  }, [activity]);

  // Jobs on a day, filtered to the selected department (or all).
  function jobsOn(date: string): any[] {
    const jobs = dayMap.get(date) ?? [];
    if (deptFilter === "all") return jobs;
    return jobs.filter(j => (deptByPersonaName.get(j.personaName)?.id ?? "general") === deptFilter);
  }
  const maxJobsInDay = useMemo(() => {
    let max = 1;
    for (const d of activity) max = Math.max(max, jobsOn(d.date).length);
    return max;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activity, deptFilter, deptByPersonaName]);

  // Schedules matching the department filter, for the ROUTINES sidebar +
  // month overlay. A schedule's department is whatever the operator picked
  // when creating it (stored in inputs.department) — an organizational tag,
  // independent of which persona/department actually ends up running it.
  const filteredSchedules = useMemo(() => {
    if (deptFilter === "all") return schedules;
    return schedules.filter(s => (s.inputs?.department as string | undefined) === deptFilter);
  }, [schedules, deptFilter]);

  const monthLabel = anchor.toLocaleString("en-US", { month: "long", year: "numeric" });
  const isSelected = (d: Date) => ymd(d) === ymd(selected);
  const isToday = (d: Date) => ymd(d) === ymd(todayLocal());
  const inMonth = (d: Date) => d.getMonth() === anchor.getMonth();

  function shift(months: number) {
    const n = new Date(anchor); n.setMonth(n.getMonth() + months); setAnchor(n);
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><CalendarDays size={24} /> Calendar</h1>
          <p className="text-sm text-cream-300/70 mt-1">Activity, meetings, and scheduled work in one view. Agents can read and plan from the same data — primitives <span className="font-mono">calendar.activity</span>, <span className="font-mono">calendar.plan_day</span>.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => shift(-1)}><ChevronLeft size={14} /></Button>
          <Button onClick={() => { const t = todayLocal(); setAnchor(t); setSelected(t); }}>Today</Button>
          <Button onClick={() => shift(1)}><ChevronRight size={14} /></Button>
        </div>
      </div>

      <div className="flex items-center justify-end">
        <div className="flex items-center rounded-full border border-ink-700 overflow-hidden text-[10px] uppercase tracking-wider">
          <button type="button" onClick={() => setView("done")} className={`px-3 py-1 ${view === "done" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}>Done</button>
          <button type="button" onClick={() => setView("notdone")} className={`px-3 py-1 ${view === "notdone" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}>Not Done</button>
          <button type="button" onClick={() => setView("routines")} className={`px-3 py-1 ${view === "routines" ? "bg-violet-500 text-white" : "text-cream-300/70 hover:text-cream-100"}`}>Routines</button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[200px_1fr_320px] gap-4 items-start">
        <RoutinesSidebar schedules={filteredSchedules} />

        <Card title={monthLabel}>
          <div className="grid grid-cols-7 gap-px bg-ink-800 rounded-lg overflow-hidden border border-ink-800">
            {WEEKDAYS.map(d => (
              <div key={d} className="bg-ink-900 px-2 py-1.5 text-[10px] uppercase tracking-wider text-cream-300/50 text-center">{d}</div>
            ))}
            {grid.map((d, i) => {
              const k = ymd(d);
              const jobs = jobsOn(k);
              const filteredJobs = view === "done" ? jobs.filter(j => j.status === "succeeded") : view === "notdone" ? jobs.filter(j => j.status !== "succeeded") : jobs;
              const displayJobs = view === "done" || view === "notdone" ? filteredJobs : jobs;
              const heat = displayJobs.length === 0 ? 0 : Math.min(1, displayJobs.length / maxJobsInDay);
              const dayRoutines = filteredSchedules.filter(s => s.enabled && cadenceMatchesDate(s.cadence, d));
              const isJobsView = view === "done" || view === "notdone";
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => setSelected(d)}
                  onDoubleClick={() => setScheduling(d)}
                  title="Click to view · double-click to schedule"
                  className={`bg-ink-950 px-2 py-2 text-left min-h-[78px] flex flex-col gap-1 group relative nw-fade-up nw-delay-${Math.min(7, Math.floor(i / 7) + 1)} ${inMonth(d) ? "" : "opacity-50"} ${isSelected(d) ? "ring-2 ring-violet-500" : "hover:bg-ink-900"} ${isJobsView && heat > 0 ? "heat-tint" : ""}`}
                  style={isJobsView && heat > 0 ? { "--heat": `${0.04 + heat * 0.12}` } as React.CSSProperties : undefined}
                >
                  <div className="flex items-center justify-between">
                    <span className={`text-xs font-mono ${isToday(d) ? "bg-violet-500 text-cream-50 rounded-full w-5 h-5 grid place-items-center" : "text-cream-100"}`}>{d.getDate()}</span>
                    {isJobsView && displayJobs.length > 0 && <span className="text-[9px] font-mono text-cream-300/60">{displayJobs.length}</span>}
                  </div>
                  {isJobsView ? (
                    (() => {
                      const byDept = new Map<string, { dept: DeptLite; count: number }>();
                      for (const j of displayJobs) {
                        const dept = deptByPersonaName.get(j.personaName) ?? GENERAL_DEPT;
                        const cur = byDept.get(dept.id);
                        if (cur) cur.count++; else byDept.set(dept.id, { dept, count: 1 });
                      }
                      const chips = [...byDept.values()];
                      return chips.length > 0 ? (
                        <div className="flex items-center gap-0.5 flex-wrap">
                          {chips.slice(0, 4).map(({ dept, count }) => {
                            const color = departmentColor(dept.color ?? "slate");
                            return (
                              <span key={dept.id} className="text-[9px] px-1 rounded border truncate max-w-[64px]" style={{ borderColor: color, color }}>
                                {dept.name}{count > 1 ? ` ×${count}` : ""}
                              </span>
                            );
                          })}
                          {chips.length > 4 && <span className="text-[9px] text-cream-300/60">+{chips.length - 4}</span>}
                        </div>
                      ) : null;
                    })()
                  ) : (
                    dayRoutines.length > 0 && (
                      <div className="flex items-center gap-0.5 flex-wrap">
                        {dayRoutines.slice(0, 3).map(s => {
                          const dept = departments.find(d2 => d2.id === (s.inputs?.department as string)) ?? GENERAL_DEPT;
                          const color = departmentColor(dept.color ?? "slate");
                          return (
                            <span key={s.id} className="text-[9px] px-1 rounded border truncate max-w-[70px] inline-flex items-center gap-0.5" style={{ borderColor: color, color }}>
                              {s.requireApproval && <Lock size={8} />} {s.name}
                            </span>
                          );
                        })}
                        {dayRoutines.length > 3 && <span className="text-[9px] text-cream-300/60">+{dayRoutines.length - 3}</span>}
                      </div>
                    )
                  )}
                </button>
              );
            })}
          </div>
          {loading && activity.length === 0 && (
            <div className="text-[11px] text-cream-300/50 mt-2 inline-flex items-center gap-2">
              <span className="nw-thinking-dots text-cream-300/60"><span /><span /><span /></span>
              Loading activity
            </div>
          )}
          <div className="text-[10px] text-cream-300/40 mt-2">Double-click a day to schedule a task.</div>
        </Card>

        <div className="space-y-4">
          <div className="flex justify-end">
            <Button onClick={() => setScheduling(selected)}><Plus size={12} /> Schedule for {selected.toLocaleDateString("en-US", { month: "short", day: "numeric" })}</Button>
          </div>
          <QuickTaskForDay date={selected} />
          <Card title={selected.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric" })}>
            {!agenda ? (
              <div className="text-sm text-cream-300/60">Loading…</div>
            ) : (
              <div className="space-y-4 text-sm">
                {!!agenda.conflicts?.length && (
                  <div className="flex items-start gap-1.5 text-[12px] text-coral-400 bg-coral-500/5 border border-coral-500/30 rounded px-2 py-1.5">
                    <AlertTriangle size={12} className="mt-0.5 shrink-0" />
                    <span>
                      {agenda.conflicts.length} overlapping event{agenda.conflicts.length === 1 ? "" : "s"}:{" "}
                      {agenda.conflicts.map((c, i) => (
                        <span key={i}>{i > 0 ? "; " : ""}"{c.eventA.summary}" overlaps "{c.eventB.summary}" ({c.overlapMinutes}m)</span>
                      ))}
                    </span>
                  </div>
                )}
                <AgendaSection
                  icon={<CalendarDays size={14} />}
                  title={`External Calendar (${agenda.externalEvents?.length ?? 0})`}
                  empty="No Google/Microsoft events (connect an account under Settings > Connectors)."
                  items={(agenda.externalEvents ?? []).map(e => ({
                    title: e.summary,
                    meta: `${e.start ? new Date(e.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "?"}${e.end ? `–${new Date(e.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""} · ${e.source === "google" ? "Google" : "Outlook"} · ${e.account}`,
                  }))}
                />
                <AgendaSection
                  icon={<CalendarDays size={14} />}
                  title="Meetings"
                  empty={agenda.meetingsError ? `iCal feed error: ${agenda.meetingsError}` : "No meetings (set NAXION_CALENDAR_ICAL_URL in naxionai/.env to overlay your real calendar)."}
                  items={agenda.meetings.map(m => ({
                    title: m.summary,
                    meta: `${new Date(m.start).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}${m.end ? `–${new Date(m.end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}${m.location ? ` · ${m.location}` : ""}`,
                  }))}
                />
                <AgendaSection
                  icon={<Briefcase size={14} />}
                  title={`Activity (${agenda.activity.length})`}
                  empty="No agent activity recorded on this day."
                  items={agenda.activity.slice(0, 12).map((j: any) => ({
                    title: j.title ?? j.kind,
                    meta: `${j.status}${j.personaName ? ` · ${j.personaName}` : ""}${j.finishedAt ? ` · ${new Date(j.finishedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : ""}`,
                    href: `/results/${j.id}`,
                    badge: j.status === "failed" ? "fail" : j.scoreOrNull !== null ? Math.round(j.scoreOrNull * 100) + "" : undefined,
                    tone: j.status === "failed" ? "fail" : undefined,
                  }))}
                />
                <AgendaSection
                  icon={<CalendarDays size={14} />}
                  title={`Events (${agenda.events?.length ?? 0})`}
                  empty="No events added for this day — agents add them via calendar.add_event."
                  items={(agenda.events ?? []).map(e => ({
                    title: e.title,
                    meta: e.subject !== "calendar" ? e.subject : "event",
                  }))}
                />
                <AgendaSection
                  icon={<Users size={14} />}
                  title="Scheduled"
                  empty="No Naxie schedules run on this day-of-week."
                  items={agenda.schedules.map((s: any) => ({
                    title: s.label ?? s.templateId,
                    meta: `${s.cadence?.hour?.toString().padStart(2, "0") ?? "?"}:${s.cadence?.minute?.toString().padStart(2, "0") ?? "?"} · ${s.enabled === false ? "paused" : "active"}`,
                  }))}
                />
                <div className="pt-2 border-t border-ink-800">
                  <Link
                    to="/naxie"
                    onClick={() => stashNaxiePrompt(`Plan my day for ${ymd(selected)} using calendar.plan_day and the daily-briefing skill.`)}
                    className="inline-flex items-center gap-1.5 text-xs text-violet-400 hover:text-violet-500"
                  >Plan this day with an agent →</Link>
                </div>
              </div>
            )}
          </Card>
        </div>
      </div>

      {scheduling && (
        <SchedulePopup
          date={scheduling}
          departments={departments}
          onClose={() => setScheduling(null)}
          onCreated={() => { setScheduling(null); loadSchedules(); showToast("Scheduled", "success"); }}
        />
      )}
    </div>
  );
}

function RoutinesSidebar({ schedules }: { schedules: Schedule[] }) {
  return (
    <Card title="Routines">
      {schedules.length === 0 ? (
        <div className="text-xs text-cream-300/40">No routines yet — double-click a day to create one.</div>
      ) : (
        <div className="space-y-2.5 max-h-[min(60vh,560px)] overflow-y-auto">
          {schedules.map(s => (
            <div key={s.id} className={`text-xs rounded-lg border px-2.5 py-2 ${s.enabled ? "border-ink-800 bg-ink-950/40" : "border-ink-800/50 bg-ink-950/20 opacity-50"}`}>
              <div className="text-cream-100 font-medium truncate">{s.name}</div>
              <div className="text-[10px] text-cream-300/60 mt-0.5">{formatCadence(s.cadence)}</div>
              <div className="flex items-center justify-between mt-1">
                <span className="text-[10px] text-cream-300/50">{s.enabled ? formatNext(s.nextFireAt) : "paused"}</span>
                {s.requireApproval && (
                  <span className="text-[9px] uppercase tracking-wider text-amber-300 inline-flex items-center gap-1"><Lock size={9} /> waits for OK</span>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}

function QuickTaskForDay({ date }: { date: Date }) {
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  async function add() {
    const t = title.trim();
    if (!t) return;
    setBusy(true);
    try {
      await api.addMyTaskItem({ title: t, dueDate: ymd(date) });
      setTitle("");
      showToast(`Task "${t}" added for ${ymd(date)}`, "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBusy(false); }
  }
  return (
    <div className="flex items-center gap-2">
      <input
        value={title}
        onChange={e => setTitle(e.target.value)}
        onKeyDown={e => { if (e.key === "Enter") void add(); }}
        placeholder={`Add task for ${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}…`}
        className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-1.5 text-xs text-cream-100 placeholder:text-cream-300/40 focus:outline-none focus:border-violet-500/60"
      />
      <Button onClick={add} disabled={busy || !title.trim()}><Plus size={12} /> Task</Button>
    </div>
  );
}

type SchedulePopupProps = {
  date: Date;
  departments: DeptLite[];
  onClose: () => void;
  onCreated: () => void;
};

function SchedulePopup({ date, departments, onClose, onCreated }: SchedulePopupProps) {
  const [department, setDepartment] = useState<string>("");
  const [hour, setHour] = useState(9);
  const [minute, setMinute] = useState(0);
  const [task, setTask] = useState("");
  const [repeat, setRepeat] = useState(false);
  const [days, setDays] = useState<Set<number>>(new Set());
  const [requireApproval, setRequireApproval] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState("");

  function toggleDay(d: number) {
    setDays(prev => { const next = new Set(prev); if (next.has(d)) next.delete(d); else next.add(d); return next; });
  }

  async function submit() {
    if (!task.trim()) { setErr("Type what this task should do."); return; }
    setErr("");
    setSaving(true);
    try {
      const cadence: Cadence = repeat
        ? { daysOfWeek: [...days], hour, minute }
        : { daysOfWeek: [], hour, minute, once: ymd(date) };
      await api.createSchedule({
        name: task.trim().slice(0, 60),
        task: task.trim(),
        cadence,
        requireApproval,
        inputs: department ? { department } : {},
      });
      onCreated();
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-md bg-ink-900 border border-ink-700 rounded-2xl p-4 space-y-3.5 shadow-2xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h2 className="text-base font-medium text-cream-50">
            Schedule for {date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })}
          </h2>
          <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={16} /></button>
        </div>

        {err && <div className="text-xs text-coral-400 bg-coral-500/10 border border-coral-500/30 rounded px-2.5 py-1.5">{err}</div>}

        <div className="flex items-center gap-2">
          <select
            value={department}
            onChange={e => setDepartment(e.target.value)}
            className="flex-1 bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-xs text-cream-100"
          >
            <option value="">General (no department)</option>
            {departments.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
          </select>
          <input
            type="number" min={0} max={23} value={hour}
            onChange={e => setHour(Math.max(0, Math.min(23, Number(e.target.value))))}
            className="w-14 bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-xs text-cream-100"
          />
          <span className="text-cream-300/50 text-xs">:</span>
          <input
            type="number" min={0} max={59} value={minute}
            onChange={e => setMinute(Math.max(0, Math.min(59, Number(e.target.value))))}
            className="w-14 bg-ink-950 border border-ink-800 rounded px-2 py-1.5 text-xs text-cream-100"
          />
        </div>

        <textarea
          value={task}
          onChange={e => setTask(e.target.value)}
          rows={3}
          placeholder="What should this task do? e.g. Draft the weekly sales summary and email it to me."
          className="w-full bg-ink-950 border border-ink-800 rounded-lg px-3 py-2 text-sm text-cream-100 resize-y focus:outline-none focus:border-violet-500/60"
        />

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setRepeat(r => !r)}
            className={`text-[10px] uppercase tracking-wider px-2.5 py-1 rounded-full border ${repeat ? "bg-violet-500 border-violet-500 text-white" : "border-ink-700 text-cream-300/70"}`}
          >
            Repeat {repeat ? "on" : "off"}
          </button>
          <span className="text-[11px] text-cream-300/50">{repeat ? "Pick the weekdays below" : `One-off, just ${ymd(date)}`}</span>
        </div>
        {repeat && (
          <div className="flex flex-wrap gap-1">
            {DAY_LABELS.map((label, i) => (
              <button
                key={i}
                type="button"
                onClick={() => toggleDay(i)}
                className={`text-[10px] px-2 py-1 rounded-full border ${days.has(i) ? "bg-violet-500 border-violet-500 text-white" : "border-ink-700 text-cream-300/70"}`}
              >{label}</button>
            ))}
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-cream-200">
          <input type="checkbox" checked={requireApproval} onChange={e => setRequireApproval(e.target.checked)} />
          Needs my OK before it runs
        </label>

        <div className="flex items-center justify-end gap-2 pt-1">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={submit} disabled={saving || !task.trim()}>{saving ? "Adding…" : "Add"}</Button>
        </div>
      </div>
    </div>
  );
}

type AgendaItem = { title: string; meta: string; href?: string; badge?: string; tone?: "fail" };

function AgendaRow({ it }: { it: AgendaItem }) {
  const body = (
    <span className={`flex items-center gap-2 px-2 py-1.5 rounded text-xs ${it.tone === "fail" ? "bg-coral-500/5 border border-coral-500/30" : "bg-ink-950 border border-ink-800"} ${it.href ? "hover:bg-ink-900" : ""}`}>
      <span className="flex-1 min-w-0">
        <span className="text-cream-100 truncate block">{it.title}</span>
        <span className="text-[10px] text-cream-300/60 truncate block">{it.meta}</span>
      </span>
      {it.badge && <span className={`text-[10px] font-mono shrink-0 ${it.tone === "fail" ? "text-coral-400" : "text-cream-300/70"}`}>{it.badge}</span>}
    </span>
  );
  return it.href ? <Link to={it.href}>{body}</Link> : body;
}

function AgendaSection({ icon, title, empty, items }: { icon: React.ReactNode; title: string; empty: string; items: AgendaItem[] }) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-cream-300/60 mb-1.5">{icon} <span>{title}</span></div>
      {items.length === 0 ? (
        <div className="text-[12px] text-cream-300/50 italic flex items-start gap-1.5">{empty.startsWith("Set ") || empty.includes("error") || empty.startsWith("No meetings") ? <AlertTriangle size={12} className="mt-0.5 text-flame-400" /> : null}{empty}</div>
      ) : (
        <ul className="space-y-1">
          {items.map((it, i) => (
            <li key={i}><AgendaRow it={it} /></li>
          ))}
        </ul>
      )}
    </div>
  );
}
