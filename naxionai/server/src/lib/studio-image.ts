// Studio text-to-image — the generative lane the rest of the stack can't do
// (Ollama is text-only). Preferred path is OpenRouter (Gemini flash image),
// which rides the existing OpenRouter key.
//
// Optional hosted providers, all env-gated (no key → the capability isn't
// offered, zero behaviour change):
//   Ideogram (config.ideogramEnabled) — best-in-class typography/design/poster
//     work, structured-JSON prompting. Auth header is "Api-Key" (NOT Bearer).
//     One synchronous call returns image URLs; we download the first to disk.
//   Muapi (config.muapiEnabled) — one key fronting a whole catalog (nano-banana,
//     flux, seedream, imagen, …; see lib/studio-models.ts). Async: submit →
//     poll a request id → download the result.
//
// Output lands in .naxion/media as a .png and the handler returns
// { path, bytes, provider, model } — same shape / vault-adjacent location as
// minimaxTts, so the existing "attach the generated file" plumbing just works.

import { existsSync, mkdirSync, writeFileSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { resolve, join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { config } from "../config.js";
import { isOffline, OfflineError } from "./offline-mode.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const MEDIA_DIR = resolve(__dirname, "../../../.naxion/media");

function ensureMediaDir(): string {
  if (!existsSync(MEDIA_DIR)) mkdirSync(MEDIA_DIR, { recursive: true });
  return MEDIA_DIR;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export type ImageProvider = "ideogram" | "muapi" | "openrouter";
export type StudioImageResult = { path: string; bytes: number; provider: ImageProvider; model: string; sourceUrl?: string; downloadUrl?: string; filename?: string };
export type StudioImageOptions = {
  provider?: ImageProvider;      // explicit override; else config.studioImageProvider / auto
  model?: string;                // muapi/openrouter model id (ignored by ideogram)
  aspectRatio?: string;          // "1:1" | "16:9" | …
  timeoutMs?: number;
};

// Which providers are actually usable right now (key present). Checked LIVE so
// an OpenRouter provider applied at runtime counts immediately.
export function availableImageProviders(): ImageProvider[] {
  const out: ImageProvider[] = [];
  if (config.ideogramEnabled) out.push("ideogram");
  if (config.muapiEnabled) out.push("muapi");
  if (config.openrouterEnabled && config.openrouterApiKey) out.push("openrouter");
  return out;
}

// Resolve the provider to use: explicit arg → config pin → auto. Auto order
// prefers OpenRouter (Gemini flash image / "nano-banana") — the standard image
// path that rides the existing OpenRouter key, no separate signup — then falls
// back to Ideogram / Muapi if those keys are set and OpenRouter isn't.
function resolveProvider(requested?: ImageProvider): ImageProvider | null {
  const available = availableImageProviders();
  if (available.length === 0) return null;
  if (requested && available.includes(requested)) return requested;
  const pin = config.studioImageProvider as ImageProvider;
  if ((pin === "ideogram" || pin === "muapi" || pin === "openrouter") && available.includes(pin)) return pin;
  // Auto preference: OpenRouter first (Gemini flash), else whatever is available.
  if (available.includes("openrouter")) return "openrouter";
  return available[0];
}

// Cap on retained generated images — prevents .naxion/media from growing
// without bound as agents produce visuals. Oldest are pruned on write.
const MAX_RETAINED_IMAGES = Number(process.env.NW_MEDIA_MAX_IMAGES ?? "500") || 500;

// Persist raw image bytes; return path/bytes/filename so a download URL can be built.
function saveImageBytes(buf: Buffer, tag: string): { path: string; bytes: number; filename: string } {
  const dir = ensureMediaDir();
  // Random suffix (not just Date.now()) so a filename can't be enumerated by
  // guessing the generation timestamp — the /api/media route has no per-user
  // ownership check, so an unguessable name is what prevents one user pulling
  // another's generated image in a shared/enterprise deployment.
  const filename = `image-${tag}-${Date.now()}-${randomUUID().slice(0, 12)}.png`;
  const path = join(dir, filename);
  writeFileSync(path, buf);
  pruneOldImages(dir);
  return { path, bytes: buf.length, filename };
}

// Keep only the newest MAX_RETAINED_IMAGES image-*.png files. Best-effort and
// image-only (never touches tts/video/music artifacts sharing the dir).
function pruneOldImages(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter(f => f.startsWith("image-") && f.endsWith(".png"))
      .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const { f } of files.slice(MAX_RETAINED_IMAGES)) {
      try { unlinkSync(join(dir, f)); } catch { /* tolerate */ }
    }
  } catch { /* pruning is best-effort */ }
}

// The studio's own artifact catalog — newest generated images first. This is
// what "send me the last 3 images we generated" resolves against: generated
// media lives in .naxion/media, NOT the vault and NOT the user's folders,
// so vault.search / fs.find_in can't find it (an agent searching there
// honestly reports "no such files" — caught live 2026-07-19).
export function listGeneratedImages(count = 10): { filename: string; path: string; bytes: number; createdAt: string; downloadUrl: string }[] {
  const dir = ensureMediaDir();
  try {
    return readdirSync(dir)
      .filter(f => f.startsWith("image-") && f.endsWith(".png"))
      .map(f => {
        const full = join(dir, f);
        const st = statSync(full);
        return { filename: f, path: full, bytes: st.size, createdAt: new Date(st.mtimeMs).toISOString(), downloadUrl: mediaDownloadUrl(f) };
      })
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, Math.max(1, Math.min(50, count)));
  } catch { return []; }
}

