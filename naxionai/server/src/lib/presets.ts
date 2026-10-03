// Role Presets — one-click "hire a worker" bundles, the jarvis `init --preset`
// idea applied to Naxie. Each preset wires up a complete role in a single
// action: it activates the matching built-in persona, makes sure that persona's
// starter templates exist, optionally stands up a recurring schedule (e.g. a
// morning briefing emailed to the user), and surfaces which integrations + skills
// that role leans on so the user knows what to connect next.
//
// Everything a preset touches already exists as its own subsystem (personas,
// persona-templates, schedules, integrations, skills) — a preset is just a
// curated composition over them, so there's no new persistence here.

import { loadPersonas, setActivePersona, type Persona } from "./personas.js";
import { refreshPersonaTemplates, buildStarterTemplates } from "./persona-templates.js";
import { listPersonaTemplates } from "./persona-templates.js";
import { createSchedule, type Cadence, type ScheduleDelivery } from "./schedules.js";

// A schedule a preset can stand up. cadence is the friendly day/time shape the
// scheduler already understands; templateId is what it runs.
export type PresetSchedule = {
  name: string;
  templateId: string;
  inputs?: Record<string, unknown>;
  cadence: Cadence;
  // When true, the apply call's `deliverEmail` (if supplied) is attached so the
  // result is emailed the moment the job finishes.
  emailResult?: boolean;
};

export type Preset = {
  id: string;
  name: string;            // display name, e.g. "Executive Assistant"
  tagline: string;         // one-line "what you get"
  personaId: string;       // built-in persona this preset activates
  recommendedSkills: string[];       // skill slugs this role leans on
  recommendedIntegrations: string[]; // integration provider ids to connect
  schedules?: PresetSchedule[];      // recurring jobs to optionally create
};

// Friendly cadence helpers.
const weekdaysAt = (hour: number, minute = 0): Cadence => ({ daysOfWeek: [1, 2, 3, 4, 5], hour, minute });
const everyDayAt = (hour: number, minute = 0): Cadence => ({ daysOfWeek: [], hour, minute });
const mondayAt = (hour: number, minute = 0): Cadence => ({ daysOfWeek: [1], hour, minute });

// Pruned 2026-09-21 alongside personas.ts's own prune (all built-ins had zero
// recorded activity in 30 days). Removed: exec-assistant (executive-assistant),
// sales-sdr (account-executive), support-desk (customer-success), recruiter
// (recruiter), ops-coordinator (operations-coordinator), content-studio
// (multimedia-producer) — each referenced a persona id that no longer exists,
// which would make applyPreset() throw ("preset references missing persona").
// No surviving persona was an obvious fit to remap these onto, so they were
// dropped rather than repointed.
export const PRESETS: Preset[] = [
  {
    id: "research-analyst",
    name: "Research Analyst",
    tagline: "Investigates anything — multi-perspective, cited, captured to vault.",
    personaId: "researcher",
    recommendedSkills: ["research-deep", "fact-check", "source-triangulation", "landscape-scan", "competitive-analysis"],
    recommendedIntegrations: ["notion", "slack"],
  },
  {
    id: "engineer",
    name: "Software Engineer",
    tagline: "Ships fixes — code review, bug investigation, trade-off memos.",
    personaId: "software-engineer",
    recommendedSkills: ["code-review", "debugging-help", "root-cause-analysis", "testing-strategy", "release-notes-from-commits"],
    recommendedIntegrations: ["github", "slack", "jira"],
  },
];

export function listPresets(): Preset[] {
  return PRESETS.slice();
}

export function getPreset(id: string): Preset | undefined {
  return PRESETS.find(p => p.id === id);
}

export type ApplyResult = {
  preset: Preset;
  persona: { id: string; name: string; role: string };
  templatesEnsured: number;
  schedulesCreated: { id: string; name: string; emailTo?: string }[];
  missingIntegrations: string[];   // recommended providers not yet connected
};

// Apply a preset: activate the persona, ensure its templates, stand up any
// schedules (attaching email delivery when requested + an address is given),
// and report which recommended integrations still need connecting. Idempotent
// on the persona/templates; schedules are additive (calling twice makes two).
export async function applyPreset(
  presetId: string,
  opts: { deliverEmail?: string; createSchedules?: boolean } = {},
): Promise<ApplyResult> {
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`unknown preset: ${presetId}`);

  // 1. Resolve + activate the persona.
  const store = loadPersonas();
  const persona: Persona | undefined = store.personas.find(p => p.id === preset.personaId);
  if (!persona) throw new Error(`preset "${presetId}" references missing persona "${preset.personaId}"`);
  setActivePersona(persona.id);

  // 2. Ensure starter templates exist for that persona.
  let templatesEnsured = listPersonaTemplates(persona.id).length;
  if (templatesEnsured === 0) {
    try {
      const r = refreshPersonaTemplates(persona);
      templatesEnsured = r.kept + r.added;
    } catch {
      templatesEnsured = buildStarterTemplates(persona).length; // best-effort count
    }
  }

  // 3. Schedules — opt-in (default on). Attach email delivery when the schedule
  //    asks for it AND the caller supplied an address.
  const schedulesCreated: ApplyResult["schedulesCreated"] = [];
  const wantSchedules = opts.createSchedules !== false;
  if (wantSchedules && preset.schedules?.length) {
    for (const spec of preset.schedules) {
      const deliver: ScheduleDelivery | undefined =
        spec.emailResult && opts.deliverEmail ? { email: opts.deliverEmail } : undefined;
      const created = createSchedule({
        name: spec.name,
        templateId: spec.templateId,
        inputs: spec.inputs ?? {},
        cadence: spec.cadence,
        enabled: true,
        deliver,
      });
      schedulesCreated.push({ id: created.id, name: created.name, emailTo: deliver?.email });
    }
  }

  // 4. Which recommended integrations are not connected yet.
  let connectedProviders = new Set<string>();
  try {
    const { listConnections } = await import("./integrations.js");
    connectedProviders = new Set(listConnections().map((c: any) => c.providerId));
  } catch { /* integrations optional — treat all as missing */ }
  const missingIntegrations = preset.recommendedIntegrations.filter(p => !connectedProviders.has(p));

  return {
    preset,
    persona: { id: persona.id, name: persona.name, role: persona.role },
    templatesEnsured,
    schedulesCreated,
    missingIntegrations,
  };
}

// Keep the unused helpers referenced so tree-shakers/linters don't complain
// when no preset uses them (weekdaysAt/mondayAt lost their only callers when
// the schedule-bearing presets were pruned 2026-09-21).
void everyDayAt;
void weekdaysAt;
void mondayAt;
