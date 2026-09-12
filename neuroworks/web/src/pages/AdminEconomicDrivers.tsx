import { TrendingUp } from "lucide-react";
import { Card } from "../components/Card";
import { GlassCard } from "../components/GlassCard";

export function AdminEconomicDrivers() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <TrendingUp size={18} className="text-violet-400" />
        <h1 className="text-lg font-semibold text-cream-50">Economic drivers</h1>
        <span className="text-xs text-cream-300/50">Kuwana EconomicDriver → personal: vault signal drivers</span>
      </div>
      <GlassCard className="p-4">
        <p className="text-sm text-cream-300/70">Global macro indicators (inflation, FX, rates) that price-trends reference. In Kuwana: <code>EconomicDriver</code> rows are admin-curated per period; basket index computed on read from <code>ListingPriceHistory</code>. Here: curated <code>_knowledge-packs/*/00-overview.md</code> + <code>vault/_neuroworks/orchestrations-sample.json</code> fill the same role — computed, not stored.</p>
        <div className="mt-3 text-[11px] text-cream-300/40">Next: wire <code>GET /api/knowledge-packs</code> → driver table; reuse <code>src/lib/marketBasket.ts</code> pattern.</div>
      </GlassCard>
      <Card className="p-4"><div className="text-sm text-cream-300/60">No drivers yet — add one via vault <code>_knowledge-packs/</code> or future <code>POST /api/admin/economic-drivers</code>.</div></Card>
    </div>
  );
}
