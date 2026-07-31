// Social-media bridge — one Ayrshare key fans a post out to X/Twitter,
// LinkedIn, Facebook, Instagram, etc., and reads back history/analytics/
// comments. Ayrshare is an OpenAI-of-social aggregator: a single Bearer key,
// one /post endpoint, per-platform routing via the `platforms` array.
//
// Trust model: PUBLISHING is outward-facing and hard to reverse, so social.post
// / social.reply route through the sensitive-action APPROVAL gate (see
// SENSITIVE_APPROVAL_TOOLS in agent.ts) — the agent drafts, the operator signs
// off, then it goes live. READS (history/analytics/comments) are free.
//
// Config (env):
//   AYRSHARE_API_KEY     the Ayrshare Business/Basic key (Bearer)
//   AYRSHARE_BASE_URL    override (default https://api.ayrshare.com/api)

const AYRSHARE_BASE = (process.env.AYRSHARE_BASE_URL ?? "https://api.ayrshare.com/api").replace(/\/+$/, "");

export function socialConfigured(): boolean {
  return (process.env.AYRSHARE_API_KEY ?? "").trim().length > 0;
}

// Platforms Ayrshare accepts in the `platforms` array. We validate against this
// so a typo ("tweet") returns a clear error instead of a silent no-post.
const KNOWN_PLATFORMS = new Set([
  "twitter", "facebook", "instagram", "linkedin", "tiktok",
  "youtube", "pinterest", "reddit", "telegram", "gmb", "bluesky", "threads",
  "snapchat",
]);

function normalizePlatforms(input: unknown): string[] {
  const raw = Array.isArray(input)
    ? input.map(String)
    : String(input ?? "").split(/[,\s]+/);
  const mapped = raw
    .map(p => p.trim().toLowerCase())
    .filter(Boolean)
    .map(p => (p === "x" || p === "tweet" || p === "tweets" ? "twitter" : p === "fb" ? "facebook" : p === "ig" ? "instagram" : p === "li" ? "linkedin" : p));
  return [...new Set(mapped)];
}

async function ayr(path: string, method: "GET" | "POST", body?: unknown): Promise<any> {
  const key = (process.env.AYRSHARE_API_KEY ?? "").trim();
  if (!key) throw new Error("social not configured — set AYRSHARE_API_KEY in clawbot/.env (one key covers X, LinkedIn, Facebook, Instagram, …). Get it from ayrshare.com.");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30_000);
  try {
    const r = await fetch(`${AYRSHARE_BASE}${path}`, {
      method,
      headers: { "Authorization": `Bearer ${key}`, "Content-Type": "application/json" },
      body: body != null ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    const text = await r.text();
    let json: any;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!r.ok) {
      const msg = json?.message ?? json?.error ?? `HTTP ${r.status}`;
      throw new Error(`Ayrshare ${r.status}: ${String(msg).slice(0, 300)}`);
    }
    return json;
  } catch (e: any) {
    if (ctrl.signal.aborted) throw new Error("Ayrshare request timed out (30s)");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Publish a post to one or more platforms. APPROVAL-GATED upstream.
export async function socialPost(args: { post: string; platforms: unknown; mediaUrls?: unknown }): Promise<any> {
  const post = String(args.post ?? "").trim();
  if (!post) throw new Error("social.post: `post` (the text) is required");
  const platforms = normalizePlatforms(args.platforms);
  if (platforms.length === 0) throw new Error("social.post: `platforms` is required — e.g. [\"twitter\",\"linkedin\"]");
  const bad = platforms.filter(p => !KNOWN_PLATFORMS.has(p));
  if (bad.length) throw new Error(`social.post: unknown platform(s) ${bad.join(", ")}. Known: ${[...KNOWN_PLATFORMS].join(", ")}`);
  const mediaUrls = args.mediaUrls
    ? (Array.isArray(args.mediaUrls) ? args.mediaUrls.map(String) : [String(args.mediaUrls)]).filter(Boolean)
    : undefined;
  const body: Record<string, unknown> = { post, platforms };
  if (mediaUrls?.length) body.mediaUrls = mediaUrls;
  const res = await ayr("/post", "POST", body);
  // Normalise the useful bits for the synth: which platforms went live + links.
  const posts = Array.isArray(res?.postIds) ? res.postIds.map((p: any) => ({ platform: p.platform, id: p.id, url: p.postUrl })) : [];
  return { status: res?.status ?? "unknown", platforms, posts, errors: res?.errors ?? [], raw: undefined };
}

// The connected social system here is Buffer, not Ayrshare — so when Ayrshare
// isn't configured, the social READ tools fall back to Buffer instead of an
// instant "not configured" throw (the 0s failures the harness flagged). Returns
// null when Buffer isn't connected either, so the caller emits the clear config
// message rather than a fallback.
async function bufferTokenOrNull(): Promise<string | null> {
  const { getConnectionByProvider } = await import("./integrations.js");
  const t = (getConnectionByProvider("buffer")?.secrets?.accessToken ?? "").trim();
  return t || null;
}

// Recent post history + delivery status.
export async function socialHistory(args: { limit?: number }): Promise<any> {
  const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
  if (!socialConfigured()) {
    const token = await bufferTokenOrNull();
    if (!token) throw new Error("social history unavailable — set AYRSHARE_API_KEY, or connect Buffer on the Integrations page.");
    const { bufferSentPosts } = await import("./buffer.js");
    const posts = await bufferSentPosts(token, { first: limit });
    return {
      source: "buffer",
      count: posts.length,
      history: posts.map(p => ({ platform: p.service, status: p.status, text: p.text, date: p.sentAt ?? p.dueAt ?? p.createdAt, id: p.id })),
    };
  }
  const res = await ayr(`/history?lastRecords=${limit}`, "GET");
  const items = Array.isArray(res) ? res : (res?.history ?? res?.posts ?? []);
  return { source: "ayrshare", count: Array.isArray(items) ? items.length : 0, history: items };
}

// Analytics for a published post. Ayrshare works per-post by its id; Buffer only
// exposes AGGREGATED metrics (and gated behind insights:read), so the Buffer
// fallback returns the aggregate for a recent window with a clear note.
export async function socialAnalytics(args: { id?: string; platforms?: unknown }): Promise<any> {
  if (!socialConfigured()) {
    const token = await bufferTokenOrNull();
    if (!token) throw new Error("social analytics unavailable — set AYRSHARE_API_KEY, or connect Buffer on the Integrations page.");
    const { bufferChannels, bufferAggregatedMetrics } = await import("./buffer.js");
    const chans = await bufferChannels(token);
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400_000);
    const r = await bufferAggregatedMetrics(token, { channelIds: chans.map(c => c.id), startDateTime: start.toISOString(), endDateTime: end.toISOString() });
    return { source: "buffer", note: "Ayrshare not configured — returning Buffer aggregated metrics (last 30 days) instead of per-post analytics.", ...r };
  }
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("social.analytics: `id` (an Ayrshare post id from social.history/social.post) is required");
  const platforms = normalizePlatforms(args.platforms);
  return await ayr("/analytics/post", "POST", { id, ...(platforms.length ? { platforms } : {}) });
}

// Read comments/mentions on a published post.
export async function socialComments(args: { id?: string }): Promise<any> {
  const id = String(args.id ?? "").trim();
  if (!id) throw new Error("social.comments: `id` (an Ayrshare post id) is required");
  const res = await ayr(`/comments/${encodeURIComponent(id)}`, "GET");
  const comments = Array.isArray(res) ? res : (res?.comments ?? []);
  return { id, count: Array.isArray(comments) ? comments.length : 0, comments };
}
