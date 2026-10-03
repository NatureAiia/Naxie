// Board Meeting — an LLM council (github.com/karpathy/llm-council), built on
// personas already hired in the system so it works with zero extra setup.
//
// Stage 1 — Opinions: every council member answers the topic independently.
// Stage 2 — Review: each member ranks the anonymized set on accuracy/insight.
// Stage 3 — Final response: Naxie, as chairman, compiles one final answer.
//
// Naxie narrates progress throughout (host of the meeting), and the final
// synthesis is the headline result — the council's stages are there to
// inspect underneath.

import { useEffect, useMemo, useState } from "react";
import { marked } from "marked";
import { RefreshCw, Users2, History, MessageSquareWarning, Clock, X } from "lucide-react";
import { api, type BoardRun, type Cadence } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { BrandMark } from "../components/BrandMark";

// Kept in sync with server/src/lib/board.ts's DEFAULT_COUNCIL — pruned
// 2026-09-21 alongside personas.ts's own prune (all built-ins had zero
// recorded activity in 30 days).
const DEFAULT_COUNCIL = ["researcher", "knowitall", "software-engineer", "accountant", "social-media-manager"];
const STORAGE_KEY = "naxie.board.topic";
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

type PersonaLite = { id: string; name: string; role: string; description?: string };

function md(text: string): string {
  try { return marked.parse(text) as string; } catch { return text; }
}

