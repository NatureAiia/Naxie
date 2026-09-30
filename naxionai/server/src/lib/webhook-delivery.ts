// Outbound webhook delivery — a persistent target registry + per-attempt
// delivery history, retry with a dead-letter tier, and manual replay.
//
// dispatch.ts already does one-shot signed webhook delivery for a single
// per-call callbackUrl (Naxie → the API caller who dispatched a task): sign,
// POST once, log-and-drop on failure. This module is the general-purpose
// sibling for STANDING outbound integrations — an operator registers a
// target once, any part of Naxie can publishEvent() to it by name, and a
// failed delivery is retried on a schedule instead of silently lost. Modeled
// on the omnis-signal "Scraper Hub" webhook_publisher.py pattern (HMAC sign +
// per-attempt persistence + dead-letter + replay), reusing this codebase's
// own SSRF guard (security-gates.ts) rather than reimplementing one.

import { createHmac, randomUUID } from "node:crypto";
import { readJsonStore, statePath, tryWriteJsonStore } from "./json-store.js";
import { assertSafePublicUrlAsync } from "./security-gates.js";

const TARGETS_PATH = () => statePath("webhook-targets.json");
const DELIVERIES_PATH = () => statePath("webhook-deliveries.json");

// Attempts before a delivery is parked as dead_letter instead of retried
// again on the next scheduler tick.
const MAX_ATTEMPTS = 5;
// Hard cap on stored delivery history — oldest are dropped first, keeping
// pending/failed ones over settled successes when trimming.
const MAX_DELIVERIES = 2000;

export type WebhookTarget = {
  id: string;
  label: string;
  url: string;
  secret: string;
  // Event names this target wants. Empty = every published event.
  events: string[];
  enabled: boolean;
  createdAt: string;
};

export type WebhookDeliveryStatus = "pending" | "success" | "failed" | "dead_letter";

export type WebhookDelivery = {
  id: string;
  targetId: string;
  event: string;
  payload: unknown;
  status: WebhookDeliveryStatus;
  attempts: number;
  lastAttemptAt?: string;
  lastError?: string;
  createdAt: string;
};

let targetsUnreadable: string | null = null;
let deliveriesUnreadable: string | null = null;

/** Why a webhook store is unreadable, or null. For /api/status. */
export function webhookStoreProblem(): string | null {
  return targetsUnreadable ?? deliveriesUnreadable;
}

function loadTargets(): WebhookTarget[] {
  const read = readJsonStore<WebhookTarget[]>(TARGETS_PATH(), () => [], {
    label: "webhook-targets",
    validate: v => Array.isArray(v),
  });
  if (read.error) targetsUnreadable = read.error;
  return Array.isArray(read.value) ? read.value : [];
}

function saveTargets(list: WebhookTarget[]): void {
  if (targetsUnreadable) {
    console.warn(`[webhook-targets] persist REFUSED — store is unreadable (${targetsUnreadable}). Resolve the quarantined file and restart.`);
    return;
  }
  tryWriteJsonStore(TARGETS_PATH(), list, { label: "webhook-targets" });
}

function loadDeliveries(): WebhookDelivery[] {
  const read = readJsonStore<WebhookDelivery[]>(DELIVERIES_PATH(), () => [], {
    label: "webhook-deliveries",
    validate: v => Array.isArray(v),
  });
  if (read.error) deliveriesUnreadable = read.error;
  return Array.isArray(read.value) ? read.value : [];
}

function saveDeliveries(list: WebhookDelivery[]): void {
  if (deliveriesUnreadable) {
    console.warn(`[webhook-deliveries] persist REFUSED — store is unreadable (${deliveriesUnreadable}). Resolve the quarantined file and restart.`);
    return;
  }
  // Trim oldest SUCCESS/DEAD_LETTER rows first so the cap never evicts a
  // still-retryable "failed" delivery ahead of settled history.
  let trimmed = list;
  if (trimmed.length > MAX_DELIVERIES) {
    const keep = [...trimmed].sort((a, b) => {
      const rank = (d: WebhookDelivery) => (d.status === "pending" || d.status === "failed" ? 0 : 1);
      const r = rank(a) - rank(b);
      return r !== 0 ? r : b.createdAt.localeCompare(a.createdAt);
    });
    trimmed = keep.slice(0, MAX_DELIVERIES);
  }
  tryWriteJsonStore(DELIVERIES_PATH(), trimmed, { label: "webhook-deliveries" });
}

