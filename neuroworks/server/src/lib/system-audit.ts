// Naxie Managing Director — System Audit
// Daily report that scans every inch of the system: files, features, pages,
// routes, lib modules, components, templates, personas, schedules, connectors,
// jobs, org-tasks, audit log, vault, cost & governance.
// Produces: what needs improvement, what's dormant, what's useless, plus
// concrete recommendations — Naxie's view as the MD that never sleeps.
//
// Mirrors the nightly loops in lib/reflection.ts + lib/innovation-scan.ts:
//   scan → collect usage → aggregate → LLM synthesize → vault write → Job
//   → scheduler + on-demand route + Telegram delivery.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { writeVaultFile } from "./vault.js";
import { enqueueVaultCommit } from "./commit-queue.js";
import { llmGenerateWithMeta } from "./llm.js";
import { config } from "../config.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../../..");
const SERVER_ROOT = resolve(__dirname, "..");
const WEB_SRC = resolve(REPO_ROOT, "neuroworks/web/src");

const AUDIT_DIR = "_neuroworks/system-audits";

// ── Types ─────────────────────────────────────────────────────────────────
export type FileInventory = {
  pages: { file: string; route: string }[];
  routes: string[];
  libFiles: string[];
  components: string[];
  templates: { id: string; role: string; title: string }[];
  personas: string[];
  schedules: number;
  connectors: number;
  integrations: number;
  totalServerFiles: number;
  totalWebFiles: number;
};

export type UsageSignals = {
  totalJobs30d: number;
  succeeded30d: number;
  failed30d: number;
  successRate30d: number;
  byTemplate: Record<string, { total: number; ok: number; failed: number }>;
  byPersona: Record<string, number>;
  auditEvents30d: number;
  auditByActor: Record<string, number>;
  orgTasks: { total: number; byStatus: Record<string, number>; byRole: Record<string, number>; staleApprovals: number; blocked: number };
  schedulesEnabled: number;
  schedulesDisabled: number;
  vaultNotes: number;
  vaultSizeMb: number;
};

export type DormantItem = {
  kind: "page" | "template" | "persona" | "schedule" | "route" | "lib" | "connector" | "feature";
  name: string;
  reason: string;
  lastSeen?: string;
  severity: "dormant" | "stale" | "unused";
};

export type ImprovementItem = {
  area: string;
  issue: string;
  evidence: string;
  recommendation: string;
  effort: "S" | "M" | "L";
  priority: "low" | "medium" | "high";
};

export type UselessItem = {
  name: string;
  kind: string;
  reason: string;
  recommendation: "remove" | "merge" | "deprecate" | "review";
};

export type SystemAuditStats = {
  date: string;
  generatedAt: string;
  inventory: FileInventory;
  usage: UsageSignals;
  dormant: DormantItem[];
  useless: UselessItem[];
  improvements: ImprovementItem[];
  health: {
    score: number; // 0-100
    summary: string;
    risks: string[];
  };
};

export type SystemAuditResult = {
  date: string;
  path: string;
  stats: SystemAuditStats;
  report: string;
  generatedAt: string;
  modelUsed?: string;
};

let lastResult: SystemAuditResult | null = null;
let inFlight: Promise<SystemAuditResult> | null = null;

// ── 1. File inventory ─────────────────────────────────────────────────────
function listFilesRecursive(dir: string, exts: string[], out: string[] = [], base = dir): string[] {
  if (!existsSync(dir)) return out;
  let entries: import("node:fs").Dirent[] = [];
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (e.name.startsWith(".") || e.name === "node_modules" || e.name === "dist") continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) listFilesRecursive(abs, exts, out, base);
    else if (exts.some(ext => e.name.endsWith(ext))) out.push(relative(base, abs).split("\\").join("/"));
  }
  return out;
}