export function BoardMeeting() {
  const [personas, setPersonas] = useState<PersonaLite[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set(DEFAULT_COUNCIL));
  const [pickerOpen, setPickerOpen] = useState(false);
  const [topic, setTopic] = useState<string>(() => {
    try { return localStorage.getItem(STORAGE_KEY) ?? ""; } catch { return ""; }
  });

  const [starting, setStarting] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const [run, setRun] = useState<BoardRun | null>(null);
  const [err, setErr] = useState("");

  const [history, setHistory] = useState<BoardRun[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);

  const [activeMemberTab, setActiveMemberTab] = useState(0);

  // Feature C — correction UI. `correctingTarget` is undefined (synthesis) or
  // a personaId (one opinion); null means the panel is closed.
  const [correctingTarget, setCorrectingTarget] = useState<string | null | undefined>(null);
  const [correctionNote, setCorrectionNote] = useState("");
  const [correcting, setCorrecting] = useState(false);

  // Feature D — recurring meetings via the existing generic Schedules
  // pipeline (registers as a hidden "board-meeting" template — see
  // lib/templates.ts / routes/templates.ts).
  const [recurringOpen, setRecurringOpen] = useState(false);
  const [recurDays, setRecurDays] = useState<Set<number>>(new Set([1, 2, 3, 4, 5]));
  const [recurHour, setRecurHour] = useState(9);
  const [recurMinute, setRecurMinute] = useState(0);
  const [savingRecurring, setSavingRecurring] = useState(false);

  useEffect(() => {
    api.listPersonas().then(r => {
      const list = (r.personas ?? []).map((p: any) => ({ id: p.id, name: p.name, role: p.role, description: p.description }));
      setPersonas(list);
    }).catch(() => {});
    refreshHistory();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORAGE_KEY, topic); } catch { /* ignore */ }
  }, [topic]);

  function refreshHistory() {
    api.listBoards().then(r => setHistory(r.runs ?? [])).catch(() => {});
  }

  // Poll the run every 2s until it reaches a terminal status — same pattern
  // used for the hand-off relay timeline on the Team page.
  useEffect(() => {
    if (!runId) return;
    let alive = true;
    let timer: any;
    async function tick() {
      const r = await api.getBoard(runId!).catch(() => null);
      if (!alive) return;
      if (r?.run) {
        setRun(r.run);
        if (r.run.status === "running") timer = setTimeout(tick, 2000);
        else refreshHistory();
      } else {
        timer = setTimeout(tick, 2500);
      }
    }
    tick();
    return () => { alive = false; if (timer) clearTimeout(timer); };
  }, [runId]);

  async function convene() {
    if (!topic.trim() || starting) return;
    setErr("");
    setStarting(true);
    setRun(null);
    setRunId(null);
    setActiveMemberTab(0);
    try {
      const r = await api.startBoard({ topic: topic.trim(), personaIds: [...selected] });
      setRunId(r.runId);
    } catch (e: any) {
      setErr(e?.message ?? String(e));
    } finally {
      setStarting(false);
    }
  }

  function loadPast(r: BoardRun) {
    setRun(r);
    setRunId(r.id);
    setTopic(r.topic);
    setActiveMemberTab(0);
    setHistoryOpen(false);
  }

  async function submitCorrection() {
    if (!run || correctingTarget === null || !correctionNote.trim() || correcting) return;
    setCorrecting(true);
    try {
      const body = correctingTarget === undefined
        ? { note: correctionNote.trim() }
        : { targetPersonaId: correctingTarget, note: correctionNote.trim() };
      const r = await api.correctBoard(run.id, body);
      setRun(r.run);
      const last = r.run.corrections?.[r.run.corrections.length - 1];
      showToast(
        last?.classification === "standing-rule" ? `Standing rule added: ${last.ruleText}` : "Noted for this meeting",
        "success",
      );
      setCorrectingTarget(null);
      setCorrectionNote("");
      refreshHistory();
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setCorrecting(false);
    }
  }

  function toggleRecurDay(d: number) {
    setRecurDays(prev => {
      const next = new Set(prev);
      if (next.has(d)) next.delete(d); else next.add(d);
      return next;
    });
  }

  async function saveRecurring() {
    if (!topic.trim() || selected.size < 3 || savingRecurring) return;
    setSavingRecurring(true);
    try {
      const cadence: Cadence = { daysOfWeek: [...recurDays].sort((a, b) => a - b), hour: recurHour, minute: recurMinute };
      await api.createSchedule({
        name: `Board: ${topic.trim().slice(0, 40)}`,
        templateId: "board-meeting",
        inputs: { topic: topic.trim(), personaIds: [...selected].join(",") },
        cadence,
        enabled: true,
      });
      showToast("Recurring board meeting scheduled — see it on the Schedules page", "success");
      setRecurringOpen(false);
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setSavingRecurring(false);
    }
  }

  function toggleMember(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const stage = useMemo(() => {
    if (!run) return 0;
    if (run.chairmanSynthesis) return 3;
    if (run.rankings.length > 0) return 2;
    if (run.opinions.length > 0) return 1;
    return 0;
  }, [run]);

  const naxieLine = !run
    ? "Give the board a topic and Naxie will convene the meeting."
    : run.status === "failed"
      ? `The meeting didn't finish: ${run.chairmanSynthesis || "unknown error"}`
      : stage === 0
        ? "Naxie is convening the council…"
        : stage === 1
          ? "Naxie has the opinions — asking each member to review the others' answers…"
          : stage === 2
            ? "Naxie is weighing the council's rankings and drafting the final response…"
            : "Naxie has compiled the board's final response.";

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg font-semibold text-cream-50 flex items-center gap-2">
            <Users2 size={18} className="text-violet-300" /> Board Meeting
          </h1>
          <p className="text-xs text-cream-300/60 mt-0.5">
            Put a topic to the council. Every member answers independently, reviews each other anonymously, then Naxie chairs the final call.
          </p>
        </div>
        <Button variant="ghost" onClick={() => setHistoryOpen(v => !v)}>
          <History size={13} className="mr-1 inline" /> Past meetings ({history.length})
        </Button>
      </div>

      {historyOpen && (
        <Card>
          {history.length === 0 ? (
            <div className="text-xs text-cream-300/50">No meetings yet.</div>
          ) : (
            <ul className="space-y-1.5 max-h-64 overflow-y-auto">
              {history.map(r => (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => loadPast(r)}
                    className="w-full text-left text-xs text-cream-100 hover:text-violet-300 truncate px-2 py-1.5 rounded hover:bg-ink-800/60"
                  >
                    <span className="text-cream-300/50 mr-2">{new Date(r.createdAt).toLocaleString()}</span>
                    {r.scheduleId && <Clock size={11} className="inline mr-1 text-violet-300" aria-label="recurring" />}
                    {r.topic}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Card>
        <textarea
          value={topic}
          onChange={e => setTopic(e.target.value)}
          placeholder="What should the board discuss or brainstorm? e.g. Should we launch a freemium tier this quarter?"
          rows={3}
          className="w-full bg-ink-950 border border-ink-800 rounded p-3 text-sm text-cream-100 placeholder:text-cream-300/30 focus:outline-none focus:border-violet-500/60 resize-y"
        />
        <div className="flex items-center justify-between mt-2 flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setPickerOpen(v => !v)}
            className="text-[11px] text-cream-300/60 hover:text-cream-100"
          >
            {selected.size} council member{selected.size === 1 ? "" : "s"} selected — {pickerOpen ? "hide" : "change"}
          </button>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setRecurringOpen(v => !v)} disabled={!topic.trim() || selected.size < 3}>
              <Clock size={13} className="mr-1 inline" /> Make recurring…
            </Button>
            <Button onClick={convene} disabled={!topic.trim() || starting || selected.size < 3}>
              {starting ? <RefreshCw size={13} className="mr-1 inline animate-spin" /> : null}
              Convene the board
            </Button>
          </div>
        </div>
        {selected.size < 3 && (
          <div className="text-[11px] text-flame-300 mt-1">Pick at least 3 members.</div>
        )}
        {recurringOpen && (
          <div className="mt-3 border-t border-ink-800 pt-3 space-y-2">
            <div className="text-[11px] text-cream-300/60">Run this topic + council automatically on a schedule (see it later on the Schedules page).</div>
            <div className="flex flex-wrap gap-1.5">
              {DAY_LABELS.map((label, d) => (
                <button
                  key={d}
                  type="button"
                  onClick={() => toggleRecurDay(d)}
                  className={`px-2 py-1 rounded text-[11px] border ${recurDays.has(d) ? "bg-violet-600 border-violet-500 text-white" : "border-ink-800 text-cream-300/60 hover:text-cream-100"}`}
                >
                  {label}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="number" min={0} max={23} value={recurHour}
                onChange={e => setRecurHour(Math.max(0, Math.min(23, Number(e.target.value) || 0)))}
                className="w-16 bg-ink-950 border border-ink-800 rounded px-2 py-1 text-xs text-cream-100"
              />
              <span className="text-cream-300/50 text-xs">:</span>
              <input
                type="number" min={0} max={59} value={recurMinute}
                onChange={e => setRecurMinute(Math.max(0, Math.min(59, Number(e.target.value) || 0)))}
                className="w-16 bg-ink-950 border border-ink-800 rounded px-2 py-1 text-xs text-cream-100"
              />
              <span className="text-cream-300/50 text-xs">(this machine's clock)</span>
              <Button onClick={saveRecurring} disabled={savingRecurring || recurDays.size === 0}>
                {savingRecurring ? <RefreshCw size={13} className="mr-1 inline animate-spin" /> : null}
                Save schedule
              </Button>
            </div>
          </div>
        )}
        {pickerOpen && (
          <div className="mt-3 border-t border-ink-800 pt-3 grid grid-cols-1 sm:grid-cols-2 gap-1.5 max-h-72 overflow-y-auto">
            {personas.map(p => (
              <label key={p.id} className="flex items-start gap-2 text-xs text-cream-100 px-2 py-1.5 rounded hover:bg-ink-800/60 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggleMember(p.id)}
                  className="mt-0.5"
                />
                <span>
                  <span className="font-medium">{p.name}</span>{" "}
                  <span className="text-cream-300/50">· {p.role}</span>
                </span>
              </label>
            ))}
          </div>
        )}
      </Card>

      {err && <div className="text-xs text-coral-300">{err}</div>}

      {run && (
        <>
          <Card>
            <div className="flex items-center gap-2.5">
              <BrandMark size={22} />
              <div className="text-sm text-cream-100">{naxieLine}</div>
            </div>
          </Card>

          {run.chairmanSynthesis && (
            <Card className="border-violet-500/40">
              <div className="flex items-center gap-2 mb-2">
                <BrandMark size={24} />
                <div className="text-sm font-semibold text-cream-50">Naxie's final response</div>
              </div>
              <div
                className="prose-vault text-sm text-cream-100"
                dangerouslySetInnerHTML={{ __html: md(run.chairmanSynthesis) }}
              />
              {run.synthesisRevisions && run.synthesisRevisions.length > 0 && (
                <details className="mt-2">
                  <summary className="text-[11px] text-cream-300/50 cursor-pointer hover:text-cream-100">Revised — show original</summary>
                  <div className="prose-vault text-xs text-cream-300/70 mt-1" dangerouslySetInnerHTML={{ __html: md(run.synthesisRevisions[run.synthesisRevisions.length - 1].previousText) }} />
                </details>
              )}
              <CorrectionAffordance
                active={correctingTarget === undefined}
                open={() => { setCorrectingTarget(undefined); setCorrectionNote(""); }}
                close={() => setCorrectingTarget(null)}
                note={correctionNote}
                setNote={setCorrectionNote}
                submit={submitCorrection}
                submitting={correcting}
              />
            </Card>
          )}

          {run.opinions.length > 0 && (
            <Card title="Stage 1 · Opinions">
              <div className="flex items-center gap-1 border-b border-ink-800 mb-3 overflow-x-auto">
                {run.opinions.map((o, i) => (
                  <button
                    key={o.personaId}
                    type="button"
                    onClick={() => setActiveMemberTab(i)}
                    className={`px-3 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors ${
                      activeMemberTab === i ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
                    }`}
                  >
                    {o.name}
                  </button>
                ))}
              </div>
              {run.opinions[activeMemberTab] && (
                <div>
                  <div className="text-[11px] text-cream-300/50 mb-2">{run.opinions[activeMemberTab].role}</div>
                  {run.opinions[activeMemberTab].error ? (
                    <div className="text-xs text-coral-300">Failed: {run.opinions[activeMemberTab].error}</div>
                  ) : (
                    <>
                      <div
                        className="prose-vault text-sm text-cream-100"
                        dangerouslySetInnerHTML={{ __html: md(run.opinions[activeMemberTab].text) }}
                      />
                      {run.opinions[activeMemberTab].revisions && run.opinions[activeMemberTab].revisions!.length > 0 && (
                        <details className="mt-2">
                          <summary className="text-[11px] text-cream-300/50 cursor-pointer hover:text-cream-100">Revised — show original</summary>
                          <div className="prose-vault text-xs text-cream-300/70 mt-1" dangerouslySetInnerHTML={{ __html: md(run.opinions[activeMemberTab].revisions![run.opinions[activeMemberTab].revisions!.length - 1].previousText) }} />
                        </details>
                      )}
                      <CorrectionAffordance
                        active={correctingTarget === run.opinions[activeMemberTab].personaId}
                        open={() => { setCorrectingTarget(run.opinions[activeMemberTab].personaId); setCorrectionNote(""); }}
                        close={() => setCorrectingTarget(null)}
                        note={correctionNote}
                        setNote={setCorrectionNote}
                        submit={submitCorrection}
                        submitting={correcting}
                      />
                    </>
                  )}
                </div>
              )}
            </Card>
          )}

          {run.rankings.length > 0 && (
            <Card title="Stage 2 · Review (ranked for accuracy & insight)">
              <div className="space-y-3">
                {run.rankings.map(r => (
                  <div key={r.personaId} className="border-t border-ink-800 first:border-t-0 pt-3 first:pt-0">
                    <div className="text-xs text-cream-100 mb-1">
                      <span className="font-medium">{r.name}</span>{" "}
                      <span className="text-cream-300/50">(their own answer was {r.label})</span>
                    </div>
                    {r.error ? (
                      <div className="text-xs text-coral-300">Failed: {r.error}</div>
                    ) : (
                      <div
                        className="prose-vault text-xs text-cream-100/90"
                        dangerouslySetInnerHTML={{ __html: md(r.rankingText) }}
                      />
                    )}
                  </div>
                ))}
              </div>
            </Card>
          )}
        </>
      )}
    </div>
  );
}

// Feature C — the "Correct this" affordance shared by the synthesis card and
// each opinion tab. `active` distinguishes which target (undefined =
// synthesis, or a personaId) currently has this panel open, since only one
// correction panel is open at a time across the whole page.
function CorrectionAffordance({ active, open, close, note, setNote, submit, submitting }: {
  active: boolean;
  open: () => void;
  close: () => void;
  note: string;
  setNote: (v: string) => void;
  submit: () => void;
  submitting: boolean;
}) {
  if (!active) {
    return (
      <button
        type="button"
        onClick={open}
        className="mt-2 text-[11px] text-cream-300/50 hover:text-cream-100 flex items-center gap-1"
      >
        <MessageSquareWarning size={12} /> Correct this
      </button>
    );
  }
  return (
    <div className="mt-2 border-t border-ink-800 pt-2 space-y-1.5">
      <div className="flex items-center justify-between">
        <div className="text-[11px] text-cream-300/60">What should change? A clear "always…" reads as a standing rule; anything else is a one-off.</div>
        <button type="button" onClick={close} className="text-cream-300/40 hover:text-cream-100"><X size={13} /></button>
      </div>
      <textarea
        value={note}
        onChange={e => setNote(e.target.value)}
        rows={2}
        placeholder="e.g. Always keep this under 100 words / this once, focus more on cost"
        className="w-full bg-ink-950 border border-ink-800 rounded p-2 text-xs text-cream-100 placeholder:text-cream-300/30 focus:outline-none focus:border-violet-500/60 resize-y"
      />
      <div className="flex justify-end">
        <Button onClick={submit} disabled={submitting || !note.trim()}>
          {submitting ? <RefreshCw size={12} className="mr-1 inline animate-spin" /> : null}
          Submit correction
        </Button>
      </div>
    </div>
  );
}
