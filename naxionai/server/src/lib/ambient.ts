// Ambient Watch — the background watcher that notices things on its own
// (a job finishing, a schedule firing, a planner reminder coming due, a new
// commit, an email landing in triage, a webhook/flow failing) and decides
// whether to bring it to the operator, instead of waiting to be asked.
//
// v1 posture is deliberately polling + rule-based, mirroring how
// github-watcher.ts proved itself before anything reacted to it:
//
//   - One 60s engine tick ("ambient-watch" in scheduler-registry.ts) scans
//     every enabled source for items newer than its cursor. No hooks are
//     patched into the jobs/schedules hot paths, so a bug here can only
//     skip a nudge, never break a run.
//   - Severity is assigned by small per-source rules; "should this interrupt
//     you?" is answered by judgeRelevance() below. That function is
//     rule-based today and is the seam where an LLM relevance judge lands
//     later — same input (the event), same output ({bring, reason}).
//   - Push goes through the operator's own channels (toast / Telegram /
//     email), honouring quiet hours: attention during quiet hours is deferred
//     to the morning digest, urgent always breaks through.
//
// State lives in three .naxion/ JSON stores (json-store.ts crash-safe IO):
// ambient-config.json (operator settings), ambient-events.json (the feed the
// page renders), ambient-state.json (per-source cursors + digest bookkeeping).

import { randomUUID } from "node:crypto";
import { statePath, readJsonStore, tryWriteJsonStore } from "./json-store.js";
import { registerEngine, listEngines } from "./scheduler-registry.js";

export type AmbientSource =
  | "job" | "schedule" | "calendar" | "github" | "email" | "webhook" | "flow";

export const AMBIENT_SOURCES: AmbientSource[] = [
  "job", "schedule", "calendar", "github", "email", "webhook", "flow",
];

export type AmbientSeverity = "info" | "attention" | "urgent";

export type AmbientEvent = {
  id: string;
  at: string;
  source: AmbientSource;
  title: string;
  detail?: string;
  severity: AmbientSeverity;
  link?: { jobId?: string; scheduleId?: string; url?: string };
  dedupeKey?: string;
  notified: string[];
  judgeNote?: string;
};

export type AmbientConfig = {
  enabled: boolean;
  sources: Record<AmbientSource, boolean>;
  channels: { toast: boolean; telegram: boolean; email: boolean };
  /** Quiet window in local 24h "HH:MM" — attention waits for the digest. Null = always notify. */
  quietHours: { start: string; end: string } | null;
  digest: { enabled: boolean; hour: number; minute: number };
  /** Where attention/urgent email goes. Defaults to the operator's own address. */
  emailTo?: string;
};

const DEFAULT_CONFIG: AmbientConfig = {
  enabled: true,
  sources: { job: true, schedule: true, calendar: true, github: true, email: true, webhook: true, flow: true },
  channels: { toast: true, telegram: true, email: false },
  quietHours: { start: "22:00", end: "07:00" },
  digest: { enabled: true, hour: 8, minute: 0 },
};

const MAX_EVENTS = 300;
const DEDUPE_WINDOW_MS = 24 * 3600 * 1000;

const CONFIG_FILE = () => statePath("ambient-config.json");
const EVENTS_FILE = () => statePath("ambient-events.json");
const STATE_FILE = () => statePath("ambient-state.json");

type AmbientCursorState = {
  jobsAt?: string;
  schedulesSeen?: Record<string, string>;
  githubAt?: string;
  triageSeen?: string[];
  webhookSeen?: string[];
  flowSeen?: string[];
  calSeen?: Record<string, string>;
  lastDigestDate?: string;
};

export function getAmbientConfig(): AmbientConfig {
  const read = readJsonStore<Partial<AmbientConfig>>(CONFIG_FILE(), () => ({}), { label: "ambient-config" });
  const v = read.value ?? {};
  return {
    ...DEFAULT_CONFIG,
    ...v,
    sources: { ...DEFAULT_CONFIG.sources, ...(v.sources ?? {}) },
    channels: { ...DEFAULT_CONFIG.channels, ...(v.channels ?? {}) },
    digest: { ...DEFAULT_CONFIG.digest, ...(v.digest ?? {}) },
  };
}

