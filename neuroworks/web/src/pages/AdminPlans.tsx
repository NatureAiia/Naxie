import { CreditCard } from "lucide-react";
import { Card } from "../components/Card";

export function AdminPlans() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2"><CreditCard size={18} className="text-violet-400" /><h1 className="text-lg font-semibold text-cream-50">Plans</h1></div>
      <Card className="p-4">
        <p className="text-sm text-cream-300/70">Kuwana <code>Plan</code> per-portal tiers. Personal: single workspace plan (owner bootstrap). Future: <code>/api/plans</code> with Stripe when billing needed.</p>
      </Card>
    </div>
  );
}
