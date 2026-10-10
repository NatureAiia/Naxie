// Route chunk prefetching. Every page is React.lazy'd (App.tsx), so its JS
// chunk isn't fetched until the route mounts — the first click on a nav item
// pays a network round-trip before anything renders. This maps each route's
// path prefix to its dynamic import() thunk so the Layout can warm the chunk
// on nav-hover (and a couple of high-traffic routes on idle after first
// paint). import() is memoized by the bundler — calling a thunk twice is free,
// the second call resolves from cache — so preloading is pure upside: if the
// user clicks, the chunk is already in flight or done; if they don't, one
// cached fetch is the only cost.
//
// Keys are matched by longest-prefix against location.pathname, so
// "/runs/:id" preloads via the "/runs" entry.

type Thunk = () => Promise<unknown>;

const preloaders: Record<string, Thunk> = {
  "/naxie": () => import("../pages/Naxie"),
  "/naxie/memory": () => import("../pages/NaxieMemory"),
  "/my-finances": () => import("../pages/MyFinances"),
  "/council": () => import("../pages/Council"),
  "/chat": () => import("../pages/Council"),
  "/orchestrate": () => import("../pages/Council"),
  "/runs": () => import("../pages/MyWork"),
  "/approvals": () => import("../pages/MyWork"),
  "/planner": () => import("../pages/Planner"),
  "/my-tasks": () => import("../pages/Planner"),
  "/calendar": () => import("../pages/Planner"),
  "/schedules": () => import("../pages/Schedules"),
  "/ide": () => import("../pages/IDE"),
  "/library": () => import("../pages/Library"),
  "/daily-reports": () => import("../pages/DailyReports"),
  "/templates": () => import("../pages/Templates"),
  "/skills": () => import("../pages/Skills"),
  "/extensions": () => import("../pages/Extensions"),
  "/automation": () => import("../pages/Automation"),
  "/office": () => import("../pages/Office"),
  "/command": () => import("../pages/CommandCenter"),
  "/connectors": () => import("../pages/Connectors"),
  "/mcp-servers": () => import("../pages/McpServers"),
  "/hermes": () => import("../pages/Hermes"),
  "/brands": () => import("../pages/Brands"),
  "/integrations": () => import("../pages/Integrations"),
  "/policies": () => import("../pages/Policies"),
  "/audit": () => import("../pages/AuditLog"),
  "/org-dashboard": () => import("../pages/CommandCenter"),
  "/cost": () => import("../pages/Cost"),
  "/models": () => import("../pages/Models"),
  "/ambient": () => import("../pages/MyWork"), // now a tab inside My Work, not its own page
  "/edit": () => import("../pages/DocEditor"),
  "/my-work": () => import("../pages/MyWork"),
};

const warmed = new Set<string>();

/** Warm the chunk for a route path (idempotent — each chunk fetched at most once). */
export function preloadRoute(path: string): void {
  // Longest-prefix match so nested paths (/runs/123) hit their parent entry.
  let best = "";
  for (const key of Object.keys(preloaders)) {
    if (path === key || path.startsWith(key + "/")) {
      if (key.length > best.length) best = key;
    }
  }
  if (!best || warmed.has(best)) return;
  warmed.add(best);
  try { void preloaders[best](); } catch { warmed.delete(best); }
}

/** After first paint, prefetch the routes a user almost always visits next. */
export function preloadLikelyRoutes(): void {
  const run = () => { preloadRoute("/council"); preloadRoute("/my-work"); };
  if (typeof (window as any).requestIdleCallback === "function") {
    (window as any).requestIdleCallback(run, { timeout: 2500 });
  } else {
    setTimeout(run, 1500);
  }
}