export function updateAmbientConfig(patch: Partial<AmbientConfig>): AmbientConfig {
  const next = getAmbientConfig();
  if (typeof patch.enabled === "boolean") next.enabled = patch.enabled;
  if (patch.sources) for (const s of AMBIENT_SOURCES) {
    if (typeof (patch.sources as any)[s] === "boolean") next.sources[s] = (patch.sources as any)[s];
  }
  if (patch.channels) for (const c of ["toast", "telegram", "email"] as const) {
    if (typeof (patch.channels as any)[c] === "boolean") next.channels[c] = (patch.channels as any)[c];
  }
  if (patch.quietHours === null) next.quietHours = null;
  else if (patch.quietHours && /^\d{2}:\d{2}$/.test(patch.quietHours.start ?? "") && /^\d{2}:\d{2}$/.test(patch.quietHours.end ?? "")) {
    next.quietHours = { start: patch.quietHours.start, end: patch.quietHours.end };
  }
  if (patch.digest) {
    const h = Math.max(0, Math.min(23, Number(patch.digest.hour)));
    const m = Math.max(0, Math.min(59, Number(patch.digest.minute)));
    if (Number.isFinite(h)) next.digest.hour = h;
    if (Number.isFinite(m)) next.digest.minute = m;
    if (typeof patch.digest.enabled === "boolean") next.digest.enabled = patch.digest.enabled;
  }
  if (patch.emailTo !== undefined) {
    const v = String(patch.emailTo ?? "").trim();
    if (v && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v)) throw new Error("emailTo is not a valid address");
    next.emailTo = v || undefined;
  }
  tryWriteJsonStore(CONFIG_FILE(), next, { label: "ambient-config" });
  return next;
}

function loadEvents(): AmbientEvent[] {
  const read = readJsonStore<AmbientEvent[]>(EVENTS_FILE(), () => [], {
    label: "ambient-events",
    validate: v => Array.isArray(v),
  });
  return Array.isArray(read.value) ? read.value : [];
}

function persistEvents(events: AmbientEvent[]): void {
  tryWriteJsonStore(EVENTS_FILE(), events.slice(0, MAX_EVENTS), { label: "ambient-events" });
}

function loadCursorState(): AmbientCursorState {
  const read = readJsonStore<AmbientCursorState>(STATE_FILE(), () => ({}), { label: "ambient-state" });
  return (read.value && typeof read.value === "object" ? read.value : {}) as AmbientCursorState;
}

function persistCursorState(s: AmbientCursorState): void {
  tryWriteJsonStore(STATE_FILE(), s, { label: "ambient-state" });
}

export function listAmbientEvents(filter?: { source?: AmbientSource; limit?: number }): AmbientEvent[] {
  const all = loadEvents();
  const bySource = filter?.source ? all.filter(e => e.source === filter.source) : all;
  return bySource.slice(0, Math.max(1, Math.min(200, filter?.limit ?? 50)));
}

export function clearAmbientEvents(): { cleared: number } {
  const n = loadEvents().length;
  persistEvents([]);
  return { cleared: n };
}

// ── The relevance judge ──────────────────────────────────────────────────────
// LLM-JUDGE SEAM (not wired yet): when this grows an LLM call, keep this exact
// signature — the tick, the test endpoint, and the digest all decide through
// here, so swapping the inside from rules to a model (with the rules as a
// cheap pre-filter / fallback when the model is unreachable) touches one
// place. Input: the recorded event. Output: bring it to the operator now?
export async function judgeRelevance(ev: AmbientEvent): Promise<{ bring: boolean; reason: string }> {
  if (ev.severity === "urgent") return { bring: true, reason: "rule:urgent-always" };
  if (ev.severity === "attention") return { bring: true, reason: `rule:${ev.source}-attention` };
  return { bring: false, reason: `rule:${ev.source}-info-feed-only` };
}

function inQuietHours(cfg: AmbientConfig, now = new Date()): boolean {
  if (!cfg.quietHours) return false;
  const cur = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const { start, end } = cfg.quietHours;
  if (start <= end) return cur >= start && cur < end;
  return cur >= start || cur < end; // overnight window, e.g. 22:00–07:00
}