// Download a remote image (Ideogram/Muapi return URLs) into the media dir.
// SSRF guard: a compromised or misbehaving provider must not be able to hand
// back an internal/loopback URL that we then fetch server-side. Reuses the
// shared public-URL assertion the browser/firecrawl tools use.
async function downloadToMedia(url: string, tag: string): Promise<{ path: string; bytes: number; filename: string }> {
  const { assertSafePublicUrlAsync } = await import("./security-gates.js");
  await assertSafePublicUrlAsync(url);
  const res = await fetch(url, { redirect: "manual" });
  if (res.status >= 300 && res.status < 400) throw new Error(`image download blocked: provider returned a redirect (${res.status})`);
  if (!res.ok) throw new Error(`image download ${res.status} from ${url.slice(0, 80)}`);
  return saveImageBytes(Buffer.from(await res.arrayBuffer()), tag);
}

// ── Ideogram ───────────────────────────────────────────────────────────
// POST {base}/v1/{model}/generate  (model defaults to ideogram-v4). The v3/v4
// API takes a multipart or JSON body; JSON is simplest. Response carries
// data[].url. Header auth is "Api-Key".
async function ideogramGenerate(prompt: string, opts: StudioImageOptions): Promise<StudioImageResult> {
  const model = config.ideogramModel || "ideogram-v4";
  const url = `${config.ideogramBaseUrl}/v1/${model}/generate`;
  const body = {
    prompt,
    ...(opts.aspectRatio ? { aspect_ratio: opts.aspectRatio.replace(":", "x") } : {}),
    rendering_speed: "DEFAULT",
    num_images: 1,
  };
  const res = await fetch(url, {
    method: "POST",
    headers: { "Api-Key": config.ideogramApiKey, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Ideogram ${res.status}: ${txt.slice(0, 300)}`);
  let parsed: any;
  try { parsed = JSON.parse(txt); } catch { throw new Error(`Ideogram returned non-JSON: ${txt.slice(0, 200)}`); }
  const imgUrl = parsed?.data?.[0]?.url ?? parsed?.images?.[0]?.url;
  if (!imgUrl) throw new Error(`Ideogram returned no image url: ${txt.slice(0, 200)}`);
  const { path, bytes, filename } = await downloadToMedia(imgUrl, "ideogram");
  return { path, bytes, filename, provider: "ideogram", model, sourceUrl: imgUrl };
}

// ── OpenRouter (free path, existing key) ─────────────────────────────────
// Image generation over the OpenAI-compatible chat/completions endpoint with
// modalities:["image","text"] and an image-output model (default Gemini flash
// image / "nano-banana"). The image comes back inline as a data: URL in
// choices[0].message.images[].image_url.url — decode the base64 to disk. Uses
// the SAME key/base the text router uses (config.openrouter*), so no new key.
async function openrouterGenerate(prompt: string, opts: StudioImageOptions): Promise<StudioImageResult> {
  const model = opts.model || config.openrouterImageModel;
  const url = `${config.openrouterBaseUrl}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 180_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.openrouterApiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.openrouterAppUrl,
        "X-Title": config.openrouterAppName,
      },
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: opts.aspectRatio ? `${prompt}\n\n(aspect ratio ${opts.aspectRatio})` : prompt }],
        modalities: ["image", "text"],
      }),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  const txt = await res.text();
  if (!res.ok) throw new Error(`OpenRouter image ${res.status}: ${txt.slice(0, 300)}`);
  let parsed: any;
  try { parsed = JSON.parse(txt); } catch { throw new Error(`OpenRouter returned non-JSON: ${txt.slice(0, 200)}`); }
  const msg = parsed?.choices?.[0]?.message ?? {};
  const dataUrl: string | undefined = msg?.images?.[0]?.image_url?.url ?? msg?.images?.[0]?.url;
  if (!dataUrl) {
    const note = typeof msg?.content === "string" ? msg.content.slice(0, 150) : "";
    throw new Error(`OpenRouter model "${model}" returned no image${note ? ` (said: ${note})` : ""} — set OPENROUTER_IMAGE_MODEL to an image-output model`);
  }
  // data:image/png;base64,XXXX  → bytes. (Also accept a plain http(s) url.)
  let buf: Buffer;
  if (dataUrl.startsWith("data:")) {
    const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    buf = Buffer.from(b64, "base64");
  } else {
    const dl = await fetch(dataUrl);
    if (!dl.ok) throw new Error(`OpenRouter image url fetch ${dl.status}`);
    buf = Buffer.from(await dl.arrayBuffer());
  }
  const { path, bytes, filename } = saveImageBytes(buf, "openrouter");
  return { path, bytes, filename, provider: "openrouter", model };
}