function scanInventory(): FileInventory {
  const pages = listFilesRecursive(join(WEB_SRC, "pages"), [".tsx", ".ts"]).map(f => ({
    file: `pages/${f}`,
    route: f.replace(/\.tsx?$/, "").toLowerCase(),
  }));
  const routes = listFilesRecursive(join(SERVER_ROOT, "routes"), [".ts"]).map(f => f.replace(/\.ts$/, ""));
  const libFiles = listFilesRecursive(join(SERVER_ROOT, "lib"), [".ts"]).map(f => `lib/${f}`);
  const components = listFilesRecursive(join(WEB_SRC, "components"), [".tsx", ".ts"]).map(f => `components/${f}`);
  const totalServerFiles = listFilesRecursive(join(SERVER_ROOT, ""), [".ts"]).length;
  const totalWebFiles = listFilesRecursive(WEB_SRC, [".tsx", ".ts"]).length;

  let templates: { id: string; role: string; title: string }[] = [];
  try {
    const raw = readFileSync(join(SERVER_ROOT, "lib/templates.ts"), "utf8");
    const ids = [...raw.matchAll(/id:\s*"([^"]+)"/g)].map(m => m[1]);
    const roles = [...raw.matchAll(/role:\s*"([^"]+)"/g)].map(m => m[1]);
    const titles = [...raw.matchAll(/title:\s*"([^"]+)"/g)].map(m => m[1]);
    templates = ids.map((id, i) => ({ id, role: roles[i] ?? "Unknown", title: titles[i] ?? id }));
  } catch { /* ignore */ }

  let personas: string[] = [];
  let schedules = 0, connectors = 0, integrations = 0;
  try {
    const raw = readFileSync(join(REPO_ROOT, ".neuroworks/personas.json"), "utf8");
    const parsed = JSON.parse(raw);
    const arr = Array.isArray(parsed) ? parsed : (parsed.personas ?? []);
    personas = arr.map((p: any) => p.name ?? p.id).filter(Boolean);
  } catch { /* ignore */ }
  if (personas.length === 0) {
    try {
      const raw2 = readFileSync(join(REPO_ROOT, "neuroworks/.neuroworks/personas.json"), "utf8");
      personas = (JSON.parse(raw2)?.personas ?? []).map((p: any) => p.name ?? p.id);
    } catch { /* ignore */ }
  }
  try {
    // Schedules: count JSON file
    const sRaw = readFileSync(join(REPO_ROOT, ".neuroworks/schedules.json"), "utf8");
    const s = JSON.parse(sRaw);
    const arr = Array.isArray(s) ? s : (s.schedules ?? []);
    schedules = arr.length;
  } catch { /* 0 */ }
  try {
    const cRaw = readFileSync(join(REPO_ROOT, ".neuroworks/connectors.json"), "utf8");
    connectors = (JSON.parse(cRaw)?.connectors ?? JSON.parse(cRaw) ?? []).length ?? 0;
    if (typeof connectors !== "number") connectors = 0;
  } catch {
    try {
      const files = readdirSync(join(REPO_ROOT, ".neuroworks"));
      connectors = files.filter(f => f.includes("connector")).length;
    } catch { /* 0 */ }
  }
  try {
    const cRaw = readFileSync(join(REPO_ROOT, ".neuroworks/integrations.json"), "utf8");
    integrations = (JSON.parse(cRaw)?.connections ?? []).length ?? 0;
  } catch { /* 0 */ }

  return { pages, routes, libFiles, components, templates, personas, schedules, connectors, integrations, totalServerFiles, totalWebFiles };
}

// ── 2. Usage signals ──────────────────────────────────────────────────────
async function collectUsage(): Promise<UsageSignals> {
  let totalJobs30d = 0, succeeded30d = 0, failed30d = 0;
  let byTemplate: Record<string, { total: number; ok: number; failed: number }> = {};
  let byPersona: Record<string, number> = {};

  try {
    const { loadJobsInWindow } = await import("./job-store.js");
    const now = Date.now();
    const recs = loadJobsInWindow(now - 30 * 24 * 3600_000, now);
    // dedupe to latest per id
    const latest = new Map<string, any>();
    for (const r of recs) latest.set(r.id, r);
    totalJobs30d = latest.size;
    for (const r of latest.values()) {
      if (r.status === "succeeded") succeeded30d++;
      else if (r.status === "failed") failed30d++;
      const tpl = r.template ?? r.kind ?? "unknown";
      byTemplate[tpl] = byTemplate[tpl] ?? { total: 0, ok: 0, failed: 0 };
      byTemplate[tpl].total++;
      if (r.status === "succeeded") byTemplate[tpl].ok++;
      if (r.status === "failed") byTemplate[tpl].failed++;
      const personaName = r.personaName ?? (r as any).persona?.name;
      if (personaName) byPersona[personaName] = (byPersona[personaName] ?? 0) + 1;
    }
  } catch { /* tolerate */ }

  const successRate30d = totalJobs30d > 0 ? Math.round((succeeded30d / totalJobs30d) * 100) / 100 : 0;

  let auditEvents30d = 0;
  let auditByActor: Record<string, number> = {};
  try {
    const { queryAudit } = await import("./audit-log.js");
    // pull last 500 and filter to 30d — queryAudit has no window param
    const since = new Date(Date.now() - 30 * 24 * 3600_000).toISOString();
    const { events } = queryAudit({ limit: 500, since });
    auditEvents30d = events.length;
    for (const e of events) auditByActor[e.actor] = (auditByActor[e.actor] ?? 0) + 1;
  } catch { /* tolerate */ }

  let orgTasks: UsageSignals["orgTasks"] = { total: 0, byStatus: {}, byRole: {}, staleApprovals: 0, blocked: 0 };
  try {
    const { listOrgTasks } = await import("./org-tasks.js");
    const tasks = listOrgTasks();
    orgTasks.total = tasks.length;
    for (const t of tasks) {
      orgTasks.byStatus[t.status] = (orgTasks.byStatus[t.status] ?? 0) + 1;
      orgTasks.byRole[t.role] = (orgTasks.byRole[t.role] ?? 0) + 1;
    }
    orgTasks.blocked = orgTasks.byStatus["blocked"] ?? 0;
    orgTasks.staleApprovals = (orgTasks.byStatus["waiting-on-approval"] ?? 0);
  } catch { /* tolerate */ }

  let schedulesEnabled = 0, schedulesDisabled = 0;
  try {
    const raw = readFileSync(join(REPO_ROOT, ".neuroworks/schedules.json"), "utf8");
    const arr: any[] = Array.isArray(JSON.parse(raw)) ? JSON.parse(raw) : (JSON.parse(raw).schedules ?? []);
    for (const s of arr) (s.enabled === false ? schedulesDisabled++ : schedulesEnabled++);
  } catch { /* tolerate */ }

  let vaultNotes = 0, vaultSizeMb = 0;
  try {
    const vaultPath = config.vaultPath;
    if (existsSync(vaultPath)) {
      const countFiles = (dir: string): number => {
        let n = 0;
        let entries: import("node:fs").Dirent[] = [];
        try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return 0; }
        for (const e of entries) {
          if (e.name.startsWith(".git") || e.name.startsWith(".obsidian")) continue;
          const abs = join(dir, e.name);
          if (e.isDirectory()) n += countFiles(abs);
          else if (e.name.endsWith(".md")) {
            n += 1;
            try { vaultSizeMb += statSync(abs).size; } catch { /* ignore */ }
          }
        }
        return n;
      };
      vaultNotes = countFiles(vaultPath);
      vaultSizeMb = Math.round((vaultSizeMb / (1024 * 1024)) * 10) / 10;
    }
  } catch { /* tolerate */ }

  return {
    totalJobs30d, succeeded30d, failed30d, successRate30d,
    byTemplate, byPersona, auditEvents30d, auditByActor,
    orgTasks, schedulesEnabled, schedulesDisabled, vaultNotes, vaultSizeMb,
  };
}

