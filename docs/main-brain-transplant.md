# main-brain Transplant Manifest

> Source: `RUBIEM-DEVELOPERS-REPO/main-brain` @ `dbfcaa5` (main, 2026-09-12)
> Target: `NatureAiia/NaxionAI-Powered-by-Neuroworks`
> Date: 2026-09-12
> Method: `gh api` sparse fetch (no full clone — 1.2 GB)

## Vision Alignment

NaxionAI = "Autonomous Digital Media Intelligent Agency" (`naxionai/ui_ux_master_prompt.md:1` — Obsidian & Neon, $50M SPA).
NeuroWorks = local-first AI Workforce shell (`README.md:13` — empty-state UAT, vault at `neuroworks/vault/`).
Rule: code → this repo; knowledge/data → `marknature/NaxionAI_Vault-Repo` (`CLAUDE.md:7`).

This transplant ports **scaffold, patterns, workforce (personas/templates), knowledge-packs, and automation contracts** — NOT operator-private rows.

## What Was Ported

| Area | From | To | Count |
|---|---|---|---|
| Vault scaffold | `CLAUDE.md`, folder layout `0-Inbox/1-Literature/2-Permanent/3-MOCs/4-Projects/_progress/_context/_knowledge/_people/_scratch/_clawbot/_neuroworks/*` | `neuroworks/vault/` | 14 dirs + `CLAUDE.md` |
| Durable docs | `2-Permanent/expected-agentic-features.md`, `NeuroWorks Architecture.md`, `scraper-hub-build-guide.md`, `NeuroWorks Data Migration.md`, `insurance-ai-underwriting-claims.md`, `zimbabwe-data-sources-catalog.md` | `neuroworks/vault/2-Permanent/` | 6 |
| Platform docs | `_knowledge/neuroworks-platform.md`, `_knowledge/clawbot-operations.md` | `neuroworks/vault/_knowledge/` | 2 |
| Knowledge packs | `_knowledge-packs/*` (agriculture, fintech, education, government, healthtech, informal-trade, it-tech, mining, ngo, retail, tourism, custom) | `neuroworks/vault/_knowledge-packs/*` | 16 files across 12 packs |
| Clawbot | `_clawbot/latest.md` (2026-05-24 digest sample), `_neuroworks/reflections` sample, `_neuroworks/orchestrations.json` sample | `neuroworks/vault/_clawbot/`, `_neuroworks/` | 3 |
| Personas | 13 missing lanes: `nova`, `research-orchestrator`, `deal-intel`, `market-intel`, `pricing-intel`, `product-intel`, `talent-intel`, `sentiment-intel`, `strategy-intel`, `head-of-ai`, `insurance-underwriter`, `insurance-sales-agent`, `sales-analyst` | `neuroworks/.neuroworks/personas.json` (37→50) + `naxionai/backend/persona_catalog.py` (+13) | 13 |
| Templates | All 288 `custom-*.md` from `_neuroworks/templates/` — merged via frontmatter parse | `neuroworks/.neuroworks/custom-templates.json` (134→294) | +160 |

## What Was Explicitly NOT Ported

`audit.jsonl`, `cost.jsonl`, `feedback.jsonl`, `quality.jsonl`, `_progress/YYYY-MM-DD-*.md` (operator session logs), `0-Inbox/` captures, `1-Literature/` raw, `4-Projects/AFC|Aiia-Institute|EasyMobile|Hustler-Wallet` client work, `email/`, `memory/*.jsonl`, `.env`/`tokens`/`naxionai.db`. These belong in the Vault Repo (if needed).

## File Map

```
neuroworks/vault/
  CLAUDE.md                         ← main-brain/CLAUDE.md (Zettelkasten + session protocol)
  2-Permanent/*.md                  ← durable claims
  _knowledge/*.md                   ← platform reference
  _knowledge-packs/*/*.md           ← vertical stubs
  _clawbot/latest.md                ← digest landing zone sample
  _neuroworks/reflections/*.md      ← reflection sample
  _neuroworks/orchestrations-sample.json ← fan-out template (AI_Landscape_Zimbabwe)
  0-Inbox/ 1-Literature/ 3-MOCs/ 4-Projects/ _progress/ _context/ _people/ _scratch/  ← empty scaffolds

neuroworks/.neuroworks/
  personas.json                     ← +13 personas (50 total)
  custom-templates.json             ← 294 templates (full main-brain parity)

naxionai/backend/
  persona_catalog.py                ← +13 PersonaDef (keeps agency daemon in sync)
```

## Verification

```powershell
gh api repos/RUBIEM-DEVELOPERS-REPO/main-brain/contents/_neuroworks/templates --jq ".[].name" | Measure-Object  # 288
Get-Content neuroworks/.neuroworks/custom-templates.json | ConvertFrom-Json | Measure-Object  # 294
Get-Content neuroworks/.neuroworks/personas.json | ConvertFrom-Json | Select-Object -ExpandProperty personas | Measure-Object  # 50
pnpm -F neuroworks-server test
graphify update . && graphify query "vault AND persona"
```

## Rollback

Revert commit `docs/main-brain-transplant.md` + the three changed files. Vault scaffold under `neuroworks/vault/` is ignored by root `.gitignore` (`neuroworks-ts/vault/*`) but intentionally tracked here for UAT demo seed — delete `neuroworks/vault/_knowledge*` etc. to return to empty shell.
