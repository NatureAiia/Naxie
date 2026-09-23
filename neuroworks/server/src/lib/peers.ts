import { config } from "../config.js";
import { listJobs } from "./jobs.js";
import { listActivePeers, noteHealthResult } from "./peer-registry.js";

export type PeerInfo = {
  url: string;
  name?: string;
  role?: string;
  model?: string;
  ok: boolean;
  ready?: boolean;
  inflightJobs?: number;
  error?: string;
  rttMs?: number;
};

// One round-trip to /api/health on every reachable peer. Bounded at 2s each
// so a dead peer never freezes the dashboard. The peer list is pulled from
// the runtime registry (env-seeded + auto-discovered + manually registered),
// not directly from config.peers — so adds/drops apply without restart.
// Each result feeds the registry's consecutive-fails counter for auto-drop.
export async function pollPeers(): Promise<PeerInfo[]> {
  const peers = listActivePeers();
  if (peers.length === 0) return [];
  return Promise.all(peers.map(async (url) => {
    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    try {
      const res = await fetch(`${url.replace(/\/+$/, "")}/api/health`, { signal: ctrl.signal });
      const rttMs = Date.now() - t0;
      if (!res.ok) { noteHealthResult(url, false); return { url, ok: false, error: `HTTP ${res.status}`, rttMs }; }
      const body = await res.json() as { name?: string; role?: string; model?: string; ready?: boolean; inflightJobs?: number };
      noteHealthResult(url, true);
      return { url, name: body.name, role: body.role, model: body.model, ok: true, ready: body.ready, inflightJobs: body.inflightJobs, rttMs };
    } catch (e: any) {
      noteHealthResult(url, false);
      return { url, ok: false, error: String(e?.message ?? e), rttMs: Date.now() - t0 };
    } finally {
      clearTimeout(timer);
    }
  }));
}

// Used by the busy-check that decides whether to delegate. "Busy" means at
// least one general-task / custom-* job is still running locally.
export function localInflightCount(): number {
  return listJobs().filter(j => j.status === "running" || j.status === "pending").length;
}

// Pick the peer with the lowest inflight count. Returns null if no peer is
// reachable+ready, or every peer is at least as busy as we are.
export async function pickLightestIdlePeer(localInflight = localInflightCount()): Promise<PeerInfo | null> {
  const all = await pollPeers();
  const candidates = all.filter(p => p.ok && p.ready);
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => (a.inflightJobs ?? 0) - (b.inflightJobs ?? 0));
  const best = candidates[0];
  if ((best.inflightJobs ?? 0) >= localInflight) return null;
  return best;
}

// Pick the LIGHTEST reachable peer matching a given role — not just the first
// one. Critical when multiple peers share a role (e.g. two persona-shifters):
// the legacy "first match" picker meant only one peer ever got work and the
// rest sat idle. Sorting by inflightJobs distributes across the role pool so
// every available worker actually executes tasks.
export async function pickPeerByRole(role: string): Promise<PeerInfo | null> {
  const all = await pollPeers();
  const matches = all.filter(p => p.ok && p.ready && (p.role ?? "").toLowerCase() === role.toLowerCase());
  if (matches.length === 0) return null;
  matches.sort((a, b) => (a.inflightJobs ?? 0) - (b.inflightJobs ?? 0));
  return matches[0];
}

// Decide where a new task should run — peer OR local — based on real-time
// load on every available executor including this clawbot. Returns the
// picked peer (delegate) or null (run locally because local is at least as
// idle as the lightest peer). The `preferRole` arg lets the caller bias
// toward a specific role (e.g. "persona-shifter") while still falling back
// to ANY idle peer if the preferred role pool is fully saturated.
//
// Tie-breaker: when peer.inflight === localInflight, we prefer LOCAL. Less
// network hop, lower latency, and the primary already has the customer's
// context loaded. Only a strictly lighter peer wins.
//
// Returns a structured snapshot so the caller can log the decision verbatim:
//   { decision: "peer" | "local", peer?, localInflight, peerInflight?, reason }
export type RoutingDecision = {
  decision: "peer" | "local";
  peer?: PeerInfo;
  localInflight: number;
  peerInflight?: number;
  candidates: { url: string; role?: string; inflight: number; ok: boolean; ready: boolean }[];
  reason: string;
};