// ── 3. Dormant / useless / improvements heuristics ────────────────────────
function deriveFindings(inventory: FileInventory, usage: UsageSignals): { dormant: DormantItem[]; useless: UselessItem[]; improvements: ImprovementItem[]; health: SystemAuditStats["health"] } {
  const dormant: DormantItem[] = [];
  const useless: UselessItem[] = [];
  const improvements: ImprovementItem[] = [];
  const risks: string[] = [];

  // — Dormant templates (no runs in 30d) —
  for (const t of inventory.templates) {
    const u = usage.byTemplate[t.id];
    if (!u || u.total === 0) {
      dormant.push({ kind: "template", name: `${t.id} — ${t.title}`, reason: `No runs in last 30 days (role: ${t.role})`, severity: "dormant" });
    } else if (u.failed > 0 && u.ok === 0) {
      improvements.push({ area: `Template: ${t.id}`, issue: `100% failure rate (${u.failed}/${u.total}) in last 30d`, evidence: `byTemplate[${t.id}] failed=${u.failed} ok=${u.ok}`, recommendation: `Review runner for ${t.id}, check error logs, fix or deprecate.`, effort: "M", priority: "high" });
    } else if (u.failed / u.total > 0.4) {
      improvements.push({ area: `Template: ${t.id}`, issue: `${Math.round(u.failed / u.total * 100)}% failure rate (${u.failed}/${u.total})`, evidence: `byTemplate[${t.id}]`, recommendation: `Investigate failure pattern for ${t.id} and tighten validation / retry logic.`, effort: "M", priority: "medium" });
    }
  }

  // — Dormant personas —
  const activePersonaNames = new Set(Object.keys(usage.byPersona));
  for (const p of inventory.personas) {
    if (!activePersonaNames.has(p)) {
      dormant.push({ kind: "persona", name: p, reason: "No tasks attributed in last 30 days", severity: "dormant" });
    }
  }
  if (inventory.personas.length > 20 && dormant.filter(d => d.kind === "persona").length > inventory.personas.length * 0.5) {
    improvements.push({ area: "Personas", issue: `${dormant.filter(d => d.kind === "persona").length}/${inventory.personas.length} personas dormant — roster may be bloated`, evidence: `personas=${inventory.personas.length}, dormant=${dormant.filter(d=>d.kind==="persona").length}`, recommendation: "Review personas catalog and retire unused personas; keep roster lean so Naxie's routing stays precise.", effort: "S", priority: "medium" });
  }

  // — Pages vs routes coverage —
  // Pages without matching route often means dead UI
  const routeSet = new Set(inventory.routes.map(r => r.toLowerCase().replace(/[^a-z]/g, "")));
  for (const pg of inventory.pages) {
    const norm = pg.route.replace(/[^a-z]/g, "");
    if (norm.length > 2 && !routeSet.has(norm) && !["dailyreports", "naxie", "board", "orgdashboard"].some(k => norm.includes(k))) {
      // Don't flag if it's a known page — just track coverage
    }
  }

  // — Schedules health —
  if (usage.schedulesDisabled > usage.schedulesEnabled && usage.schedulesDisabled > 3) {
    dormant.push({ kind: "schedule", name: `${usage.schedulesDisabled} disabled schedules`, reason: `${usage.schedulesDisabled} schedules are disabled — may be abandoned`, severity: "stale" });
    improvements.push({ area: "Schedules", issue: `${usage.schedulesDisabled} disabled schedules vs ${usage.schedulesEnabled} enabled`, evidence: `schedules disabled=${usage.schedulesDisabled} enabled=${usage.schedulesEnabled}`, recommendation: "Audit disabled schedules: delete abandoned ones, re-enable those that should run.", effort: "S", priority: "low" });
  }
  if (usage.schedulesEnabled === 0 && inventory.schedules > 0) {
    dormant.push({ kind: "schedule", name: "All schedules disabled", reason: "No active schedules — automation is dormant", severity: "dormant" });
  }

  // — OrgTask health —
  if (usage.orgTasks.blocked > 5) {
    improvements.push({ area: "Org Tasks", issue: `${usage.orgTasks.blocked} tasks stuck in blocked — may need triage`, evidence: `orgTasks blocked=${usage.orgTasks.blocked} total=${usage.orgTasks.total}`, recommendation: "Review blocked OrgTasks on /org-dashboard, resolve or archive stale items.", effort: "S", priority: "high" });
    risks.push(`${usage.orgTasks.blocked} OrgTasks blocked — work is accumulating without resolution`);
  }
  if (usage.orgTasks.staleApprovals > 3) {
    improvements.push({ area: "Approvals", issue: `${usage.orgTasks.staleApprovals} items waiting on approval — bottleneck`, evidence: `waiting-on-approval=${usage.orgTasks.staleApprovals}`, recommendation: "Clear approval queue on /approvals — stale approvals block downstream work.", effort: "S", priority: "high" });
    risks.push(`Approval bottleneck: ${usage.orgTasks.staleApprovals} tasks parked waiting-on-approval`);
  }
  if (usage.orgTasks.total === 0) {
    dormant.push({ kind: "feature", name: "Org Tasks", reason: "No OrgTasks created — Naxie's org layer is dormant (all work via direct jobs)", severity: "dormant" });
  }

  // — Vault —
  if (usage.vaultNotes === 0) {
    dormant.push({ kind: "feature", name: "Vault", reason: "Vault has 0 markdown notes — knowledge base is empty", severity: "dormant" });
    improvements.push({ area: "Vault", issue: "Knowledge base empty — no notes to ground RAG / search", evidence: `vaultNotes=0`, recommendation: "Seed vault with onboarding notes or import existing docs so search + RAG have signal.", effort: "M", priority: "medium" });
    risks.push("Vault empty — RAG and knowledge features have nothing to retrieve");
  } else if (usage.vaultNotes < 10) {
    improvements.push({ area: "Vault", issue: `Only ${usage.vaultNotes} notes — knowledge base is thin`, evidence: `vaultNotes=${usage.vaultNotes}`, recommendation: "Add more notes / imports to strengthen RAG coverage.", effort: "M", priority: "low" });
  }

  // — Jobs health —
  if (usage.totalJobs30d === 0) {
    dormant.push({ kind: "feature", name: "Jobs (30d)", reason: "No jobs in last 30 days — system is idle", severity: "dormant" });
    risks.push("System idle for 30 days — no jobs recorded");
  } else if (usage.successRate30d < 0.6) {
    improvements.push({ area: "Reliability", issue: `Low success rate ${(usage.successRate30d * 100).toFixed(0)}% over last 30d (${usage.succeeded30d}/${usage.totalJobs30d})`, evidence: `successRate=${usage.successRate30d} failed=${usage.failed30d}`, recommendation: "Check reflection + audit log for top failure patterns; fix flaky runners or connectors.", effort: "M", priority: "high" });
    risks.push(`Low success rate ${(usage.successRate30d * 100).toFixed(0)}% — reliability needs attention`);
  }

  // — Audit log health —
  if (usage.auditEvents30d === 0) {
    improvements.push({ area: "Audit", issue: "No audit events in 30d — logging may be broken or system unused", evidence: `auditEvents30d=0`, recommendation: "Verify audit log writes (check _neuroworks/audit.jsonl) and ensure jobs log events.", effort: "S", priority: "medium" });
  }

  // — Useless / candidate for removal —
  // Heuristics for potentially unused code — conservative, always "review" not auto-delete
  if (inventory.libFiles.length > 80) {
    // Large lib surface — flag oldest / least-referenced as review candidates if dormancy is high
    const dormantRatio = dormant.length / Math.max(1, inventory.templates.length + inventory.personas.length + inventory.pages.length);
    if (dormantRatio > 0.4) {
      useless.push({ name: `${dormant.length} dormant items`, kind: "dormant-surface", reason: `${Math.round(dormantRatio * 100)}% of catalogued features are dormant — system surface may be overgrown`, recommendation: "review" });
    }
  }
  // Check for empty .neuroworks state files that indicate unused features
  const emptyStateChecks: { file: string; feature: string }[] = [
    { file: ".neuroworks/schedules.json", feature: "Schedules" },
    { file: ".neuroworks/connectors.json", feature: "Connectors" },
    { file: ".neuroworks/org-tasks.json", feature: "Org Tasks" },
    { file: ".neuroworks/crm.json", feature: "CRM" },
  ];
  for (const { file, feature } of emptyStateChecks) {
    try {
      const abs = join(REPO_ROOT, file);
      if (existsSync(abs)) {
        const raw = readFileSync(abs, "utf8").trim();
        const parsed = JSON.parse(raw);
        const arr = Array.isArray(parsed) ? parsed : (parsed.tasks ?? parsed.connectors ?? parsed.contacts ?? parsed.deals ?? []);
        if (Array.isArray(arr) && arr.length === 0) {
          // Already flagged via dormant above; also note as potentially useless if long-empty
          const ageMs = Date.now() - statSync(abs).mtimeMs;
          if (ageMs > 30 * 24 * 3600_000) {
            useless.push({ name: feature, kind: "empty-store", reason: `Store ${file} has been empty for >30 days — feature may be unused`, recommendation: "review" });
          }
        }
      }
    } catch { /* ignore */ }
  }

  // — Vault size —
  if (usage.vaultSizeMb > 500) {
    improvements.push({ area: "Vault", issue: `Vault is large (${usage.vaultSizeMb} MB) — may affect search/index performance`, evidence: `vaultSizeMb=${usage.vaultSizeMb}`, recommendation: "Archive old exports / media; ensure large binaries are not committed to git.", effort: "S", priority: "low" });
  }

  // — Health score (0-100) —
  let score = 100;
  score -= Math.min(30, usage.totalJobs30d === 0 ? 30 : (1 - usage.successRate30d) * 40);
  score -= Math.min(20, usage.orgTasks.blocked * 3);
  score -= Math.min(15, usage.orgTasks.staleApprovals * 4);
  score -= Math.min(15, dormant.filter(d => d.severity === "dormant").length * 1.5);
  score -= Math.min(10, useless.length * 3);
  score = Math.max(0, Math.min(100, Math.round(score)));
  const summary = score >= 80 ? "Healthy — minor tune-ups only"
    : score >= 60 ? "Stable — some dormant areas and a few fixes worth doing"
    : score >= 40 ? "Needs attention — dormant surface + reliability gaps"
    : "Needs review — significant dormant/unused surface or low success rate";

  return { dormant, useless, improvements, health: { score, summary, risks } };
}

