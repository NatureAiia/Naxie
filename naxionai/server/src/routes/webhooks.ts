import { Router } from "express";
import { callerLayer } from "../lib/access.js";
import { respond } from "../lib/respond.js";
import {
  listTargets, getTarget, addTarget, removeTarget, setTargetEnabled, rotateTargetSecret,
  listDeliveries, getDelivery, replayDelivery, publishEvent,
  toPublicTarget, WEBHOOK_EVENT_CATALOG,
  type WebhookDeliveryStatus,
} from "../lib/webhook-delivery.js";
import { assertSafePublicUrlAsync } from "../lib/security-gates.js";

// Outbound webhook management — mounted at /api/webhooks. Same admin gate as
// workflow-tree.ts and org-tasks.ts: this is standing integration
// configuration and delivery history, not a secrets tier, but write actions
// (creating/removing a target that will receive Naxie's data) are
// admin-gated regardless.

export const webhooksRouter = Router();

function requireAdmin(req: any, res: any): boolean {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    respond.error(res, 403, "forbidden", "Managing webhooks requires admin access.");
    return false;
  }
  return true;
}

const VALID_STATUSES: WebhookDeliveryStatus[] = ["pending", "success", "failed", "dead_letter"];

webhooksRouter.get("/catalog", (_req, res) => {
  respond.ok(res, { events: WEBHOOK_EVENT_CATALOG });
});

webhooksRouter.get("/targets", (_req, res) => {
  respond.ok(res, { targets: listTargets().map(toPublicTarget) });
});

webhooksRouter.post("/targets", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { label, url, events } = req.body ?? {};
  if (typeof label !== "string" || !label.trim()) return respond.error(res, 400, "invalid_input", "label is required");
  if (label.trim().length > 100) return respond.error(res, 400, "invalid_input", "label must be 100 characters or fewer");
  if (typeof url !== "string" || !url.trim()) return respond.error(res, 400, "invalid_input", "url is required");
  if (url.trim().length > 2048) return respond.error(res, 400, "invalid_input", "url must be 2048 characters or fewer");
  if (events !== undefined && (!Array.isArray(events) || events.some((event: unknown) => typeof event !== "string"))) {
    return respond.error(res, 400, "invalid_input", "events must be an array of event names");
  }
  const selectedEvents: string[] = Array.from(new Set<string>(((events ?? []) as string[]).map(event => event.trim())));
  const knownEvents = new Set<string>(WEBHOOK_EVENT_CATALOG.map(event => event.name));
  if (selectedEvents.length > 8) return respond.error(res, 400, "invalid_input", "choose no more than 8 event types");
  const unknownEvents = selectedEvents.filter(event => !knownEvents.has(event));
  if (unknownEvents.length) return respond.error(res, 400, "invalid_input", `unknown event type(s): ${unknownEvents.join(", ")}`);
  if (selectedEvents.includes("webhook.test")) return respond.error(res, 400, "invalid_input", "webhook.test is reserved for connection checks");
  try {
    await assertSafePublicUrlAsync(url.trim());
    const target = addTarget({ label: label.trim(), url: url.trim(), events: selectedEvents });
    respond.ok(res, { target: toPublicTarget(target), secret: target.secret }, 201);
  } catch (e: any) {
    respond.error(res, 400, "invalid_input", e?.message ?? String(e));
  }
});

webhooksRouter.patch("/targets/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { enabled } = req.body ?? {};
  if (typeof enabled !== "boolean") return respond.error(res, 400, "invalid_input", "body.enabled (boolean) is required");
  const target = setTargetEnabled(req.params.id, enabled);
  if (!target) return respond.empty(res, "webhook target not found");
  respond.ok(res, { target: toPublicTarget(target) });
});

webhooksRouter.post("/targets/:id/rotate-secret", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const target = rotateTargetSecret(req.params.id);
  if (!target) return respond.empty(res, "webhook target not found");
  respond.ok(res, { target: toPublicTarget(target), secret: target.secret });
});

webhooksRouter.delete("/targets/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const ok = removeTarget(req.params.id);
  if (!ok) return respond.empty(res, "webhook target not found");
  respond.ok(res, {});
});

// Send a one-off test event to a single target (or every enabled target
// with no filter, mirroring publishEvent's own default) — lets an operator
// confirm a newly-added target actually receives + can verify the signature
// before wiring anything real to it.
webhooksRouter.post("/test", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const targetId = typeof req.body?.targetId === "string" ? req.body.targetId : undefined;
  if (targetId && !getTarget(targetId)) return respond.empty(res, "webhook target not found");
  const out = await publishEvent("webhook.test", {
    message: "This is a test event from Naxie's Webhooks page.",
    sentAt: new Date().toISOString(),
  }, { targetId, ignoreEventFilter: true });
  respond.ok(res, out);
});

webhooksRouter.get("/deliveries", (req, res) => {
  const targetId = typeof req.query.targetId === "string" ? req.query.targetId : undefined;
  const statusParam = typeof req.query.status === "string" ? req.query.status : undefined;
  const status = statusParam && (VALID_STATUSES as string[]).includes(statusParam) ? (statusParam as WebhookDeliveryStatus) : undefined;
  respond.ok(res, { deliveries: listDeliveries({ targetId, status }) });
});

webhooksRouter.get("/deliveries/:id", (req, res) => {
  const delivery = getDelivery(req.params.id);
  if (!delivery) return respond.empty(res, "delivery not found");
  respond.ok(res, { delivery });
});

webhooksRouter.post("/deliveries/:id/replay", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const delivery = await replayDelivery(req.params.id);
    if (!delivery) return respond.empty(res, "delivery not found");
    respond.ok(res, { delivery });
  } catch (e: any) {
    respond.error(res, 400, "replay_failed", e?.message ?? String(e));
  }
});
