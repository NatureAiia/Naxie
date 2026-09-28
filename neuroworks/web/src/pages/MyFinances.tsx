import { useEffect, useState } from "react";
import { PiggyBank, Plus, Trash2, Sparkles, Wallet } from "lucide-react";
import { Card, Button, showToast } from "../components/Card";
import { Notice } from "../components/Notice";
import { ConfirmDialog } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { apiResult } from "../lib/apiResult";

// "My Finances" — the operator's OWN budget (savings plans + income/expense
// tracking), ported from KimmyDeku/sebastian's Money suite. Deliberately
// separate from Aria's company/market finance feed (routes/public-finance.ts)
// — this is personal, not company data. The 50/30/20 split and category
// breakdown are plain arithmetic on the operator's own recorded figures;
// the optional AI assessment is explicitly user-triggered (a button, never
// automatic) and carries the non-advice disclaimer at three layers: the
// prompt itself, this page's subtitle, and a persistent Notice under every
// result — not just a one-time modal.

type Plan = {
  id: string; name: string; target: number; frequency: "weekly" | "monthly" | "flexible"; commitment: number;
  deposits: { id: string; amount: number; at: string; note?: string }[];
  archived: boolean;
  progress: { saved: number; pct: number };
};
type Txn = { id: string; type: "income" | "expense"; label: string; category: string; amount: number; date: string };
type Summary = {
  income: number; expenses: number; net: number;
  byCategory: { category: string; amount: number }[];
  fiftyThirtyTwenty: { needs: number; wants: number; save: number };
};
type Assessment = { headline: string; savingsPlan: string[]; cutBack: string[] };

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function MyFinances() {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [newPlan, setNewPlan] = useState({ name: "", target: "", frequency: "monthly" as Plan["frequency"], commitment: "" });
  const [newTxn, setNewTxn] = useState({ type: "expense" as Txn["type"], label: "", category: "Other", amount: "", date: new Date().toISOString().slice(0, 10) });
  const [depositFor, setDepositFor] = useState<Plan | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [assessing, setAssessing] = useState(false);
  const [confirmDeletePlan, setConfirmDeletePlan] = useState<Plan | null>(null);

  async function load() {
    const [p, t, s, c] = await Promise.all([
      apiResult<{ plans: Plan[] }>("/api/personal-finance/plans"),
      apiResult<{ txns: Txn[] }>("/api/personal-finance/txns"),
      apiResult<{ summary: Summary }>("/api/personal-finance/summary"),
      apiResult<{ categories: string[] }>("/api/personal-finance/categories"),
    ]);
    if (p.ok) setPlans(p.plans);
    if (t.ok) setTxns(t.txns);
    if (s.ok) setSummary(s.summary);
    if (c.ok) setCategories(c.categories);
  }
  useEffect(() => { void load(); }, []);

  async function createPlan() {
    if (!newPlan.name.trim() || !newPlan.target) return;
    const r = await apiResult("/api/personal-finance/plans", {
      method: "POST",
      body: JSON.stringify({ name: newPlan.name, target: Number(newPlan.target), frequency: newPlan.frequency, commitment: Number(newPlan.commitment) || 0 }),
    });
    if (!r.ok) return showToast(r.error, "error");
    setNewPlan({ name: "", target: "", frequency: "monthly", commitment: "" });
    void load();
  }

  async function confirmDelete() {
    if (!confirmDeletePlan) return;
    await apiResult(`/api/personal-finance/plans/${confirmDeletePlan.id}`, { method: "DELETE" });
    setConfirmDeletePlan(null);
    void load();
  }

  async function deposit() {
    if (!depositFor || !depositAmount) return;
    const r = await apiResult(`/api/personal-finance/plans/${depositFor.id}/deposits`, { method: "POST", body: JSON.stringify({ amount: Number(depositAmount) }) });
    if (!r.ok) return showToast(r.error, "error");
    setDepositFor(null); setDepositAmount("");
    void load();
  }

  async function addTxn() {
    if (!newTxn.label.trim() || !newTxn.amount) return;
    const r = await apiResult("/api/personal-finance/txns", { method: "POST", body: JSON.stringify(newTxn) });
    if (!r.ok) return showToast(r.error, "error");
    setNewTxn({ ...newTxn, label: "", amount: "" });
    void load();
  }

  async function runAssessment() {
    setAssessing(true);
    try {
      const r = await apiResult<{ assessment: Assessment }>("/api/personal-finance/assess", { method: "POST" });
      if (!r.ok) return showToast(r.error, "error");
      setAssessment(r.assessment);
    } finally { setAssessing(false); }
  }

  return (
    <div className="max-w-5xl mx-auto space-y-6">
      <PageHeader
        icon={<PiggyBank size={22} className="text-leaf-400" />}
        title="My Finances"
        subtitle="Your own savings plans and spending — organisation, not financial advice."
      />

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <Card title="Income">{summary && <div className="text-2xl text-leaf-400 font-medium">{money(summary.income)}</div>}</Card>
        <Card title="Expenses">{summary && <div className="text-2xl text-coral-400 font-medium">{money(summary.expenses)}</div>}</Card>
        <Card title="Net">{summary && <div className={`text-2xl font-medium ${summary.net >= 0 ? "text-leaf-400" : "text-coral-400"}`}>{money(summary.net)}</div>}</Card>
      </div>

      {summary && (
        <Card title="50 / 30 / 20 split (from recorded income)">
          <div className="grid grid-cols-3 gap-3 text-center">
            <div><div className="text-xs text-cream-300/60">Needs (50%)</div><div className="text-lg text-cream-100">{money(summary.fiftyThirtyTwenty.needs)}</div></div>
            <div><div className="text-xs text-cream-300/60">Wants (30%)</div><div className="text-lg text-cream-100">{money(summary.fiftyThirtyTwenty.wants)}</div></div>
            <div><div className="text-xs text-cream-300/60">Save (20%)</div><div className="text-lg text-cream-100">{money(summary.fiftyThirtyTwenty.save)}</div></div>
          </div>
          {summary.byCategory.length > 0 && (
            <div className="mt-4 space-y-1.5">
              <div className="text-xs text-cream-300/60 mb-1">Where it goes</div>
              {summary.byCategory.map(c => (
                <div key={c.category} className="flex items-center gap-2 text-xs">
                  <span className="w-24 shrink-0 text-cream-300/70">{c.category}</span>
                  <div className="flex-1 h-2 bg-ink-800 rounded-full overflow-hidden">
                    <div className="h-full bg-violet-500" style={{ width: `${Math.min(100, (c.amount / (summary.expenses || 1)) * 100)}%` }} />
                  </div>
                  <span className="w-16 text-right text-cream-100">{money(c.amount)}</span>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}

      <Card
        title="AI assessment"
        action={<Button variant="subtle" onClick={() => void runAssessment()} disabled={assessing}><Sparkles size={13} /> {assessing ? "Reviewing…" : "Get an assessment"}</Button>}
      >
        {assessment ? (
          <div className="space-y-3">
            <div className="text-sm text-cream-100">{assessment.headline}</div>
            {assessment.savingsPlan.length > 0 && (
              <div>
                <div className="text-xs text-cream-300/60 mb-1">Ideas for saving</div>
                <ul className="list-disc ml-4 text-xs text-cream-300/80 space-y-0.5">{assessment.savingsPlan.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            {assessment.cutBack.length > 0 && (
              <div>
                <div className="text-xs text-cream-300/60 mb-1">Where you could cut back</div>
                <ul className="list-disc ml-4 text-xs text-cream-300/80 space-y-0.5">{assessment.cutBack.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </div>
            )}
            <Notice tone="ai">
              These are the figures you've recorded. Naxie offers budgeting guidance, not regulated financial advice, and never moves money.
            </Notice>
          </div>
        ) : (
          <p className="text-xs text-cream-300/60">Click "Get an assessment" for Naxie's read on your recorded figures — nothing runs automatically.</p>
        )}
      </Card>

      <Card title="Savings plans">
        <div className="grid grid-cols-1 md:grid-cols-[1fr_100px_120px_100px_auto] gap-2 mb-4">
          <input value={newPlan.name} onChange={e => setNewPlan(s => ({ ...s, name: e.target.value }))} placeholder="Plan name" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <input value={newPlan.target} onChange={e => setNewPlan(s => ({ ...s, target: e.target.value }))} placeholder="Target $" type="number" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <select value={newPlan.frequency} onChange={e => setNewPlan(s => ({ ...s, frequency: e.target.value as Plan["frequency"] }))} className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs">
            <option value="weekly">Weekly</option>
            <option value="monthly">Monthly</option>
            <option value="flexible">Flexible</option>
          </select>
          <input value={newPlan.commitment} onChange={e => setNewPlan(s => ({ ...s, commitment: e.target.value }))} placeholder="Commit $" type="number" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <Button onClick={() => void createPlan()} disabled={!newPlan.name.trim() || !newPlan.target}><Plus size={13} /> Add</Button>
        </div>
        <div className="space-y-3">
          {plans.length === 0 && <p className="text-xs text-cream-300/60">No savings plans yet.</p>}
          {plans.map(p => (
            <div key={p.id} className="border border-ink-800 rounded-lg p-3">
              <div className="flex items-center justify-between">
                <div className="text-sm text-cream-100">{p.name}</div>
                <div className="flex items-center gap-2">
                  <Button variant="subtle" onClick={() => setDepositFor(p)}>Add deposit</Button>
                  <button onClick={() => setConfirmDeletePlan(p)} className="text-cream-300/50 hover:text-coral-400 p-1"><Trash2 size={13} /></button>
                </div>
              </div>
              <div className="mt-2 h-2 bg-ink-800 rounded-full overflow-hidden">
                <div className="h-full bg-leaf-500" style={{ width: `${p.progress.pct * 100}%` }} />
              </div>
              <div className="mt-1 text-[11px] text-cream-300/60">{money(p.progress.saved)} of {money(p.target)} · {p.frequency} commitment {money(p.commitment)}</div>
            </div>
          ))}
        </div>
      </Card>

      <Card title="Log income / expense">
        <div className="grid grid-cols-1 md:grid-cols-[100px_1fr_120px_100px_130px_auto] gap-2">
          <select value={newTxn.type} onChange={e => setNewTxn(s => ({ ...s, type: e.target.value as Txn["type"] }))} className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs">
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          <input value={newTxn.label} onChange={e => setNewTxn(s => ({ ...s, label: e.target.value }))} placeholder="Label" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <select value={newTxn.category} onChange={e => setNewTxn(s => ({ ...s, category: e.target.value }))} className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs">
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <input value={newTxn.amount} onChange={e => setNewTxn(s => ({ ...s, amount: e.target.value }))} placeholder="Amount" type="number" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <input value={newTxn.date} onChange={e => setNewTxn(s => ({ ...s, date: e.target.value }))} type="date" className="bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-xs" />
          <Button onClick={() => void addTxn()} disabled={!newTxn.label.trim() || !newTxn.amount}><Wallet size={13} /> Log</Button>
        </div>
        <div className="mt-4 divide-y divide-ink-800">
          {txns.slice(0, 15).map(t => (
            <div key={t.id} className="py-2 flex items-center justify-between text-xs">
              <div>
                <span className="text-cream-100">{t.label}</span>
                <span className="text-cream-300/50 ml-2">{t.category} · {t.date}</span>
              </div>
              <span className={t.type === "income" ? "text-leaf-400" : "text-coral-400"}>{t.type === "income" ? "+" : "-"}{money(t.amount)}</span>
            </div>
          ))}
        </div>
      </Card>

      <ConfirmDialog
        open={depositFor !== null}
        title={`Add deposit to "${depositFor?.name}"`}
        rows={[["Currently saved", depositFor ? money(depositFor.progress.saved) : ""]]}
        body={<input autoFocus value={depositAmount} onChange={e => setDepositAmount(e.target.value)} type="number" placeholder="Amount" className="w-full bg-ink-950 border border-ink-800 rounded-md px-2 py-1.5 text-sm" />}
        confirmLabel="Add"
        onConfirm={() => void deposit()}
        onCancel={() => { setDepositFor(null); setDepositAmount(""); }}
      />

      <ConfirmDialog
        open={confirmDeletePlan !== null}
        title={`Delete "${confirmDeletePlan?.name}"?`}
        body="This removes the plan and its deposit history. It doesn't affect your logged income/expenses."
        confirmLabel="Delete"
        danger
        onConfirm={() => void confirmDelete()}
        onCancel={() => setConfirmDeletePlan(null)}
      />
    </div>
  );
}