// ── 4. LLM synthesis — Managing Director voice ────────────────────────────
async function synthesizeReport(stats: SystemAuditStats): Promise<{ text: string; modelUsed?: string }> {
  if (stats.inventory.totalServerFiles === 0 && stats.inventory.totalWebFiles === 0) {
    return { text: `_No inventory found — scan could not locate server/web source. Check REPO_ROOT path._` };
  }

  const sys = `You are Naxie, the Managing Director of NeuroWorks — the single accountable owner for every inch of the system. You have just completed a full scan of the entire codebase, every page, route, lib module, component, template, persona, schedule, connector, job, org-task, audit trail, and vault.

Write a Managing Director's system update in markdown. Be direct, specific, and decisive — this is a board-ready update, not a chat reply. Use EXACT headings:

## 🏢 Executive Summary
One short paragraph (2-4 sentences): overall health score, the single most important thing to act on, and the tone (healthy / stable / needs attention).

## 📊 System Map
Compact inventory: how many pages, routes, lib files, components, templates, personas, schedules, connectors. One bullet per line, numbers only — no filler.

## 🔧 What Needs Improvement
Concrete problems with evidence (numbers). Each bullet: what, why it matters, what to do, effort (S/M/L) + priority. If nothing, say so plainly.

## 💤 What's Dormant
Features/pages/templates/personas that exist but haven't been used in 30 days. Each bullet: name + why it's dormant + whether to keep, revive, or retire. If nothing dormant, say so.

## 🗑️ What Looks Useless
Candidates for removal / merge / deprecation. Be conservative — flag for human review, never declare "delete this" as fact. Cite the evidence (empty store for 30d, 0 runs, etc.). If nothing, say so.

## ✅ MD Directives
2-4 crisp directives from the MD: what the team should do this week, who owns it (role), and by when ("this week" is fine). Example: "Clear the 4 blocked OrgTasks (owner: Admin) — this week."

Rules:
- Numbers always. "4 of 12 templates dormant" beats "some templates unused".
- No filler ("In today's fast-paced environment..."). No emoji outside headings.
- Keep headings exactly as specified — the UI renders them.
- If stats are thin, say so honestly — don't pad.`;

  const prompt = `Date: ${stats.date}
Health: ${stats.health.score}/100 — ${stats.health.summary}
Risks: ${stats.health.risks.join("; ") || "(none)"}

## Inventory
Pages: ${stats.inventory.pages.length}  (sample: ${stats.inventory.pages.slice(0, 8).map(p => p.file).join(", ") || "(none)"})
Routes: ${stats.inventory.routes.length} — ${stats.inventory.routes.slice(0, 12).join(", ") || "(none)"}
Lib files: ${stats.inventory.libFiles.length} — ${stats.inventory.libFiles.slice(0, 12).join(", ") || "(none)"}
Components: ${stats.inventory.components.length}
Templates: ${stats.inventory.templates.length} — ${stats.inventory.templates.map(t => t.id).join(", ") || "(none)"}
Personas: ${stats.inventory.personas.length} — ${stats.inventory.personas.slice(0, 10).join(", ") || "(none)"}
Schedules: ${stats.inventory.schedules}  Connectors: ${stats.inventory.connectors}  Integrations: ${stats.inventory.integrations}
Total files: server=${stats.inventory.totalServerFiles} web=${stats.inventory.totalWebFiles}
Vault: ${stats.usage.vaultNotes} notes, ${stats.usage.vaultSizeMb} MB

## Usage (last 30d)
Jobs: ${stats.usage.totalJobs30d} total, ${stats.usage.succeeded30d} succeeded, ${stats.usage.failed30d} failed, successRate ${(stats.usage.successRate30d * 100).toFixed(0)}%
By template: ${Object.entries(stats.usage.byTemplate).map(([k, v]) => `${k}: ${v.total} (${v.ok} ok, ${v.failed} failed)`).join(" | ") || "(none)"}
By persona: ${Object.entries(stats.usage.byPersona).map(([k, v]) => `${k}: ${v}`).join(" | ") || "(none)"}
Audit events 30d: ${stats.usage.auditEvents30d} — by actor: ${Object.entries(stats.usage.auditByActor).map(([k, v]) => `${k}:${v}`).join(", ") || "(none)"}
OrgTasks: total ${stats.usage.orgTasks.total} — byStatus ${JSON.stringify(stats.usage.orgTasks.byStatus)} — byRole ${JSON.stringify(stats.usage.orgTasks.byRole)}
Schedules: enabled ${stats.usage.schedulesEnabled}, disabled ${stats.usage.schedulesDisabled}

## Pre-computed dormancy (heuristic)
${stats.dormant.length > 0 ? stats.dormant.map(d => `- [${d.severity}] ${d.kind}: ${d.name} — ${d.reason}`).join("\n") : "_(none dormant by heuristic)_"}

## Pre-computed useless candidates
${stats.useless.length > 0 ? stats.useless.map(u => `- ${u.kind}: ${u.name} — ${u.reason} → ${u.recommendation}`).join("\n") : "_(none flagged)_"}

## Pre-computed improvements
${stats.improvements.length > 0 ? stats.improvements.map(i => `- [${i.priority}/${i.effort}] ${i.area}: ${i.issue} — ${i.recommendation} (evidence: ${i.evidence})`).join("\n") : "_(none)_"}

Write the Managing Director's system update.`;

  const attempt = async (): Promise<{ text: string; modelUsed?: string }> => {
    let lastErr: any;
    for (let attemptIdx = 0; attemptIdx < 2; attemptIdx++) {
      try {
        const meta = await llmGenerateWithMeta(prompt, sys, { profile: "synthesis", complexity: "high" } as any);
        if (attemptIdx > 0) console.log(`[system-audit] LLM synthesis succeeded on retry`);
        return { text: meta.text.trim(), modelUsed: meta.model };
      } catch (e: any) {
        lastErr = e;
        if (attemptIdx === 0) {
          console.warn(`[system-audit] LLM synthesis failed (${String(e?.message ?? e).slice(0, 100)}) — retrying in 2s`);
          await new Promise(r => setTimeout(r, 2_000));
        }
      }
    }
    // Fallback: render without LLM
    const fallback = [
      `## 🏢 Executive Summary`,
      `Health ${stats.health.score}/100 — ${stats.health.summary}. LLM synthesis failed (\`${String(lastErr?.message ?? lastErr).slice(0, 120)}\`) — stats below are still valid; re-run \`/api/system-audit/run\` once the LLM is reachable.`,
      ``,
      `## 📊 System Map`,
      `- Pages: ${stats.inventory.pages.length}  Routes: ${stats.inventory.routes.length}  Lib: ${stats.inventory.libFiles.length}  Components: ${stats.inventory.components.length}`,
      `- Templates: ${stats.inventory.templates.length}  Personas: ${stats.inventory.personas.length}  Schedules: ${stats.inventory.schedules}  Connectors: ${stats.inventory.connectors}`,
      `- Vault: ${stats.usage.vaultNotes} notes (${stats.usage.vaultSizeMb} MB)  Jobs 30d: ${stats.usage.totalJobs30d} (${(stats.usage.successRate30d * 100).toFixed(0)}% success)`,
      ``,
      `## 🔧 What Needs Improvement`,
      ...(stats.improvements.length ? stats.improvements.map(i => `- [${i.priority}/${i.effort}] **${i.area}**: ${i.issue} — ${i.recommendation}`) : ["- _(no improvements flagged by heuristic)_"]),
      ``,
      `## 💤 What's Dormant`,
      ...(stats.dormant.length ? stats.dormant.map(d => `- **${d.name}** (${d.kind}, ${d.severity}): ${d.reason}`) : ["- _(none dormant)_"]),
      ``,
      `## 🗑️ What Looks Useless`,
      ...(stats.useless.length ? stats.useless.map(u => `- **${u.name}** (${u.kind}): ${u.reason} → ${u.recommendation}`) : ["- _(none flagged)_"]),
      ``,
      `## ✅ MD Directives`,
      `- Review this report and re-run with LLM once the backend is healthy to get the full narrative.`,
    ].join("\n");
    return { text: fallback };
  };

  const SYNTH_TIMEOUT_MS = Math.max(60_000, Number(process.env.NEUROWORKS_SYSTEM_AUDIT_SYNTH_TIMEOUT_MS ?? String(8 * 60_000)));
  let capTimer: NodeJS.Timeout | undefined;
  const cap = new Promise<{ text: string; modelUsed?: string }>((resolve) => {
    capTimer = setTimeout(() => {
      const mins = Math.round(SYNTH_TIMEOUT_MS / 60_000);
      console.warn(`[system-audit] synthesis exceeded ${mins}min cap — writing fallback`);
      const capFallback = [
        `_LLM synthesis exceeded the ${mins}min cap and was abandoned. The raw stats below are still valid — re-run \`/api/system-audit/run\` once the LLM backend is healthy._`,
        ``,
        `## 🏢 Executive Summary`,
        `Health ${stats.health.score}/100 — ${stats.health.summary}. Cap hit at ${mins}min.`,
        ``,
        `## 📊 System Map`,
        `- Pages: ${stats.inventory.pages.length}  Routes: ${stats.inventory.routes.length}  Lib: ${stats.inventory.libFiles.length}  Components: ${stats.inventory.components.length}`,
        `- Templates: ${stats.inventory.templates.length}  Personas: ${stats.inventory.personas.length}  Schedules: ${stats.inventory.schedules}  Connectors: ${stats.inventory.connectors}`,
        `- Vault: ${stats.usage.vaultNotes} notes (${stats.usage.vaultSizeMb} MB)  Jobs 30d: ${stats.usage.totalJobs30d} (${(stats.usage.successRate30d * 100).toFixed(0)}% success)`,
        ``,
        `## 🔧 What Needs Improvement`,
        ...(stats.improvements.length ? stats.improvements.map(i => `- **${i.area}**: ${i.issue} — ${i.recommendation}`) : ["- _(none)_"]),
        ``,
        `## 💤 What's Dormant`,
        ...(stats.dormant.length ? stats.dormant.slice(0, 20).map(d => `- **${d.name}** (${d.kind}): ${d.reason}`) : ["- _(none)_"]),
        ``,
        `## 🗑️ What Looks Useless`,
        ...(stats.useless.length ? stats.useless.map(u => `- **${u.name}**: ${u.reason} → ${u.recommendation}`) : ["- _(none)_"]),
        ``,
        `## ✅ MD Directives`,
        `- Re-run audit when LLM is healthy for full narrative.`,
      ].join("\n");
      resolve({ text: capFallback });
    }, SYNTH_TIMEOUT_MS);
    if (typeof capTimer.unref === "function") capTimer.unref();
  });
  try {
    return await Promise.race([attempt(), cap]);
  } finally {
    if (capTimer) clearTimeout(capTimer);
  }
}

