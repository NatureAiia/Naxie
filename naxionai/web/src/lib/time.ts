// Shared date/time helpers — single source of truth so every page doesn't
// re-implement the same 8-line function. Used by Connectors, GithubAccounts,
// Integrations, McpServers, Orchestrate, Webhooks, WhatsApp, and more.

/** Relative time like "5s ago", "12m ago", "3h ago", "2d ago". */
export function relTime(iso?: string | null): string {
  if (!iso) return "";
  const s = Math.max(1, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/** Format an ISO date as a short absolute timestamp, e.g. "Oct 10, 2026". */
export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

/** Format an ISO date as a time-only string, e.g. "2:30 PM". */
export function shortTime(iso?: string | null): string {
  if (!iso) return "";
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
}