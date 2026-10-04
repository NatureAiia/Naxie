# Naxie LLM evaluation suite

This suite checks the fast triage signal, deterministic tool routes, RAG intent/entity routing, JSON output contracts, optional live Jev and model-planner behavior, configured-vault retrieval, answer grading, and model-call trace health. It runs from the Naxie server repository and does not modify production routing.

## Run offline checks

From `naxionai/server`:

```sh
npm run eval
```

Offline mode uses synthetic tasks and pure routing/contract functions. It does not call Jev, a model provider, or the user's vault.

## Optional live checks

```sh
npm run eval -- --live-jev
npm run eval -- --live-plan
npm run eval -- --live-rag
npm run eval -- --trace
npm run eval -- --gate
```

- `--live-jev` sends the synthetic routing cases to the configured Jev service and reports decisive accuracy, coverage, and false-direct decisions. Ambiguous answers count as abstentions, matching the production fallback behavior.
- `--live-plan` calls the configured planner model for the synthetic planning cases; it does not execute the resulting tools.
- `--live-rag` searches the configured Naxie vault and records retrieval telemetry. It reports hit/source coverage; add `expectedEvidenceTerms` to retrieval cases to enable top-five evidence relevance checks.
- `--trace` summarizes the newest 1,000 privacy-preserving LLM trace rows. Trace rows contain sizes, timings, model names and hashes, not prompt or response text.
- `--gate` exits nonzero when a measured section misses its minimum. Sections not run are skipped.

Live modes require their corresponding local provider configuration. They can incur provider costs. Avoid using private tasks in live planner runs unless sending them to the configured provider is acceptable.

## LLM-as-judge input

Create a local JSONL file with one item per answer to score, then run:

```sh
npm run eval -- --judge-file ./my-eval-input.jsonl
```

Each row has this shape:

```json
{"id":"case-1","task":"Answer the question","evidence":["Source text"],"answer":"Candidate answer","citationApplies":true}
```

The judge returns the same four axes used by Naxie's quality verdict: factuality risk, citation coverage, persona fit, and prompt alignment. The report includes scores and verdicts, but not task, evidence, or answer text. This mode sends all three to the configured model provider; use synthetic or approved data.

## Dataset and interpretation

`cases.json` is a small seed dataset, not a representative benchmark. Add anonymized production failures and counterexamples as they are reviewed. Keep direct/tool labels explicit, include both positive and negative tool-routing examples, and version meaningful dataset changes. Treat LLM-judge scores as advisory until human-reviewed examples show the judge is stable. The gate thresholds in `run.ts` are starter guardrails; tune them only after collecting a baseline.
