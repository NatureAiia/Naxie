import { Receipt } from "lucide-react";
import { Card } from "../components/Card";

export function AdminTransactions() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2"><Receipt size={18} className="text-violet-400" /><h1 className="text-lg font-semibold text-cream-50">Transactions</h1></div>
      <Card className="p-4">
        <p className="text-sm text-cream-300/70">Mirrors Kuwana FINANCE → Transactions. Personal: cost ledger <code>_neuroworks/cost.jsonl</code> + <code>/api/cost/summary</code>. Wallet top-ups (Paynow) land in <code>WalletTransaction</code> when enabled.</p>
        <div className="text-[11px] text-cream-300/40 mt-2">See <a href="/cost" className="underline">Cost</a> for live spend.</div>
      </Card>
    </div>
  );
}
