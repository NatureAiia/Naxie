import { useEffect, useState } from "react";
import { UserPlus, CheckCircle2 } from "lucide-react";
import { api, type Preset, type PresetApplyResult } from "../lib/api";
import { PageHeader } from "../components/PageHeader";
import { Card, Button, showToast } from "../components/Card";
import { Notice } from "../components/Notice";

// "Hire a worker" — one-click role bundles: activate a persona, ensure its
// starter templates, optionally stand up a recurring schedule. Ported from
// AI-Institute-Africa/neuroworks' Presets.tsx UI over Naxie's already-built,
// previously-unused presets.ts backend.
export function Presets() {
  const [presets, setPresets] = useState<Preset[] | null>(null);
  const [applying, setApplying] = useState<string | null>(null);
  const [result, setResult] = useState<{ id: string; applied: PresetApplyResult } | null>(null);

  useEffect(() => {
    api.listPresets().then(r => setPresets(r.presets)).catch(() => setPresets([]));
  }, []);

  async function apply(id: string) {
    setApplying(id);
    setResult(null);
    try {
      const r = await api.applyPreset(id, { createSchedules: true });
      setResult({ id, applied: r });
      showToast(`${r.persona.name} is now active`, "success");
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
    } finally {
      setApplying(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={<UserPlus size={24} />}
        title="Hire a Worker"
        subtitle="One-click role bundles — activates a persona, ensures its starter templates, and can stand up a recurring briefing schedule."
      />

      {presets === null ? (
        <div className="text-sm text-cream-300/60">Loading…</div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {presets.map(p => (
            <Card key={p.id} title={p.name}>
              <p className="text-xs text-cream-300/70 mb-3">{p.tagline}</p>
              {p.recommendedSkills.length > 0 && (
                <div className="flex flex-wrap gap-1 mb-2">
                  {p.recommendedSkills.slice(0, 5).map(s => (
                    <span key={s} className="text-[9px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">{s}</span>
                  ))}
                </div>
              )}
              <Button onClick={() => void apply(p.id)} disabled={applying === p.id} className="w-full">
                {applying === p.id ? "Hiring…" : "Hire"}
              </Button>
              {result?.id === p.id && (
                <div className="mt-3 space-y-2">
                  <Notice tone="confirm">
                    <div className="flex items-center gap-1.5"><CheckCircle2 size={13} /> {result.applied.persona.name} activated · {result.applied.templatesEnsured} templates ensured</div>
                  </Notice>
                  {result.applied.schedulesCreated.length > 0 && (
                    <div className="text-[11px] text-cream-300/60">Schedules: {result.applied.schedulesCreated.map(s => s.name).join(", ")}</div>
                  )}
                  {result.applied.missingIntegrations.length > 0 && (
                    <div className="text-[11px] text-amber-300/80">Connect for full effect: {result.applied.missingIntegrations.join(", ")}</div>
                  )}
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
