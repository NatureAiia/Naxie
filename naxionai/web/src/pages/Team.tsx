import { useEffect, useState } from "react";
import { Users, Play, Plus, Trash2 } from "lucide-react";
import { api } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";

// "Focus Team" — dispatch a shared brief to several personas in parallel,
// each polled independently. Ported from the earlier prototype'
// Team.tsx UI; Naxie's backend (routes/team.ts) already existed unused.
type DraftTask = { persona: string; content: string };
type Dispatched = { taskIndex: number; persona: { id: string; name: string; role: string } | null; personaAutoRouted: boolean; jobId: string; route: string };
type JobPoll = { status: string; answer?: string | null; error?: string };

export function Team() {
  const [personas, setPersonas] = useState<{ id: string; name: string; role: string }[]>([]);
  const [tasks, setTasks] = useState<DraftTask[]>([{ persona: "", content: "" }]);
  const [running, setRunning] = useState(false);
  const [dispatched, setDispatched] = useState<Dispatched[] | null>(null);
  const [jobPolls, setJobPolls] = useState<Record<string, JobPoll>>({});

  useEffect(() => {
    api.listPersonas().then(r => setPersonas(r.personas.map((p: any) => ({ id: p.id, name: p.name, role: p.role })))).catch(() => {});
  }, []);

  useEffect(() => {
    if (!dispatched) return;
    const ids = dispatched.map(d => d.jobId).filter(Boolean);
    if (ids.length === 0) return;
    const i = setInterval(async () => {
      const next: Record<string, JobPoll> = {};
      for (const id of ids) {
        try {
          const j = await api.getJob(id);
          next[id] = { status: j.status, answer: j.result?.answer ?? j.answer ?? null, error: j.error };
        } catch { /* ignore transient poll failure */ }
      }
      setJobPolls(prev => ({ ...prev, ...next }));
    }, 4000);
    return () => clearInterval(i);
  }, [dispatched]);

  function addTask() { setTasks(t => [...t, { persona: "", content: "" }]); }
  function removeTask(i: number) { setTasks(t => t.filter((_, ix) => ix !== i)); }
  function updateTask(i: number, patch: Partial<DraftTask>) { setTasks(t => t.map((x, ix) => ix === i ? { ...x, ...patch } : x)); }

  async function run() {
    const valid = tasks.filter(t => t.content.trim());
    if (valid.length === 0) return;
    setRunning(true);
    setJobPolls({});
    try {
      const r = await api.runTeamTasks(valid.map(t => ({ persona: t.persona || undefined, content: t.content.trim() })));
      setDispatched(r.tasks);
      showToast(`${r.tasksDispatched} task(s) dispatched`, "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setRunning(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<Users size={24} />}
        title="Focus Team"
        subtitle="Assign a shared brief to several personas at once — each runs in parallel, poll each independently."
      />

      <Card title="New team dispatch" action={<Button variant="subtle" onClick={addTask}><Plus size={14} /> Add task</Button>}>
        <div className="space-y-3">
          {tasks.map((t, i) => (
            <div key={i} className="flex gap-2 items-start bg-ink-950 border border-ink-800 rounded-lg p-3">
              <select value={t.persona} onChange={e => updateTask(i, { persona: e.target.value })} className="text-xs bg-ink-900 border border-ink-800 rounded-md px-2 py-1.5 text-cream-100 shrink-0">
                <option value="">auto-route</option>
                {personas.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
              <textarea
                value={t.content}
                onChange={e => updateTask(i, { content: e.target.value })}
                placeholder="What should this persona do?"
                rows={2}
                className="flex-1 bg-ink-900 border border-ink-800 rounded-md px-3 py-1.5 text-sm text-cream-100 resize-none"
              />
              {tasks.length > 1 && (
                <button type="button" onClick={() => removeTask(i)} className="p-1.5 rounded-md border border-ink-800 hover:border-coral-500/40 text-cream-300/60 hover:text-coral-400 shrink-0">
                  <Trash2 size={12} />
                </button>
              )}
            </div>
          ))}
        </div>
        <div className="flex justify-end mt-3">
          <Button onClick={() => void run()} disabled={running || tasks.every(t => !t.content.trim())}>
            {running ? "Dispatching…" : <><Play size={14} className="mr-1 inline" /> Run team</>}
          </Button>
        </div>
      </Card>

      {dispatched && (
        <div className="space-y-1.5">
          {dispatched.map(d => {
            const poll = jobPolls[d.jobId];
            return (
              <div key={d.taskIndex} className="text-xs rounded-md bg-ink-950/50 border border-ink-800 px-2.5 py-2">
                <div className="flex items-center gap-2">
                  <span className="text-cream-100">{d.persona?.name ?? "primary"}</span>
                  {d.personaAutoRouted && <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-violet-500/15 text-violet-300">auto-routed</span>}
                  <span className={`text-[9px] px-1.5 py-0.5 rounded-full ${poll?.status === "done" ? "bg-leaf-500/15 text-leaf-400" : poll?.status === "failed" ? "bg-coral-500/15 text-coral-400" : "bg-ink-800 text-cream-300/60"}`}>
                    {poll?.status ?? "pending"}
                  </span>
                </div>
                {poll?.answer && <div className="text-cream-300/70 mt-1 whitespace-pre-wrap">{poll.answer.slice(0, 800)}{poll.answer.length > 800 ? "…" : ""}</div>}
                {poll?.error && <div className="text-coral-400 mt-1">{poll.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