export async function pickExecutor(opts: { preferRole?: string; localInflight?: number } = {}): Promise<RoutingDecision> {
  const localInflight = opts.localInflight ?? localInflightCount();
  const all = await pollPeers();
  const live = all.filter(p => p.ok && p.ready);
  const candidates = all.map(p => ({
    url: p.url, role: p.role, inflight: p.inflightJobs ?? 0,
    ok: p.ok, ready: p.ready ?? false,
  }));
  if (live.length === 0) {
    return { decision: "local", localInflight, candidates, reason: "Handling this myself — no peer workers are reachable." };
  }
  // First pass: prefer the requested role pool. Pick lightest within it.
  let pool = opts.preferRole
    ? live.filter(p => (p.role ?? "").toLowerCase() === opts.preferRole!.toLowerCase())
    : live;
  // If the preferred role pool is empty OR fully saturated (every member at
  // or above local inflight), fall back to ANY live peer so work still moves.
  if (pool.length === 0) pool = live;
  pool = [...pool].sort((a, b) => (a.inflightJobs ?? 0) - (b.inflightJobs ?? 0));
  const lightestPeer = pool[0];
  const peerInflight = lightestPeer.inflightJobs ?? 0;
  if (peerInflight < localInflight) {
    return {
      decision: "peer",
      peer: lightestPeer,
      localInflight,
      peerInflight,
      candidates,
      reason: `Sending this to ${lightestPeer.name ?? lightestPeer.url} — they're freer right now (${peerInflight} job${peerInflight === 1 ? "" : "s"} in progress vs ${localInflight} here).`,
    };
  }
  // Peer is equal or busier than local. Run locally — no network hop, lower
  // latency, primary already has the customer's context loaded.
  return {
    decision: "local",
    localInflight,
    peerInflight,
    candidates,
    reason: `Handling this myself — I'm at least as free as my peers (${localInflight} vs ${peerInflight} jobs in progress).`,
  };
}

// Per-poll snapshot forwarded to the caller while the peer is still working.
// Lets the primary mirror the worker's intermediate state (plan, in-flight
// step runs, log lines) into its own job so the UI shows live progress
// instead of a frozen "running" badge for minutes at a time.
export type PeerProgress = {
  status: string;
  newLogLines: string[];
  plan?: any;
  runs?: any[];
  phase?: string;
  partialAnswer?: string;
};

// Send a task to a SPECIFIC peer (the caller already picked it, e.g. by role).
// Returns the peer's final answer and surfaces which peer answered + total
// elapsed time so the caller can show provenance in the UI. Used by the chat
// router after it picks a persona-shifter peer — we don't want to re-pick
// because the lightest-load criterion may have shifted by the time we delegate.
//
// The optional onProgress callback fires on each poll once we've seen new
// state from the worker. The caller (chat router) uses it to forward the
// worker's log lines and result-shape into the primary's own job — that's
// what makes the UI's progress bar tick during delegation.
// `personaSnapshot` is the full persona object — sent so the worker can adopt
// a CUSTOM employee the customer created on the primary without needing it
// pre-installed in the worker's own personas.json. The worker registers it
// ephemerally for the run and drops it after. `persona` is the legacy id-only
// fallback used by code that doesn't have the full object handy.

// 3s reachability check shared by both delegation paths — throws with a
// distinct message the callers surface, so an unreachable worker costs 3
// seconds instead of the full delegate timeout.
async function preflightPing(base: string, name?: string): Promise<void> {
  try {
    const ping = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(3000) });
    if (!ping.ok) throw new Error(`health returned HTTP ${ping.status}`);
  } catch (e: any) {
    throw new Error(`peer ${name ?? base} failed the pre-flight ping (${String(e?.message ?? e).slice(0, 80)}) — not delegating; run locally instead`);
  }
}

