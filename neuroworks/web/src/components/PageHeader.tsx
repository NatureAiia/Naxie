import { ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronRight, ArrowLeft } from "lucide-react";

// PageHeader — ported from KimmyDeku/sebastian's src/components/ui/Page.tsx.
// Every page today hand-rolls its own `<h1 className="font-display text-3xl
// text-cream-50">` header (AgentApprovals.tsx, AmbientWatch.tsx, Brands.tsx,
// ...); this collects crumbs + title + subtitle + back + a right-side action
// slot into one component for pages that want it. Existing headers are left
// as-is — additive, not a forced rewrite.

export type Crumb = { label: string; to?: string };

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <nav className="flex items-center gap-1 text-xs text-cream-300/50 mb-1" aria-label="Breadcrumb">
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight size={11} className="text-cream-300/30" />}
          {c.to ? <Link to={c.to} className="hover:text-cream-100">{c.label}</Link> : <span>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

export function BackButton({ to, onClick, label = "Back" }: { to?: string; onClick?: () => void; label?: string }) {
  const cls = "inline-flex items-center gap-1 text-xs text-cream-300/70 hover:text-cream-100";
  if (to) return <Link to={to} className={cls}><ArrowLeft size={13} /> {label}</Link>;
  return <button type="button" onClick={onClick} className={cls}><ArrowLeft size={13} /> {label}</button>;
}

export function PageHeader({ crumbs, title, subtitle, back, action, icon }: {
  crumbs?: Crumb[];
  title: ReactNode;
  subtitle?: ReactNode;
  back?: { to?: string; onClick?: () => void; label?: string };
  action?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 flex-wrap mb-6">
      <div className="min-w-0">
        {crumbs && <Breadcrumbs items={crumbs} />}
        {back && <div className="mb-1"><BackButton {...back} /></div>}
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3">{icon}{title}</h1>
        {subtitle && <p className="text-sm text-cream-300/70 mt-1">{subtitle}</p>}
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}
