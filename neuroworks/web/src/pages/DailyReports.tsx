import { useEffect, useState } from "react";
import { marked } from "marked";
import { api } from "../lib/api";
import { Card } from "../components/Card";
import { useLoadMore, LoadMoreButton } from "../components/LoadMore";

// Daily Reports — the human-readable face of the nightly reflection, plus
// the Innovation Scan digest. Two tabs on one page: "Reflections" (what ran,
// how it went) and "Innovation Scan" (fixing our own weak spots + what's new
// in AI/tech), same tab-toggle pattern used elsewhere (see MyWork.tsx).

type ReflectionMeta = { date: string; path: string; preview: string; stats?: any };

export function DailyReports() {
  const [tab, setTab] = useState<"reflections" | "innovation-scan">("reflections");
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-cream-100">Daily Reports</h1>
        <p className="text-sm text-cream-300/70 mt-1">
          What your organization did each day, and what it's learning about the wider world.
        </p>
      </div>
      <div className="flex items-center gap-1 border-b border-ink-800">
        {([["reflections", "Reflections"], ["innovation-scan", "Innovation Scan"]] as const).map(([id, label]) => (
          <button
            key={id}
            type="button"
            onClick={() => setTab(id)}
            className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-colors ${
              tab === id ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === "reflections" ? <ReflectionsTab /> : <InnovationScanTab />}
    </div>
  );
}

function ReflectionsTab() {
  const [list, setList] = useState<ReflectionMeta[]>([]);
  const reportList = useLoadMore(list);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listReflections()
      .then(r => {
        setList(r.reflections);
        if (!selected && r.reflections.length > 0) setSelected(r.reflections[0].date);
      })
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!selected) return;
    setBody("");
    api.getReflection(selected)
      .then(r => setBody(r.body.replace(/^---[\s\S]*?---\n+/, "")))
      .catch(e => setBody(`_Couldn't load this report: ${String(e?.message ?? e)}_`));
  }, [selected]);

  const reflectNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runReflection(24);
      setSelected(r.date);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-cream-300/70">
          Successes, failures, and the lessons the system took from them.
        </p>
        <button
          onClick={reflectNow}
          disabled={running}
          className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {running ? "Reflecting…" : "Reflect now"}
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-2">
          {loading && <div className="text-sm text-cream-300/60">Loading reports…</div>}
          {!loading && list.length === 0 && (
            <Card title="No reports yet">
              <p className="text-sm text-cream-300/70">
                The nightly reflection runs at ~2 AM and writes its first report after a day of
                activity. Or press <span className="text-cream-100">Reflect now</span> to generate
                one for the last 24 hours.
              </p>
            </Card>
          )}
          {reportList.visible.map(r => (
            <button
              key={r.date}
              onClick={() => setSelected(r.date)}
              className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                selected === r.date
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-cream-100/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium text-cream-100">{r.date}</div>
              {r.stats?.totalTasks !== undefined && (
                <div className="text-xs text-cream-300/60 mt-0.5">
                  {r.stats.totalTasks} tasks · {r.stats.successRate !== undefined ? `${Math.round(Number(r.stats.successRate) * 100)}% success` : ""}
                </div>
              )}
              <div className="text-xs text-cream-300/50 mt-1 line-clamp-2">{r.preview}</div>
            </button>
          ))}
          <LoadMoreButton state={reportList} noun="reports" />
        </div>

        <div>
          {selected ? (
            <Card title={`Report — ${selected}`}>
              {body
                ? <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                : <div className="text-sm text-cream-300/60">Loading…</div>}
            </Card>
          ) : (
            !loading && list.length > 0 && <div className="text-sm text-cream-300/60">Pick a report on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}

function InnovationScanTab() {
  const [list, setList] = useState<ReflectionMeta[]>([]);
  const scanList = useLoadMore(list);
  const [selected, setSelected] = useState<string | null>(null);
  const [body, setBody] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = () => {
    setLoading(true);
    api.listInnovationScans()
      .then(r => {
        setList(r.scans);
        if (!selected && r.scans.length > 0) setSelected(r.scans[0].date);
      })
      .catch(e => setError(String(e?.message ?? e)))
      .finally(() => setLoading(false));
  };
  useEffect(load, []);

  useEffect(() => {
    if (!selected) return;
    setBody("");
    api.getInnovationScan(selected)
      .then(r => setBody(r.body.replace(/^---[\s\S]*?---\n+/, "")))
      .catch(e => setBody(`_Couldn't load this scan: ${String(e?.message ?? e)}_`));
  }, [selected]);

  const scanNow = async () => {
    setRunning(true);
    setError(null);
    try {
      const r = await api.runInnovationScan();
      setSelected(r.date);
      load();
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="text-sm text-cream-300/70">
          How we're fixing our own weak spots, and what's new and interesting in AI/tech.
        </p>
        <button
          onClick={scanNow}
          disabled={running}
          className="shrink-0 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-50 px-4 py-2 text-sm font-medium text-white"
        >
          {running ? "Scanning…" : "Scan now"}
        </button>
      </div>

      {error && <div className="text-sm text-red-400">{error}</div>}

      <div className="grid grid-cols-1 lg:grid-cols-[280px_1fr] gap-6">
        <div className="space-y-2">
          {loading && <div className="text-sm text-cream-300/60">Loading scans…</div>}
          {!loading && list.length === 0 && (
            <Card title="No scans yet">
              <p className="text-sm text-cream-300/70">
                The nightly innovation scan runs a few hours after reflection and writes its first
                digest once there's enough data to learn from. Or press{" "}
                <span className="text-cream-100">Scan now</span> to generate one immediately.
              </p>
            </Card>
          )}
          {scanList.visible.map(r => (
            <button
              key={r.date}
              onClick={() => setSelected(r.date)}
              className={`w-full text-left rounded-xl border px-4 py-3 transition ${
                selected === r.date
                  ? "border-violet-500/60 bg-violet-500/10"
                  : "border-cream-100/10 bg-white/[0.02] hover:bg-white/[0.05]"
              }`}
            >
              <div className="text-sm font-medium text-cream-100">{r.date}</div>
              {r.stats?.targetedCount !== undefined && (
                <div className="text-xs text-cream-300/60 mt-0.5">
                  {r.stats.targetedCount} weak spot{r.stats.targetedCount === "1" ? "" : "s"} · {r.stats.repoCount ?? 0} repos · {r.stats.newsCount ?? 0} news
                </div>
              )}
              <div className="text-xs text-cream-300/50 mt-1 line-clamp-2">{r.preview}</div>
            </button>
          ))}
          <LoadMoreButton state={scanList} noun="scans" />
        </div>

        <div>
          {selected ? (
            <Card title={`Scan — ${selected}`}>
              {body
                ? <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(body) as string }} />
                : <div className="text-sm text-cream-300/60">Loading…</div>}
            </Card>
          ) : (
            !loading && list.length > 0 && <div className="text-sm text-cream-300/60">Pick a scan on the left.</div>
          )}
        </div>
      </div>
    </div>
  );
}
