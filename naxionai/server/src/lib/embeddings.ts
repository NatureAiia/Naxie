// Embeddings — used ONLY to back the vector RAG stores (vault_chunks table,
// see migrations/0001_vault_chunks.sql, plus MongoDB Atlas). Deliberately
// independent of whichever provider is active for chat (Gemini by default,
// see llm.ts).
//
// Backend priority (deterministic — never switches mid-stream):
//   1. OpenAI-compatible /v1/embeddings when OPENAI_EMBEDDING_API_KEY is set
//      (default model text-embedding-3-small, 1536 dims).
//   2. Local Ollama /api/embed otherwise (default model nomic-embed-text,
//      768 dims) — free, offline-capable, no key needed.
// The two produce DIFFERENT dimensions: callers must label rows with
// embeddingModelInUse() (rag-embed.ts does) so stores never mix them
// silently — pgvector's vector(1536) column rejects mismatched dims.
//
// Kept out of llm.ts (which is chat-completions focused) as its own small
// module — one concern, one file, easy to find.

import { config } from "../config.js";
import { isOffline, isLocalUrl } from "./offline-mode.js";

// OpenAI's /v1/embeddings accepts a batch of inputs per call; keep batches
// well under any practical request-size limit. Ollama batches smaller —
// local inference is slower per token.
const OPENAI_MAX_BATCH = 100;
const OLLAMA_MAX_BATCH = 32;

export class EmbeddingsUnavailable extends Error {
  constructor(reason: string) {
    super(`embeddings unavailable: ${reason}`);
    this.name = "EmbeddingsUnavailable";
  }
}

// Dynamic check (not the boot-time openaiEmbeddingEnabled flag) so runtime
// key overrides via rag-config also switch the backend.
function useOpenAI(): boolean {
  return (config.openaiEmbeddingApiKey ?? "").length > 0;
}

// The model label for rows produced by embedText() right now — rag-embed.ts
// stamps this into embedding_model so re-embeds and queries stay consistent.
export function embeddingModelInUse(): string {
  return useOpenAI() ? config.openaiEmbeddingModel : `ollama/${config.ollamaEmbeddingModel}`;
}

// Fast-path gate for callers (rag.ts, rag-embed.ts): true when the OpenAI
// key is present OR an Ollama host is configured. Ollama reachability itself
// is only known by attempting — failures surface as EmbeddingsUnavailable
// and callers degrade to keyword search.
export function embeddingsConfigured(): boolean {
  return useOpenAI() || config.ollamaHost.trim().length > 0;
}

// Embeds a list of texts, batching internally. Throws EmbeddingsUnavailable
// when neither backend can serve — callers (rag.ts's pgvectorSearch, the
// re-embed job) MUST catch this and degrade gracefully (skip semantic search
// / skip re-embedding), matching this codebase's existing posture for every
// optional integration.
export async function embedText(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (useOpenAI()) {
    if (isOffline() && !isLocalUrl(config.openaiEmbeddingBaseUrl)) {
      throw new EmbeddingsUnavailable("offline mode");
    }
    return embedViaOpenAI(texts);
  }
  return embedViaOllama(texts);
}

async function embedViaOpenAI(texts: string[]): Promise<number[][]> {
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += OPENAI_MAX_BATCH) {
    const batch = texts.slice(i, i + OPENAI_MAX_BATCH);
    const res = await fetch(`${config.openaiEmbeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.openaiEmbeddingApiKey}`,
      },
      body: JSON.stringify({
        model: config.openaiEmbeddingModel,
        input: batch,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new EmbeddingsUnavailable(`OpenAI embeddings HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json: any = await res.json();
    const data = Array.isArray(json?.data) ? json.data : [];
    // OpenAI returns results in input order, but sort by index defensively.
    data.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
    for (const d of data) out.push(d.embedding as number[]);
  }
  return out;
}

async function embedViaOllama(texts: string[]): Promise<number[][]> {
  if (isOffline() && !isLocalUrl(config.ollamaHost)) {
    throw new EmbeddingsUnavailable("offline mode");
  }
  const model = config.ollamaEmbeddingModel;
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += OLLAMA_MAX_BATCH) {
    const batch = texts.slice(i, i + OLLAMA_MAX_BATCH);
    let res: Response;
    try {
      res = await fetch(`${config.ollamaHost}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: batch }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e: any) {
      throw new EmbeddingsUnavailable(`ollama unreachable at ${config.ollamaHost}: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      if (res.status === 404 && /not found/i.test(body)) {
        throw new EmbeddingsUnavailable(`ollama model "${model}" not pulled — run \`ollama pull ${model}\``);
      }
      throw new EmbeddingsUnavailable(`ollama embed HTTP ${res.status}: ${body.slice(0, 300)}`);
    }
    const json: any = await res.json().catch(() => ({}));
    const embeddings = Array.isArray(json?.embeddings) ? json.embeddings : [];
    if (embeddings.length !== batch.length) {
      throw new EmbeddingsUnavailable(`ollama returned ${embeddings.length} embeddings for ${batch.length} inputs`);
    }
    for (const e of embeddings) out.push(e as number[]);
  }
  return out;
}