async function dispatch(ev: AmbientEvent, cfg: AmbientConfig): Promise<string[]> {
  const done: string[] = [];
  const title = `Naxie · ${ev.title}`;
  const body = ev.detail ?? ev.title;
  if (cfg.channels.toast) {
    try {
      const { notifyToast } = await import("./host-tools.js");
      await notifyToast(title, body.slice(0, 200));
      done.push("toast");
    } catch { /* best-effort */ }
  }
  if (cfg.channels.telegram) {
    try {
      const { sendTelegramMessage } = await import("./telegram-bridge.js");
      const { card } = await import("./telegram-format.js");
      const icon = ev.severity === "urgent" ? "🚨" : "🔔";
      await sendTelegramMessage(card({ icon, title: ev.title, body }).slice(0, 3800));
      done.push("telegram");
    } catch { /* best-effort */ }
  }
  if (cfg.channels.email && ev.severity !== "info") {
    try {
      const { sendEmail, emailConfigured } = await import("./email.js");
      if (emailConfigured()) {
        let to = (cfg.emailTo ?? "").trim();
        if (!to) {
          try {
            const { lookupUser } = await import("./users.js");
            to = lookupUser("operator")?.email ?? "";
          } catch { /* no operator address */ }
        }
        if (to) {
          await sendEmail({ to, subject: title, body });
          done.push("email");
        }
      }
    } catch { /* best-effort */ }
  }
  try {
    const { logAudit } = await import("./audit-log.js");
    logAudit({
      level: ev.severity === "info" ? "info" : "warn",
      actor: "ambient-watch",
      action: `ambient.${ev.source}`,
      target: ev.title,
      detail: `${ev.severity} · via ${done.join(",") || "feed-only"}${ev.judgeNote ? ` · ${ev.judgeNote}` : ""}`,
      jobId: ev.link?.jobId,
      result: done.length ? "success" : "pending",
    });
  } catch { /* audit is best-effort */ }
  return done;
}

/** Record an event, run it through the judge, and push if warranted. Never throws. */
export async function emitAmbientEvent(input: {
  source: AmbientSource;
  title: string;
  detail?: string;
  severity: AmbientSeverity;
  link?: AmbientEvent["link"];
  dedupeKey?: string;
}): Promise<AmbientEvent | null> {
  try {
    const cfg = getAmbientConfig();
    if (!cfg.enabled || !cfg.sources[input.source]) return null;
    const events = loadEvents();
    if (input.dedupeKey) {
      const seen = events.find(e =>
        e.dedupeKey === input.dedupeKey &&
        Date.now() - Date.parse(e.at) < DEDUPE_WINDOW_MS);
      if (seen) return seen;
    }
    const ev: AmbientEvent = {
      id: randomUUID().slice(0, 8),
      at: new Date().toISOString(),
      source: input.source,
      title: input.title.slice(0, 200),
      detail: input.detail?.slice(0, 2000),
      severity: input.severity,
      link: input.link,
      dedupeKey: input.dedupeKey,
      notified: [],
    };
    const judged = await judgeRelevance(ev).catch(() => ({ bring: false, reason: "judge-error" }));
    ev.judgeNote = judged.reason;
    if (judged.bring) {
      if (ev.severity !== "urgent" && inQuietHours(cfg)) {
        ev.notified = ["deferred-quiet-hours"];
      } else {
        ev.notified = await dispatch(ev, cfg);
      }
    }
    persistEvents([ev, ...events]);
    return ev;
  } catch (e: any) {
    console.warn(`[ambient] emit failed: ${e?.message ?? e}`);
    return null;
  }
}

// ── Source scans (one per tick, each best-effort and cursor-guarded) ─────────

