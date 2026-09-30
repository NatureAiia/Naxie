// Multi-turn slot-filling dialogue state — ported by PATTERN (not code) from
// ZimVoice (AI-Institute-Africa/ZimVoice)'s workflow_engine.py +
// engine.py's `_pending_context` mechanism.
//
// ZimVoice's own implementation keeps exactly one active flow in a single
// instance field (`self._active_workflow_id` / `self._pending_context`) —
// fine for its one-process, one-conversation deployment, but wrong for a
// multi-session server. This port keeps the two ideas that matter and fixes
// that gap:
//   - a flow declares its slots once (name + a per-turn extractor) instead
//     of hand-rolling "which fields are still missing" bookkeeping per flow;
//   - a single utterance can fill more than one slot at once (each slot's
//     extractor runs independently against the same text, exactly like
//     ZimVoice's `_extract_entities`), not just the one slot being "awaited";
// and adds real per-session scoping: state lives in a Map keyed by an
// explicit session key, with a TTL so an abandoned flow doesn't leak forever.

export type SlotExtractor = (text: string, known: Record<string, string>) => string | undefined;

export type FlowDefinition = {
  id: string;
  /** Slot name -> extractor tried against the raw utterance every turn. */
  slots: Record<string, SlotExtractor>;
  /** Order slots are asked in when more than one is still missing. */
  order: string[];
  /** Human prompt for a given still-missing slot. */
  prompt: (slot: string, collected: Record<string, string>) => string;
};

export type FlowState = {
  flowId: string;
  collected: Record<string, string>;
  missing: string[];
  startedAt: number;
  updatedAt: number;
};

const flows = new Map<string, FlowDefinition>();
const sessions = new Map<string, FlowState>();

const SESSION_TTL_MS = 30 * 60_000; // abandoned flows self-clear after 30 min idle

export function registerFlow(def: FlowDefinition): void {
  flows.set(def.id, def);
}

export function _resetFlowsForTests(): void {
  flows.clear();
  sessions.clear();
}

function missingSlots(def: FlowDefinition, collected: Record<string, string>): string[] {
  return def.order.filter(s => !(s in collected));
}

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, st] of sessions) {
    if (now - st.updatedAt > SESSION_TTL_MS) sessions.delete(key);
  }
}

export type SlotFillResult =
  | { status: "no_flow" }
  | { status: "started" | "advanced"; flowId: string; collected: Record<string, string>; missing: string[]; prompt?: string }
  | { status: "complete"; flowId: string; collected: Record<string, string> };

/**
 * Advance (or start) the slot-filling flow for `sessionKey`.
 *
 * - If no flow is active for this session, `flowId` must be given to start one.
 * - Every call re-runs EVERY slot's extractor against `text` (not just the
 *   single "awaited" one) so one utterance can answer several slots at once,
 *   matching ZimVoice's workflow_engine behavior. Already-collected slots are
 *   never overwritten by a later, possibly-noisier match.
 */
export function advanceFlow(sessionKey: string, text: string, flowId?: string): SlotFillResult {
  pruneExpired();
  let state = sessions.get(sessionKey);
  let justStarted = false;

  if (!state) {
    if (!flowId) return { status: "no_flow" };
    const def = flows.get(flowId);
    if (!def) return { status: "no_flow" };
    state = { flowId, collected: {}, missing: [...def.order], startedAt: Date.now(), updatedAt: Date.now() };
    sessions.set(sessionKey, state);
    justStarted = true;
  }

  const def = flows.get(state.flowId);
  if (!def) {
    sessions.delete(sessionKey);
    return { status: "no_flow" };
  }

  for (const [slot, extract] of Object.entries(def.slots)) {
    if (slot in state.collected) continue;
    const value = extract(text, state.collected);
    if (value !== undefined && value !== "") state.collected[slot] = value;
  }
  state.missing = missingSlots(def, state.collected);
  state.updatedAt = Date.now();

  if (state.missing.length === 0) {
    sessions.delete(sessionKey);
    return { status: "complete", flowId: def.id, collected: state.collected };
  }

  const nextSlot = state.missing[0];
  return {
    status: justStarted ? "started" : "advanced",
    flowId: def.id,
    collected: { ...state.collected },
    missing: [...state.missing],
    prompt: def.prompt(nextSlot, state.collected),
  };
}

export function activeFlow(sessionKey: string): FlowState | undefined {
  pruneExpired();
  return sessions.get(sessionKey);
}

export function cancelFlow(sessionKey: string): boolean {
  return sessions.delete(sessionKey);
}