export async function delegateToPeer(peer: PeerInfo, args: {
  task: string;
  persona?: string;
  personaSnapshot?: any;
  // Initiating human's email — forwarded so the WORKER's job record carries
  // the same owner as the primary's. Without it, delegated jobs land in the
  // shared journal unattributed and the per-user task/calendar slice can't
  // show them to their owner (nor hide them from everyone else).
  createdByEmail?: string;
  // Operator cancel signal — when it aborts, the poll loop stops waiting and
  // best-effort asks the worker to cancel its own job.
  signal?: AbortSignal;
  onProgress?: (snap: PeerProgress) => void;
}): Promise<any> {
  const base = peer.url.replace(/\/+$/, "");
  const t0 = Date.now();
  // Pre-flight ping: 3s health check before committing to a delegation. A
  // down/hung worker used to eat the full delegate timeout (up to 12 min)
  // before surfacing as a failure — the 07-03 reflection put peer.review at a
  // 22% failure rate largely from exactly that. Fail fast with a clear reason
  // so the caller keeps the work local instead.
  await preflightPing(base, peer.name);
  const startRes = await fetch(`${base}/api/peers/delegate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      task: args.task,
      persona: args.persona,
      personaSnapshot: args.personaSnapshot,
      createdByEmail: args.createdByEmail,
    }),
  });
  if (!startRes.ok) {
    let body = "";
    try { body = (await startRes.text()).slice(0, 400); } catch { /* ignore */ }
    throw new Error(`peer delegate HTTP ${startRes.status}${body ? ` — ${body}` : ""}`);
  }
  const { jobId } = await startRes.json() as { jobId: string };

  // Peer delegation timeout. 5 min was too tight — qwen2.5:3b on the worker
  // routinely takes 4 minutes JUST to plan a multi-perspective task, leaving
  // no time for the actual work. 12 min still timed out real delegated
  // general-task runs (2026-07-20 journal: a multi-source run hit the ceiling
  // at 12min), so the default is now 20 min — a fan-out plan can run several
  // slow sub-agents plus a synth serially on a small local model. Tunable via
  // env so customers on larger/faster models can shorten it.
  const DELEGATE_TIMEOUT_MS = Number(process.env.NEUROWORKS_PEER_DELEGATE_TIMEOUT_MS ?? (20 * 60_000));
  const deadline = Date.now() + DELEGATE_TIMEOUT_MS;
  let attempt = 0;
  // Track how many log lines we've already forwarded so each poll only emits
  // the *delta*. Without this we'd resend the whole worker log every 1-3s.
  let forwardedLogCount = 0;
  // A worker saturated by local inference drops the odd connection — one
  // thrown poll fetch must NOT fail a 12-min delegation whose job is still
  // running (observed: parent died "fetch failed" at 46s, worker succeeded at
  // 64s). Tolerate transient poll errors; only give up after ~1min of
  // CONSECUTIVE dead air, which means the worker is actually gone.
  let pollFails = 0;
  const MAX_CONSECUTIVE_POLL_FAILS = 20;
  while (Date.now() < deadline) {
    // Operator cancelled — stop waiting on the worker and best-effort ask it
    // to cancel its own job so the worker isn't left grinding on abandoned work.
    if (args.signal?.aborted) {
      try { await fetch(`${base}/api/tasks/jobs/${jobId}/cancel`, { method: "POST", signal: AbortSignal.timeout(4000) }); } catch { /* best-effort */ }
      return { peer: { url: peer.url, name: peer.name, model: peer.model }, jobId, status: "failed", answer: "Run cancelled.", error: "Cancelled by the operator", elapsedMs: Date.now() - t0, cancelled: true };
    }
    attempt++;
    await new Promise(r => setTimeout(r, attempt < 10 ? 1000 : 3000));
    let j: any;
    try {
      const r = await fetch(`${base}/api/templates/jobs/${jobId}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { pollFails = 0; continue; } // worker answered — job just isn't visible yet
      j = await r.json();
      pollFails = 0;
    } catch (e: any) {
      pollFails++;
      if (pollFails >= MAX_CONSECUTIVE_POLL_FAILS) {
        throw new Error(`peer ${peer.name ?? base} stopped answering polls (${pollFails} consecutive failures, last: ${String(e?.message ?? e).slice(0, 80)}) — jobId=${jobId}`);
      }
      continue;
    }

    // Forward intermediate progress to the caller every poll, even while the
    // worker is still running. The primary's job thus mirrors the worker's
    // plan / step runs / log lines as they appear.
    if (args.onProgress) {
      const allLog: string[] = Array.isArray(j.log) ? j.log : [];
      const newLines = allLog.slice(forwardedLogCount);
      forwardedLogCount = allLog.length;
      try {
        args.onProgress({
          status: j.status,
          newLogLines: newLines,
          plan: j.result?.plan,
          runs: j.result?.runs,
          phase: j.result?.phase,
          partialAnswer: j.result?.partialAnswer,
        });
      } catch { /* consumer error — don't kill the poll loop */ }
    }

    // awaiting-approval is TERMINAL for a delegate: a worker's plan hit the
    // sensitive-action checkpoint (db.query / connector.call / email.send) and
    // parked. The primary can't approve a worker's job, so we return here with
    // the plan + approvalRequired so the caller re-parks on the primary and
    // replays locally on approval. Without this the poll spun until the 20-min
    // timeout (or, against a worker whose runJob marks it succeeded-with-empty-
    // result, the primary reported a hollow "succeeded" and dropped the ask).
    if (j.status === "succeeded" || j.status === "failed" || j.status === "rejected" || j.status === "awaiting-approval") {
      return {
        peer: { url: peer.url, name: peer.name, model: peer.model },
        jobId,
        status: j.status,
        answer: j.result?.answer,
        plan: j.result?.plan,
        runs: j.result?.runs,
        // Surface the worker's sensitive-action checkpoint so the primary can
        // re-park + replay it locally on approval (worker jobs aren't approvable
        // from here).
        approvalRequired: j.result?.approvalRequired,
        // Forward sub-agent telemetry so the primary's Results page can
        // render the spin-up panel for delegated work too. Without this
        // the secondary's wave timings vanish and the user can't tell
        // delegated execution from local.
        budgets: j.result?.budgets,
        subagentTimings: j.result?.subagentTimings,
        review: j.result?.review,
        quality: j.result?.quality,
        security: j.result?.security,
        // Persona verification trail — the worker stamps personaIdUsed /
        // personaNameUsed on its return so the primary's chat handler can
        // confirm the snapshot was honored. Without forwarding these here,
        // the primary reads null and warns "ran as <none>" even when the
        // worker actually scoped the run correctly.
        personaIdUsed: j.result?.personaIdUsed ?? null,
        personaNameUsed: j.result?.personaNameUsed ?? null,
        error: j.error,
        elapsedMs: Date.now() - t0,
      };
    }
  }
  throw new Error(`peer delegation timed out after ${Math.round(DELEGATE_TIMEOUT_MS / 60_000)}min (peer=${peer.url}, jobId=${jobId})`);
}

