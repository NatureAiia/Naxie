# neuroworks → naxionai merge: what was intentionally dropped

This is the record for Phase 6 ("retire neuroworks") of the neuroworks →
naxionai merge. Phases 1–5 ported connectors, data sources, models, and
governance (see `connector_client.py`, `data_source_client.py`,
`model_router.py`, `governance.py`). Phase 6 ported six more
personal-assistant-relevant features (my-tasks, vault, security gates/
watch, model-providers, OCR, docx/PDF export, calendar, downloads-sync —
see their respective top-level modules and `api/*.py` routers) and then
retired the `neuroworks/` folder itself.

Everything below had **no naxionai equivalent** and was evaluated and
**dropped, on purpose** — not missed. naxionai is a personal, single-user
assistant; neuroworks was a multi-department AI-workforce platform, and
most of what's listed here only makes sense in that enterprise context.

## Enterprise-only (dropped — belongs to the multi-department product, not a personal assistant)

- `lib/adrs.ts` — "AI Data Readiness" pipeline publishing versioned company datasets.
- `lib/api-keys.ts` — scoped bearer tokens for external *systems* to dispatch agent jobs.
- `lib/assignments.ts` + `routes/assignments.ts` — human work ledger with reporting-chain hierarchy.
- `lib/department-data.ts` — per-department company knowledge store (Finance/HR/Sales).
- `lib/dispatch.ts` + `routes/dispatch.ts` — inbound API for external systems to dispatch jobs.
- `lib/doc-ingest.ts` — routes uploaded docs into the Workforce contact book or department data.
- `lib/enterprise-auth.ts` — enterprise-mode auth gate.
- `lib/finance-snapshot.ts` + `routes/public-finance.ts` — external Finance System ingest.
- `lib/handoff.ts` + `routes/handoff.ts` — sequential task relay down a chain of personas.
- `lib/heygen.ts` — AI avatar/spokesperson video generation.
- `lib/human-work.ts` — human employee timesheet tracking vs. agent work.
- `lib/job-visibility.ts` — multi-user job-visibility scoping.
- `lib/knowledge-packs.ts` + `routes/knowledge-packs.ts` — installable per-sector knowledge packs.
- `lib/omnisignal.ts` + `routes/omnisignal.ts` — multi-source company data acquisition.
- `lib/org-chart.ts` — org hierarchy parsing for manager/peer routing.
- `lib/peer-registry.ts`, `lib/peers.ts` + `routes/peers.ts` — distributed peer-node worker registry.
- `lib/presets.ts` + `routes/presets.ts` — "hire a worker" role bundles.
- `lib/sector-packs.ts` + `routes/onboarding.ts` — industry-vertical onboarding packs.
- `lib/task-restrictions.ts` — role/department-scoped capability restrictions.
- `lib/telegram-bridge.ts` — Telegram messaging bridge.
- `lib/worker-manager.ts` — auto-spawned worker child processes.
- `routes/workforce.ts` — AI + human workforce contact book.

## Everything else evaluated (dropped — optional capabilities, not core to a personal assistant)

- `lib/curation.ts`, `lib/quality.ts` + `routes/quality.ts`, `routes/feedback.ts` — draft quality review / thumbs-up-down learned quality signals.
- `lib/deliverable.ts` — shared research/creative/procedural/code classification for planner+grader agreement.
- `lib/email.ts`, `lib/email-inbound.ts`, `lib/email-auth.ts`, `lib/email-threads.ts` + `routes/email.ts` — full email-as-chat bridge (naxionai keeps the simpler approval-reply IMAP poller in `agent/tools/email_inbox.py`).
- `lib/executor-mode.ts`, `lib/hermes.ts` + `routes/executor.ts`, `routes/external-agents.ts`, `routes/primitives.ts` — pluggable alternate agent executor + external-agent HTTP bridge.
- `lib/github.ts` + `routes/repos.ts` — GitHub repo/PR/issue reading and workflow dispatch.
- `lib/language-prompts.ts` — per-language system-prompt localization.
- `lib/lane.ts` — per-persona "lane" pre-flight check (naxionai's `personas.py` already documents no per-persona routing today).
- `lib/my-tasks.ts` (routing/list logic beyond what was ported) — ported; see `api/my_tasks.py`.
- `lib/notepad.ts` — reads Windows Notepad's autosave tab store.
- `lib/persona-profile.ts`, `lib/persona-router.ts`, `lib/persona-templates.ts` — self-updating persona profiles, auto-routing, auto-generated task templates.
- `lib/prompt-cache-stats.ts` — prompt-cache hit-rate tracking.
- `lib/security-gates.ts`, `lib/security-watch.ts`, `lib/security.ts` — **ported**; see `security_gates.py`, `security_watch.py`, `security_scan.py`.
- `lib/shona-glossary.ts` — Shona/Ndebele conversational vocabulary.
- `lib/small-model-harness.ts` — defers to an external `little-coder` CLI for small-model execution.
- `lib/source-validator.ts`, `lib/source-validator-types.ts` — research-source quality grading.
- `lib/studio-image.ts`, `lib/studio-models.ts` — text-to-image generation + model catalog.
- `lib/sync-downloads.ts` — **ported**; see `sync_downloads.py`.
- `lib/vault.ts`, `lib/vault-index.ts` + `routes/brain.ts` — **ported** (trimmed scope, see the module docstring); see `vault.py`, `api/vault.py`.
- `lib/model-providers.ts` — **ported**; see `model_providers.py`.
- `lib/ocr.ts` — **ported**; see `ocr.py`.
- `lib/docx-export.ts` + `routes/exports.ts` — **ported**; see `document_export.py`, `api/exports.py`.
- `lib/calendar-ical.ts` — **ported**; see `calendar_ical.py`.
- `routes/status.ts`, `routes/terminal.ts` — general server-status dashboard + arbitrary-shell-command runner. Terminal was already replaced in Phase 5 by the narrow `git_command` tool in `agent/tools/pa_tools.py` (status/pull on one operator-configured repo only).

## Verified before retirement

- No file under `naxionai/` imports, calls, or references `neuroworks/` at
  runtime (checked exhaustively — every hit was a "ported from" provenance
  comment or cosmetic "NeuroWorks" branding string).
- The local `./vault` folder naxionai now reads/writes moved out of
  `neuroworks/vault/` beforehand so it isn't lost with the folder.
