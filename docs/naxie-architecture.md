# Naxie Architecture Proposal

Status: **draft — awaiting sign-off**, but Phase (a) and parts of Phase (b)/(c) have already landed (see §10's per-phase status) — this line is kept for the boundary flags in §9, which still stand for anything not yet started.

> **Revision note (v3).** This revision folds in answers from a 16-question architecture/design review, resolving decisions the prior draft had either left open or assumed. The headline changes: (1) Naxie is confirmed **single-user, always** — no multi-tenant design debt; (2) the 5 specialist roles are **fully invisible** in conversation — Naxie never names them, the org dashboard is an opt-in diagnostics view, not a feature; (3) `neuroworks/server` is confirmed to run as an **always-on Windows Service**, which changes the wake-word recommendation from "browser-first, offline-later" to **host-level listening directly**, since the tab-open ceiling that justified the interim step no longer applies; (4) host-tool gating moves from an environment-variable pattern (which doesn't map cleanly onto a single-user local install) to a **plain settings toggle**; (5) Naxie's operational data now has a real backup story — periodic git push to the vault repo, driven by the same daemon tick loop; (6) the Executor role is confirmed **broad/generalist** (business, personal, coding — anything project-shaped) rather than domain-scoped, with an explicit duration/complexity rule for routing between it, Admin, and Scheduler; (7) the Architect role (§7) gets read access to Naxie's own source, not just usage data, sharpening what its proposals can actually contain; (8) `naxionai/backend`'s retirement timing is explicitly **not** committed to a phase yet — "merge what's useful, delete the rest" is the intent, but when that happens is deferred.
>
> **Revision note (v4, UI/UX).** A follow-up 12-question round nails down what you'll actually see day to day (§8 rewritten): Naxie becomes reachable from **every page** via a persistent floating widget (not just her own route), the app's **default landing page becomes /naxie**, approvals mostly surface as a **direct inline ask from Naxie** (voice or text) except anything carrying an actual diff — which always forces the full Approvals page, since a spoken "yes" can't meaningfully approve a code change — and proactive nudges stay **silent (badge only) until you engage**, never an unprompted spoken interruption. The knowledge graph on Naxie's page shrinks to a tab rather than being removed. New capabilities (background service, wake-word, host tools) get a **one-time guided opt-in walkthrough** rather than being settings you have to go discover cold.

## 0. What Naxie is

Naxie is a personal assistant, for one person, always. There is no multi-user design question here — the rest of `neuroworks` (Users, roles, departments) keeps its existing multi-user machinery for the app's other surfaces, but Naxie's PA layer (task queues, approvals, daemon, audit) has exactly one owner and never needs an `ownerId`/session-scoping question anywhere in this design.

Everything in this document — the 5-role org, the daemon, the host tools — exists **in service of** that one assistant feeling capable, proactive, and trustworthy. The org is never a second product surface: **you only ever talk to Naxie.** She never says "I've handed that to Scheduler" — she says "I'll handle it" or "I'll get back to you." The five roles are as invisible to you as which microservice handled an HTTP request; the org dashboard (§8) exists so *you* can peek at what's happening internally if you choose to, not because Naxie ever references it in conversation.

Two things make "just an LLM chat window" fall short of being a real PA, and this doc is organized around fixing both:

1. **Reliability on multi-step work.** A PA that forgets a multi-step ask, can't tell you it's stuck, or silently fails isn't trustworthy. §3–§6 cover the org — five specialist roles that are Naxie's internal division of labor.
2. **Feeling present, not just reachable.** A PA you have to open an app and type into isn't "Jarvis" — it's a chatbot. §2 covers always-on infrastructure, wake-word activation, host-level tools, and a proactive daemon that checks in between conversations.

## 1. Ground truth — what exists today

### The fork this proposal resolves

Two backends both claim the "Naxie" identity, built independently, with overlapping-but-different feature sets:

| | `neuroworks/` (TypeScript: `neuroworks/server` + `neuroworks/web`) | `naxionai/backend` (Python/FastAPI) |
|---|---|---|
| What the live `/naxie` orb talks to today | **Yes** — `Naxie.tsx` → `/api/voice/converse` (direct LLM passthrough) | No — has no bundled frontend in this repo (`start_frontend.bat` references one that isn't checked in) |
| Task/job model | `Job` (`lib/jobs.ts`): status `pending/awaiting-approval/running/succeeded/failed/rejected/waiting_on_human`, `requiresApproval`, plan-approval flow, SSE streaming, ETA stats | `Goal` → `AgentTask`: richer status lifecycle (`briefing→planning→awaiting_approval→executing→monitoring→complete/paused/failed`), `depends_on` links, retries |
| Multi-role workflow | **`Handoff` relay** (`lib/handoff.ts`) — sequential chain of personas, each with `status: pending/running/done/failed`, a parsed `HANDOFF:`/`STATUS:` directive, persisted timeline. **`Teams`** (`lib/teams.ts`) — parallel fan-out + reusable team-brief templates | LangGraph fixed graph (manager→orchestrator→strategist→researcher→...) — nodes, not a persona-driven roster |
| Personas | Rich catalog (`lib/personas.ts`, 30+ built-ins with full system prompts), `workMode: agent/hybrid/human`, org chart (`lib/org-chart.ts`: manager/peer escalation graph parsed from vault markdown) | 36 built-ins (`persona_catalog.py`), but explicitly documented as **prompt framing only** — "naxionai's graph is a fixed topology... not a dynamic persona roster" |
| Governance | `lib/governance.ts` — policy prefix, extracted constraints, `gateAction`, `CONSEQUENTIAL_TOOLS` allowlist. Pre-execution step gate (`checkStepAgainstGovernance`) **is wired** at consequential-tool call sites, plus a post-synth content gate | `governance.py` — same design (line-for-line port), but its own docstring says the pre-tool-execution gate is **not yet wired** to individual call sites |
| Scheduling | `lib/schedules.ts` — 30s tick, cadence, fires a template run, optional email delivery, cross-process-safe (mtime-checked cache) | `scheduler.py` — near-identical design, fires a `Goal` instead |
| Autonomous loop | **None** — schedules fire templates, nothing else runs unprompted | `agency_daemon.py` — real 24/7 heartbeat: stalled-goal recovery, failed-post retry, proactive research (2h), idle/chat-inactivity nudges, scheduled briefs, all via `chat_push` |
| Audit | `lib/audit-log.ts` — JSONL (`_neuroworks/audit.jsonl`), `logAudit`/`queryAudit`, already called from every finished `Job` | `AgentLog` rows (DB), `target`/`result` columns added specifically for audit |
| Approval UI | `Approvals.tsx` (admin-gated route, wired to `Job.approve/reject`) | none |
| External API | `lib/dispatch.ts` — signed-webhook async dispatch, SSRF-guarded, idempotency, per-key rate limit | none |
| Voice | `lib/voice.ts` — three-tier (OpenAI Realtime / local TTS sidecar / browser speechSynthesis), per-persona voice hashing | faster-whisper + Vosk wake-word (`agent/wake_word.py`), Piper/pyttsx3 TTS |
| Host-level PA tools | None (see §2.2) | `agent/tools/pa_tools.py` — weather, reminders, system control, clipboard, git, browser (see §2.2) |
| Proactive/background behavior | `lib/schedules.ts` fires templates on a timer; no idle/inactivity awareness | `agent/agency_daemon.py` — idle-goal report, chat-inactivity nudge, proactive research cadence, brief scheduling (see §2.4) |

**Decision: target the TypeScript stack (`neuroworks/`).** Rationale:

1. It's what the orb already talks to — no rewiring the front door, no auth/session duplication.
2. It already has the org-shaped substrate mostly built: a sequential multi-persona relay with per-step status (`Handoff`), an approval-gated job model, a governance gate that's actually wired to tool call sites (ahead of naxionai's own admission it isn't), schedules, audit log, and a real Approvals page. Building the 5-role org here is substantially extension, not invention.
3. It already has a UI shell (`neuroworks/web`) with the design system, nav, and existing Approvals/Governance/Audit/Schedules/Personas pages the new views need to sit beside.
4. The gaps — a persistent autonomous loop, Jarvis-style presence (wake-word, host tools), and a genuinely always-on process — are absent here but are the entire subject of §2.

**Decision: port specific PA capabilities out of `naxionai/backend`; merge what's useful, delete the rest — timing not yet committed.** `naxionai/backend` also contains a fixed LangGraph social-media-agency pipeline (`Goal`, campaign planning, Buffer/Facebook publishing) that has nothing to do with a personal assistant. Three capabilities are worth porting by behavior into `neuroworks/lib`: wake-word activation, the PA host tools, and the daemon's cadence logic (§2). Everything else in `naxionai/backend` is presumed not useful to this product, but **when** the directory itself gets deleted is deliberately left open — revisit once the ports in §2 are built and it's clear whether anything else is worth salvaging. Don't schedule this as a numbered phase yet (see §9's note).

## 2. Making Naxie feel like Jarvis

This section is what turns Naxie from "a chat window that also runs an org" into something that feels present: the server is genuinely always running, she can hear you say her name, she can touch your machine (safely, behind a toggle you control), and she checks in on her own.

### 2.0 Always-on server (Windows Service)

**Decision: `neuroworks/server` runs as a real Windows Service**, not a start-when-you-open-it process. This is the foundation everything else in §2 depends on — a daemon that "checks in between conversations" and a wake-word listener that "hears you say Naxie" are both fictions if the server isn't actually running when you're not looking at the app.

- Register the server via a Windows service wrapper (e.g. `node-windows`, or NSSM as a lighter external option) — starts at boot before any login, survives reboots, and restarts automatically on crash.
- This is real, one-time setup work: an install script, and admin rights to register the service once. Not something that happens implicitly as a side effect of another phase — see §9's explicit phase for it.
- Once this exists, §2.1's wake-word and §2.4's daemon both get to assume "the process is there," which is what makes host-level (not browser-tab-scoped) listening and proactive nudging actually true rather than aspirational.

### 2.1 Wake-word activation ("Hey Naxie")

**What exists today (`naxionai/backend/agent/wake_word.py`):** an offline, grammar-constrained Vosk recognizer. `get_vosk_model()` lazy-loads a small Vosk model from `agent/media/vosk_model/` (not shipped in-repo, ~40MB, manually downloaded), degrading to `None` rather than raising if absent. `WakeWordSession` builds a closed grammar from `_build_grammar()` — the target phrase (default `"hey naxie"`) plus phonetic near-homophones from a hardcoded `_PHONETIC_VARIANTS` dict (`"naxie": ["nexi", "naxi", "nyx", "nixie", "natty", "nexus", "annex"]`, because the small model's fixed dictionary doesn't contain the invented brand name). Its one real API is `accept(pcm_bytes: bytes) -> bool` — feed one chunk of raw 16-bit mono PCM at a time, get back whether that chunk completed an exact match against the grammar set. There is no `close()`/`stop()` method.

**Decision: build for real host-level listening directly — skip the browser-only interim.** With §2.0's always-on service in place, the "browser tab must be open" ceiling that would have justified a two-step plan (ship browser Web Speech first, offline daemon later) no longer applies — the service is already running continuously, so it should be the thing listening, not a foreground tab. This needs a spike to confirm what's actually available for continuous mic capture + wake-word matching on the Node/Windows side (the research behind this doc only confirmed the Python `vosk` package `wake_word.py` uses, not a specific Node-side equivalent) — porting the *grammar-constrained-matching idea* (phonetic variants against a small vocabulary) is the target regardless of which underlying library ends up doing the recognition. The browser `useSpeechRecognition` push-to-talk flow in `Naxie.tsx` stays exactly as-is as the manual fallback (tap-to-talk when you don't want always-on listening, or when the host listener isn't available) — it isn't being replaced, just not being built out into an interim always-on version of its own.

**Voice data handling**: once a wake phrase triggers and a command is captured, the transcribed **text** joins the same conversation history Naxie already keeps (today: `sessionStorage` in `Naxie.tsx`) — useful for "what did I ask you five minutes ago." The **raw audio is never persisted** — captured, matched/transcribed, then discarded immediately. This applies whether the eventual host-level listener or the manual push-to-talk path is used.

### 2.2 PA host tools (system control, clipboard, weather, reminders, git, browser)

**What exists today (`naxionai/backend/agent/tools/pa_tools.py`):** six LangChain `@tool`-decorated functions, returned by `get_pa_tools()` in the order `get_weather, set_reminder, system_control, manage_clipboard, browser_open, git_command`:

- `get_weather(location="auto")` — Open-Meteo geocoding + forecast, 5s timeouts, hardcoded London fallback, never raises out.
- `set_reminder(title, message, delay_seconds=0)` — schedules an `asyncio` task that shells a PowerShell toast-notification script, passing `{title, message}` as JSON **over stdin**, explicitly not string-interpolated into the script (injection avoidance). Fields are XML-escaped inside the PS script before display.
- `system_control(action, target="")` — `open_app` / `take_screenshot` / `volume_mute`/`unmute` / `focus_window` / `brightness_get`/`set` / `battery_status`. `open_app` only ever resolves `target` through a fixed `_APP_ALLOWLIST` dict (calc, notepad, explorer, chrome, edge, firefox, word, excel, outlook, paint, terminal, cmd) — never passes arbitrary strings to the shell.
- `manage_clipboard(action="read", text="")` — `write` sends `text` over subprocess **stdin** to a `Set-Clipboard` PowerShell call (same no-interpolation pattern); `read` shells `Get-Clipboard`.
- `git_command(action)` — `status`/`pull` (fast-forward only, never auto-merge) against exactly one operator-configured repo path (`GIT_REPO_PATH`); the LLM never supplies a path itself.
- `browser_open(url_or_search)` — opens a URL as-is, or wraps bare text as a Google search URL; not gated (see below).

**The security posture to preserve exactly, not just the function shapes:**

- Reminder/clipboard writes pass user data over the subprocess's **stdin**, never interpolated into the PowerShell command string — this specific pattern prevents shell/PS injection and must carry over unchanged.
- `open_app` never accepts a free-form executable path — only lookups against a fixed allowlist.
- `git_command` never lets the model choose which repo — one operator-configured path, checked for a `.git` directory before use.
- One thing to actually **fix**, not carry over: the Python gate (`_system_control_allowed()`) fails **open** if it can't load settings. That's a bug to fix in the port, not a behavior to preserve.

**Decision: gate with a plain settings toggle, not an environment variable.** naxionai's `ALLOW_SYSTEM_CONTROL` env var is a dev/production distinction that doesn't map cleanly onto a single-user, always-on local install — there's no meaningful "staging" for your own PC. Instead: a **Settings > System Access** page with explicit switches (e.g. "Allow system control," "Allow clipboard read/write"), both **OFF by default**, matching the "safe subset first" risk posture. `get_weather` and `set_reminder` (desktop toast only — see §2.4 for the notification-channel wiring) are not gated at all, same as the Python original. **Correction from the initial draft of this section**: `git_command` — both `status` and `pull` — IS gated by the same toggle in the Python original (`_system_control_allowed()` is called at the top of `git_command`, same as `system_control`/`manage_clipboard`); an earlier pass of this doc claimed `git_command status` was ungated, which doesn't match the source and has been corrected here and in the actual port.

**Where this lands in `neuroworks`:** none of clipboard, desktop notifications, or generic system-control exec exist anywhere in `neuroworks/server` today. The closest existing convention is the connector-registration pattern in `lib/connectors.ts` (a plausible home for a ported `get_weather` if it stays HTTP-shaped), but true host-level tools need real OS access an HTTP connector can't provide — these become a new `lib/host-tools.ts` module, following the allowlist + stdin-not-interpolation + settings-toggle posture above. `set_reminder` is genuinely net-new — `neuroworks` today only has `reminderAt` as a passive data field, no scheduled-notification mechanism.

### 2.3 Notifications

Three channels, escalating by severity — the same tiering pattern `jobs.ts` (email on `waiting_on_human`) and `agency_daemon.py` (briefs as email-worthy) already gesture at independently, now made an explicit, deliberate policy:

| Severity | Channel | Examples |
|---|---|---|
| Routine | In-app only (chat feed / approval inbox) | Task moved to done, backlog updated, a role finished its slice of a project |
| Needs your attention soon | Desktop OS toast | A new item landed in `waiting-on-approval`; an Executor project needs a check-in decision |
| Time-sensitive / digest | Email | An approval has sat unanswered past a threshold; a scheduled daily/weekly brief fires |

Desktop toasts reuse the exact PowerShell-toast pattern from `set_reminder` (§2.2) generalized into a small `notify(title, message)` helper in `lib/host-tools.ts`, gated the same way as the rest of that module. Email reuses `lib/email.ts`, already wired for this shape of message. This tiering is a starting policy, not fixed forever — expect to tune actual thresholds (e.g. "unanswered for how long before it escalates to email") once real usage shows what's actually annoying vs. actually useful.

### 2.4 Proactive daemon (idle nudges, chat check-ins, proactive research cadence, vault backup)

**What exists today (`naxionai/backend/agent/agency_daemon.py`):** a 24/7 loop (`agency_daemon()`) that runs `_run_cycle()` every `DAEMON_CYCLE_SECONDS` (300s). Per cycle, four independent cadence checks: idle-activity report (`IDLE_THRESHOLD_HRS`, 24h), chat-inactivity check-in (`CHAT_IDLE_THRESHOLD_HRS`, 2h, throttled via `last_idle_chat_nudge`), proactive research (`PROACTIVE_RESEARCH_HRS`, 2h), and scheduled briefs (per-user configurable time slots) — the brief-composition step notably calls `get_weather` directly, a real cross-reference between the daemon and the host-tools layer worth preserving. (One thing flagged as worth *fixing*, not porting as-is: the idle-report throttle re-checks against `daemon_last_ran`, which only updates on a full cycle success — not fully robust.)

**What exists today in `neuroworks` to build this on:** the `setInterval` + `.unref()` background-loop convention, already proven twice — a bare hourly sweep in `lib/jobs.ts`, and the richer pattern in `lib/schedules.ts`: a private `tick()` that scans due work and fires it fire-and-forget, an idempotent `start*()` guard, `setInterval(tick, N).unref()`, plus an immediate `setTimeout(tick, 2_000)` so anything due during downtime fires within seconds of boot.

**The port**: `lib/org-daemon.ts` absorbs all of this as one loop with several tick-phases, not several competing timers:

- The four PA cadence behaviors from `agency_daemon.py` (idle nudge, chat check-in, proactive research, scheduled briefs), re-derived against `neuroworks` conventions (JSON-file state, not SQLAlchemy).
- The org-orchestration housekeeping from §6 (advancing `OrgTask`s, nudging stale approvals).
- **Vault-repo backup** (new, from this revision): on a schedule (e.g. hourly, or batched on a threshold of changes), commit an org-tasks/audit-log snapshot to a local clone of the vault repo and `git push` to `marknature/NaxionAI_Vault-Repo`. Needs one-time setup — a git remote and credentials (SSH key or PAT) configured on this machine, since this is an unattended background job touching a remote repo. Flagged in §8 as needing your explicit go-ahead on the credential mechanism before it's wired to run unattended.
- The three-tier notification dispatch from §2.3.

This is a port of *cadence and intent*, not of `asyncio`/SQLAlchemy plumbing — the named constants (300s cycle, 2h research, 24h idle, etc.) carry over for continuity; the storage and push mechanism are native `neuroworks` design.

## 3. Roles → code mapping

Naxie stays the single conversational front door — the *only* thing you talk to. The five specialist roles below are **personas** in the existing `lib/personas.ts` catalog — not new processes, not new LLM instances, and never a surface you address directly. They exist purely so multi-step work is tracked, routed, and executed reliably instead of getting lost in one undifferentiated task list. Each role gets:

- A `Persona` entry (system prompt, tone, responsibilities) — same shape as the existing 30+.
- A fixed `roleKey` (`scheduler | researcher | executor | admin | architect`) distinct from `persona.id`.
- Its own task queue (§4).

**Role scope, per role:**

- **Scheduler** — purely time-based: reminders, calendar, time-triggered nudges. Narrowest, most concrete, fastest to trust.
- **Admin** — recurring, bounded, same-shape-every-time tasks that finish quickly: email triage (via `email-inbound.ts`/`email-threads.ts`), tracking commitments, small admin asks.
- **Researcher** — lookups, summarization, prepared briefings. Builds on the existing Researcher persona's `research.deep`/`research.multiperspective` tool preferences.
- **Executor** — deliberately **broad/generalist**, not domain-scoped: any genuine multi-step *project* that needs its own plan and check-ins over time, regardless of whether it's a research/writing project, personal life admin (planning a trip, comparing purchase options), or a coding task in this repo (or another `GIT_REPO_PATH`-style configured repo). The line isn't "what kind of work" — it's "does this need a standing plan Naxie works over multiple sessions."
- **Architect** — self-improvement; see §7.

**Role-routing rule (Executor vs. Admin vs. Scheduler)**: **duration/complexity**, not domain.

- Purely time-triggered → **Scheduler** ("remind me to call mom tomorrow").
- Recurring, bounded, finishes quickly, same shape every time → **Admin** ("triage my inbox each morning").
- A genuine multi-step project needing its own plan and check-ins, whatever the domain → **Executor** ("plan and book my trip to Lisbon," "fix the bug in `Naxie.tsx`").

**Routing mechanism**: Naxie's chat handler (today: direct passthrough via `/api/voice/converse`, no planning) gains a lightweight triage step — a new classification pass built for `neuroworks` on its own terms — that decides: (a) answer directly (unchanged for small talk/quick Q&A), or (b) file a task against one of the 5 role queues, silently. The user-visible behavior is always "Naxie will handle it" — the role, the routing decision, and any internal hand-off are never narrated in chat (see §0, §8).

**Execution model**: each role's queued task runs through the existing `Handoff`-style single-agent execution (`planAndExecute`) scoped to that persona's system prompt and a role-specific tool allowlist (§5) — not the parallel `Teams` fan-out. Multi-step Executor projects reuse `Job`'s existing plan-approval + `waiting_on_human` machinery.

Justification against rewrite risk: no new agent runtime, no new LLM call path — `planAndExecute` and the `Job` lifecycle are reused as-is. The new surface is the queue/routing layer around them.

## 4. Task/project data model

New store: `lib/org-tasks.ts`, persisted the same way as `handoffs.json`/`schedules.json` (JSON file in `.neuroworks/`, in-memory cache, mtime-checked cross-process reads) — no new DB dependency, and no `ownerId` field anywhere (single-user, per §0).

```ts
type OrgTaskStatus = "backlog" | "active" | "blocked" | "waiting-on-approval" | "done";

type OrgTask = {
  id: string;
  role: "scheduler" | "researcher" | "executor" | "admin" | "architect";
  title: string;
  detail: string;
  status: OrgTaskStatus;
  priority: "low" | "normal" | "high" | "urgent";
  linkedTaskIds: string[];        // multi-step project grouping — no separate "project" entity needed
  jobId?: string;                 // the underlying Job driving execution, once active
  createdAt: string;
  updatedAt: string;
  createdBy: "naxie" | "user" | "daemon";
  // Present only when status === "waiting-on-approval"
  pendingApproval?: {
    actionDescription: string;    // plain-language: "Send email to X saying Y" — never names the internal role
    kind: "external-comms" | "spend" | "calendar-external" | "host-tool" | "architect-change" | "other";
    requestedAt: string;
  };
};
```

Audit trail is **not** duplicated onto `OrgTask` — every status transition calls the existing `logAudit()` (`lib/audit-log.ts`) with `actor: role`, `action: "org_task.<transition>"`, `jobId`. The audit log stays the single source of "what happened and when"; `OrgTask` stays the current-state view. `actor` still carries the internal role name for the audit log/dashboard (§8) — invisibility is a conversational rule for Naxie's own voice, not a data-modeling constraint; you can still inspect which role did what if you choose to open the diagnostics views.

`linkedTaskIds` (plain array, both directions maintained on write) is deliberately simpler than a graph library — a flat list covers "these tasks are one project" without new query complexity.

## 5. Governance / permission tiers

Extends `lib/governance.ts` — no new gating engine.

- **Per-role default autonomy** — a small static table (`ROLE_AUTONOMY` in `lib/org-tasks.ts`): read-only research, drafting, own-backlog status changes are autonomous for every role; anything hitting `CONSEQUENTIAL_TOOLS` already routes through `checkStepAgainstGovernance` — this proposal adds one more always-on rule ahead of the existing constraint check: any step proposed by the `architect` role is force-routed to `pending-approval` unconditionally, with no override, regardless of `NEUROWORKS_GOVERNANCE_MODE=monitor` (that env var is an operator escape hatch for policy false-positives — it must not be able to silently let Architect self-modify).
- **Calendar changes affecting other people** and **spend** aren't in `CONSEQUENTIAL_TOOLS` today (it's scoped to comms/data/code side effects) — add `calendar.write_external_attendee` and a `finance.*` category as new entries.
- **Host tools (§2.2)** slot into this same gate structure: gated by the Settings > System Access toggle (not an env var — see §2.2), and `open_app`'s fixed allowlist is the same "no free-form target reaches the shell" pattern `CONSEQUENTIAL_TOOLS` already enforces elsewhere.
- Every gated action that pauses becomes an `OrgTask` in `waiting-on-approval` with `pendingApproval.actionDescription` in plain language, never naming the internal role — this is the surface for the approval inbox (§8). One-tap approve/reject reuses `Job.approve`/`Job.reject`, then flips the `OrgTask` status and logs the audit event.

## 6. Orchestration loop

New: `lib/org-daemon.ts`, started alongside `startScheduleScheduler()` in the server's boot sequence — the same module that absorbs the §2.4 PA cadence behaviors, since this is one daemon with more tick-phases, not two competing loops. For the org-orchestration side specifically:

- 5-minute tick (matching `agency_daemon`'s `DAEMON_CYCLE_SECONDS`).
- Each tick: pick up due `Schedule`-fired work (already exists), advance any `active` `OrgTask` whose underlying `Job` finished, and nudge stale `waiting-on-approval` tasks (reusing `sweepStaleApprovals`'s pattern from `jobs.ts`, generalized to also fire a notification per §2.3 rather than just failing the job after `APPROVAL_TTL_MS`).
- Executor-specific: for a multi-step `active` task with no `Job` update in >15 minutes, push a status check-in (same shape as `agency_daemon`'s `_push_execution_status`).
- Idle/proactive surfacing: if no `OrgTask` activity in N hours, Naxie proactively summarizes what's outstanding — same idea as `_push_idle_report`.

This — combined with the §2.4 PA cadence behaviors and the vault-backup tick — is the component with no direct TS analog today, so it's the correct place to expect the most implementation risk in Phase (b/b2).

## 7. Architect role

The self-improvement role, and deliberately the last one built and the highest-risk piece of this whole plan.

**What it observes**: usage/audit data (the audit log, `OrgTask` history, approval accept/reject patterns — e.g. "you've rejected Scheduler's reminder-time guesses 8 times this month") **and** read access to Naxie's own `neuroworks` source (`lib/org-tasks.ts`, persona definitions, the daemon, etc.). Read access to source is a deliberately bigger surface than usage data alone — it's what lets Architect's proposals be real code diffs instead of only config/prompt suggestions — but it is still **read-only**: Architect can look at anything relevant to how Naxie works, but cannot write, apply, or execute any change on its own.

**What it can propose**: a diff (config, persona prompt, or actual source code) plus a plain-language rationale, landing in the same approval inbox as every other pending action (§8.5) — but never as an inline chat yes/no (§8.3): a diff is exactly the case that forces the full Approvals page, since there's no way to meaningfully review a code change through a spoken "yes." There is no code path from an Architect proposal to a merged/applied change without going through that same review-and-approve step — no exception, no "trusted" threshold it can cross on its own, ever (§5).

## 8. UI/UX — what you'll actually see

All new views live in `neuroworks/web`, using the existing design tokens/HUD language (`assets/naxie-reference/`) — extending `Naxie.tsx`'s aesthetic rather than introducing a second design system.

### 8.1 Naxie is reachable from anywhere

A persistent floating widget lives on **every page** of the app, not just `/naxie` — a small orb, using the exact same state-color language `Naxie.tsx` already has (violet idle / orange listening / green thinking / fuchsia speaking), no numeric badge count. Clicking it opens a **lightweight inline popup** right where you are — a compact chat panel, not a navigation away from whatever you were doing (Tasks, Governance, wherever). If a conversation clearly wants the fuller experience (the knowledge-graph tab, longer scrollback), a button in the popup jumps to the dedicated `/naxie` page with the thread continued there.

The app's **default landing route changes from `/chat` to `/naxie`** (`App.tsx`'s `<Route path="/" element={<Navigate to="/chat" />} />` becomes `/naxie`) — since Naxie is now explicitly the product, opening the app opens her.

### 8.2 The `/naxie` page itself

The knowledge graph ("brain") doesn't disappear, but it stops being the default half-the-screen split — it moves into its own tab/panel you open when you want it, and the chat panel becomes the visual center of the page by default. This is a real layout change to the existing `Naxie.tsx` (currently `KnowledgeGraph` fills the left, the orb panel is a fixed 380px right column) — worth a small design pass when this phase is built, not just a CSS tweak, since it changes which element the eye lands on first.

### 8.3 Approvals surface mostly inline, with one deliberate exception

The general pattern: approval requests appear **as a message from Naxie in the normal chat flow** — "I'd like to send that reply to Sam, should I go ahead?" — answerable by voice ("yes"/"no") or a tap, right there, in either the popup or the full page. The Approvals page (§8.5) still exists as the complete backlog/history view, but routine yes/no moments don't force you there.

**The exception**: anything carrying an actual **diff** — Architect proposals (§7) foremost, but the same rule applies to any other approval whose content is a code/config change rather than a plain action description — always routes to the full Approvals page. A spoken "yes" can't meaningfully approve a change you haven't read. Naxie still tells you inline that something's waiting ("I've got a proposed change to how I schedule reminders — it needs a real look, check the Approvals page"), she just doesn't offer an inline yes/no for it.

### 8.4 Proactive nudges are silent until you engage

When the daemon (§2.4) has something to tell you and you're not actively in a conversation, the floating widget shows the "something's waiting" state (via the same orb color language, not a separate badge) — but Naxie does **not** speak or interrupt unprompted, at any severity tier. She surfaces what she has to say only once you open the widget or the page. This holds even for the more time-sensitive tiers in §2.3 — those escalate through desktop toast/email as designed, not through an unsolicited voice interruption.

### 8.5 New pages, and where they live

- **Settings > System Access** (§2.2 host-tool toggles, both OFF by default) — exact nav placement (its own top-level entry vs. folded into the existing Admin page) is left open until this is actually built, to fit however `Layout.tsx`'s nav groups look at that point rather than pre-deciding.
- **Org dashboard** (§4's per-role activity-feed/kanban) is a genuine diagnostics view, not a feature — it's tucked under an "Advanced"/diagnostics nav area rather than sitting alongside Tasks/Calendar at the same visual weight. Naxie never sends you there in conversation; it's there for when you go looking on your own.
- **Approval inbox**: extend the existing `Approvals.tsx` (today scoped to `Job.requiresApproval`) to also list `OrgTask`s in `waiting-on-approval` and host-tool actions gated per §5, each showing `pendingApproval.actionDescription` in plain language (no role names), one-tap approve/reject, with diff-carrying items (§8.3) rendering the actual diff for review rather than just a description string.
- **Audit/activity log**: extend `AuditLog.tsx` (already searchable via `actor`/`action`/`since`) with a `role` facet for when you want to dig in.

### 8.6 First-run setup for the riskier new capabilities

Rather than shipping the background service, wake-word listening, and host tools as settings you have to go discover cold, they get a **one-time guided walkthrough** the first time they're relevant — explaining what each capability needs (mic access, an elevated one-time service install, real OS-level access) and asking for explicit per-capability opt-in, rather than defaulting anything on silently. This walkthrough is scoped to the genuinely higher-stakes items; smaller settings (weather location, TTS voice choice) stay plain discoverable settings with no ceremony around them.

## 9. Boundary flags (things I will ask before crossing)

- Any change to `neuroworks/vault/` behavior beyond org-tasks/audit staying in `.neuroworks/` — none currently planned.
- `naxionai/backend`'s deletion timing is explicitly deferred (§1) — I will not delete it as a side effect of any phase below without asking first, even once its useful pieces are ported.
- Extending `CONSEQUENTIAL_TOOLS` with `calendar.write_external_attendee`/`finance.*` (§5) touches the governance list shared by every persona/team/handoff flow, not just Naxie's org.
- The wake-word Node/Windows implementation path (§2.1) needs a spike before it's a confirmed plan, not just a confirmed intent.
- Host tools (§2.2) grant real OS-level access from an LLM-reachable surface — the Settings toggle is load-bearing, not decorative.
- The Windows Service install (§2.0) needs admin rights on your machine once — I'll confirm before running anything that requires elevation.
- The vault-repo git-push credential mechanism (§2.4) — SSH key vs. PAT, and where it's stored — needs your explicit choice before an unattended job is wired to push to a remote repo on a schedule.

## 10. Phased implementation (after sign-off)

Status key: ✅ done · ◐ partially done (see note) · ○ not started.

- ✅ **(a) Data model + governance/permission layer** — `lib/org-tasks.ts` (CRUD, `ROLE_AUTONOMY`, `forceApprovalForRole`, `classifyOrgRole`), `CONSEQUENTIAL_TOOLS` additions (`calendar.write_external_attendee`, a `finance.*` prefix category — see `governance.ts`), Architect force-approval rule. `routes/org-tasks.ts` (list/get/resolve, admin-gated) and an Admin.tsx diagnostics card were added on top, ahead of where this doc originally sequenced them (§10(d)) — see that entry below.
- ○ **(a2) Always-on server setup** — Windows Service registration (§2.0) not started; needs the elevated one-time install this doc flags in §9 before proceeding. Deliberately deferred (2026-08-24 pass) pending that go-ahead.
- ◐ **(b) Role/task orchestration backend + PA host tools + daemon port** — done: `lib/host-tools.ts` (§2.2, settings-toggle gated) plus its Settings > System Access UI (§8.5, on `/admin`); `lib/org-daemon.ts`'s org-housekeeping half (§6) — stale-approval sweep, orphaned-active-task reconciliation; **(2026-08-24)** live chat triage (§3) — `lib/naxie-router.ts`'s `classifyChatIntent` + the shared `matchRoleFromText` helper factored out of `classifyOrgRole`, wired into `routes/voice.ts`'s `/converse` so ordinary chat (not just the widget's `/task` escape hatch) files task-shaped messages onto a role queue with a templated ack — role names never appear in the visible reply; the vault-repo backup tick — `org-daemon.ts`'s `maybeBackupVault`, hourly, via the existing debounced `commit-queue.ts`; the floating widget (`NaxieWidget.tsx`, wired into `Layout.tsx`); the default-route change to `/naxie` (`App.tsx`). **(2026-08-27)** the three-tier notification dispatch (§2.3) — `lib/notify.ts`: `notifyAttention()` (desktop toast, gated by a new `allowNotifications` toggle on `HostToolsSettings`, default **ON** — display-only, so it's a separate lower-risk toggle from `allowSystemControl`/`allowClipboardAccess`, shipped as its own "Notifications" card on `/admin` next to System Access) and `notifyUrgent()` (email to the operator via the existing `lookupUser("operator")`/`sendEmail` pattern from `jobs.ts`'s `waiting_on_human` handoff, plus a toast, best-effort, no-op past an audit entry when email isn't configured). Wired into `org-daemon.ts`: `maybeNudgePendingApprovals` now goes through `notifyAttention` instead of calling `notifyToast` directly; `sweepStaleOrgApprovals` now calls `notifyUrgent` when an approval expires unanswered — the exact "sat unanswered past a threshold" trigger from §2.3's tiering table. The "routine" tier stays deliberately code-free — it's the existing OrgTask/AuditLog/Approvals surfaces, not a new push channel. **Still not done**: the daemon's PA-cadence behaviors themselves (idle nudge, chat check-in, proactive research, scheduled briefs, §2.4) — the channel they'd ride on now exists, but each cadence behavior is its own unscoped feature (activity tracking, a proactive-research trigger source, brief content assembly), not picked up as a side effect of building the dispatcher.
- ◐ **(c) Approval inbox + audit log UI** — done: `Approvals.tsx` lists `OrgTask`s in `waiting-on-approval` with one-tap approve/reject (plain-language `pendingApproval.actionDescription`, per §8.5); **(2026-08-24)** diff rendering for `pendingApproval.diff`/Architect `proposal.diff` (monospace `+`/`-` view) and `AuditLog.tsx`'s `role` facet (exact-match backend filter, avoids colliding with `schedules.ts`'s unrelated `"scheduler"` actor string). **Not done**: the inline-vs-full-page split from §8.3 — everything still lands on the full Approvals page.
- ◐ **(d) Org/dashboard UI** — a read-only per-role task table shipped as a card on `/admin` rather than a separate "Advanced/diagnostics" nav area — functionally what §8.5 asked for, placed pragmatically rather than pre-deciding new nav structure (§8.5 itself left exact placement open).
- ✅ **(e) Architect role** — **(2026-08-24)** built: `lib/architect.ts` (private, repo-root-scoped, deny-listed source reader — never registered as a shared primitive, never touches `naxionai/backend/`), `runArchitectReview()` proposes single-file whole-content diffs as `role: "architect"` OrgTasks (`kind: "architect-change"`, `proposal: {diff, filesTouched, rationale}`), reusing the already-built `ROLE_AUTONOMY.architect`/`forceApprovalForRole("architect")` force-approval rule unchanged. Triggered manually (admin-gated `POST /api/naxie/architect/review`) and on a weekly `org-daemon.ts` tick. Approval never auto-applies — confirmed `resolveApproval` only flips status/logs audit; a human applies the diff by hand. Proposals touching `org-tasks.ts`/`governance.ts`/`architect.ts` itself get an explicit "⚠ changes governance rules" flag in the rationale, not a block.
- ○ **(f) Wake-word activation** — not started; still needs the Node/Windows spike this doc flags in §9. (`naxionai/backend/agent/tools/transcription.py` added recently is a general standalone audio/video transcription utility, unrelated to wake-word specifically.)

After each phase: run the existing test suite, typecheck, lint, build; report what changed before moving on. Remaining phases ((a2), the PA-cadence/notification half of (b), (f)) still shouldn't start without a real go-ahead — each carries one of §9's boundary flags (elevation, an unbuilt notification channel, or a hardware/OS spike).
