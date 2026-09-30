import { useEffect, useMemo, useState } from "react";
import { Sun, Star, Plus, Trash2, X, Repeat, Bell, CalendarDays, ChevronDown, ChevronRight, List as ListIcon, Zap, Pause, Search } from "lucide-react";
import {
  Inbox, Send, Loader2, CheckCircle2, XCircle, Play, Paperclip, Bot,
  User as UserIcon, Clock, AlertTriangle, RotateCcw, Download,
  FileText, ListChecks, History,
} from "lucide-react";
import { api, type MyTaskItem, type MyTaskList, type RepeatRule, type TaskAutomation } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { Modal } from "../components/Modal";
import { Option } from "../components/Option";
import { DAY_LABELS, formatCadence } from "../lib/scheduleFormat";
import { CalendarPage } from "./CalendarPage";

type ViewKey = "my-day" | "important" | "calendar" | `list:${string}`;

function todayYmd(): string { return new Date().toISOString().slice(0, 10); }

export function MyTasks() {
  const [lists, setLists] = useState<MyTaskList[]>([]);
  const [items, setItems] = useState<MyTaskItem[]>([]);
  const [view, setView] = useState<ViewKey>("my-day");
  const [selected, setSelected] = useState<MyTaskItem | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [newListName, setNewListName] = useState("");
  const [addingList, setAddingList] = useState(false);
  const [showCompleted, setShowCompleted] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function refreshLists() {
    try { const r = await api.myTaskLists(); setLists(r.lists); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function refreshItems() {
    if (view === "calendar") { setLoaded(true); return; }
    try {
      const filter = view === "my-day" ? { myDay: true } : view === "important" ? { important: true } : { listId: view.slice(5) };
      const r = await api.myTaskItems(filter);
      setItems(r.items);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setLoaded(true); }
  }
  useEffect(() => { void refreshLists(); }, []);
  useEffect(() => { setLoaded(false); void refreshItems(); }, [view]);

  const incomplete = useMemo(() => items.filter(i => !i.completed).sort((a, b) => a.order - b.order), [items]);
  const completed = useMemo(() => items.filter(i => i.completed), [items]);

  async function addTask() {
    const title = newTitle.trim();
    if (!title) return;
    setNewTitle("");
    try {
      const body: any = { title };
      if (view === "my-day") body.myDay = true;
      else if (view === "important") body.important = true;
      else if (view.startsWith("list:")) body.listId = view.slice(5);
      const r = await api.addMyTaskItem(body);
      setItems(prev => [...prev, r.item]);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function toggle(item: MyTaskItem) {
    try {
      const r = await api.toggleMyTaskItem(item.id);
      setItems(prev => prev.map(i => i.id === item.id ? r.item : i));
      if (selected?.id === item.id) setSelected(r.item);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function addList() {
    const name = newListName.trim();
    if (!name) { setAddingList(false); return; }
    try {
      const r = await api.addMyTaskList(name);
      setLists(prev => [...prev, r.list]);
      setNewListName(""); setAddingList(false);
      setView(`list:${r.list.id}`);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  async function removeList(id: string, name: string) {
    if (!confirm(`Delete list "${name}" and all its tasks?`)) return;
    try {
      await api.removeMyTaskList(id);
      setLists(prev => prev.filter(l => l.id !== id));
      if (view === `list:${id}`) setView("my-day");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  function patchLocal(item: MyTaskItem) {
    setItems(prev => prev.map(i => i.id === item.id ? item : i));
    setSelected(item);
  }

  const [todayMeetings, setTodayMeetings] = useState<number | null>(null);
  useEffect(() => {
    if (view !== "my-day") return;
    api.calendarAgenda(todayYmd()).then(r => setTodayMeetings(r.meetings?.length ?? 0)).catch(() => setTodayMeetings(0));
  }, [view]);
  const viewTitle = view === "my-day" ? "My Day" : view === "important" ? "Important" : view === "calendar" ? "Calendar" : lists.find(l => l.id === view.slice(5))?.name ?? "List";
  const viewSubtitle = view === "my-day" ? todayYmd() : undefined;

  return (
    <div className="flex gap-4 h-[calc(100vh-140px)]">
      {/* Lists sidebar — all planner tools in one place */}
      <div className="w-56 shrink-0 space-y-1">
        <button type="button" onClick={() => setView("my-day")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${view === "my-day" ? "bg-ink-800 text-cream-50" : "text-cream-300/80 hover:bg-ink-900"}`}>
          <Sun size={15} /> My Day
        </button>
        <button type="button" onClick={() => setView("important")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${view === "important" ? "bg-ink-800 text-cream-50" : "text-cream-300/80 hover:bg-ink-900"}`}>
          <Star size={15} /> Important
        </button>
        <button type="button" onClick={() => setView("calendar")}
          className={`w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-left ${view === "calendar" ? "bg-ink-800 text-cream-50" : "text-cream-300/80 hover:bg-ink-900"}`}>
          <CalendarDays size={15} /> Calendar
        </button>
        <div className="pt-2 mt-2 border-t border-ink-800 space-y-1">
          {lists.map(l => (
            <div key={l.id} className={`group flex items-center gap-2 px-3 py-2 rounded-lg text-sm ${view === `list:${l.id}` ? "bg-ink-800 text-cream-50" : "text-cream-300/80 hover:bg-ink-900"}`}>
              <button type="button" onClick={() => setView(`list:${l.id}`)} className="flex-1 flex items-center gap-2 text-left min-w-0">
                <ListIcon size={15} className="shrink-0" /> <span className="truncate">{l.name}</span>
              </button>
              <button type="button" onClick={() => removeList(l.id, l.name)} className="opacity-0 group-hover:opacity-100 text-cream-300/40 hover:text-coral-400 shrink-0">
                <Trash2 size={13} />
              </button>
            </div>
          ))}
          {addingList ? (
            <div className="px-1">
              <input autoFocus value={newListName} onChange={e => setNewListName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") void addList(); if (e.key === "Escape") setAddingList(false); }}
                onBlur={() => void addList()}
                placeholder="List name" className="w-full bg-ink-950 border border-ink-800 rounded-lg px-2.5 py-1.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60" />
            </div>
          ) : (
            <button type="button" onClick={() => setAddingList(true)} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-sm text-cream-300/60 hover:bg-ink-900 hover:text-cream-100">
              <Plus size={15} /> New list
            </button>
          )}
        </div>
      </div>

      {/* Main panel — task list or calendar */}
      {view === "calendar" ? (
        <div className="flex-1 min-w-0 overflow-auto">
          <CalendarPage />
        </div>
      ) : (
        <>
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="mb-3">
              <h1 className="text-2xl font-semibold tracking-tight text-cream-50">{viewTitle}</h1>
              {viewSubtitle && <p className="text-sm text-cream-300/60">{new Date(viewSubtitle + "T12:00:00").toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</p>}
              {view === "my-day" && todayMeetings !== null && (
                <div className="mt-2 inline-flex items-center gap-2 text-[11px] px-2.5 py-1 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-300">
                  <CalendarDays size={11} /> {todayMeetings} meeting{todayMeetings === 1 ? "" : "s"} today · {incomplete.filter(i => i.dueDate === todayYmd()).length} tasks due
                </div>
              )}
            </div>

            <div className="flex items-center gap-2 mb-3">
              <input value={newTitle} onChange={e => setNewTitle(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void addTask(); }}
                placeholder="Add a task" className="flex-1 bg-ink-950 border border-ink-800 rounded-lg px-3 py-2.5 text-sm text-cream-100 focus:outline-none focus:border-violet-500/60" />
              <Button onClick={addTask} disabled={!newTitle.trim()}><Plus size={14} /> Add</Button>
            </div>

            <div className="flex-1 overflow-auto space-y-1">
              {loaded && incomplete.length === 0 && completed.length === 0 && (
                <Card><div className="text-center py-10 text-cream-300/50 text-sm">Nothing here yet.</div></Card>
              )}
              {incomplete.map(item => <TaskRow key={item.id} item={item} onToggle={() => toggle(item)} onOpen={() => setSelected(item)} />)}

              {completed.length > 0 && (
                <div className="pt-2">
                  <button type="button" onClick={() => setShowCompleted(s => !s)} className="flex items-center gap-1.5 text-xs text-cream-300/60 hover:text-cream-100 px-1 py-1.5">
                    {showCompleted ? <ChevronDown size={13} /> : <ChevronRight size={13} />} Completed ({completed.length})
                  </button>
                  {showCompleted && completed.map(item => <TaskRow key={item.id} item={item} onToggle={() => toggle(item)} onOpen={() => setSelected(item)} />)}
                </div>
              )}
            </div>
          </div>

          {selected && (
            <TaskDetail item={selected} lists={lists} onClose={() => setSelected(null)}
              onChange={patchLocal}
              onDeleted={() => { setItems(prev => prev.filter(i => i.id !== selected.id)); setSelected(null); }} />
          )}
        </>
      )}
    </div>
  );
}

function dueBadge(item: MyTaskItem): { text: string; overdue: boolean } | null {
  if (!item.dueDate) return null;
  const today = todayYmd();
  const overdue = !item.completed && item.dueDate < today;
  const text = item.dueDate === today ? "Today" : new Date(item.dueDate + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return { text, overdue };
}

function TaskRow({ item, onToggle, onOpen }: { item: MyTaskItem; onToggle: () => void; onOpen: () => void }) {
  const due = dueBadge(item);
  const stepsDone = item.steps.filter(s => s.done).length;
  return (
    <div className="group flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-ink-900 cursor-pointer" onClick={onOpen}>
      <button type="button" onClick={e => { e.stopPropagation(); onToggle(); }}
        className={`w-4.5 h-4.5 shrink-0 rounded-full border-2 grid place-items-center ${item.completed ? "bg-violet-500 border-violet-500" : "border-ink-600 hover:border-violet-400"}`}
        style={{ width: 18, height: 18 }}>
        {item.completed && <span className="w-2 h-2 rounded-full bg-ink-950" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm truncate ${item.completed ? "text-cream-300/40 line-through" : "text-cream-100"}`}>{item.title}</div>
        {(due || item.steps.length > 0) && (
          <div className="flex items-center gap-2 mt-0.5 text-[11px] text-cream-300/50">
            {due && <span className={due.overdue ? "text-coral-400" : ""}>{due.overdue ? "Overdue " : ""}{due.text}</span>}
            {item.steps.length > 0 && <span>{stepsDone}/{item.steps.length} steps</span>}
          </div>
        )}
      </div>
      {item.important && <Star size={14} className="text-amber-400 fill-amber-400 shrink-0" />}
    </div>
  );
}

function TaskDetail({ item, lists, onClose, onChange, onDeleted }: {
  item: MyTaskItem; lists: MyTaskList[]; onClose: () => void; onChange: (item: MyTaskItem) => void; onDeleted: () => void;
}) {
  const [notes, setNotes] = useState(item.notes ?? "");
  const [newStep, setNewStep] = useState("");
  useEffect(() => { setNotes(item.notes ?? ""); }, [item.id]);

  async function saveNotes() {
    if (notes === (item.notes ?? "")) return;
    try { const r = await api.updateMyTaskItem(item.id, { notes }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function setDue(v: string) {
    try { const r = await api.updateMyTaskItem(item.id, { dueDate: v || null }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function setReminder(v: string) {
    try { const r = await api.updateMyTaskItem(item.id, { reminderAt: v ? new Date(v).toISOString() : null }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function setImportant(v: boolean) {
    try { const r = await api.updateMyTaskItem(item.id, { important: v }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function setRepeat(rule: RepeatRule | null) {
    try { const r = await api.updateMyTaskItem(item.id, { repeat: rule }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function toggleMyDay() {
    try { const r = await api.setMyTaskItemMyDay(item.id, !item.myDay); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function addStep() {
    const title = newStep.trim();
    if (!title) return;
    setNewStep("");
    try { const r = await api.addMyTaskStep(item.id, title); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function toggleStep(stepId: string) {
    try { const r = await api.toggleMyTaskStep(item.id, stepId); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function removeStep(stepId: string) {
    try { const r = await api.removeMyTaskStep(item.id, stepId); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function moveList(listId: string) {
    try { const r = await api.updateMyTaskItem(item.id, { listId }); onChange(r.item); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  async function remove() {
    if (!confirm(`Delete "${item.title}"?`)) return;
    try { await api.removeMyTaskItem(item.id); onDeleted(); } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }
  const [automating, setAutomating] = useState(false);
  const [decomposing, setDecomposing] = useState(false);
  async function decomposeWithNaxie() {
    setDecomposing(true);
    try {
      const r = await api.chat([{ role: "user", content: `Break down this task into 3-5 short actionable steps, one per line, no numbering: "${item.title}"` + (item.notes ? `\nContext: ${item.notes}` : "") }]);
      const lines = String(r.text ?? "").split("\n").map(s => s.replace(/^\s*[-*\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 5);
      if (lines.length === 0) { showToast("Naxie didn't return steps", "error"); return; }
      let cur: MyTaskItem = item;
      for (const line of lines) {
        const res = await api.addMyTaskStep(cur.id, line);
        cur = res.item;
      }
      onChange(cur);
      showToast(`Added ${lines.length} steps via Naxie`, "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setDecomposing(false); }
  }
  const [automationBusy, setAutomationBusy] = useState(false);
  async function toggleAutomationEnabled() {
    if (!item.automation) return;
    setAutomationBusy(true);
    try { const r = await api.setTaskAutomation(item.id, { enabled: !item.automation.enabled }); onChange(r.item); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setAutomationBusy(false); }
  }
  async function runAutomationNow() {
    setAutomationBusy(true);
    try { const r = await api.runTaskAutomation(item.id); onChange(r.item); showToast(`Ran "${item.title}"`, "success"); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setAutomationBusy(false); }
  }
  async function removeAutomation() {
    if (!confirm(`Remove the automation from "${item.title}"? It stays as a regular to-do.`)) return;
    try { const r = await api.removeTaskAutomation(item.id); onChange(r.item); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60";

  return (
    <div className="w-80 shrink-0 border-l border-ink-800 pl-4 overflow-auto space-y-4">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm text-cream-100 font-medium">{item.title}</div>
        <button onClick={onClose} className="text-cream-300/50 hover:text-cream-100"><X size={16} /></button>
      </div>

      <div className="flex items-center gap-3 text-[12px]">
        <button type="button" onClick={() => setImportant(!item.important)} className={`flex items-center gap-1.5 ${item.important ? "text-amber-400" : "text-cream-300/60 hover:text-cream-100"}`}>
          <Star size={14} className={item.important ? "fill-amber-400" : ""} /> Important
        </button>
        <button type="button" onClick={toggleMyDay} className={`flex items-center gap-1.5 ${item.myDay ? "text-violet-300" : "text-cream-300/60 hover:text-cream-100"}`}>
          <Sun size={14} /> {item.myDay ? "In My Day" : "Add to My Day"}
        </button>
      </div>

      <div>
        <label className="flex items-center gap-1.5 text-[11px] text-cream-300/70 mb-1"><CalendarDays size={12} /> Due date</label>
        <input type="date" value={item.dueDate ?? ""} onChange={e => setDue(e.target.value)} className={FIELD} />
      </div>

      <div>
        <label className="flex items-center gap-1.5 text-[11px] text-cream-300/70 mb-1"><Bell size={12} /> Reminder</label>
        <input type="datetime-local" value={item.reminderAt ? item.reminderAt.slice(0, 16) : ""} onChange={e => setReminder(e.target.value)} className={FIELD} />
      </div>

      <div>
        <label className="flex items-center gap-1.5 text-[11px] text-cream-300/70 mb-1"><Repeat size={12} /> Repeat</label>
        <select
          value={item.repeat ? `${item.repeat.freq}:${item.repeat.interval}` : ""}
          onChange={e => {
            const v = e.target.value;
            if (!v) return setRepeat(null);
            const [freq, interval] = v.split(":");
            setRepeat({ freq: freq as RepeatRule["freq"], interval: Number(interval) });
          }}
          className={FIELD}
        >
          <option value="">Doesn't repeat</option>
          <option value="daily:1">Daily</option>
          <option value="weekly:1">Weekly</option>
          <option value="weekly:2">Every 2 weeks</option>
          <option value="monthly:1">Monthly</option>
        </select>
      </div>

      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Steps</label>
        <div className="space-y-1">
          {item.steps.map(s => (
            <div key={s.id} className="flex items-center gap-2 group">
              <input type="checkbox" checked={s.done} onChange={() => toggleStep(s.id)} className="accent-violet-500" />
              <span className={`flex-1 text-sm ${s.done ? "text-cream-300/40 line-through" : "text-cream-100"}`}>{s.title}</span>
              <button onClick={() => removeStep(s.id)} className="opacity-0 group-hover:opacity-100 text-cream-300/40 hover:text-coral-400"><X size={13} /></button>
            </div>
          ))}
        </div>
        <input value={newStep} onChange={e => setNewStep(e.target.value)} onKeyDown={e => { if (e.key === "Enter") void addStep(); }}
          placeholder="Add a step" className={`${FIELD} mt-1.5`} />
        <button type="button" onClick={decomposeWithNaxie} disabled={decomposing} className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] px-2.5 py-1 rounded-full border border-violet-500/30 bg-violet-500/10 text-violet-300 hover:bg-violet-500/15 disabled:opacity-50">
          {decomposing ? <Loader2 size={11} className="animate-spin" /> : <span className="text-[11px]">✦</span>} Break down with Naxie
        </button>
      </div>

      <div>
        <label className="block text-[11px] text-cream-300/70 mb-1">Notes</label>
        <textarea value={notes} onChange={e => setNotes(e.target.value)} onBlur={saveNotes} rows={4}
          placeholder="Add notes…" className={FIELD} />
      </div>

      {lists.length > 1 && (
        <div>
          <label className="block text-[11px] text-cream-300/70 mb-1">List</label>
          <select value={item.listId} onChange={e => moveList(e.target.value)} className={FIELD}>
            {lists.map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
        </div>
      )}

      <div className="pt-2 border-t border-ink-800">
        <label className="flex items-center gap-1.5 text-[11px] text-cream-300/70 mb-1.5"><Zap size={12} /> Automation</label>
        {item.automation ? (
          <div className="space-y-1.5">
            <div className="flex items-center gap-1.5 flex-wrap text-[11px] text-cream-300/70">
              {!item.automation.enabled && <span className="text-[10px] uppercase tracking-wider text-cream-300/50 bg-ink-850 border border-ink-700 rounded px-1.5 py-0.5">paused</span>}
              <span>{item.automation.cadence ? formatCadence(item.automation.cadence) : "On-demand"}</span>
              <span className="text-cream-300/40">·</span>
              <span>{item.automation.tools.length} tool{item.automation.tools.length === 1 ? "" : "s"}</span>
            </div>
            {item.automation.lastFiredAt && (
              <div className="text-[10px] text-cream-300/50">Last fired {new Date(item.automation.lastFiredAt).toLocaleString()}</div>
            )}
            {item.automation.lastError && (
              <div className="text-[10px] text-coral-400 flex items-start gap-1"><AlertTriangle size={11} className="mt-0.5" /> {item.automation.lastError}</div>
            )}
            <div className="flex items-center gap-1 pt-0.5">
              <button type="button" onClick={runAutomationNow} disabled={automationBusy} className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800" title="Run now" aria-label="Run now"><Play size={13} /></button>
              <button type="button" onClick={toggleAutomationEnabled} disabled={automationBusy} className="text-cream-300 hover:text-cream-50 p-1.5 rounded hover:bg-ink-800" title={item.automation.enabled ? "Pause" : "Resume"} aria-label={item.automation.enabled ? "Pause" : "Resume"}>
                {item.automation.enabled ? <Pause size={13} /> : <Play size={13} />}
              </button>
              <button type="button" onClick={() => setAutomating(true)} className="text-cream-300 hover:text-cream-50 text-[11px] px-2 py-1 rounded hover:bg-ink-800">Edit</button>
              <button type="button" onClick={removeAutomation} className="text-cream-300/70 hover:text-coral-400 p-1.5 rounded hover:bg-ink-800" title="Remove automation" aria-label="Remove automation"><Trash2 size={13} /></button>
            </div>
          </div>
        ) : (
          <button type="button" onClick={() => setAutomating(true)} className="flex items-center gap-1.5 text-[11px] px-2.5 py-1.5 rounded-lg border border-ink-800 bg-ink-950/50 text-cream-300 hover:border-violet-500/50 hover:text-cream-50">
            <Zap size={12} /> Make this a scheduled automation
          </button>
        )}
      </div>

      <button type="button" onClick={remove} className="flex items-center gap-1.5 text-[12px] text-coral-400/80 hover:text-coral-400">
        <Trash2 size={13} /> Delete task
      </button>

      {automating && (
        <AutomationModal item={item} onClose={() => setAutomating(false)} onSaved={saved => { onChange(saved); setAutomating(false); }} />
      )}
    </div>
  );
}

type ToolInfo = { name: string; description?: string; readonly?: boolean };

// Editor for a task's automation config — ported from the retired Workflow
// Tree page's node form, minus the workflow/task-id fields (this attaches to
// an EXISTING planner task, it doesn't create a new one).
function AutomationModal({ item, onClose, onSaved }: { item: MyTaskItem; onClose: () => void; onSaved: (item: MyTaskItem) => void }) {
  const a = item.automation;
  const [hasCadence, setHasCadence] = useState(!!a?.cadence);
  const [days, setDays] = useState<number[]>(a?.cadence?.daysOfWeek ?? [1, 2, 3, 4, 5]);
  const [hour, setHour] = useState(a?.cadence?.hour ?? 9);
  const [minute, setMinute] = useState(a?.cadence?.minute ?? 0);
  const [tools, setTools] = useState<string[]>(a?.tools ?? []);
  const [data, setData] = useState((a?.data ?? []).join(", "));
  const [outputPath, setOutputPath] = useState(a?.outputPath ?? "");
  const [toolCatalog, setToolCatalog] = useState<ToolInfo[]>([]);
  const [toolFilter, setToolFilter] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.automationToolCatalog().then(r => setToolCatalog(r.tools)).catch(() => {}); }, []);

  function toggleDay(d: number) {
    setDays(prev => prev.includes(d) ? prev.filter(x => x !== d) : [...prev, d].sort((x, y) => x - y));
  }
  function toggleTool(name: string) {
    setTools(prev => prev.includes(name) ? prev.filter(t => t !== name) : [...prev, name]);
  }

  async function save() {
    setSaving(true);
    try {
      const patch: Partial<TaskAutomation> = {
        enabled: a?.enabled ?? true,
        cadence: hasCadence ? { daysOfWeek: days, hour, minute } : undefined,
        tools,
        data: data.split(",").map(s => s.trim()).filter(Boolean),
        outputPath: outputPath.trim() || undefined,
      };
      const r = await api.setTaskAutomation(item.id, patch);
      showToast(a ? "Automation saved" : "Automation created", "success");
      onSaved(r.item);
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setSaving(false); }
  }

  const filteredTools = toolCatalog.filter(t => !toolFilter.trim() || t.name.toLowerCase().includes(toolFilter.toLowerCase()) || t.description?.toLowerCase().includes(toolFilter.toLowerCase()));
  const FIELD = "w-full bg-ink-950 border border-ink-800 text-sm text-cream-100 rounded-lg px-3 py-2 focus:outline-none focus:border-violet-500/60";

  return (
    <Modal open onClose={onClose} title={a ? `Edit automation — "${item.title}"` : `Automate "${item.title}"`} className="max-w-2xl">
      <div className="space-y-4 max-h-[70vh] overflow-y-auto pr-1">
        <label className="flex items-center gap-2 text-sm text-cream-100">
          <input type="checkbox" checked={hasCadence} onChange={e => setHasCadence(e.target.checked)} />
          Runs on a schedule (otherwise on-demand only — use "Run now")
        </label>

        {hasCadence && (
          <div className="space-y-2 pl-1 border-l-2 border-ink-800 ml-1">
            <div className="flex flex-wrap gap-1 pl-3">
              {DAY_LABELS.map((d, i) => (
                <Option key={d} selected={days.includes(i)} onToggle={() => toggleDay(i)}>{d}</Option>
              ))}
            </div>
            <div className="flex items-center gap-2 pl-3">
              <input type="number" min={0} max={23} value={hour} onChange={e => setHour(Number(e.target.value))} className="w-16 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-sm" />
              <span className="text-cream-300/50">:</span>
              <input type="number" min={0} max={59} value={minute} onChange={e => setMinute(Number(e.target.value))} className="w-16 bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-sm" />
              <span className="text-xs text-cream-300/50">local time</span>
            </div>
          </div>
        )}

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Vault paths this automation may read (optional, comma-separated)</label>
          <input value={data} onChange={e => setData(e.target.value)} placeholder="_neuroworks/" className={`${FIELD} font-mono`} />
        </div>

        <div>
          <label className="block text-[11px] uppercase tracking-wider text-cream-300/60 mb-1">Output path (optional)</label>
          <input value={outputPath} onChange={e => setOutputPath(e.target.value)} placeholder="_neuroworks/reports/{date}.md" className={`${FIELD} font-mono`} />
        </div>

        <div>
          <div className="flex items-center justify-between mb-1">
            <label className="block text-[11px] uppercase tracking-wider text-cream-300/60">Tools this automation may call ({tools.length} selected)</label>
          </div>
          <div className="relative mb-1.5">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-cream-300/40" />
            <input value={toolFilter} onChange={e => setToolFilter(e.target.value)} placeholder="Filter tools…" className="w-full bg-ink-950 border border-ink-800 rounded-md pl-7 pr-3 py-1.5 text-xs" />
          </div>
          <div className="max-h-40 overflow-y-auto border border-ink-800 rounded-md divide-y divide-ink-800">
            {filteredTools.map(t => (
              <label key={t.name} className="flex items-start gap-2 px-2 py-1.5 text-xs hover:bg-ink-900 cursor-pointer">
                <input type="checkbox" checked={tools.includes(t.name)} onChange={() => toggleTool(t.name)} className="mt-0.5" />
                <span className="font-mono text-cream-100 shrink-0">{t.name}</span>
                <span className="text-cream-300/50 truncate">{t.description}</span>
              </label>
            ))}
            {filteredTools.length === 0 && <div className="px-2 py-3 text-xs text-cream-300/50 text-center">No tools match.</div>}
          </div>
        </div>

        {a?.handler && (
          <div className="text-[11px] text-cream-300/50 font-mono">Handler: {a.handler} (not editable here)</div>
        )}

        <div className="text-xs text-cream-300/60 bg-ink-900/50 border border-ink-800 rounded-xl px-4 py-3 leading-relaxed">
          An automation runs with the tool allowlist above whenever its schedule fires, or immediately via "Run now" — same trust level as a scheduled job.
        </div>
      </div>
      <div className="flex justify-end gap-2 pt-4 border-t border-ink-800 mt-4">
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button onClick={() => void save()} disabled={saving}>{a ? "Save" : "Create automation"}</Button>
      </div>
    </Modal>
  );
}
