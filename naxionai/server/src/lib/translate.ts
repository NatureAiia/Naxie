// Deterministic translation for English ↔ Shona ↔ Ndebele via Meta's
// NLLB-200-distilled-600M on the Hugging Face Inference API — cheaper,
// faster, and more accurate for these low-resource pairs than burning
// general-LLM tokens. Pattern adapted from the translator-gdsc
// translationApi.ts approach (endpoint-per-direction, Bearer token,
// wait_for_model), hardened: server-side key only (theirs shipped in a
// NEXT_PUBLIC_ var), same-language guard, timeout, explicit errors.
//
// This does NOT replace the translation.md skill — that handles nuanced
// message translation + response drafting (tone, register,
// back-translation). This primitive handles short, explicit
// "translate X to Shona" asks, called directly from chat's fast-path.
//
// NLLB license note: facebook/nllb-200-distilled-600M is CC-BY-NC-4.0
// (non-commercial). Fine for personal use; revisit the model choice if
// translations start serving the business brand commercially.
// Ndebele coverage is best-effort — sna_Latn (Shona) is confirmed in the
// model's language list, nbl_Latn is attempted and any API rejection
// surfaces as an error so the caller can fall back to the LLM.

const NLLB_MODEL = "facebook/nllb-200-distilled-600M";
const NLLB_ENDPOINT = `https://api-inference.huggingface.co/models/${NLLB_MODEL}`;
const TIMEOUT_MS = 120_000;
const MAX_CHARS = 2000;

export type TranslateLang = "english" | "shona" | "ndebele";

const NLLB_CODES: Record<TranslateLang, string> = {
  english: "eng_Latn",
  shona: "sna_Latn",
  ndebele: "nbl_Latn",
};

const LANG_ALIASES: Array<[RegExp, TranslateLang]> = [
  [/\bshona\b/i, "shona"],
  [/\bndebele\b/i, "ndebele"],
  [/\benglish\b/i, "english"],
];

export function resolveTranslateLang(s: string): TranslateLang | null {
  for (const [re, lang] of LANG_ALIASES) if (re.test(s)) return lang;
  return null;
}

export type TranslateCommand = { text: string; from: TranslateLang | null; to: TranslateLang };

/**
 * Parse short explicit translate commands. Tight on purpose — anything
 * conversational ("can you help me translate this contract...") falls
 * through to the agent + translation.md skill.
 */
export function parseTranslateCommand(text: string): TranslateCommand | null {
  const t = text.trim();
  if (t.length > MAX_CHARS + 60) return null;
  const patterns = [
    /^(?:please\s+)?translate\s+(?:this\s+|that\s+)?(?:to|into)\s+(english|shona|ndebele)\s*[:—\-,]\s*(.+)$/is,
    /^(?:please\s+)?translate\s+(.+?)\s+(?:to|into)\s+(english|shona|ndebele)\s*[.?!]?\s*$/is,
    /^(?:how\s+do\s+(?:you|i)\s+say\s+|say\s+)(.+?)\s+in\s+(english|shona|ndebele)\s*[.?!]?\s*$/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    // Pattern 1 and 3 put the language in group 1... normalize by
    // resolving whichever group names a language.
    let to: TranslateLang | null = null;
    let body = "";
    for (let i = 1; i < m.length; i++) {
      const lang = resolveTranslateLang(m[i] ?? "");
      if (lang && !to) { to = lang; continue; }
      if ((m[i] ?? "").trim()) body = (m[i] ?? "").trim();
    }
    if (!to || !body) continue;
    const clean = body.replace(/^["'“”]|["'“”]$/g, "").trim();
    if (clean.length < 1 || clean.length > MAX_CHARS) continue;
    return { text: clean, from: null, to };
  }
  return null;
}

export type TranslateResult = { text: string; from: TranslateLang; to: TranslateLang; model: string };

export async function translateText(input: { text: string; from: TranslateLang; to: TranslateLang }): Promise<TranslateResult> {
  if (process.env.NAXION_TRANSLATE === "0") throw new Error("translation disabled (NAXION_TRANSLATE=0)");
  const token = (process.env.HF_API_TOKEN ?? "").trim();
  if (!token) throw new Error("translation unavailable — set HF_API_TOKEN on the server");
  const { text, from, to } = input;
  if (!text.trim()) throw new Error("nothing to translate");
  if (from === to) throw new Error(`already ${to} — pick two different languages`);
  if (text.length > MAX_CHARS) throw new Error(`text too long for the fast path (${text.length} > ${MAX_CHARS} chars) — ask as a normal task instead`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(NLLB_ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        inputs: text,
        parameters: { src_lang: NLLB_CODES[from], tgt_lang: NLLB_CODES[to] },
        options: { wait_for_model: true },
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      // 503 with estimated_time can survive wait_for_model on a cold model
      // on the very first call — surface it plainly, don't retry-loop here.
      throw new Error(`translation backend ${res.status}: ${body.slice(0, 200) || res.statusText}`);
    }
    const data = await res.json().catch(() => null);
    const out = Array.isArray(data) ? (data[0]?.translation_text ?? data[0]?.generated_text ?? "") : (data?.translation_text ?? data?.generated_text ?? "");
    if (!String(out).trim()) throw new Error("translation backend returned an empty result");
    const result = { text: String(out).trim(), from, to, model: `hf/${NLLB_MODEL}` };
    // Instrumented via audit-log only, deliberately NOT cost-tracker:
    // cost-tracker ledgers token-billed LLM spend (its backend union has no
    // huggingface entry), and filing HF calls there would corrupt the Cost
    // page breakdown. Usage volume is visible in audit + translation-history.
    try {
      const { logAudit } = await import("./audit-log.js");
      logAudit({ level: "info", actor: "system", action: "translate.nllb", target: `${from}->${to}`, detail: `${text.length} chars`, result: "success" });
    } catch { /* audit best-effort */ }
    return result;
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error("translation timed out after 120s — the model may be cold; try again in a minute");
    try {
      const { logAudit } = await import("./audit-log.js");
      logAudit({ level: "warn", actor: "system", action: "translate.nllb", target: `${from}->${to}`, detail: String(e?.message ?? e).slice(0, 200), result: "failure" });
    } catch { /* ignore */ }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
