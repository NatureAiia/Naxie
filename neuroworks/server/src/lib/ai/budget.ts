/**
 * Kuwana-inspired monthly AI budget cap — personal-app variant.
 * Uses existing JSONL cost tracker (cost-tracker.ts) + AppSetting-style env.
 * When month-to-date spend ≥ LLM_MONTHLY_BUDGET_USD, paid rungs are skipped.
 */
import { getCostRecords } from "../cost-tracker.js";

const DEFAULT_BUDGET_USD = Number(process.env.LLM_MONTHLY_BUDGET_USD ?? process.env.NEUROWORKS_LLM_BUDGET_USD ?? "20");

export type BudgetStatus = { allowed: boolean; spentUsd: number; budgetUsd: number; remainingUsd: number };

function monthStart(d = new Date()): Date {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

export function getBudgetUsd(): number {
  const v = Number(process.env.LLM_MONTHLY_BUDGET_USD ?? process.env.NEUROWORKS_LLM_BUDGET_USD ?? String(DEFAULT_BUDGET_USD));
  if (!Number.isFinite(v) || v < 0) return DEFAULT_BUDGET_USD;
  return v;
}

export function getMonthSpendUsd(now = new Date()): number {
  const start = monthStart(now).toISOString();
  const records = getCostRecords(start);
  // only paid calls count; ollama is $0 anyway
  return records.reduce((s, r) => s + (r.costUsd ?? 0), 0);
}

export function checkBudget(): BudgetStatus {
  const budgetUsd = getBudgetUsd();
  if (budgetUsd === 0) return { allowed: true, spentUsd: 0, budgetUsd: 0, remainingUsd: Infinity }; // 0 = disabled
  const spentUsd = getMonthSpendUsd();
  const allowed = spentUsd < budgetUsd;
  return { allowed, spentUsd, budgetUsd, remainingUsd: budgetUsd - spentUsd };
}

export class AiBudgetExceededError extends Error {
  status = 402;
  spentUsd: number;
  budgetUsd: number;
  constructor(spentUsd: number, budgetUsd: number) {
    super(`Monthly AI budget $${budgetUsd} exceeded (spent $${spentUsd.toFixed(4)}). Set LLM_MONTHLY_BUDGET_USD=0 to disable.`);
    this.name = "AiBudgetExceededError";
    this.spentUsd = spentUsd;
    this.budgetUsd = budgetUsd;
  }
}
