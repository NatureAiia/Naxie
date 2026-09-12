import { ShoppingBasket } from "lucide-react";
import { Card } from "../components/Card";
import { GlassCard } from "../components/GlassCard";

export function AdminMarketBaskets() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <ShoppingBasket size={18} className="text-violet-400" />
        <h1 className="text-lg font-semibold text-cream-50">Market baskets</h1>
        <span className="text-xs text-cream-300/50">Kuwana MarketBasketItem → personal: vault pack baskets</span>
      </div>
      <GlassCard className="p-4">
        <p className="text-sm text-cream-300/70">Named baskets (e.g. Consumer Price Basket → mealie-meal, diesel, data bundle) admin-curated; index stays <b>computed on read</b> from each component's <code>ListingPriceHistory</code> via <code>getBasketIndexTrend</code> — same shape as every other trend in Kuwana.</p>
        <div className="mt-3 text-[11px] text-cream-300/40">Personal mapping: each <code>_knowledge-packs/&lt;pack&gt;</code> is a basket; files inside are items.</div>
      </GlassCard>
      <Card className="p-4"><div className="text-sm text-cream-300/60">Baskets read from <code>neuroworks/vault/_knowledge-packs/</code> (12 packs seeded). Create a pack in the vault to add a basket.</div></Card>
    </div>
  );
}