// ── Muapi ──────────────────────────────────────────────────────────────
// POST {base}/api/v1/{endpoint} with { prompt, aspect_ratio? } and header
// x-api-key. Muapi is async for most models: the submit response carries a
// request_id; poll {base}/api/v1/predictions/{id}/result until status is
// completed, then read the output image url. A few models answer synchronously
// (output present on submit) — handle both.
async function muapiGenerate(prompt: string, opts: StudioImageOptions): Promise<StudioImageResult> {
  const { findStudioModel } = await import("./studio-models.js");
  const modelId = opts.model || "nano-banana";
  const model = findStudioModel(modelId);
  const endpoint = model?.endpoint ?? modelId;
  const submitUrl = `${config.muapiBaseUrl}/api/v1/${endpoint}`;
  const headers = { "x-api-key": config.muapiApiKey, "Content-Type": "application/json" };
  const payload: Record<string, unknown> = { prompt };
  if (opts.aspectRatio) payload.aspect_ratio = opts.aspectRatio;

  const res = await fetch(submitUrl, { method: "POST", headers, body: JSON.stringify(payload) });
  const txt = await res.text();
  if (!res.ok) throw new Error(`Muapi ${endpoint} ${res.status}: ${txt.slice(0, 300)}`);
  let sub: any;
  try { sub = JSON.parse(txt); } catch { throw new Error(`Muapi returned non-JSON: ${txt.slice(0, 200)}`); }

  const pickUrl = (o: any): string | undefined =>
    o?.outputs?.[0]?.url ?? o?.output?.[0]?.url ?? o?.output?.url ?? o?.images?.[0]?.url ?? o?.image_url ?? o?.result?.[0]?.url;

  let imgUrl = pickUrl(sub);
  const reqId = sub?.request_id ?? sub?.id ?? sub?.data?.request_id;
  if (!imgUrl && reqId) {
    const deadline = Date.now() + (opts.timeoutMs ?? 5 * 60_000);
    const resultUrl = `${config.muapiBaseUrl}/api/v1/predictions/${reqId}/result`;
    while (Date.now() < deadline) {
      await sleep(3000);
      const pr = await fetch(resultUrl, { headers }).catch(() => null);
      if (!pr || !pr.ok) continue;
      const pj: any = await pr.json().catch(() => ({}));
      const status = String(pj?.status ?? "").toLowerCase();
      imgUrl = pickUrl(pj);
      if (imgUrl) break;
      if (status === "failed" || status === "error") throw new Error(`Muapi ${endpoint} failed: ${JSON.stringify(pj).slice(0, 200)}`);
    }
  }
  if (!imgUrl) throw new Error(`Muapi ${endpoint} returned no image (timed out or unexpected shape)`);
  const { path, bytes, filename } = await downloadToMedia(imgUrl, endpoint);
  return { path, bytes, filename, provider: "muapi", model: endpoint, sourceUrl: imgUrl };
}

// Public entry — generate one image, saved to disk. Attaches a downloadUrl
// (served by GET /api/media/<filename>) so the UI/email can offer a real
// download, not just a disk path. Throws a clear error when no provider is
// configured (the primitive turns that into a friendly message).
export async function generateStudioImage(prompt: string, opts: StudioImageOptions = {}): Promise<StudioImageResult> {
  if (!prompt.trim()) throw new Error("studio-image: prompt is required");
  // All image providers are cloud (Ideogram / Muapi / OpenRouter) — Ollama
  // is text-only. Fail fast with a clear message instead of letting the
  // fetch hit the offline guard mid-flight.
  if (isOffline()) throw new OfflineError("image provider (offline mode — Naxie uses local models only)");
  const provider = resolveProvider(opts.provider);
  if (!provider) {
    throw new Error("no image provider configured — image generation needs IDEOGRAM_API_KEY or MUAPI_API_KEY, or an active OpenRouter provider (Integrations)");
  }
  const result = provider === "ideogram" ? await ideogramGenerate(prompt, opts)
    : provider === "muapi" ? await muapiGenerate(prompt, opts)
    : await openrouterGenerate(prompt, opts);
  if (result.filename) result.downloadUrl = mediaDownloadUrl(result.filename);
  // Record the generation in the Cost monitor (per-image pricing). Best-effort:
  // never fail a produced image because cost logging hiccuped.
  try {
    const { recordImageCost } = await import("./cost-tracker.js");
    recordImageCost(result.provider, result.model);
  } catch { /* cost tracking is best-effort */ }
  return result;
}

// Build the loopback download URL for a generated media file. The GET
// /api/media route (index.ts) serves the media dir with a traversal guard.
export function mediaDownloadUrl(filename: string): string {
  return `http://127.0.0.1:${config.port}/api/media/${encodeURIComponent(filename)}`;
}

export function studioImageHealth(): { enabled: boolean; providers: ImageProvider[]; defaultProvider: ImageProvider | null } {
  const providers = availableImageProviders();
  return { enabled: providers.length > 0, providers, defaultProvider: resolveProvider() };
}
