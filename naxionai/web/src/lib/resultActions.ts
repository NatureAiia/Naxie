import { api, getToken, type BoardRun, type OrchestrationRun } from "./api";
import { showToast } from "../components/Card";

// Shared after-done actions for Board Meeting + Orchestrate results:
// copy, download (MD/PDF), save-to-vault, and cross-handoffs.

// ─── markdown builders ──────────────────────────────────────────────

export function buildBoardMarkdown(run: BoardRun): string {
  const lines: string[] = [];
  lines.push(`# Board Meeting: ${run.topic}`);
  lines.push("");
  lines.push(`- Date: ${new Date(run.createdAt).toLocaleString()}`);
  lines.push(`- Status: ${run.status}`);
  if (run.roster?.length) {
    lines.push(`- Council: ${run.roster.map(m => `${m.name} (${m.role})`).join(", ")}`);
  }
  lines.push("");
  lines.push("## Naxie's final synthesis");
  lines.push("");
  lines.push(run.chairmanSynthesis || "_(not yet synthesized)_");
  lines.push("");
  if (run.opinions?.length) {
    lines.push("## Council opinions (Stage 1)");
    lines.push("");
    for (const o of run.opinions) {
      lines.push(`### ${o.name} (${o.role})`);
      lines.push("");
      lines.push(o.error ? `_Failed: ${o.error}_` : (o.text || "_(empty)_"));
      lines.push("");
    }
  }
  if (run.rankings?.length) {
    lines.push("## Peer review (Stage 2)");
    lines.push("");
    for (const r of run.rankings) {
      lines.push(`### ${r.name}'s ranking`);
      lines.push("");
      lines.push(r.error ? `_Failed: ${r.error}_` : (r.rankingText || "_(empty)_"));
      lines.push("");
    }
  }
  if (run.groundedIn?.length) {
    lines.push("## Grounded in");
    lines.push("");
    for (const g of run.groundedIn) lines.push(`- ${g.path} — ${g.preview}`);
    lines.push("");
  }
  return lines.join("\n");
}

export function buildOrchestrationMarkdown(run: OrchestrationRun): string {
  const lines: string[] = [];
  lines.push(`# Orchestration: ${run.label}`);
  lines.push("");
  lines.push(`- Date: ${new Date(run.createdAt).toLocaleString()}`);
  lines.push(`- Status: ${run.status}`);
  lines.push("");
  lines.push("## Objective");
  lines.push("");
  lines.push(run.objective || "_(empty)_");
  lines.push("");
  if (run.decomposition) {
    lines.push("## Decomposition");
    lines.push("");
    lines.push(run.decomposition);
    lines.push("");
  }
  if (run.subTasks?.length) {
    lines.push("## Sub-tasks");
    lines.push("");
    run.subTasks.forEach((s, i) => {
      lines.push(`### ${i + 1}. ${s.label}${s.personaName ? ` (${s.personaName})` : ""} — ${s.status}`);
      lines.push("");
      if (s.instructions) { lines.push(`_Instructions: ${s.instructions}_`); lines.push(""); }
      lines.push(s.error ? `_Failed: ${s.error}_` : (s.output || "_(no output)_"));
      lines.push("");
    });
  }
  if (run.finalReport) {
    lines.push("## Final report");
    lines.push("");
    lines.push(run.finalReport);
    lines.push("");
  }
  return lines.join("\n");
}

// ─── clipboard ──────────────────────────────────────────────────────

export async function copyText(text: string, okMsg = "Copied"): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    showToast(okMsg, "success");
  } catch {
    // Fallback for non-secure contexts: select-and-copy via textarea.
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      ta.remove();
      showToast(okMsg, "success");
    } catch {
      showToast("Copy failed — select the text manually", "error");
    }
  }
}

// ─── downloads (auth-aware: window.open would drop the Bearer token) ─

function authHeaders(): Record<string, string> {
  try {
    const t = getToken();
    return t ? { Authorization: `Bearer ${t}` } : {};
  } catch { return {}; }
}

async function downloadBlob(res: Response, filename: string): Promise<void> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b: any = await res.json(); if (b?.error) msg = b.error; } catch { /* non-JSON */ }
    throw new Error(msg);
  }
  const blob = await res.blob();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function safeBase(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "result";
}

export async function downloadMarkdown(markdown: string, filenameBase: string): Promise<void> {
  const filename = `${safeBase(filenameBase)}.md`;
  try {
    const res = await fetch("/api/exports/markdown", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ markdown, filename }),
    });
    await downloadBlob(res, filename);
    showToast(`Downloaded ${filename}`, "success");
  } catch (e: any) {
    showToast(e?.message ?? String(e), "error");
  }
}

export async function downloadPdfFromMarkdown(markdown: string, filenameBase: string, title?: string): Promise<void> {
  const filename = `${safeBase(filenameBase)}.pdf`;
  try {
    const res = await fetch("/api/exports/pdf", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ markdown, filename, ...(title ? { title } : {}) }),
    });
    await downloadBlob(res, filename);
    showToast(`Downloaded ${filename}`, "success");
  } catch (e: any) {
    showToast(e?.message ?? String(e), "error");
  }
}

/** Board fast-path: the server already wrote a vault note — export that file directly. */
export function downloadVaultFile(format: "pdf" | "docx", path: string): void {
  const url = `/api/exports/${format}?path=${encodeURIComponent(path)}`;
  // GET with auth: fetch as blob so the Bearer token is sent (window.open would drop it).
  fetch(url, { headers: { ...authHeaders() } })
    .then(async res => {
      const filename = (path.split("/").pop() ?? "document").replace(/\.(md|markdown|txt)$/i, "") + `.${format}`;
      await downloadBlob(res, filename);
      showToast(`Downloaded ${filename}`, "success");
    })
    .catch((e: any) => showToast(e?.message ?? String(e), "error"));
}

// ─── save to vault (uses the existing /api/brain/file surface — no new backend) ─

export async function saveMarkdownToVault(markdown: string, filenameBase: string): Promise<string | null> {
  // Strip non-digits rather than with an explicit separator character class:
  // Tailwind scans every src TS file for class candidates, and a bracketed
  // "dash-colon-T" pattern reads as an arbitrary-property rule that
  // lightningcss then refuses to minify (production build fails).
  const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
  const path = `0-Inbox/${stamp}-${safeBase(filenameBase)}.md`;
  try {
    await api.brainSave(path, markdown);
    showToast(`Saved to vault: ${path}`, "success");
    return path;
  } catch (e: any) {
    showToast(e?.message ?? String(e), "error");
    return null;
  }
}

// ─── handoff to Naxie chat: stash prompt where a fresh /naxie mount picks it up ─

export const NAXIE_HANDOFF_KEY = "naxie.handoffPrompt";

/** Queue a prompt for Naxie's composer. Naxie reads + clears it on mount. */
export function stashNaxiePrompt(prompt: string): void {
  try { localStorage.setItem(NAXIE_HANDOFF_KEY, prompt); } catch { /* ignore */ }
}

export function sendToNaxie(navigate: (to: string) => void, prompt: string): void {
  stashNaxiePrompt(prompt);
  void copyText(prompt, "Copied — opening Naxie to continue…");
  navigate("/naxie");
}
