// OpenAI embeddings — used ONLY to back the pgvector RAG store
// (vault_chunks table, see migrations/0001_vault_chunks.sql). Deliberately
// independent of whichever provider is active for chat (Gemini by default,
// see llm.ts) since OpenAI's /v1/embeddings endpoint is the one clearly
// OpenAI-compatible embeddings API already reachable from this codebase.
//
// Kept out of llm.ts (which is chat-completions focused) as its own small
// module — one concern, one file, easy to find.

import { config } from "../config.js";
import { isOffline, isLocalUrl } from "./offline-mode.js";

const EMBEDDING_MODEL = config.openaiEmbeddingModel;
// OpenAI's /v1/embeddings accepts a batch of inputs per call; keep batches
// well under any practical request-size limit.
const MAX_BATCH = 100;

export class EmbeddingsUnavailable extends Error {
  constructor(reason: string) {
    super(`embeddings unavailable: ${reason}`);
    this.name = "EmbeddingsUnavailable";
  }
}

// Embeds a list of texts, batching internally. Throws EmbeddingsUnavailable
// when OPENAI_EMBEDDING_API_KEY isn't configured — callers (rag.ts's
// pgvectorSearch, the re-embed job) MUST catch this and degrade gracefully
// (skip semantic search / skip re-embedding), matching this codebase's
// existing posture for every optional integration.
export async function embedText(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  if (!config.openaiEmbeddingEnabled) {
    throw new EmbeddingsUnavailable("OPENAI_EMBEDDING_API_KEY not set");
  }
  if (isOffline() && !isLocalUrl(config.openaiEmbeddingBaseUrl)) {
    throw new EmbeddingsUnavailable("offline mode");
  }

  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const res = await fetch(`${config.openaiEmbeddingBaseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${config.openaiEmbeddingApiKey}`,
      },
      body: JSON.stringify({
        model: EMBEDDING_MODEL,
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