// Send a task to the lightest-loaded peer and poll its job until completion.
// Returns the peer's final answer and surfaces which peer answered + total
// elapsed time so the caller can show provenance in the UI.
export async function delegateToBestPeer(args: { task: string; persona?: string }): Promise<any> {
  const peer = await pickLightestIdlePeer();
  if (!peer) throw new Error("no idle peer available");
  const base = peer.url.replace(/\/+$/, "");
  const t0 = Date.now();
  await preflightPing(base, (peer as any).name);
  const startRes = await fetch(`${base}/api/peers/delegate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ task: args.task, persona: args.persona }),
  });
  if (!startRes.ok) throw new Error(`peer delegate HTTP ${startRes.status}`);
  const { jobId } = await startRes.json() as { jobId: string };

  // Poll. Bound at 20 minutes to MATCH delegateToPeer — the two paths shared the
  // same env knob but this one still defaulted to 12 min, so general-task runs
  // delegated via this path timed out at 12 min while the specific-peer path had
  // 20 (4 such timeouts in the 30-day audit, 2026-07-28). A fan-out plan on a
  // slow local model (qwen2.5:3b) needs the extra headroom.
  const DELEGATE_TIMEOUT_MS = Number(process.env.NEUROWORKS_PEER_DELEGATE_TIMEOUT_MS ?? (20 * 60_000));
  const deadline = Date.now() + DELEGATE_TIMEOUT_MS;
  let attempt = 0;
  // Same transient-poll tolerance as delegateToPeer — one dropped connection
  // to a busy worker must not fail a delegation whose job is still running.
  let pollFails = 0;
  const MAX_CONSECUTIVE_POLL_FAILS = 20;
  while (Date.now() < deadline) {
    attempt++;
    await new Promise(r => setTimeout(r, attempt < 10 ? 1000 : 3000));
    let j: any;
    try {
      const r = await fetch(`${base}/api/templates/jobs/${jobId}`, { signal: AbortSignal.timeout(10_000) });
      if (!r.ok) { pollFails = 0; continue; }
      j = await r.json();
      pollFails = 0;
    } catch (e: any) {
      pollFails++;
      if (pollFails >= MAX_CONSECUTIVE_POLL_FAILS) {
        throw new Error(`peer ${peer.name ?? base} stopped answering polls (${pollFails} consecutive failures, last: ${String(e?.message ?? e).slice(0, 80)}) — jobId=${jobId}`);
      }
      continue;
    }
    // awaiting-approval is terminal here too (see delegateToPeer): a delegated
    // sub-task's plan hit the sensitive-action checkpoint and parked on the
    // worker. Return it instead of polling to the timeout, and forward
    // approvalRequired so the caller can surface it.
    if (j.status === "succeeded" || j.status === "failed" || j.status === "rejected" || j.status === "awaiting-approval") {
      return {
        peer: { url: peer.url, name: peer.name, model: peer.model },
        jobId,
        status: j.status,
        answer: j.result?.answer,
        plan: j.result?.plan,
        runs: j.result?.runs,
        approvalRequired: j.result?.approvalRequired,
        budgets: j.result?.budgets,
        subagentTimings: j.result?.subagentTimings,
        review: j.result?.review,
        quality: j.result?.quality,
        security: j.result?.security,
        error: j.error,
        elapsedMs: Date.now() - t0,
      };
    }
  }
  throw new Error(`peer delegation timed out after ${Math.round(DELEGATE_TIMEOUT_MS / 60_000)}min (peer=${peer.url}, jobId=${jobId})`);
}

// Send a task + draft answer to a peer for critique. Returns a structured
// verdict — the caller can decide whether to surface the revision or stick
// with the original. Falls back to self-review (calling our own /api/peers/review)
// when no peer is configured, so single-clawbot setups still get a critique.
// The reviewer field is tagged "self" in that case so the caller can present
// it honestly.
export async function reviewWithPeer(args: { task: string; answer: string }): Promise<any> {
  const peer = await pickLightestIdlePeer(0);
  const base = peer
    ? peer.url.replace(/\/+$/, "")
    : `http://127.0.0.1:${config.port}`;
  const t0 = Date.now();
  // CALLER-side wall cap. The review HANDLER has its own 300s cap, but the
  // caller had NO timeout — so a peer that hangs (or a slow local self-review
  // on a long answer) blocked the whole task unbounded. Measured live
  // 2026-07-26: one peer.review ran 1213s (20min) on a long innovation-scan
  // report, dominating a 39-min task. Abort at REVIEW_CAP_MS (default 240s,
  // NEUROWORKS_PEER_REVIEW_TIMEOUT_MS) and let the caller keep the draft it
  // already has rather than pay minutes for a second opinion that stalled.
  // Strict 90s wall cap (was 240s). Combined with the handler-side bounding
  // (skip the full-rewrite on long answers + maxTokens cap), a second opinion
  // that can't land in 90s isn't worth stalling the task for — keep the draft.
  // Tunable via NEUROWORKS_PEER_REVIEW_TIMEOUT_MS.
  const REVIEW_CAP_MS = Math.max(30_000, Number(process.env.NEUROWORKS_PEER_REVIEW_TIMEOUT_MS ?? "90000"));
  const ctrl = new AbortController();
  const capTimer = setTimeout(() => ctrl.abort(), REVIEW_CAP_MS);
  let r: Response;
  try {
    r = await fetch(`${base}/api/peers/review`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error(`peer.review wall-time cap (${Math.round(REVIEW_CAP_MS / 1000)}s) exceeded — kept the existing draft`);
    throw e;
  } finally {
    clearTimeout(capTimer);
  }
  if (!r.ok) throw new Error(`review HTTP ${r.status}`);
  const body = await r.json();
  const peerInfo = peer
    ? { url: peer.url, name: peer.name, model: peer.model }
    : { url: base, name: `${config.name} (self)`, model: config.ollamaModel };
  return { peer: peerInfo, elapsedMs: Date.now() - t0, ...body };
}

// Judge two candidate answers to the SAME task head-to-head and pick a
// winner — used by chat.ts's Hermes/clawbot cross-check (see executor-mode's
// `crosscheck` flag) instead of always discarding Hermes's answer on a
// quality-fail offload. Same local-first / peer-routed / capped-wall-time
// scaffold as reviewWithPeer(): pick the lightest idle peer (or self-review
// via our own /api/peers/crosscheck when none is configured), bounded so a
// hung judge never stalls the caller.
//
// FAIL-OPEN TOWARD "A": on any error, timeout, or unparseable verdict, this
// returns { winner: "a", ... }. The caller's convention is that "a" is
// Hermes's answer — mirroring scoreHermesAnswer's existing philosophy of
// keeping Hermes's own answer when the scorer/judge itself fails, rather
// than silently preferring clawbot's just because the judge broke.
export async function crosscheckAnswers(args: {
  task: string;
  answerA: string;
  answerB: string;
  labelA?: string;
  labelB?: string;
}): Promise<{ winner: "a" | "b" | "tie"; reason: string; confidence: number }> {
  const FAIL_OPEN = { winner: "a" as const, reason: "crosscheck unavailable", confidence: 0 };
  const peer = await pickLightestIdlePeer(0);
  const base = peer
    ? peer.url.replace(/\/+$/, "")
    : `http://127.0.0.1:${config.port}`;
  // Same caller-side wall cap philosophy as reviewWithPeer — a hung judge (peer
  // or self) must not stall the task that's waiting on a final answer.
  // Tunable via NEUROWORKS_PEER_CROSSCHECK_TIMEOUT_MS.
  const CROSSCHECK_CAP_MS = Math.max(30_000, Number(process.env.NEUROWORKS_PEER_CROSSCHECK_TIMEOUT_MS ?? "90000"));
  const ctrl = new AbortController();
  const capTimer = setTimeout(() => ctrl.abort(), CROSSCHECK_CAP_MS);
  try {
    const r = await fetch(`${base}/api/peers/crosscheck`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(args),
      signal: ctrl.signal,
    });
    if (!r.ok) return FAIL_OPEN;
    const body = await r.json();
    if (body?.winner !== "a" && body?.winner !== "b" && body?.winner !== "tie") return FAIL_OPEN;
    return {
      winner: body.winner,
      reason: typeof body.reason === "string" ? body.reason : "",
      confidence: typeof body.confidence === "number" ? Math.max(0, Math.min(1, body.confidence)) : 0,
    };
  } catch {
    // Covers both the abort (wall-time cap) and any transport failure.
    return FAIL_OPEN;
  } finally {
    clearTimeout(capTimer);
  }
}
