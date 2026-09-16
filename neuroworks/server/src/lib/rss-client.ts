// Lightweight RSS/Atom fetch+parse — a verified-URL supplement to
// innovation-scan.ts's LLM-driven broad news pass. No xml parser is a
// dependency of this package (see package.json); this mirrors web-client.ts's
// own approach to a foreign markup format (extractReadable's regex-based HTML
// extraction) rather than pulling one in for what's a handful of well-known
// feed shapes.
import { fetchWeb } from "./web-client.js";

export type CuratedRssItem = { title: string; url: string; source: string; publishedAt: string };

type FeedSpec = { url: string; label: string };

// High-signal, keyless feeds for the AI/tech-industry domain this scan
// already watches (see BROAD_REPO_QUERIES / BROAD_NEWS_QUERIES in
// innovation-scan.ts) — model labs, arXiv categories, dev platforms, and
// major tech press. Every URL below was fetched and confirmed to return a
// well-formed RSS/Atom document on 2026-09-15.
const CURATED_FEEDS: FeedSpec[] = [
  { url: "https://export.arxiv.org/rss/cs.AI", label: "arXiv cs.AI" },
  { url: "https://export.arxiv.org/rss/cs.CL", label: "arXiv cs.CL" },
  { url: "https://export.arxiv.org/rss/cs.LG", label: "arXiv cs.LG" },
  { url: "https://openai.com/news/rss.xml", label: "OpenAI News" },
  { url: "https://blog.google/technology/ai/rss/", label: "Google AI Blog" },
  { url: "https://www.deepmind.com/blog/rss.xml", label: "Google DeepMind Blog" },
  { url: "https://huggingface.co/blog/feed.xml", label: "Hugging Face Blog" },
  { url: "https://www.microsoft.com/en-us/research/feed/", label: "Microsoft Research Blog" },
  { url: "https://aws.amazon.com/blogs/machine-learning/feed/", label: "AWS Machine Learning Blog" },
  { url: "https://blogs.nvidia.com/feed/", label: "NVIDIA Blog" },
  { url: "https://github.blog/feed/", label: "GitHub Blog" },
  { url: "https://simonwillison.net/atom/everything/", label: "Simon Willison" },
  { url: "https://www.technologyreview.com/feed/", label: "MIT Technology Review" },
  { url: "https://techcrunch.com/category/artificial-intelligence/feed/", label: "TechCrunch AI" },
  { url: "https://www.theverge.com/rss/index.xml", label: "The Verge" },
  { url: "https://arstechnica.com/feed/", label: "Ars Technica" },
  { url: "https://www.wired.com/feed/tag/ai/latest/rss", label: "Wired AI" },
  { url: "https://www.theregister.com/software/ai_ml/headlines.atom", label: "The Register AI/ML" },
];

const FETCH_TIMEOUT_MS = 6_000;
const MAX_ITEMS_PER_FEED = 8;
const WINDOW_HOURS = 48;

function decodeXmlText(raw: string): string {
  const cdata = raw.match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
  const inner = cdata ? cdata[1] : raw;
  return inner
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, " ")
    .trim();
}

function extractTagText(block: string, tag: string): string | null {
  const m = block.match(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/${tag}>`, "i"));
  return m ? decodeXmlText(m[1]) : null;
}

// RSS gives the link as text content: <link>URL</link>. Atom gives it as an
// attribute on a self-closing tag, and an entry can carry several
// (rel="self", rel="alternate", ...) — the alternate (or first href-bearing,
// lacking that) is the article URL.
function extractItemLink(block: string): string | null {
  let fallbackHref: string | null = null;
  for (const m of block.matchAll(/<link\b([^>]*)>/gi)) {
    const hrefM = m[1].match(/href=["']([^"']+)["']/i);
    if (!hrefM) continue;
    const relM = m[1].match(/rel=["']([^"']+)["']/i);
    if (!relM || relM[1].toLowerCase() === "alternate") return hrefM[1];
    fallbackHref = fallbackHref ?? hrefM[1];
  }
  const rssLink = extractTagText(block, "link");
  if (rssLink && /^https?:\/\//i.test(rssLink)) return rssLink;
  return fallbackHref;
}

function parseFeedItems(xml: string): { title: string; url: string; publishedAt: string | null }[] {
  const blocks = xml.match(/<item\b[\s\S]*?<\/item>|<entry\b[\s\S]*?<\/entry>/gi) ?? [];
  const out: { title: string; url: string; publishedAt: string | null }[] = [];
  for (const block of blocks.slice(0, MAX_ITEMS_PER_FEED)) {
    const title = extractTagText(block, "title");
    const url = extractItemLink(block);
    if (!title || !url) continue;
    const publishedAt = extractTagText(block, "pubDate") ?? extractTagText(block, "published") ?? extractTagText(block, "updated");
    out.push({ title, url, publishedAt });
  }
  return out;
}

async function fetchOneFeed(feed: FeedSpec, cutoffMs: number): Promise<CuratedRssItem[]> {
  try {
    const r = await fetchWeb(feed.url, { timeoutMs: FETCH_TIMEOUT_MS, maxBytes: 250_000 });
    if (r.status < 200 || r.status >= 300) return [];
    const items: CuratedRssItem[] = [];
    for (const it of parseFeedItems(r.text)) {
      const ts = it.publishedAt ? Date.parse(it.publishedAt) : NaN;
      if (!Number.isFinite(ts) || ts < cutoffMs) continue; // undated or stale — can't vouch for recency
      items.push({ title: it.title, url: it.url, source: feed.label, publishedAt: new Date(ts).toISOString() });
    }
    return items;
  } catch {
    return [];
  }
}

// Verified-URL supplement to the LLM-driven broad news pass — every
// title/url here is exactly what the feed published, never LLM-touched, so
// it's a hallucination-free cross-check even when the search-driven news
// findings are thin. Dedup by URL (a story often runs on more than one feed).
export async function fetchCuratedRss(): Promise<CuratedRssItem[]> {
  const cutoffMs = Date.now() - WINDOW_HOURS * 3_600_000;
  const perFeed = await Promise.all(CURATED_FEEDS.map(f => fetchOneFeed(f, cutoffMs)));
  const seen = new Set<string>();
  const out: CuratedRssItem[] = [];
  for (const list of perFeed) {
    for (const item of list) {
      if (seen.has(item.url)) continue;
      seen.add(item.url);
      out.push(item);
    }
  }
  out.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
  return out;
}
