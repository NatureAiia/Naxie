import { useState, ChangeEvent } from "react";
import { api } from "../lib/api";
import { Loader2, Hammer, Sparkles, Eye, Save, AlertCircle, CheckCircle } from "lucide-react";
import { Button, showToast, Card } from "../components/Card";
import { PageHeader } from "../components/PageHeader";
import { EmptyState, ErrorState } from "../components/States";
import { Input, Textarea } from "../components/forms";

export function SkillForge() {
  const [intent, setIntent] = useState("");
  const [taskSample, setTaskSample] = useState("");
  const [failureReason, setFailureReason] = useState("");
  const [loading, setLoading] = useState(false);
  const [draft, setDraft] = useState<{ skill: any; raw: string } | null>(null);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const forge = async () => {
    if (!intent.trim() || !taskSample.trim()) return;
    setLoading(true);
    setError("");
    setDraft(null);
    setSaved(false);
    try {
      const result = await api.draftSkill(intent.trim(), taskSample.trim(), failureReason.trim() || undefined);
      setDraft(result);
    } catch (e: any) {
      setError(e?.message ?? "Failed to generate skill");
    } finally {
      setLoading(false);
    }
  };

  const save = async () => {
    if (!draft) return;
    setSaving(true);
    try {
      const result = await api.saveSkill(intent.trim(), draft.raw);
      if (result.ok) {
        setSaved(true);
        showToast("Skill saved to library", "success");
      }
    } catch (e: any) {
      setError(e?.message ?? "Failed to save skill");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="SkillForge"
        subtitle="Generate a skill playbook from a natural language description. The LLM writes a structured markdown skill with frontmatter, process, rules, and pitfalls. Review and save it to your skill library."
        icon={<Hammer size={28} />}
        action={
          <Button onClick={forge} disabled={loading || !intent.trim() || !taskSample.trim()} className="px-4 py-2">
            {loading ? <Loader2 size={16} className="animate-spin" /> : <Sparkles size={16} />}
            Forge Skill
          </Button>
        }
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <Card>
          <div className="space-y-4">
            <Input
              label="Intent label"
              value={intent}
              onChange={(e: ChangeEvent<HTMLInputElement>) => setIntent(e.target.value)}
              placeholder="e.g. draft-email, compliance-check"
            />
            <Textarea
              label="Task sample"
              value={taskSample}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setTaskSample(e.target.value)}
              rows={4}
              placeholder="Paste a real task that this skill should handle…"
            />
            <Textarea
              label="Failure reason (optional)"
              value={failureReason}
              onChange={(e: ChangeEvent<HTMLTextAreaElement>) => setFailureReason(e.target.value)}
              rows={2}
              placeholder="What went wrong last time? Helps the LLM draft better rules…"
            />
          </div>
        </Card>

        <Card>
          {error ? (
            <ErrorState title="Generation failed" body={error} onRetry={forge} />
          ) : loading ? (
            <div className="flex items-center justify-center py-20">
              <Loader2 size={24} className="animate-spin text-violet-400" />
              <span className="ml-2 text-sm text-cream-300/60">Generating skill…</span>
            </div>
          ) : draft ? (
            <div className="space-y-4">
              <div className="flex items-center gap-2">
                <Eye size={16} className="text-cream-300/70" />
                <span className="font-medium text-sm text-cream-100">Draft: {draft.skill.name}</span>
                {draft.skill.applies_to?.length > 0 && (
                  <span className="text-xs text-cream-300/50">applies to: {draft.skill.applies_to.join(", ")}</span>
                )}
              </div>
              <pre className="text-xs border border-ink-800 rounded-lg p-3 bg-ink-950 overflow-auto max-h-96 whitespace-pre-wrap font-mono text-cream-300">
                {draft.raw}
              </pre>
              <div className="flex items-center gap-2">
                {saved ? (
                  <div className="flex items-center gap-2 text-sm text-leaf-400">
                    <CheckCircle size={16} /> Saved to skill library
                  </div>
                ) : (
                  <Button onClick={save} disabled={saving} className="px-3 py-1.5">
                    {saving ? <Loader2 size={14} className="animate-spin" /> : <Save size={14} />}
                    Save to Library
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <EmptyState
              icon={Sparkles}
              title="No draft yet"
              body="Fill in the intent and task sample, then click Forge Skill to generate a draft."
            />
          )}
        </Card>
      </div>
    </div>
  );
}