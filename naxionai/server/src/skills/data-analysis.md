---
name: data-analysis
description: End-to-end spreadsheet analysis — profile, clean, explore, visualize, model, and write a findings memo with charts saved to the vault. Use whenever a task asks to analyze a CSV, spreadsheet, or dataset.
applies_to: [analyze, research, summarize]
---

# Skill: Spreadsheet analysis

## Goal

A findings memo the operator can act on — key numbers, what changed, what's driving it, what to do next — backed by charts saved as files in the vault. Not a data dump, not a notebook transcript.

## Process

1. **Locate the data.** Resolve the file (vault path, upload `contextId`, or local folder). If it's `.xlsx`, read the right sheet first — never assume sheet 1. If it's large, work on a copy, never the original.
2. **Profile before touching anything.** Shape, dtypes, null counts per column, duplicate rows, date ranges, categorical cardinality. Print a compact profile table; this decides everything downstream.
3. **Clean (HR checklist).** Drop redundant columns, rename cryptic headers, drop exact duplicates, decide per-column what NaNs mean (missing vs zero vs unknown — don't blanket-fill). Write the cleaned copy next to the original as `<name>.cleaned.csv`. The source file is never modified.
4. **Explore.** Distributions for numeric columns, top-N for categoricals, trends over time if a date column exists, correlation map for numeric pairs. Compute in Python (pandas) — never eyeball aggregates or ask the LLM to do arithmetic.
5. **Visualize.** 2-4 charts max, one message per chart. `matplotlib.use("Agg")` (headless — there is no display), save as PNG under `_naxion/analysis/<slug>/`. Charts go to the vault as files; the chat reply carries the findings, not the pixels.
6. **Model only if asked.** If the task wants prediction (restock, churn, forecast), train the simplest model that beats a naive baseline, report the baseline comparison honestly, and save model + rerun script under `_naxion/models/<slug>/` so it runs again without you (train-once pattern).
7. **Write the findings memo.** Headline numbers first, then drivers, then recommended actions. State assumptions and data caveats explicitly.

## Output shape

```
# Analysis — <file> · <date>

## Headline numbers
- <3-6 bullets, each with the number>

## What's driving it
- <drivers with evidence, not hunches>

## Charts
- <what each saved chart shows> (`_naxion/analysis/<slug>/...png`)

## Caveats
- <assumptions, dirty data, what wasn't checked>

## Recommended actions
- [ ] <concrete next step>
```

## Rules

- **Compute, don't estimate.** Every number in the memo comes from executed code, never from reading raw rows.
- **Cap what enters the prompt.** Summaries and profiles go to the LLM; raw rows never do. Sample at most ~20 rows for illustration.
- **One message per chart.** A chart showing three things shows nothing.
- **State the baseline.** A model without a naive-baseline comparison is decoration.
- **Cleaned copy lives next to the original** as `<name>.cleaned.csv` — reproducible, auditable.

## Pitfalls

- Filling NaNs with zero/means without asking what missing means — silently invents data.
- Correlation treated as cause — report the correlation, label the causal claim as hypothesis.
- Chart sprawl — ten auto-plots nobody reads; pick the 2-4 that answer the question.
- Modifying the source file in place — destroys the audit trail.
- Forgetting `Agg` backend — matplotlib blocks waiting for a display that doesn't exist.
