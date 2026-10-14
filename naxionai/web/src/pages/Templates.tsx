import { useEffect, useMemo, useState } from "react";
import { api, Template, Role } from "../lib/api";
import { Card, RoleIcon } from "../components/Card";
import { TaskRunner } from "../components/TaskRunner";

export function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [roles, setRoles] = useState<Role[]>([]);
  const [activeRole, setActiveRole] = useState<string>("All");
  const [active, setActive] = useState<Template | null>(null);
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    api.listTemplates()
      .then(r => {
        setTemplates(r.templates);
        setRoles(r.roles);
      })
      .catch(e => {
        setError(e instanceof Error ? e.message : "Failed to load templates");
      })
      .finally(() => {
        setLoading(false);
      });
  }, []);

  const filtered = useMemo(() => {
    let xs = templates;
    if (activeRole !== "All") xs = xs.filter(t => t.role === activeRole);
    const q = filter.toLowerCase().trim();
    if (q) {
      xs = xs.filter(t => {
        const title = t.title?.toLowerCase() || "";
        const description = t.description?.toLowerCase() || "";
        const id = t.id?.toLowerCase() || "";
        return title.includes(q) || description.includes(q) || id.includes(q);
      });
    }
    return xs;
  }, [templates, activeRole, filter]);

  const totalCount = templates.length;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-3xl text-cream-50">Templates</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          Pre-built tasks you can hand to the AI workforce.{" "}
          {totalCount > 0 && <span className="ml-1">{totalCount} template{totalCount === 1 ? "" : "s"} available</span>}
        </p>
      </div>

      {error && (
        <Card>
          <div className="text-sm text-red-400 py-2">{error}</div>
        </Card>
      )}

      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => setActiveRole("All")}
          className={`px-3 py-1.5 rounded-full text-xs transition-colors ${activeRole === "All" ? "bg-cream-100 text-ink-950" : "bg-ink-800 text-cream-200 hover:bg-ink-700"}`}
        >
          All <span className="opacity-60 ml-1">{templates.length}</span>
        </button>
        {roles.map(r => (
          <button
            key={r.id}
            onClick={() => setActiveRole(r.id)}
            className={`px-3 py-1.5 rounded-full text-xs transition-colors ${activeRole === r.id ? "bg-cream-100 text-ink-950" : "bg-ink-800 text-cream-200 hover:bg-ink-700"}`}
          >
            {r.label} <span className="opacity-60 ml-1">{r.count}</span>
          </button>
        ))}
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="filter by name, description, or id..."
          className="ml-auto bg-ink-900 border border-ink-700 rounded-md px-3 py-1.5 text-xs w-56 focus:outline-none focus:border-violet-500 placeholder:text-cream-300/40"
        />
      </div>

      {loading ? (
        <Card>
          <div className="text-sm text-cream-300/60 text-center py-6">Loading templates...</div>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <div className="text-sm text-cream-300/60 text-center py-6">
            {filter ? `No templates match "${filter}"` : "No templates match this filter."}
          </div>
        </Card>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtered.map(t => (
            <button
              key={t.id}
              onClick={() => setActive(t)}
              className="text-left bg-ink-900 hover:bg-ink-850 border border-ink-800 hover:border-violet-500/40 rounded-xl p-4 transition-colors group"
              title={`Run ${t.title}`}
            >
              <div className="flex items-start gap-3">
                <RoleIcon role={t.role} />
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] text-cream-300/60 uppercase tracking-wider">{t.role}</div>
                  <div className="font-display text-lg text-cream-50 leading-tight group-hover:text-violet-300 transition-colors truncate">
                    {t.title}
                  </div>
                </div>
                {t.requiresApproval && (
                  <span className="text-[10px] text-flame-400 bg-flame-500/10 border border-flame-500/30 px-1.5 py-0.5 rounded flex-shrink-0">
                    approval
                  </span>
                )}
              </div>
              <div className="text-xs text-cream-300/70 mt-3 line-clamp-3 min-h-[3rem]">{t.description}</div>
              <div className="flex items-center justify-between mt-3">
                <div className="text-[10px] text-cream-300/40 font-mono">~{t.estimateSeconds}s</div>
                {t.runCount !== undefined && t.runCount > 0 && (
                  <div className="text-[10px] text-cream-300/60 flex items-center gap-1">
                    <span>runs</span>
                    <span className="font-mono">{t.runCount}</span>
                  </div>
                )}
              </div>
              {t.lastRunAt && (
                <div className="text-[10px] text-cream-300/40 mt-1 truncate">
                  Last run: {new Date(t.lastRunAt).toLocaleDateString()}
                </div>
              )}
            </button>
          ))}
        </div>
      )}

      {active && <TaskRunner template={active} onClose={() => setActive(null)} />}
    </div>
  );
}
