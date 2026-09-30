import { useEffect, useState } from "react";
import { Building2, Plus, Trash2, Pencil, TrendingUp, TriangleAlert, Hourglass, BadgeDollarSign } from "lucide-react";
import { Card, Button, showToast } from "../components/Card";
import { ConfirmDialog } from "../components/Modal";
import { PageHeader } from "../components/PageHeader";
import { apiResult } from "../lib/apiResult";

// "Business Finance" — Variety & Co's books: product price book (cost vs
// sell with margin), business income/expense tracking, deterministic leakage
// detection (recurring drains + category spikes), cash runway forecasting,
// and approval-gated big spends (parked as PendingSpend + OrgTask, resolved
// from the Approvals page or inline here). Separate store from My Finances
// (operator's own budget) — business money, not personal money.

type Margin = { amount: number; pct: number };
type Product = {
  id: string; name: string; category: string; costPrice: number; sellPrice: number;
  unit: string; active: boolean; notes?: string; margin: Margin;
};
type Txn = { id: string; type: "income" | "expense"; label: string; category: string; amount: number; date: string; productId?: string };
type Pending = { id: string; label: string; category: string; amount: number; date: string; taskId: string };
type Summary = {
  income: number; expenses: number; net: number;
  byCategory: { category: string; amount: number }[];
  topProducts: { productId: string; name: string; revenue: number; estMargin: number }[];
};
type Leak = { kind: "recurring" | "spike"; label: string; category: string; monthlyEstimate: number; occurrences: number; detail: string };
type Forecast = {
  monthsOfData: number; avgMonthlyIncome: number; avgMonthlyBurn: number; netMonthly: number;
  cashOnHand: number; runwayMonths: number | null;
  projection: { month: string; income: number; burn: number; cash: number }[];
};
type Settings = { approvalThreshold: number; cashOnHand: number };

