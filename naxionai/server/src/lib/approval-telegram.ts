// Telegram inbox approvals — pure builders for OrgTask approve/reject over
// Telegram inline keyboards. The bridge (telegram-bridge.ts) owns transport
// (allow-list, callbacks, loopback resolve); this module owns shapes so the
// contract is unit-tested without a bot or a server.
//
// Safety rules (mirror docs/naxie-architecture.md §5/§8.3):
// - Diff-carrying items (pendingApproval.diff, proposal.diff, or kind
//   architect-change) NEVER get an inline Approve button — code changes get
//   eyes on the Approvals page, never a tapped "yes".
// - callback_data stays under Telegram's 64-byte limit (uuid ids are 36ch).

export type ApprovalAction = "approve" | "reject" | "detail" | "list" | "jobapprove" | "jobreject" | "jobdetail";

export type WaitingTaskView = {
  id: string;
  title: string;
  actionDescription: string;
  kind: string;
  requestedAt: string;
  hasDiff: boolean;
};

export type WaitingJobView = {
  id: string;
  title: string;
  task: string;
  steps: number;
  parkedAt: string;
};

export function parseApprovalCallback(data: string): { action: ApprovalAction; id?: string } | null {
  const m = /^approval:(approve|reject|detail|list|jobapprove|jobreject|jobdetail)(?::([0-9a-fA-F-]{1,64}))?$/.exec(String(data ?? ""));
  if (!m) return null;
  const action = m[1] as ApprovalAction;
  if (action === "list") return { action };
  if (!m[2]) return null;
  return { action, id: m[2] };
}

export function approvalCallback(action: Exclude<ApprovalAction, "list">, id: string): string;
export function approvalCallback(action: "list"): string;
export function approvalCallback(action: ApprovalAction, id?: string): string {
  return action === "list" ? "approval:list" : `approval:${action}:${id}`;
}

export function isDiffCarrying(t: { pendingApproval?: { diff?: string; kind?: string; proposal?: { diff?: string } } }): boolean {
  const p = t.pendingApproval;
  if (!p) return false;
  return p.kind === "architect-change" || Boolean(p.diff) || Boolean(p.proposal?.diff);
}

export function toWaitingView(t: any): WaitingTaskView {
  return {
    id: String(t.id),
    title: String(t.title ?? "(untitled)"),
    actionDescription: String(t.pendingApproval?.actionDescription ?? t.detail ?? "").slice(0, 300),
    kind: String(t.pendingApproval?.kind ?? "other"),
    requestedAt: String(t.pendingApproval?.requestedAt ?? t.updatedAt ?? ""),
    hasDiff: isDiffCarrying(t),
  };
}

function shortTitle(title: string, max = 24): string {
  const s = title.trim();
  return s.length <= max ? s : s.slice(0, max - 1).trimEnd() + "…";
}

// Inline keyboard for the nudge / inbox list. At most `maxTasks` task rows;
// each row is [✅ title] [❌] — or [📋 review in app] for diff items, which
// must not be one-tap approved. A final row re-opens the inbox.
export function approvalKeyboard(tasks: WaitingTaskView[], maxTasks = 3): any[][] {
  const rows: any[][] = [];
  for (const t of tasks.slice(0, maxTasks)) {
    if (t.hasDiff) {
      rows.push([{ text: `📋 ${shortTitle(t.title)} — review in app`, callback_data: approvalCallback("detail", t.id) }]);
    } else {
      rows.push([
        { text: `✅ ${shortTitle(t.title)}`, callback_data: approvalCallback("approve", t.id) },
        { text: "❌", callback_data: approvalCallback("reject", t.id) },
      ]);
    }
  }
  if (tasks.length > maxTasks) {
    rows.push([{ text: `📥 ${tasks.length - maxTasks} more in inbox`, callback_data: approvalCallback("list") }]);
  }
  return rows;
}

// Buttons for a single detail card. Diff items get no Approve button.
export function detailKeyboard(t: WaitingTaskView): any[][] {
  if (t.hasDiff) return [[{ text: "📋 Review on Approvals page", callback_data: approvalCallback("list") }]];
  return [[
    { text: "✅ Approve", callback_data: approvalCallback("approve", t.id) },
    { text: "❌ Reject", callback_data: approvalCallback("reject", t.id) },
  ]];
}

// Buttons for a single job detail card. Jobs carry reviewed plans (not raw
// diffs), so approve/reject here matches the Approvals page one-tap shape.
export function jobDetailKeyboard(jobId: string): any[][] {
  return [[
    { text: "✅ Approve job", callback_data: approvalCallback("jobapprove", jobId) },
    { text: "❌ Reject job", callback_data: approvalCallback("jobreject", jobId) },
  ]];
}

// Stable signature of a waiting set — identical sets suppress repeat nudges.
export function waitingSignature(tasks: { id: string }[]): string {
  return tasks.map((t) => t.id).sort().join(",");
}
