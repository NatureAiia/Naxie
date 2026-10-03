import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { addPersona, updatePersona, loadPersonas, type Persona } from "./personas.js";
import { writeVaultFile, readVaultFile } from "./vault.js";

// Brand registry — the marketing feature's first-class "which voice/audience/
// channel am I speaking for" concept. Seeded with the 3 brands the operator
// runs: personal, work, and business — voice/audience/values are filled in
// on the Brands page.
//
// Persisted under .naxion/brands.json (gitignored), same pattern as
// custom-departments.ts. A brand does NOT require a department — it links to
// one or more Persona ids directly (see seedDefaultBrands / createBrand),
// which is lighter than the full department/workflow machinery for "one
// voice, one calendar, one set of channels."

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const STORE = resolve(CONFIG_DIR, "brands.json");

export type BrandChannel = {
  provider: "buffer" | "social" | string;
  connectionLabel: string;
  platforms?: string[];
};

export type Brand = {
  id: string;
  name: string;
  tagline: string;
  voice: string;
  audience: string;
  values: string;
  guidelinesVaultPath?: string;
  personaIds: string[];
  channels: BrandChannel[];
  calendarCadence?: string;
  color: string;
  icon: string;
  createdAt: string;
  // Phase 2 (brand-signals.ts) — terms this brand's mention-monitoring scan
  // searches for. Absent/empty = the brand hasn't set up monitoring yet;
  // runBrandSignalScan refuses to run with an empty watch list (mirrors
  // MAIA's "refuses if the watch list is empty" design).
  watchTerms?: string[];
  // Phase 2 — per-brand reputation-risk terms for the "critical" alert rule.
  // Absent/empty = falls back to brand-signals.ts's shared generic list, so a
  // brand doesn't have to configure this before monitoring is useful.
  riskTerms?: string[];
  // Phase 2 — this brand's own domain(s)/handle(s), used to score a hit as
  // "primary" (0.6) provenance instead of guessing from the brand's name.
  ownDomains?: string[];
};

function load(): Brand[] {
  try { if (existsSync(STORE)) return JSON.parse(readFileSync(STORE, "utf8")) as Brand[]; }
  catch { /* corrupt → empty */ }
  return [];
}
function save(list: Brand[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify(list, null, 2), { encoding: "utf8", mode: 0o600 });
}

// Exported so any caller that builds a vault path from a brandId (e.g. the
// buffer-story-post/social-optimize runners' per-brand subfolder) sanitizes
// it the same way — a brandId is sometimes free-typed (a Schedule's stored
// inputs, a template run) rather than looked up, so it must never be trusted
// as a raw path segment (no "../" traversal out of _naxion/social/).
export const slug = (s: string) => String(s).toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);

export function listBrands(): Brand[] {
  return load();
}

export function getBrand(id: string): Brand | undefined {
  return load().find(b => b.id === id);
}

export function createBrand(input: {
  id?: string; name: string; tagline?: string; voice?: string; audience?: string; values?: string;
  guidelinesVaultPath?: string; calendarCadence?: string; color?: string; icon?: string;
  channels?: BrandChannel[];
}): Brand {
  const list = load();
  const id = input.id ? slug(input.id) : slug(input.name);
  if (!id) throw new Error("brand needs a name");
  if (list.some(b => b.id === id)) throw new Error(`brand "${id}" already exists`);
  const brand: Brand = {
    id,
    name: input.name,
    tagline: input.tagline ?? "",
    voice: input.voice ?? "",
    audience: input.audience ?? "",
    values: input.values ?? "",
    guidelinesVaultPath: input.guidelinesVaultPath,
    personaIds: [],
    channels: input.channels ?? [],
    calendarCadence: input.calendarCadence,
    color: input.color ?? "violet",
    icon: input.icon ?? "megaphone",
    createdAt: new Date().toISOString(),
  };
  list.push(brand);
  save(list);
  return brand;
}

export function updateBrand(id: string, patch: Partial<Omit<Brand, "id" | "createdAt">>): Brand | null {
  const list = load();
  const b = list.find(x => x.id === id);
  if (!b) return null;
  Object.assign(b, patch);
  save(list);
  return b;
}

export function deleteBrand(id: string): boolean {
  const list = load();
  const next = list.filter(b => b.id !== id);
  if (next.length === list.length) return false;
  save(next);
  return true;
}

// Pick a brand's channel binding for a specific provider (e.g. "buffer") —
// NOT just channels[0], which silently ignores every channel but the first
// one bound (a real bug when a brand has both a Buffer and a Social channel).
export function channelFor(brand: Brand | undefined, provider: string): BrandChannel | undefined {
  return brand?.channels.find(c => c.provider === provider);
}

export function addBrandChannel(id: string, channel: BrandChannel): Brand | null {
  const b = getBrand(id);
  if (!b) return null;
  const channels = b.channels.filter(c => !(c.provider === channel.provider && c.connectionLabel === channel.connectionLabel));
  channels.push(channel);
  return updateBrand(id, { channels });
}

// Guidelines path for the work brand's voice doc in the vault.
const WORK_GUIDELINES_PATH = "_brands/work/voice-guidelines.md";
const SASHA_PERSONA_ID = "social-media-manager";