const money = (n: number) => n.toLocaleString(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const pct = (n: number) => `${Math.round(n * 100)}%`;

export function BusinessFinance() {
  const [products, setProducts] = useState<Product[]>([]);
  const [txns, setTxns] = useState<Txn[]>([]);
  const [pending, setPending] = useState<Pending[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [leaks, setLeaks] = useState<Leak[]>([]);
  const [forecast, setForecast] = useState<Forecast | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [categories, setCategories] = useState<string[]>([]);
  const [newProduct, setNewProduct] = useState({ name: "", category: "Repair", costPrice: "", sellPrice: "", unit: "each" });
  const [editing, setEditing] = useState<Product | null>(null);
  const [newTxn, setNewTxn] = useState({ type: "income" as Txn["type"], label: "", category: "Sales", amount: "", date: new Date().toISOString().slice(0, 10), productId: "" });
  const [settingsDraft, setSettingsDraft] = useState({ approvalThreshold: "", cashOnHand: "" });
  const [confirmDeleteProduct, setConfirmDeleteProduct] = useState<Product | null>(null);

  async function load() {
    const [p, t, s, c, l, f, g] = await Promise.all([
      apiResult<{ products: Product[] }>("/api/business-finance/products"),
      apiResult<{ txns: Txn[] }>("/api/business-finance/txns"),
      apiResult<{ summary: Summary }>("/api/business-finance/summary"),
      apiResult<{ categories: string[]; settings: Settings }>("/api/business-finance/settings"),
      apiResult<{ leaks: Leak[] }>("/api/business-finance/leaks"),
      apiResult<{ forecast: Forecast }>("/api/business-finance/forecast"),
      apiResult<{ pending: Pending[] }>("/api/business-finance/pending"),
    ]);
    if (p.ok) setProducts(p.products);
    if (t.ok) setTxns(t.txns);
    if (s.ok) setSummary(s.summary);
    if (c.ok) { setCategories(c.categories); setSettings(c.settings); setSettingsDraft({ approvalThreshold: String(c.settings.approvalThreshold), cashOnHand: String(c.settings.cashOnHand) }); }
    if (l.ok) setLeaks(l.leaks);
    if (f.ok) setForecast(f.forecast);
    if (g.ok) setPending(g.pending);
  }
  useEffect(() => { void load(); }, []);

  async function saveProduct() {
    if (!newProduct.name.trim()) return;
    const body = { name: newProduct.name, category: newProduct.category, costPrice: Number(newProduct.costPrice) || 0, sellPrice: Number(newProduct.sellPrice) || 0, unit: newProduct.unit || "each" };
    const r = editing
      ? await apiResult(`/api/business-finance/products/${editing.id}`, { method: "PATCH", body: JSON.stringify(body) })
      : await apiResult("/api/business-finance/products", { method: "POST", body: JSON.stringify(body) });
    if (!r.ok) return showToast(r.error, "error");
    setNewProduct({ name: "", category: "Repair", costPrice: "", sellPrice: "", unit: "each" });
    setEditing(null);
    void load();
  }

  async function confirmDelete() {
    if (!confirmDeleteProduct) return;
    await apiResult(`/api/business-finance/products/${confirmDeleteProduct.id}`, { method: "DELETE" });
    setConfirmDeleteProduct(null);
    void load();
  }

  async function recordTxn() {
    if (!newTxn.label.trim() || !newTxn.amount) return;
    const r = await apiResult<{ txn?: Txn; pending?: Pending; approvalRequired?: boolean }>("/api/business-finance/txns", {
      method: "POST",
      body: JSON.stringify({
        type: newTxn.type, label: newTxn.label, category: newTxn.category,
        amount: Number(newTxn.amount), date: newTxn.date,
        ...(newTxn.type === "income" && newTxn.productId ? { productId: newTxn.productId } : {}),
      }),
    });
    if (!r.ok) return showToast(r.error, "error");
    if (r.approvalRequired) showToast(`Parked for approval (≥ ${money(settings?.approvalThreshold ?? 0)}) — see Approvals or Pending below.`, "success");
    setNewTxn({ type: "income", label: "", category: "Sales", amount: "", date: new Date().toISOString().slice(0, 10), productId: "" });
    void load();
  }

  async function resolvePending(taskId: string, approved: boolean) {
    const r = await apiResult(`/api/org-tasks/${taskId}/resolve`, { method: "PATCH", body: JSON.stringify({ approved }) });
    if (!r.ok) return showToast(r.error, "error");
    showToast(approved ? "Expense approved and posted." : "Expense rejected and dropped.", "success");
    void load();
  }

  async function saveSettings() {
    const r = await apiResult<{ settings: Settings }>("/api/business-finance/settings", {
      method: "PATCH",
      body: JSON.stringify({ approvalThreshold: Number(settingsDraft.approvalThreshold) || 0, cashOnHand: Number(settingsDraft.cashOnHand) || 0 }),
    });
    if (!r.ok) return showToast(r.error, "error");
    setSettings(r.settings);
    showToast("Business finance settings saved.", "success");
    void load();
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={<Building2 size={22} />} title="Business Finance" subtitle="Variety & Co's books — price book, cashflow, leaks, runway. Business money, not personal money." />

      {summary && (
        <div className="grid grid-cols-3 gap-3">
          <Card><div className="text-xs opacity-70">Income</div><div className="text-2xl text-emerald-300">{money(summary.income)}</div></Card>
          <Card><div className="text-xs opacity-70">Expenses</div><div className="text-2xl text-rose-300">{money(summary.expenses)}</div></Card>
          <Card><div className="text-xs opacity-70">Net</div><div className={`text-2xl ${summary.net >= 0 ? "text-emerald-300" : "text-rose-300"}`}>{money(summary.net)}</div></Card>
        </div>
      )}

      {forecast && (
        <Card>
          <div className="flex items-center gap-2 mb-2"><Hourglass size={16} /><h3 className="font-semibold">Runway & forecast</h3></div>
          <div className="text-sm opacity-80">
            {forecast.monthsOfData === 0 ? "No books yet — record income and expenses to build a forecast."
              : forecast.runwayMonths === null
                ? `Cashflow positive (${money(forecast.netMonthly)}/mo on ${forecast.monthsOfData} mo of books). No runway question.`
                : `Burning ${money(forecast.avgMonthlyBurn - forecast.avgMonthlyIncome)}/mo against ${money(forecast.cashOnHand)} cash → ~${forecast.runwayMonths} months of runway.`}
          </div>
          {forecast.projection.length > 0 && forecast.monthsOfData > 0 && (
            <div className="mt-2 text-sm grid grid-cols-3 gap-2">
              {forecast.projection.map(p => (
                <div key={p.month} className="opacity-80">{p.month}: <span className="text-emerald-300/90">+{money(p.income)}</span> <span className="text-rose-300/90">-{money(p.burn)}</span> → {money(p.cash)}</div>
              ))}
            </div>
          )}
          {summary && summary.topProducts.length > 0 && (
            <div className="mt-2 text-sm">
              <span className="opacity-70">Top products: </span>
              {summary.topProducts.map(p => `${p.name} (${money(p.revenue)}, ~${money(p.estMargin)} margin)`).join(" · ")}
            </div>
          )}
        </Card>
      )}

      {leaks.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-2"><TriangleAlert size={16} /><h3 className="font-semibold">Leaks ({leaks.length})</h3></div>
          <ul className="space-y-1 text-sm">
            {leaks.map((l, i) => (
              <li key={i} className="opacity-90">
                <span className="text-amber-300">[{l.kind === "recurring" ? "recurring" : "spike"}]</span> {l.label} — {l.detail}
              </li>
            ))}
          </ul>
        </Card>
      )}

      {pending.length > 0 && (
        <Card>
          <div className="flex items-center gap-2 mb-2"><BadgeDollarSign size={16} /><h3 className="font-semibold">Awaiting approval ({pending.length})</h3></div>
          <ul className="space-y-2 text-sm">
            {pending.map(p => (
              <li key={p.id} className="flex items-center justify-between gap-2">
                <span>{p.label} — {money(p.amount)} <span className="opacity-60">({p.category}, {p.date})</span></span>
                <span className="flex gap-2">
                  <Button onClick={() => resolvePending(p.taskId, true)}>Approve</Button>
                  <Button onClick={() => resolvePending(p.taskId, false)}>Reject</Button>
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card>
        <div className="flex items-center gap-2 mb-3"><TrendingUp size={16} /><h3 className="font-semibold">Price book</h3></div>
        {products.length > 0 && (
          <table className="w-full text-sm mb-3">
            <thead><tr className="text-left opacity-60"><th>Product</th><th>Category</th><th>Cost</th><th>Sell</th><th>Margin</th><th></th></tr></thead>
            <tbody>
              {products.map(p => (
                <tr key={p.id} className="border-t border-white/10">
                  <td>{p.name} <span className="opacity-50">/{p.unit}{!p.active && " (off)"}</span></td>
                  <td className="opacity-70">{p.category}</td>
                  <td>{money(p.costPrice)}</td>
                  <td>{money(p.sellPrice)}</td>
                  <td className={p.margin.amount >= 0 ? "text-emerald-300" : "text-rose-300"}>{money(p.margin.amount)} ({pct(p.margin.pct)})</td>
                  <td className="text-right whitespace-nowrap">
                    <button className="opacity-60 hover:opacity-100 mr-2" onClick={() => { setEditing(p); setNewProduct({ name: p.name, category: p.category, costPrice: String(p.costPrice), sellPrice: String(p.sellPrice), unit: p.unit }); }}><Pencil size={14} /></button>
                    <button className="opacity-60 hover:opacity-100" onClick={() => setConfirmDeleteProduct(p)}><Trash2 size={14} /></button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="flex flex-wrap gap-2 items-end">
          <input className="bg-white/5 rounded px-2 py-1 text-sm" placeholder="Product name" value={newProduct.name} onChange={e => setNewProduct({ ...newProduct, name: e.target.value })} />
          <input className="bg-white/5 rounded px-2 py-1 text-sm w-24" placeholder="Category" value={newProduct.category} onChange={e => setNewProduct({ ...newProduct, category: e.target.value })} />
          <input className="bg-white/5 rounded px-2 py-1 text-sm w-24" placeholder="Cost" inputMode="decimal" value={newProduct.costPrice} onChange={e => setNewProduct({ ...newProduct, costPrice: e.target.value })} />
          <input className="bg-white/5 rounded px-2 py-1 text-sm w-24" placeholder="Sell" inputMode="decimal" value={newProduct.sellPrice} onChange={e => setNewProduct({ ...newProduct, sellPrice: e.target.value })} />
          <input className="bg-white/5 rounded px-2 py-1 text-sm w-20" placeholder="Unit" value={newProduct.unit} onChange={e => setNewProduct({ ...newProduct, unit: e.target.value })} />
          <Button onClick={saveProduct}><Plus size={14} /> {editing ? "Save" : "Add"}</Button>
          {editing && <Button onClick={() => { setEditing(null); setNewProduct({ name: "", category: "Repair", costPrice: "", sellPrice: "", unit: "each" }); }}>Cancel</Button>}
        </div>
      </Card>

      <Card>
        <div className="flex items-center gap-2 mb-3"><Plus size={16} /><h3 className="font-semibold">Record movement</h3></div>
        <div className="flex flex-wrap gap-2 items-end">
          <select className="bg-white/5 rounded px-2 py-1 text-sm" value={newTxn.type} onChange={e => setNewTxn({ ...newTxn, type: e.target.value as Txn["type"] })}>
            <option value="income">Income</option>
            <option value="expense">Expense</option>
          </select>
          <input className="bg-white/5 rounded px-2 py-1 text-sm" placeholder="Label" value={newTxn.label} onChange={e => setNewTxn({ ...newTxn, label: e.target.value })} />
          <select className="bg-white/5 rounded px-2 py-1 text-sm" value={newTxn.category} onChange={e => setNewTxn({ ...newTxn, category: e.target.value })}>
            {categories.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          {newTxn.type === "income" && products.length > 0 && (
            <select className="bg-white/5 rounded px-2 py-1 text-sm" value={newTxn.productId} onChange={e => setNewTxn({ ...newTxn, productId: e.target.value })}>
              <option value="">No product link</option>
              {products.filter(p => p.active).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          )}
          <input className="bg-white/5 rounded px-2 py-1 text-sm w-28" placeholder="Amount" inputMode="decimal" value={newTxn.amount} onChange={e => setNewTxn({ ...newTxn, amount: e.target.value })} />
          <input className="bg-white/5 rounded px-2 py-1 text-sm" type="date" value={newTxn.date} onChange={e => setNewTxn({ ...newTxn, date: e.target.value })} />
          <Button onClick={recordTxn}>Record</Button>
        </div>
        {newTxn.type === "expense" && settings && Number(newTxn.amount) >= settings.approvalThreshold && settings.approvalThreshold > 0 && (
          <div className="text-xs text-amber-300/90 mt-1">At or above the {money(settings.approvalThreshold)} approval threshold — this will park for approval instead of posting.</div>
        )}
        {txns.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm max-h-64 overflow-y-auto">
            {txns.slice(0, 30).map(t => (
              <li key={t.id} className="opacity-80">{t.date} — {t.label} <span className="opacity-60">({t.category})</span> <span className={t.type === "income" ? "text-emerald-300" : "text-rose-300"}>{t.type === "income" ? "+" : "-"}{money(t.amount)}</span></li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h3 className="font-semibold mb-2">Settings</h3>
        <div className="flex flex-wrap gap-2 items-end text-sm">
          <label className="opacity-70">Approval threshold ($)
            <input className="ml-2 bg-white/5 rounded px-2 py-1" inputMode="decimal" value={settingsDraft.approvalThreshold} onChange={e => setSettingsDraft({ ...settingsDraft, approvalThreshold: e.target.value })} />
          </label>
          <label className="opacity-70">Cash on hand ($)
            <input className="ml-2 bg-white/5 rounded px-2 py-1" inputMode="decimal" value={settingsDraft.cashOnHand} onChange={e => setSettingsDraft({ ...settingsDraft, cashOnHand: e.target.value })} />
          </label>
          <Button onClick={saveSettings}>Save</Button>
        </div>
      </Card>

      <ConfirmDialog
        open={!!confirmDeleteProduct}
        title="Delete product?"
        body={`Remove "${confirmDeleteProduct?.name}" from the price book? Past sale rows keep their labels but lose the product link.`}
        onCancel={() => setConfirmDeleteProduct(null)}
        onConfirm={confirmDelete}
      />
    </div>
  );
}