function renderMarkdown(result: { stats: SystemAuditStats; report: string; generatedAt: string; modelUsed?: string }): string {
  const s = result.stats;
  const niceDate = new Date(s.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const header = `---
type: system-audit
date: ${s.date}
healthScore: ${s.health.score}
totalFiles: ${s.inventory.totalServerFiles + s.inventory.totalWebFiles}
dormantCount: ${s.dormant.length}
uselessCount: ${s.useless.length}
improvementsCount: ${s.improvements.length}
generated: ${result.generatedAt}
${result.modelUsed ? `model: ${result.modelUsed}\n` : ""}---

# 🏢 Managing Director — System Audit — ${niceDate}

> *Naxie's daily MD scan — every file, every feature, every page. What's improving, what's dormant, what's useless.*

| Health | Pages | Routes | Lib | Templates | Personas | Jobs 30d | Dormant | Useless |
|---|---|---|---|---|---|---|---|---|
| **${s.health.score}/100** | ${s.inventory.pages.length} | ${s.inventory.routes.length} | ${s.inventory.libFiles.length} | ${s.inventory.templates.length} | ${s.inventory.personas.length} | ${s.usage.totalJobs30d} | ${s.dormant.length} | ${s.useless.length} |

*${s.health.summary}${s.health.risks.length ? ` — Risks: ${s.health.risks.join("; ")}` : ""}*

---

`;
  const footer = `

---

<details><summary>Raw stats snapshot</summary>

\`\`\`json
${JSON.stringify(s, null, 2)}
\`\`\`

</details>
`;
  return header + result.report.trim() + footer;
}

// ── 5. Top-level orchestrator ──────────────────────────────────────────────
export async function runSystemAudit(): Promise<SystemAuditResult> {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const runStartedAtIso = new Date().toISOString();
    const inventory = scanInventory();
    const usage = await collectUsage();
    const findings = deriveFindings(inventory, usage);
    const date = new Date().toISOString().slice(0, 10);
    const generatedAt = new Date().toISOString();
    const stats: SystemAuditStats = {
      date,
      generatedAt,
      inventory,
      usage,
      dormant: findings.dormant,
      useless: findings.useless,
      improvements: findings.improvements,
      health: findings.health,
    };
    const { text, modelUsed } = await synthesizeReport(stats);
    const finalGeneratedAt = new Date().toISOString();
    stats.generatedAt = finalGeneratedAt;
    const path = `${AUDIT_DIR}/${date}.md`;
    const body = renderMarkdown({ stats, report: text, generatedAt: finalGeneratedAt, modelUsed });
    try {
      writeVaultFile(path, body);
      void enqueueVaultCommit(`chore(system-audit): MD audit for ${date} — health ${stats.health.score}/100`);
    } catch (e: any) {
      console.warn(`[system-audit] vault write failed: ${e?.message ?? e}`);
    }
    const result: SystemAuditResult = { date, path, stats, report: text, generatedAt: finalGeneratedAt, modelUsed };
    lastResult = result;
    // Surface on Calendar / audit
    try {
      const { newJob } = await import("./jobs.js");
      const { persistJobRecord } = await import("./job-store.js");
      const j = newJob("system-audit");
      j.title = `MD System Audit — ${date} (health ${stats.health.score}/100, ${stats.dormant.length} dormant, ${stats.useless.length} useless, ${stats.improvements.length} improvements)`;
      j.status = "succeeded";
      j.startedAt = runStartedAtIso;
      j.finishedAt = finalGeneratedAt;
      j.result = { answer: text, stats, auditPath: path } as any;
      try { persistJobRecord(j); } catch { /* tolerate */ }
    } catch (e: any) {
      console.warn(`[system-audit] job registration failed: ${e?.message ?? e}`);
    }
    return result;
  })();
  try { return await inFlight; }
  finally { inFlight = null; }
}