async function scanJobs(cursors: AmbientCursorState): Promise<void> {
  const { listJobs } = await import("./jobs.js");
  const since = Date.parse(cursors.jobsAt ?? "") || Date.now() - 3600_000;
  let high = since;
  for (const j of listJobs()) {
    const at = Date.parse((j as any).finishedAt ?? j.startedAt);
    if (!Number.isFinite(at) || at <= since) continue;
    if (at > high) high = at;
    const st: string = j.status;
    if (!["succeeded", "failed", "rejected", "waiting_on_human"].includes(st)) continue;
    const label = (j as any).title ?? (j as any).template ?? (j as any).kind ?? "task";
    if (st === "failed") {
      await emitAmbientEvent({
        source: "job", title: `Job failed — ${label}`,
        detail: String((j as any).error ?? "no error recorded").slice(0, 500),
        severity: "attention", link: { jobId: j.id }, dedupeKey: `job:${j.id}`,
      });
    } else if (st === "waiting_on_human") {
      await emitAmbientEvent({
        source: "job", title: `Agent is waiting on you — ${label}`,
        detail: "Answer in My Inbox to resume the run.",
        severity: "attention", link: { jobId: j.id }, dedupeKey: `job:${j.id}`,
      });
    } else if (st === "rejected") {
      await emitAmbientEvent({
        source: "job", title: `Run rejected — ${label}`,
        detail: "A run was rejected at approval.", severity: "info",
        link: { jobId: j.id }, dedupeKey: `job:${j.id}`,
      });
    } else {
      await emitAmbientEvent({
        source: "job", title: `Job finished — ${label}`,
        detail: "Result is on the Runs feed.", severity: "info",
        link: { jobId: j.id }, dedupeKey: `job:${j.id}`,
      });
    }
  }
  cursors.jobsAt = new Date(high).toISOString();
}

async function scanSchedules(cursors: AmbientCursorState): Promise<void> {
  const { listSchedules } = await import("./schedules.js");
  cursors.schedulesSeen ??= {};
  for (const s of listSchedules()) {
    const firedAt = (s as any).lastFiredAt as string | undefined;
    if (!firedAt || cursors.schedulesSeen[s.id] === firedAt) continue;
    cursors.schedulesSeen[s.id] = firedAt;
    if ((s as any).lastError) {
      await emitAmbientEvent({
        source: "schedule", title: `Schedule failed — ${s.name}`,
        detail: String((s as any).lastError).slice(0, 500),
        severity: "attention", link: { scheduleId: s.id },
      });
    } else {
      await emitAmbientEvent({
        source: "schedule", title: `Schedule fired — ${s.name}`,
        detail: (s as any).lastJobId ? `Job ${(s as any).lastJobId.slice(0, 8)} running.` : undefined,
        severity: "info", link: { scheduleId: s.id, jobId: (s as any).lastJobId },
        dedupeKey: `sched:${s.id}:${firedAt}`,
      });
    }
  }
}

async function scanCalendar(cursors: AmbientCursorState): Promise<void> {
  // The Planner is the operator's personal calendar (tasks with reminderAt /
  // dueDate). The store is owner-scoped per user, but the watcher is
  // system-wide, so read the raw store and scan every owner's open items.
  const read = readJsonStore<{ items?: any[] }>(statePath("my-tasks.json"), () => ({ items: [] }), { label: "ambient-calendar" });
  const items = Array.isArray(read.value?.items) ? read.value!.items! : [];
  cursors.calSeen ??= {};
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  for (const it of items) {
    if (!it || it.completed) continue;
    const id = String(it.id ?? "");
    if (!id) continue;
    if (it.reminderAt) {
      const at = Date.parse(it.reminderAt);
      if (Number.isFinite(at) && at <= now + 30 * 60_000 && at > now - 6 * 3600_000) {
        const key = `rem:${id}:${new Date(at).toISOString().slice(0, 13)}`;
        if (cursors.calSeen[key] !== today + ":fired") {
          cursors.calSeen[key] = today + ":fired";
          await emitAmbientEvent({
            source: "calendar", title: `Reminder due — ${String(it.title ?? "untitled").slice(0, 120)}`,
            detail: `Due ${new Date(at).toLocaleString()}.`,
            severity: "attention", dedupeKey: key,
          });
        }
      }
    }
    if (it.dueDate && typeof it.dueDate === "string" && it.dueDate < today) {
      const key = `over:${id}:${today}`;
      if (!cursors.calSeen[key]) {
        cursors.calSeen[key] = "fired";
        await emitAmbientEvent({
          source: "calendar", title: `Overdue task — ${String(it.title ?? "untitled").slice(0, 120)}`,
          detail: `Was due ${it.dueDate}.`, severity: "attention", dedupeKey: key,
        });
      }
    }
  }
}

