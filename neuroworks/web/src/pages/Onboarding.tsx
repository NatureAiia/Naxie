import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Compass, ArrowRight, ArrowLeft, Check, Sparkles, Package, Loader2 } from "lucide-react";
import { api, type OnboardingSector, type SectorBundleResult } from "../lib/api";
import { Card, Button, showToast } from "../components/Card";
import { t } from "../lib/i18n";

// Finishes a feature that was half-built and abandoned: sector-packs.ts's
// OnboardingState model + SECTORS catalog + this route already existed, but
// setOnboardingState() had zero callers and this route was a dead
// <Navigate to="/naxie" /> stub. This page is the missing wizard — it also
// doubles as an "edit my profile" screen (pre-fills from GET
// /api/onboarding/state on every visit, not just the first).

type Form = {
  name: string; email: string; title: string; orgName: string;
  sector: string; customSectorName: string;
  responseStyle: "standard" | "caveman";
  priorities: string; communicationStyle: string; notes: string;
};

const EMPTY: Form = {
  name: "", email: "", title: "", orgName: "",
  sector: "", customSectorName: "",
  responseStyle: "standard",
  priorities: "", communicationStyle: "", notes: "",
};

const STEPS = ["intro", "about", "style", "tell", "bundle", "done"] as const;

export function Onboarding() {
  const navigate = useNavigate();
  const [step, setStep] = useState<number>(0);
  const [form, setForm] = useState<Form>(EMPTY);
  const [sectors, setSectors] = useState<OnboardingSector[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [wasAlreadyDone, setWasAlreadyDone] = useState(false);
  const [bundleResult, setBundleResult] = useState<SectorBundleResult | null>(null);
  const [installingBundle, setInstallingBundle] = useState(false);

  useEffect(() => {
    Promise.all([api.onboardingState(), api.onboardingSectors()])
      .then(([s, sec]) => {
        setSectors(sec.sectors);
        setWasAlreadyDone(s.state.completed === true);
        setForm(f => ({
          ...f,
          name: s.operator.name && s.operator.name !== "Nature" ? s.operator.name : "",
          email: s.operator.email ?? "",
          title: s.operator.title ?? "",
          orgName: s.operator.orgName ?? s.state.orgName ?? "",
          sector: s.state.sector ?? "",
          customSectorName: s.state.customSectorName ?? "",
          responseStyle: s.state.responseStyle ?? "standard",
          priorities: s.state.priorities ?? "",
          communicationStyle: s.state.communicationStyle ?? "",
          notes: s.state.notes ?? "",
        }));
      })
      .catch(e => showToast(e instanceof Error ? e.message : String(e), "error"))
      .finally(() => setLoading(false));
  }, []);

  function set<K extends keyof Form>(key: K, value: Form[K]) {
    setForm(f => ({ ...f, [key]: value }));
  }

  function next() {
    if (step === 1 && !form.name.trim()) {
      showToast("Naxie needs at least your name to move on", "error");
      return;
    }
    setStep(s => Math.min(s + 1, STEPS.length - 1));
  }
  function back() {
    setStep(s => Math.max(s - 1, 0));
  }

  async function finish() {
    setSaving(true);
    try {
      await api.completeOnboarding({
        name: form.name.trim(),
        email: form.email.trim() || undefined,
        title: form.title.trim() || undefined,
        orgName: form.orgName.trim() || undefined,
        sector: form.sector || undefined,
        customSectorName: form.sector === "custom" ? form.customSectorName.trim() : undefined,
        responseStyle: form.responseStyle,
        priorities: form.priorities.trim() || undefined,
        communicationStyle: form.communicationStyle.trim() || undefined,
        notes: form.notes.trim() || undefined,
      });
      // Sector chosen → offer the one-click bundle install before the final
      // "done" screen; no sector (or user hasn't picked one) skips straight
      // to done, matching this app's "nothing installs itself" default.
      setStep(form.sector ? 4 : 5);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setSaving(false);
    }
  }

  async function installBundle() {
    setInstallingBundle(true);
    try {
      const r = await api.applyOnboardingBundle(form.sector);
      setBundleResult(r.result);
    } catch (e) {
      showToast(e instanceof Error ? e.message : String(e), "error");
    } finally {
      setInstallingBundle(false);
    }
  }

  if (loading) return <div className="space-y-6 max-w-2xl mx-auto"><p className="text-sm text-cream-300/60">Loading…</p></div>;

  return (
    <div className="space-y-6 max-w-2xl mx-auto">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3">
          <Compass size={24} /> {wasAlreadyDone ? t("onboarding.editProfile") : t("onboarding.title")}
        </h1>
        <p className="text-sm text-cream-300/70 mt-1">{t("onboarding.subtitle")}</p>
      </div>

      <div className="flex items-center gap-1.5">
        {STEPS.slice(0, 4).map((s, i) => (
          <div key={s} className={`h-1 flex-1 rounded-full ${i <= step ? "bg-violet-500" : "bg-ink-800"}`} />
        ))}
      </div>

      {step === 0 && (
        <Card>
          <div className="flex flex-col items-center text-center gap-3 py-4">
            <Sparkles size={32} className="text-violet-400" />
            <h2 className="text-lg font-semibold text-cream-100">{t("onboarding.intro.title")}</h2>
            <p className="text-sm text-cream-300/70 max-w-md">{t("onboarding.intro.body")}</p>
            <div className="flex gap-2 mt-2">
              <Button variant="ghost" onClick={() => navigate("/naxie")}>{t("onboarding.skipped")}</Button>
              <Button onClick={next}>{t("onboarding.next")} <ArrowRight size={14} className="inline ml-1" /></Button>
            </div>
          </div>
        </Card>
      )}

      {step === 1 && (
        <Card title={t("onboarding.name")}>
          <div className="space-y-4">
            <Field label={t("onboarding.name")} value={form.name} onChange={v => set("name", v)} placeholder={t("onboarding.namePlaceholder")} required />
            <Field label={t("onboarding.email")} value={form.email} onChange={v => set("email", v)} placeholder={t("onboarding.emailPlaceholder")} />
            <Field label={t("onboarding.role")} value={form.title} onChange={v => set("title", v)} placeholder={t("onboarding.rolePlaceholder")} />
            <Field label={t("onboarding.orgName")} value={form.orgName} onChange={v => set("orgName", v)} placeholder={t("onboarding.orgNamePlaceholder")} />
            <div>
              <label className="text-xs text-cream-300/70 mb-1 block">{t("onboarding.sector")}</label>
              <p className="text-xs text-cream-300/50 mb-2">{t("onboarding.sectorDesc")}</p>
              <select
                value={form.sector}
                onChange={e => set("sector", e.target.value)}
                className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100"
              >
                <option value="">—</option>
                {sectors.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
              {form.sector === "custom" && (
                <div className="mt-2">
                  <Field label="" value={form.customSectorName} onChange={v => set("customSectorName", v)} placeholder={t("onboarding.customSectorNamePlaceholder")} />
                </div>
              )}
            </div>
            <Nav onBack={back} onNext={next} showBack={false} />
          </div>
        </Card>
      )}

      {step === 2 && (
        <Card title={t("onboarding.responseStyle")}>
          <div className="space-y-3">
            {(["standard", "caveman"] as const).map(style => (
              <label key={style} className={`flex items-start gap-3 p-3 rounded-md border cursor-pointer ${form.responseStyle === style ? "border-violet-500 bg-violet-500/10" : "border-ink-800"}`}>
                <input type="radio" name="responseStyle" checked={form.responseStyle === style} onChange={() => set("responseStyle", style)} className="mt-1" />
                <span className="text-sm text-cream-100">{t(`onboarding.responseStyle.${style}`)}</span>
              </label>
            ))}
            <Nav onBack={back} onNext={next} />
          </div>
        </Card>
      )}

      {step === 3 && (
        <Card title={t("onboarding.priorities")}>
          <div className="space-y-4">
            <TextArea label={t("onboarding.priorities")} value={form.priorities} onChange={v => set("priorities", v)} placeholder={t("onboarding.prioritiesPlaceholder")} />
            <TextArea label={t("onboarding.communication")} value={form.communicationStyle} onChange={v => set("communicationStyle", v)} placeholder={t("onboarding.communicationPlaceholder")} />
            <TextArea label={t("onboarding.notes")} value={form.notes} onChange={v => set("notes", v)} placeholder={t("onboarding.notesPlaceholder")} />
            <div className="flex items-center justify-between pt-2">
              <Button variant="ghost" onClick={back}><ArrowLeft size={14} className="inline mr-1" /> {t("onboarding.back")}</Button>
              <Button onClick={finish} disabled={saving}>{saving ? "…" : t("onboarding.finish")} <Check size={14} className="inline ml-1" /></Button>
            </div>
          </div>
        </Card>
      )}

      {step === 4 && (
        <Card title="Set up your workspace">
          {!bundleResult ? (
            <div className="space-y-3">
              <p className="text-sm text-cream-300/70">
                Install the {sectors.find(s => s.id === form.sector)?.name ?? form.sector} starter bundle — a knowledge
                pack tuned for your sector, plus department(s) with their agents ready to hire. You can always add
                more later; nothing else is installed automatically.
              </p>
              {(() => {
                const sector = sectors.find(s => s.id === form.sector);
                return sector ? (
                  <ul className="text-[13px] text-cream-200/80 space-y-1 list-disc list-inside">
                    {sector.suggestedDepartments.length > 0 && <li>{sector.suggestedDepartments.length} department{sector.suggestedDepartments.length === 1 ? "" : "s"} with their agents</li>}
                    <li>A knowledge pack for {sector.name}</li>
                    {sector.suggestedIntegrations.length > 0 && <li>Suggested connectors: {sector.suggestedIntegrations.join(", ")}</li>}
                  </ul>
                ) : null;
              })()}
              <div className="flex items-center justify-between pt-2">
                <Button variant="ghost" onClick={() => setStep(5)}>Skip for now</Button>
                <Button onClick={installBundle} disabled={installingBundle}>
                  {installingBundle ? <Loader2 size={14} className="inline mr-1 animate-spin" /> : <Package size={14} className="inline mr-1" />} Set up workspace
                </Button>
              </div>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="text-sm text-leaf-400 flex items-center gap-2"><Check size={16} /> Workspace set up.</div>
              <ul className="text-[13px] text-cream-200/80 space-y-1 list-disc list-inside">
                {bundleResult.departments.map(d => <li key={d.id}>{d.departmentName} — {d.personaCount} agent{d.personaCount === 1 ? "" : "s"}</li>)}
                {bundleResult.knowledgePack.installed && <li>Knowledge pack installed ({bundleResult.knowledgePack.files.length} files)</li>}
                {bundleResult.suggestedConnectors.length > 0 && (
                  <li>Suggested connectors — add these under Connectors: {bundleResult.suggestedConnectors.map(c => c.label).join(", ")}</li>
                )}
              </ul>
              <div className="flex justify-end pt-2">
                <Button onClick={() => setStep(5)}>Continue <ArrowRight size={14} className="inline ml-1" /></Button>
              </div>
            </div>
          )}
        </Card>
      )}

      {step === 5 && (
        <Card>
          <div className="flex flex-col items-center text-center gap-3 py-4">
            <Check size={32} className="text-leaf-500" />
            <h2 className="text-lg font-semibold text-cream-100">{t("onboarding.done")}</h2>
            <p className="text-sm text-cream-300/70 max-w-md">
              {`Naxie now knows you as ${form.name || "you"}. `}{t("onboarding.doneDesc")}
            </p>
            <Button onClick={() => navigate("/naxie")}>Back to Naxie</Button>
          </div>
        </Card>
      )}
    </div>
  );
}

function Nav({ onBack, onNext, showBack = true }: { onBack: () => void; onNext: () => void; showBack?: boolean }) {
  return (
    <div className="flex items-center justify-between pt-2">
      {showBack ? <Button variant="ghost" onClick={onBack}><ArrowLeft size={14} className="inline mr-1" /> Back</Button> : <span />}
      <Button onClick={onNext}>Next <ArrowRight size={14} className="inline ml-1" /></Button>
    </div>
  );
}

function Field({ label, value, onChange, placeholder, required = false }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string; required?: boolean }) {
  return (
    <div>
      {label && <label className="text-xs text-cream-300/70 mb-1 block">{label}{required && <span className="text-coral-400"> *</span>}</label>}
      <input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100"
      />
    </div>
  );
}

function TextArea({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="text-xs text-cream-300/70 mb-1 block">{label}</label>
      <textarea
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        rows={2}
        className="w-full bg-ink-950 border border-ink-800 rounded-md px-3 py-2 text-sm text-cream-100 resize-none"
      />
    </div>
  );
}