export function lastSystemAudit(): SystemAuditResult | null { return lastResult; }

export function getLatestSystemAuditSummary(): string | null {
  if (!lastResult) return null;
  const s = lastResult.stats;
  return `MD Audit ${s.date} — health ${s.health.score}/100 — ${s.health.summary}. Dormant: ${s.dormant.length}, Useless: ${s.useless.length}, Improvements: ${s.improvements.length}.`;
}

// Lightweight inventory probe for /api/naxie/status etc.
export function quickInventoryCounts(): { pages: number; routes: number; lib: number; templates: number; personas: number } {
  try {
    const inv = scanInventory();
    return { pages: inv.pages.length, routes: inv.routes.length, lib: inv.libFiles.length, templates: inv.templates.length, personas: inv.personas.length };
  } catch { return { pages: 0, routes: 0, lib: 0, templates: 0, personas: 0 }; }
}

// ── Scheduler (daily, 07:00 local — before innovation scan at 08:00) ───────
let scheduler: NodeJS.Timeout | null = null;
let lastRunDate: string | null = null;

async function deliverToTelegram(result: SystemAuditResult): Promise<void> {
  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const niceDate = new Date(result.date + "T12:00:00").toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    const s = result.stats;
    const header = `🏢 *MD System Audit — ${niceDate}*\nHealth ${s.health.score}/100 — ${s.health.summary}`;
    const line = `📄 ${s.inventory.pages.length} pages · 🔌 ${s.inventory.routes.length} routes · 📦 ${s.inventory.templates.length} templates · 👥 ${s.inventory.personas.length} personas`;
    const line2 = `💤 ${s.dormant.length} dormant · 🗑️ ${s.useless.length} useless · 🔧 ${s.improvements.length} improvements`;
    const body = result.report.slice(0, 3300);
    const footer = `\n\n— _Full report in vault: ${result.path}_`;
    const text = `${header}\n${line}\n${line2}\n\n${body}${footer}`;
    const r = await sendTelegramMessage(text);
    if (!r.ok) console.warn(`[system-audit] Telegram delivery skipped: ${r.error}`);
  } catch (e: any) { console.warn(`[system-audit] Telegram delivery failed: ${e?.message ?? e}`); }
}

