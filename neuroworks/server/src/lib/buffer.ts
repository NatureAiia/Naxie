// Buffer "Public API" client — Buffer's NEW API is GraphQL at api.buffer.com
// (Bearer auth + content-type: application/json). The classic REST API
// (api.bufferapp.com/1) rejects these tokens ("Public API tokens are not
// accepted"), and graph.buffer.com bounces them ("Please use api.buffer.com").
// Schema (introspected 2026-07-28):
//   query    account { organizations { id } }
//   query    channels(input:{organizationId}) { id service name }
//   mutation createPost(input: CreatePostInput!) : PostActionPayload (union)
//     CreatePostInput: channelId!, assets:[Asset!]! ([] for text-only),
//       mode: ShareMode! (shareNow|addToQueue|customScheduled|shareNext),
//       schedulingType: SchedulingType! (automatic|notification),
//       text, dueAt (ISO, for customScheduled), saveToDraft.

const BUFFER_GQL = "https://api.buffer.com/";

export async function bufferGraphQL(token: string, query: string, variables?: Record<string, unknown>): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const r = await fetch(BUFFER_GQL, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ query, variables: variables ?? {} }),
      signal: ctrl.signal,
    });
    return await r.json().catch(() => ({}));
  } catch (e: any) {
    return { errors: [{ message: `network: ${String(e?.message ?? e).slice(0, 100)}` }] };
  } finally {
    clearTimeout(timer);
  }
}

// Is the token accepted? (account query authenticates). Returns email or null.
export async function bufferAccountEmail(token: string): Promise<string | null> {
  const j = await bufferGraphQL(token, `{ account { id email } }`);
  return j?.data?.account?.email ?? (j?.data?.account?.id ? "connected" : null);
}

export async function bufferOrgId(token: string): Promise<string | null> {
  const j = await bufferGraphQL(token, `{ account { organizations { id } } }`);
  return j?.data?.account?.organizations?.[0]?.id ?? null;
}

export type BufferChannel = { id: string; service: string; name: string };
export async function bufferChannels(token: string): Promise<BufferChannel[]> {
  const orgId = await bufferOrgId(token);
  if (!orgId) return [];
  const j = await bufferGraphQL(token, `query($input: ChannelsInput!){ channels(input:$input){ id service name } }`, { input: { organizationId: orgId } });
  return (j?.data?.channels ?? []).map((c: any) => ({ id: c.id, service: c.service, name: c.name }));
}

const CREATE_POST = `mutation($input: CreatePostInput!){
  createPost(input:$input){
    __typename
    ... on PostActionSuccess { post { id } }
    ... on InvalidInputError { message }
    ... on UnexpectedError { message }
    ... on LimitReachedError { message }
    ... on UnauthorizedError { message }
    ... on RestProxyError { message }
    ... on NotFoundError { message }
  }
}`;

// ─── Reading what we've posted (posts:read — GRANTED by the standard token) ───
// The self-improving social loop needs the real post record: what went out, when,
// to which channel, and its status. This is available under posts:read.
export type BufferSentPost = {
  id: string; status: string; text: string; service: string;
  dueAt?: string; sentAt?: string; createdAt?: string; via?: string;
};
export async function bufferSentPosts(token: string, opts: { first?: number } = {}): Promise<BufferSentPost[]> {
  const orgId = await bufferOrgId(token);
  if (!orgId) return [];
  const first = Math.min(100, Math.max(1, opts.first ?? 30));
  // NB: only SCALAR Post fields here. `error` is an object type — selecting it
  // as a scalar makes the whole query fail (data:null), so it's excluded.
  const j = await bufferGraphQL(token,
    `query($input: PostsInput!, $first: Int){ posts(input:$input, first:$first){ edges { node {
      id status text channelService dueAt sentAt createdAt via
    } } } }`,
    { input: { organizationId: orgId }, first });
  const edges = j?.data?.posts?.edges ?? [];
  return edges.map((e: any) => {
    const n = e.node ?? {};
    return {
      id: n.id, status: n.status, text: n.text ?? "", service: n.channelService ?? "",
      dueAt: n.dueAt ?? undefined, sentAt: n.sentAt ?? undefined, createdAt: n.createdAt ?? undefined,
      via: n.via ?? undefined,
    };
  });
}