async function scanGithub(cursors: AmbientCursorState): Promise<void> {
  const { listGithubEvents } = await import("./github-watcher.js");
  const since = Date.parse(cursors.githubAt ?? "") || Date.now() - 3600_000;
  let high = since;
  for (const g of listGithubEvents()) {
    const at = Date.parse(g.at);
    if (!Number.isFinite(at) || at <= since) continue;
    if (at > high) high = at;
    await emitAmbientEvent({
      source: "github", title: `New commit in ${g.repo}`,
      detail: `${g.message} — ${g.author}`.slice(0, 500),
      severity: "info", link: { url: g.url }, dedupeKey: `gh:${g.repo}:${g.sha}`,
    });
  }
  cursors.githubAt = new Date(high).toISOString();
}

async function scanEmail(cursors: AmbientCursorState): Promise<void> {
  const { listTriage } = await import("./email.js");
  cursors.triageSeen ??= [];
  const seen = new Set(cursors.triageSeen);
  for (const [key, t] of Object.entries(listTriage() as Record<string, any>)) {
    if (!t || t.status !== "pending" || seen.has(key)) continue;
    seen.add(key);
    await emitAmbientEvent({
      source: "email", title: `Email needs triage — ${String(t.subject ?? "(no subject)").slice(0, 120)}`,
      detail: `From ${t.sender ?? "unknown"}. Open the inbox to reply, snooze, or resolve.`,
      severity: "attention", dedupeKey: `mail:${key}`,
    });
  }
  cursors.triageSeen = [...seen].slice(-200);
}

async function scanWebhooks(cursors: AmbientCursorState): Promise<void> {
  const { listDeliveries } = await import("./webhook-delivery.js");
  cursors.webhookSeen ??= [];
  const seen = new Set(cursors.webhookSeen);
  for (const d of listDeliveries({ status: "failed" })) {
    if (seen.has(d.id)) continue;
    if (Date.now() - Date.parse(d.createdAt) > DEDUPE_WINDOW_MS) continue;
    seen.add(d.id);
    await emitAmbientEvent({
      source: "webhook", title: `Webhook delivery failing — ${d.event}`,
      detail: (d.lastError ?? `target ${d.targetId}, attempt ${d.attempts}`).slice(0, 500),
      severity: "attention", dedupeKey: `wh:${d.id}`,
    });
  }
  for (const d of listDeliveries({ status: "dead_letter" })) {
    if (seen.has(d.id)) continue;
    if (Date.now() - Date.parse(d.createdAt) > DEDUPE_WINDOW_MS) continue;
    seen.add(d.id);
    await emitAmbientEvent({
      source: "webhook", title: `Webhook dead-lettered — ${d.event}`,
      detail: `Gave up after ${d.attempts} attempts: ${(d.lastError ?? "").slice(0, 300)}`,
      severity: "urgent", dedupeKey: `wh:${d.id}`,
    });
  }
  cursors.webhookSeen = [...seen].slice(-200);
}

async function scanFlows(cursors: AmbientCursorState): Promise<void> {
  const { listRuns } = await import("./flow-automations.js");
  cursors.flowSeen ??= [];
  const seen = new Set(cursors.flowSeen);
  for (const r of listRuns(undefined, 20)) {
    if ((r as any).status !== "failed" || seen.has((r as any).id)) continue;
    seen.add((r as any).id);
    await emitAmbientEvent({
      source: "flow", title: `Flow run failed — ${(r as any).flowId ?? "flow"}`,
      detail: String((r as any).lastError ?? "no error recorded").slice(0, 500),
      severity: "attention", dedupeKey: `flow:${(r as any).id}`,
    });
  }
  cursors.flowSeen = [...seen].slice(-200);
}