export function startSystemAuditScheduler(): void {
  if (scheduler) return;
  const AUDIT_HOUR = Number(process.env.NEUROWORKS_SYSTEM_AUDIT_HOUR ?? "7");
  const tick = async () => {
    const now = new Date();
    const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
    if (now.getHours() < AUDIT_HOUR || lastRunDate === today) return;
    try {
      const { join } = await import("node:path");
      const dir = join(config.vaultPath, AUDIT_DIR);
      if (existsSync(dir)) {
        const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        const ranToday = readdirSync(dir).some(f => {
          if (!f.endsWith(".md")) return false;
          try { return statSync(join(dir, f)).mtimeMs >= midnight; } catch { return false; }
        });
        if (ranToday) { lastRunDate = today; return; }
      }
    } catch { /* vault unreachable — fall through */ }
    lastRunDate = today;
    console.log(`[system-audit] firing daily MD audit (hour>=${AUDIT_HOUR}, catch-up)`);
    try {
      const result = await runSystemAudit();
      void deliverToTelegram(result);
    } catch (e: any) { console.warn(`[system-audit] scheduler run failed: ${e?.message ?? e}`); }
  };
  scheduler = setInterval(tick, 10 * 60_000);
  // unref so it doesn't hold process open in tests
  (scheduler as any).unref?.();
  void tick();
}

export function stopSystemAuditScheduler(): void {
  if (scheduler) { clearInterval(scheduler); scheduler = null; }
}

void llmGenerateWithMeta;
