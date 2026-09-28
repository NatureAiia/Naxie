// Management surface for the _workflows/ tree (see lib/workflow-tree.ts).
// Phase 0 shipped the engine with no UI at all; this is what lets the
// operator actually see, create, edit, run, and delete nodes instead of
// hand-editing task.md files in Obsidian.
//
// Writes are admin-gated (creating a scheduled task that fires with a given
// tool allowlist is the same trust level as Settings > System Access).
// Reads are open so the dashboard can render for any signed-in caller.

import { Router } from "express";
import { callerLayer } from "../lib/access.js";
import { respond } from "../lib/respond.js";
import {
  walkWorkflowTree, getNode, updateNode, createNode, deleteNode, runNode,
  getNodeStatus, isEngineArmed, type TaskNode,
} from "../lib/workflow-tree.js";
import { primitives } from "../lib/primitives.js";

export const workflowTreeRouter = Router();

function requireAdmin(req: any, res: any): boolean {
  const layer = callerLayer(req);
  if (layer !== null && layer !== "superadmin" && layer !== "admin") {
    respond.error(res, 403, "forbidden", "Managing the workflow tree requires admin access.");
    return false;
  }
  return true;
}

function withStatus(node: TaskNode) {
  return { ...node, status: getNodeStatus(node) };
}

workflowTreeRouter.get("/", (_req, res) => {
  const nodes = walkWorkflowTree().map(withStatus);
  respond.ok(res, { nodes, engineArmed: isEngineArmed(), flagEnabled: process.env.NEUROWORKS_WORKFLOW_TREE === "1" });
});

// The full primitive catalog (name/description/readonly), unfiltered by any
// allowlist — GET /api/primitives is scoped to the MCP-bridge allowlist and
// isn't the right shape for "which tools can this node use" picker.
workflowTreeRouter.get("/tool-catalog", (_req, res) => {
  respond.ok(res, { tools: primitives.map(p => ({ name: p.name, description: p.description, readonly: p.readonly })) });
});

workflowTreeRouter.get("/node", (req, res) => {
  const path = String(req.query.path ?? "");
  const node = getNode(path);
  if (!node) return respond.empty(res, "node not found");
  respond.ok(res, { node: withStatus(node) });
});

workflowTreeRouter.post("/", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { workflowId, taskId, enabled, cadence, tools, data, outputPath, deliver, body } = req.body ?? {};
  if (!workflowId || !taskId) return respond.error(res, 400, "invalid_input", "workflowId and taskId are required");
  const result = createNode(String(workflowId), String(taskId), { enabled, cadence, tools, data, outputPath, deliver, body });
  if (!result.ok) return respond.error(res, 400, "invalid_input", result.error);
  respond.ok(res, { node: withStatus(result.node) }, 201);
});

workflowTreeRouter.patch("/node", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const path = String(req.query.path ?? "");
  const { enabled, cadence, tools, data, outputPath, deliver, body, handler } = req.body ?? {};
  const node = updateNode(path, { enabled, cadence, tools, data, outputPath, deliver, body, handler });
  if (!node) return respond.empty(res, "node not found");
  respond.ok(res, { node: withStatus(node) });
});

workflowTreeRouter.delete("/node", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const path = String(req.query.path ?? "");
  if (!deleteNode(path)) return respond.empty(res, "node not found");
  respond.ok(res, {});
});

// Fire a node right now, bypassing its cadence — same effect as the tick
// loop firing it, so "run now" always exercises the exact real path.
workflowTreeRouter.post("/node/run", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const path = String(req.query.path ?? "");
  const node = getNode(path);
  if (!node) return respond.empty(res, "node not found");
  const result = await runNode(node);
  if (!result.ok) return respond.error(res, 502, "run_failed", result.error ?? "unknown error");
  respond.ok(res, { status: getNodeStatus(node) });
});
