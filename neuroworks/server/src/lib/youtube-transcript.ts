// Fetch a YouTube video's caption track without an API key — the same
// technique the `youtube-transcript` npm package uses: scrape the watch
// page for the caption-track list embedded in its player config, then fetch
// the chosen track's timedtext XML directly. No key, no quota, best-effort
// (fails cleanly with a real error when a video has captions disabled).

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

export type YoutubeTranscript = {
  videoId: string;
  languageCode: string;
  text: string;
  segments: number;
};

export function extractYoutubeVideoId(input: string): string | null {
  const trimmed = input.trim();
  if (/^[\w-]{11}$/.test(trimmed)) return trimmed; // bare video id
  try {
    const u = new URL(trimmed);
    if (u.hostname === "youtu.be") return u.pathname.slice(1) || null;
    if (u.hostname.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      const shorts = u.pathname.match(/\/shorts\/([\w-]{11})/);
      if (shorts) return shorts[1];
      const embed = u.pathname.match(/\/embed\/([\w-]{11})/);
      if (embed) return embed[1];
    }
  } catch { /* not a URL — fall through */ }
  return null;
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"").replace(/&#39;/g, "'").replace(/&nbsp;/g, " ");
}

export async function fetchYoutubeTranscript(urlOrId: string, preferredLang = "en"): Promise<YoutubeTranscript> {
  const videoId = extractYoutubeVideoId(urlOrId);
  if (!videoId) throw new Error(`could not extract a YouTube video id from "${urlOrId}"`);

  const pageResp = await fetch(`https://www.youtube.com/watch?v=${videoId}`, {
    headers: { "User-Agent": UA, "Accept-Language": "en-US,en;q=0.9" },
  });
  if (!pageResp.ok) throw new Error(`YouTube watch page returned ${pageResp.status}`);
  const html = await pageResp.text();

  const m = html.match(/"captionTracks":(\[[^\]]*\])/);
  if (!m) throw new Error("no captions available for this video (captions may be disabled, or the video is age/region-restricted)");
  let tracks: { baseUrl: string; languageCode: string; kind?: string }[];
  try { tracks = JSON.parse(m[1].replace(/\\u0026/g, "&")); }
  catch { throw new Error("could not parse the caption track list"); }
  if (tracks.length === 0) throw new Error("no caption tracks found for this video");

  // YouTube's captionTracks array can include a long tail of auto-translate
  // targets sharing most of the same base timedtext URL (only a trailing
  // &tlang= differs) — several can legitimately 404 or return an empty body
  // for a given video. Rank candidates by preference and try each in turn
  // instead of committing to the first match.
  const ranked = [...tracks].sort((a, b) => {
    const score = (t: typeof a) =>
      (t.languageCode === preferredLang ? 100 : 0) +
      (t.languageCode?.startsWith(preferredLang) ? 50 : 0) +
      (t.kind !== "asr" ? 10 : 0);
    return score(b) - score(a);
  });

  let lastError = "caption track was empty";
  for (const track of ranked.slice(0, 5)) {
    try {
      const capResp = await fetch(track.baseUrl.replace(/\\u0026/g, "&"), { headers: { "User-Agent": UA } });
      if (!capResp.ok) { lastError = `caption track fetch returned ${capResp.status}`; continue; }
      const xml = await capResp.text();
      const lines = [...xml.matchAll(/<text[^>]*>([\s\S]*?)<\/text>/g)].map(x => decodeHtmlEntities(x[1]).trim()).filter(Boolean);
      if (lines.length === 0) continue;
      return {
        videoId,
        languageCode: track.languageCode,
        text: lines.join(" ").replace(/\s+/g, " ").trim(),
        segments: lines.length,
      };
    } catch (e: any) { lastError = e?.message ?? String(e); }
  }
  throw new Error(lastError);
}