async function maybeDigest(cfg: AmbientConfig, cursors: AmbientCursorState): Promise<void> {
  if (!cfg.digest.enabled) return;
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (cursors.lastDigestDate === today) return;
  const fireAt = new Date(now);
  fireAt.setHours(cfg.digest.hour, cfg.digest.minute, 0, 0);
  if (now < fireAt) return; // not time yet
  cursors.lastDigestDate = today;
  persistCursorState(cursors);
  const since = Date.now() - DEDUPE_WINDOW_MS;
  const fresh = loadEvents().filter(e => Date.parse(e.at) >= since);
  if (fresh.length === 0) return;
  const deferred = fresh.filter(e => e.notified.includes("deferred-quiet-hours"));
  const lines = fresh.slice(0, 15).map(e =>
    `• [${e.source}] ${e.title}${e.notified.length && !e.notified.includes("deferred-quiet-hours") ? ` (sent: ${e.notified.join(",")})` : ""}`);
  const text = `Naxie · morning digest — ${fresh.length} thing(s) in the last 24h${deferred.length ? `, ${deferred.length} held for quiet hours` : ""}:\n\n${lines.join("\n")}${fresh.length > 15 ? `\n\n…and ${fresh.length - 15} more on the Ambient Watch page.` : ""}`;
  try {
    if (cfg.channels.telegram) {
      const { sendTelegramMessage } = await import("./telegram-bridge.js");
      await sendTelegramMessage(text.slice(0, 3800));
    }
    if (cfg.channels.email) {
      const { sendEmail, emailConfigured } = await import("./email.js");
      if (emailConfigured()) {
        let to = (cfg.emailTo ?? "").trim();
        if (!to) {
          try {
            const { lookupUser } = await import("./users.js");
            to = lookupUser("operator")?.email ?? "";
          } catch { /* ignore */ }
        }
        if (to) await sendEmail({ to, subject: "Naxie · morning digest", body: text });
      }
    }
  } catch { /* digest is best-effort */ }
}

async function tick(): Promise<void> {
  const cfg = getAmbientConfig();
  if (!cfg.enabled) return;
  const cursors = loadCursorState();
  // Each source is independently best-effort — one throwing must not starve
  // the rest of the tick.
  if (cfg.sources.job) await scanJobs(cursors).catch(e => console.warn(`[ambient] jobs scan: ${e?.message ?? e}`));
  if (cfg.sources.schedule) await scanSchedules(cursors).catch(e => console.warn(`[ambient] schedules scan: ${e?.message ?? e}`));
  if (cfg.sources.calendar) await scanCalendar(cursors).catch(e => console.warn(`[ambient] calendar scan: ${e?.message ?? e}`));
  if (cfg.sources.github) await scanGithub(cursors).catch(e => console.warn(`[ambient] github scan: ${e?.message ?? e}`));
  if (cfg.sources.email) await scanEmail(cursors).catch(e => console.warn(`[ambient] email scan: ${e?.message ?? e}`));
  if (cfg.sources.webhook) await scanWebhooks(cursors).catch(e => console.warn(`[ambient] webhooks scan: ${e?.message ?? e}`));
  if (cfg.sources.flow) await scanFlows(cursors).catch(e => console.warn(`[ambient] flows scan: ${e?.message ?? e}`));
  persistCursorState(cursors);
  await maybeDigest(cfg, cursors).catch(e => console.warn(`[ambient] digest: ${e?.message ?? e}`));
}

export const AMBIENT_INTERVAL_SECONDS = Number(process.env.NAXION_AMBIENT_INTERVAL_SECONDS ?? "60") || 60;

export function startAmbientWatcher(): void {
  registerEngine({ name: "ambient-watch", intervalSeconds: AMBIENT_INTERVAL_SECONDS, run: tick });
}

/** Test seam — run one tick on demand (route + future tests). */
export async function runAmbientTickOnce(): Promise<void> {
  await tick();
}

export function ambientEngineStatus(): { name: string; intervalSeconds: number; lastRunAt?: string; lastError?: string } | null {
  return listEngines().find(e => e.name === "ambient-watch") ?? null;
}