function newSecret(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

// ── Target registry ─────────────────────────────────────────────────────────

export function listTargets(): WebhookTarget[] {
  return loadTargets().sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getTarget(id: string): WebhookTarget | undefined {
  return loadTargets().find(t => t.id === id);
}

export function addTarget(input: { label: string; url: string; events?: string[]; secret?: string }): WebhookTarget {
  const list = loadTargets();
  const target: WebhookTarget = {
    id: randomUUID(),
    label: input.label.trim() || "Untitled webhook",
    url: input.url.trim(),
    secret: (input.secret ?? "").trim() || newSecret(),
    events: Array.isArray(input.events) ? input.events.map(String) : [],
    enabled: true,
    createdAt: new Date().toISOString(),
  };
  if (!target.url) throw new Error("url is required");
  list.push(target);
  saveTargets(list);
  return target;
}

export function removeTarget(id: string): boolean {
  const list = loadTargets();
  const next = list.filter(t => t.id !== id);
  if (next.length === list.length) return false;
  saveTargets(next);
  return true;
}

export function setTargetEnabled(id: string, enabled: boolean): WebhookTarget | null {
  const list = loadTargets();
  const t = list.find(x => x.id === id);
  if (!t) return null;
  t.enabled = enabled;
  saveTargets(list);
  return t;
}

export function rotateTargetSecret(id: string): WebhookTarget | null {
  const list = loadTargets();
  const t = list.find(x => x.id === id);
  if (!t) return null;
  t.secret = newSecret();
  saveTargets(list);
  return t;
}

// ── Delivery history ────────────────────────────────────────────────────────

export function listDeliveries(filter?: { targetId?: string; status?: WebhookDeliveryStatus }): WebhookDelivery[] {
  let list = loadDeliveries();
  if (filter?.targetId) list = list.filter(d => d.targetId === filter.targetId);
  if (filter?.status) list = list.filter(d => d.status === filter.status);
  return list.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export function getDelivery(id: string): WebhookDelivery | undefined {
  return loadDeliveries().find(d => d.id === id);
}

function sign(secret: string, body: string): string {
  return "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
}

// Attempts one HTTP delivery, mutating `delivery` in place with the outcome.
// Never throws — every failure path is recorded on the delivery instead.
async function attemptDelivery(target: WebhookTarget, delivery: WebhookDelivery): Promise<void> {
  const body = JSON.stringify({ event: delivery.event, payload: delivery.payload, deliveryId: delivery.id });
  delivery.attempts += 1;
  delivery.lastAttemptAt = new Date().toISOString();
  try {
    await assertSafePublicUrlAsync(target.url);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    let res: Response;
    try {
      res = await fetch(target.url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Webhook-Signature": sign(target.secret, body),
          "X-Webhook-Event": delivery.event,
          "User-Agent": "Naxie-Webhook/1",
        },
        body,
        // Do NOT follow redirects — a target URL that 302s to an internal
        // host would otherwise slip past the SSRF check on the original host.
        redirect: "manual",
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    if (res.status >= 200 && res.status < 300) {
      delivery.status = "success";
      delivery.lastError = undefined;
      return;
    }
    throw new Error(`HTTP ${res.status}`);
  } catch (e: any) {
    delivery.lastError = String(e?.message ?? e).slice(0, 2000);
    delivery.status = delivery.attempts >= MAX_ATTEMPTS ? "dead_letter" : "failed";
  }
}

// Publish an event to every enabled target subscribed to it (or every
// enabled target, if a target declares no event filter). Best-effort per
// target — one target's failure never blocks another's delivery.
export async function publishEvent(event: string, payload: unknown): Promise<{ dispatched: number; deliveryIds: string[] }> {
  const targets = listTargets().filter(t => t.enabled && (t.events.length === 0 || t.events.includes(event)));
  const deliveryIds: string[] = [];
  if (targets.length === 0) return { dispatched: 0, deliveryIds };

  const list = loadDeliveries();
  for (const target of targets) {
    const delivery: WebhookDelivery = {
      id: randomUUID(),
      targetId: target.id,
      event,
      payload,
      status: "pending",
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    await attemptDelivery(target, delivery);
    list.push(delivery);
    deliveryIds.push(delivery.id);
  }
  saveDeliveries(list);
  return { dispatched: targets.length, deliveryIds };
}

// Scheduler tick (registered via scheduler-registry.ts) — retries every
// "failed" delivery whose target is still enabled. A target removed or
// disabled since the failure just leaves its deliveries parked, untouched.
export async function retryFailedDeliveries(): Promise<{ retried: number }> {
  const list = loadDeliveries();
  let retried = 0;
  for (const d of list) {
    if (d.status !== "failed") continue;
    const target = getTarget(d.targetId);
    if (!target || !target.enabled) continue;
    await attemptDelivery(target, d);
    retried += 1;
  }
  if (retried > 0) saveDeliveries(list);
  return { retried };
}

// Manual replay — works on a "failed" OR "dead_letter" delivery, resetting
// its attempt count so a dead-lettered delivery gets a fresh MAX_ATTEMPTS
// budget rather than instantly re-dead-lettering on attempt 1.
export async function replayDelivery(id: string): Promise<WebhookDelivery | null> {
  const list = loadDeliveries();
  const delivery = list.find(d => d.id === id);
  if (!delivery) return null;
  const target = getTarget(delivery.targetId);
  if (!target) throw new Error("target no longer exists");
  delivery.attempts = 0;
  delivery.status = "pending";
  await attemptDelivery(target, delivery);
  saveDeliveries(list);
  return delivery;
}

// Test-only — clears the "unreadable" latch so a fresh test fixture isn't
// blocked by a previous test's simulated corruption.
export function _resetForTests(): void {
  targetsUnreadable = null;
  deliveriesUnreadable = null;
}
