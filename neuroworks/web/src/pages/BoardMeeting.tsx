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
import { RefreshCw, Users2, History } from "lucide-react";
import { api, type BoardRun } from "../lib/api";
import { Card, Button } from "../components/Card";
import { BrandMark } from "../components/BrandMark";

const DEFAULT_COUNCIL = ["researcher", "knowitall", "product-manager", "qa-engineer", "data-analyst"];
const STORAGE_KEY = "neuroworks.board.topic";

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
          <Button onClick={convene} disabled={!topic.trim() || starting || selected.size < 3}>
            {starting ? <RefreshCw size={13} className="mr-1 inline animate-spin" /> : null}
            Convene the board
          </Button>
        </div>
        {selected.size < 3 && (
          <div className="text-[11px] text-flame-300 mt-1">Pick at least 3 members.</div>
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
                    <div
                      className="prose-vault text-sm text-cream-100"
                      dangerouslySetInnerHTML={{ __html: md(run.opinions[activeMemberTab].text) }}
                    />
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
