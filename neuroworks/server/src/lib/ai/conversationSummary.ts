/**
 * Kuwana-inspired conversation summary — keeps long chats grounded beyond the 20-msg window.
 * Cheap 2-3 sentence summary, updated every 10 messages, injected as system memory.
 */
import { llmGenerate } from "../llm.js";

const SUMMARY_EVERY_N = 10;

export async function shouldSummarize(messageCount: number): Promise<boolean> {
  return messageCount > 0 && messageCount % SUMMARY_EVERY_N === 0;
}

export async function summarizeConversation(messages: { role: string; content: string }[]): Promise<string | null> {
  if (messages.length < 6) return null;
  const excerpt = messages.slice(-20).map(m => `${m.role}: ${m.content.slice(0, 400)}`).join("\n");
  try {
    const res = await llmGenerate(
      excerpt.slice(0, 6000),
      `Summarize this NeuroWorks conversation in 2-3 sentences for future context. Keep names, decisions, and open asks. No preamble, just the summary.`,
      { profile: "triage", maxTokens: 120, temperature: 0.2 },
    );
    return res.trim().slice(0, 600) || null;
  } catch { return null; }
}
