// Shared step-by-step render for an agent run's tool calls — one entry per
// StepRun (agent.ts). Used by Runs.tsx's ProcessTrace (post-hoc, via polling)
// and the Naxie Workbench view (live, via the job SSE stream) so both read
// off the same shape instead of duplicating the render logic.
export type AgentStep = {
  step: { tool: string; label?: string; rationale?: string };
  ok: boolean;
  error?: string;
  durationMs?: number;
  modelUsed?: string;
};

export function AgentStepFeed({ steps, phase, emptyLabel }: { steps: AgentStep[]; phase?: string; emptyLabel?: string }) {
  if (steps.length === 0) {
    return emptyLabel ? <div className="text-xs text-cream-300/40">{emptyLabel}</div> : null;
  }
  return (
    <div>
      {phase && <div className="text-[10px] uppercase tracking-wider text-cream-300/40 mb-2">{phase}</div>}
      <ol className="space-y-2 text-sm">
        {steps.map((run, i) => {
          const dot = run.ok ? "bg-leaf-500" : run.error ? "bg-coral-500" : "bg-cream-300/30";
          return (
            <li key={i} className="flex items-start gap-3">
              <span className={`inline-block w-1.5 h-1.5 rounded-full mt-2 flex-shrink-0 ${dot} ${!run.ok && !run.error ? "animate-pulse" : ""}`} />
              <div className="flex-1 min-w-0">
                <div className="text-cream-100">{run.step?.label || run.step?.tool}</div>
                {run.step?.rationale && <div className="text-[11px] text-cream-300/60 mt-0.5">{run.step.rationale}</div>}
                <div className="flex gap-3 mt-1 text-[10px] text-cream-300/40 font-mono">
                  {run.modelUsed && <span>{run.modelUsed}</span>}
                  {run.durationMs != null && <span>{(run.durationMs / 1000).toFixed(1)}s</span>}
                  {run.error && <span className="text-coral-400">{run.error.slice(0, 80)}</span>}
                </div>
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