// ─── Engagement metrics (insights:read — NOT in the standard token's scopes) ───
// aggregatedPostMetrics + per-post metrics both require the `insights:read` scope.
// The Buffer connection minted for posting only carries posts/account/ideas scopes,
// so this returns a structured { needsScope } signal today. The moment the operator
// reconnects Buffer granting insights:read, real metrics flow through unchanged.
export type BufferMetric = { name: string; value: number; unit?: string; type?: string };
export type BufferMetricsResult =
  | { ok: true; metricsUpdatedAt?: string; metrics: BufferMetric[] }
  | { ok: false; needsScope?: string; grantedScopes?: string[]; error: string };

export async function bufferAggregatedMetrics(token: string, opts: {
  channelIds: string[]; startDateTime: string; endDateTime: string;
}): Promise<BufferMetricsResult> {
  const orgId = await bufferOrgId(token);
  if (!orgId) return { ok: false, error: "could not resolve Buffer organization" };
  const j = await bufferGraphQL(token,
    `query($input: AggregatedPostMetricsInput!){ aggregatedPostMetrics(input:$input){
      metricsUpdatedAt metrics { name value unit type } } }`,
    { input: { organizationId: orgId, channelIds: opts.channelIds, startDateTime: opts.startDateTime, endDateTime: opts.endDateTime } });
  const err = j?.errors?.[0];
  if (err) {
    const ext = err.extensions ?? {};
    if (ext.code === "INSUFFICIENT_SCOPE") {
      return { ok: false, needsScope: (ext.requiredScopes ?? ["insights:read"]).join(","), grantedScopes: ext.grantedScopes, error: err.message };
    }
    return { ok: false, error: String(err.message).slice(0, 200) };
  }
  const agg = j?.data?.aggregatedPostMetrics;
  return { ok: true, metricsUpdatedAt: agg?.metricsUpdatedAt, metrics: agg?.metrics ?? [] };
}

// Create one post on one channel. mode: "addToQueue" (default — Buffer slots it
// into the channel's schedule), "customScheduled" (+dueAt ISO), "shareNow", or
// draft via saveToDraft. A videoUrl attaches as a video asset — required for
// video-only channels like TikTok. Returns the post id or an error string.
export async function bufferCreatePost(token: string, opts: {
  channelId: string; text: string; mode?: string; dueAt?: string; saveToDraft?: boolean;
  videoUrl?: string; thumbnailUrl?: string; imageUrl?: string;
}): Promise<{ ok: boolean; postId?: string; error?: string }> {
  // Buffer AssetInput is a union: { video:{url} } | { image:{url} }.
  // NB: do NOT send a custom video thumbnailUrl — Buffer rejects it ("social
  // networks do not accept custom video thumbnail images"; a thumbnail is picked
  // via metadata.thumbnailOffset instead). So a supplied thumbnail is used only
  // in the review message, never on the Buffer asset (live 2026-07-28).
  const assets: unknown[] = [];
  if (opts.videoUrl) assets.push({ video: { url: opts.videoUrl } });
  else if (opts.imageUrl) assets.push({ image: { url: opts.imageUrl } });
  const input: Record<string, unknown> = {
    channelId: opts.channelId,
    text: opts.text,
    assets,
    mode: opts.dueAt ? "customScheduled" : (opts.mode ?? "addToQueue"),
    schedulingType: "automatic",
  };
  if (opts.dueAt) input.dueAt = opts.dueAt;
  if (opts.saveToDraft) input.saveToDraft = true;
  const j = await bufferGraphQL(token, CREATE_POST, { input });
  const cp = j?.data?.createPost;
  if (cp?.__typename === "PostActionSuccess") return { ok: true, postId: cp.post?.id };
  return { ok: false, error: cp?.message ?? j?.errors?.[0]?.message ?? "createPost failed" };
}