function ensureBrandPersona(brand: Brand, opts: { reuseSasha?: boolean }): string {
  if (opts.reuseSasha) {
    // work: repoint the EXISTING Sasha persona instead of
    // cloning, so its history/tone/job description isn't duplicated.
    updatePersona(SASHA_PERSONA_ID, { department: `brand-${brand.id}` });
    const existing = loadPersonas().personas.find(p => p.id === SASHA_PERSONA_ID);
    if (existing) return existing.id;
  }
  const id = `social-media-manager-${brand.id}`;
  const persona: Persona = {
    id,
    name: `${brand.name} Social Manager`,
    role: "Social Media Manager",
    description: `Owns ${brand.name}'s social channels — content calendar, drafting, publishing (with sign-off), and engagement monitoring.`,
    jobDescription: `Brand-scoped social media manager for ${brand.name}. Plans and drafts platform-native posts for this brand only, schedules a content calendar, publishes through the configured channel (every publish parks for approval before it goes live), and monitors mentions/comments/analytics to inform what to post next.`,
    tone: brand.voice || "on-brand · concise · engagement-aware",
    responsibilities: [
      `Draft platform-native posts and a content calendar for ${brand.name} only`,
      "Publish via social.post/buffer.post — always via the approval gate, never silently",
      "Monitor mentions/comments and flag what needs a reply",
      "Read post analytics and report what's working",
      `Never reference another brand's audience, offer, or voice — see the cross-brand-isolation skill`,
    ],
    systemPromptOverride:
      `You are the Social Media Manager for ${brand.name}.\n\n` +
      `Audience: ${brand.audience || "(not set yet — ask the operator before assuming one)"}\n` +
      `Voice: ${brand.voice || "(not set yet)"}\n` +
      (brand.values ? `\nValues:\n${brand.values}\n` : "") +
      `\nHow you operate:\n` +
      `- Platform-native: match length, tone, and hashtag/emoji norms per platform.\n` +
      `- PUBLISHING is outward-facing: it PARKS FOR APPROVAL before going live — present the draft clearly for sign-off, never bypass it.\n` +
      `- Never invent engagement numbers — pull real figures or say plainly that analytics aren't available.\n` +
      `- This persona speaks ONLY for ${brand.name} — never blend in another brand's voice, audience, or offers.`,
    department: `brand-${brand.id}`,
    createdAt: new Date().toISOString(),
  };
  addPersona(persona);
  return id;
}

// Idempotent — creates the 3 confirmed brands (personal / work=AIIA /
// business=Variety Vault) on first boot if brands.json doesn't exist yet.
// Safe to call on every server start (no-ops once brands.json exists).
export function seedDefaultBrands(): void {
  if (existsSync(STORE)) return;

  const personal = createBrand({
    id: "personal",
    name: "Personal",
    tagline: "Your personal brand",
    voice: "",
    audience: "",
    values: "",
    guidelinesVaultPath: "_brands/personal/voice-guidelines.md",
    color: "leaf",
    icon: "user",
  });
  try {
    if (!readVaultFile("_brands/personal/voice-guidelines.md")) throw new Error("empty");
  } catch {
    writeVaultFile("_brands/personal/voice-guidelines.md",
      `---\ntype: brand-guidelines\nbrand: personal\n---\n\n# Personal brand voice guidelines\n\n` +
      `_Fill this in — voice, audience, values, do's and don'ts. The Brands page and brand-voice skill read this file._\n`);
  }

  const work = createBrand({
    id: "work",
    name: "Work",
    tagline: "Work / professional",
    voice: "",
    audience: "",
    values: "",
    guidelinesVaultPath: WORK_GUIDELINES_PATH,
    color: "flame",
    icon: "briefcase",
  });
  try {
    if (!readVaultFile("_brands/work/voice-guidelines.md")) throw new Error("empty");
  } catch {
    writeVaultFile("_brands/work/voice-guidelines.md",
      `---\ntype: brand-guidelines\nbrand: work\n---\n\n# Work — brand voice guidelines\n\n` +
      `_Fill this in — voice, audience, values, do's and don'ts. The Brands page and brand-voice skill read this file._\n`);
  }
  // One-time migration: the work brand's pre-Brands strategy
  // note (routes/templates.ts's SOCIAL_DIR = "_naxion/social") moves into
  // the new brand-scoped subfolder rather than starting the "learning" loop
  // over. Existing drafts/ under the legacy root are left as historical
  // archive — only new drafts land under work/ going forward.
  try {
    const legacy = readVaultFile("_naxion/social/strategy.md");
    if (legacy && legacy.trim()) writeVaultFile("_naxion/social/work/strategy.md", legacy);
  } catch { /* no legacy strategy note — nothing to migrate */ }

  const business = createBrand({
    id: "business",
    name: "Variety Vault",
    tagline: "Variety & Co.",
    voice: "",
    audience: "",
    values: "",
    guidelinesVaultPath: "_brands/business/voice-guidelines.md",
    color: "coral",
    icon: "store",
  });
  try {
    if (!readVaultFile("_brands/business/voice-guidelines.md")) throw new Error("empty");
  } catch {
    writeVaultFile("_brands/business/voice-guidelines.md",
      `---\ntype: brand-guidelines\nbrand: business\n---\n\n# Variety Vault / Variety & Co. — brand voice guidelines\n\n` +
      `_Fill this in — voice, audience, values, do's and don'ts. The Brands page and brand-voice skill read this file._\n`);
  }

  updateBrand(personal.id, { personaIds: [ensureBrandPersona(personal, {})] });
  updateBrand(work.id, { personaIds: [ensureBrandPersona(work, { reuseSasha: true })] });
  updateBrand(business.id, { personaIds: [ensureBrandPersona(business, {})] });
}
