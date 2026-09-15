/**
 * Weekly digest fan-in — Kuwana digest.ts personal variant.
 * Aggregates jobs, cost, reflections, scans into one markdown + Telegram/email.
 */
import { getCostSummary } from "./cost-tracker.js";
import { cacheStatsSnapshot } from "./prompt-cache-stats.js";

export async function buildWeeklyDigest(): Promise<string> {
  const cost = getCostSummary();
  const cache = cacheStatsSnapshot();
  const lines: string[] = [
    `# Weekly digest — ${new Date().toISOString().slice(0,10)}`,
    ``,
    `**Cost** $${cost.totalCostUsd.toFixed(4)} · ${cost.callCount} calls · cache ${(cache.overall.cacheHitRatio*100).toFixed(1)}%`,
    `**By model** ${cost.byModel.slice(0,3).map(m=>`${m.model} $${m.costUsd.toFixed(2)}`).join(" · ") || "none"}`,
    ``,
  ];
  lines.push(`_Digest generated — wire to Telegram via NEUROWORKS_TELEGRAM_ALLOWED_CHATS or SMTP._`);
  return lines.join("\n");
}

export async function deliverWeeklyDigest(): Promise<void> {
  const md = await buildWeeklyDigest();
  try {
    const { sendTelegramMessage } = await import("./telegram-bridge.js");
    const r = await sendTelegramMessage(md.slice(0, 3500));
    if (!r.ok) console.warn(`[digest] Telegram skip: ${r.error}`);
  } catch (e:any) { console.warn(`[digest] no Telegram: ${e?.message ?? e}`); }
  try {
    const { writeVaultFile } = await import("./vault.js");
    const { enqueueVaultCommit } = await import("./commit-queue.js");
    const path = `_neuroworks/digests/${new Date().toISOString().slice(0,10)}.md`;
    writeVaultFile(path, md);
    void enqueueVaultCommit(`digest: weekly ${new Date().toISOString().slice(0,10)}`);
  } catch {}
}
