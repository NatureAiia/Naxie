import { Router } from "express";
import { config } from "../config.js";
import { getVaultHealth, getVaultPullStatus } from "../lib/vault.js";
import { vaultCommitStats } from "../lib/commit-queue.js";

export const storageRouter = Router();

export type StorageBackendStatus = {
  id: "local" | "obsidian" | "github" | "drive" | "supabase";
  label: string;
  configured: boolean;
  reachable: boolean;
  detail: string;
};

// Lightweight reachability ping — HEAD against the PostgREST root with the
// secret key. 2s timeout: this endpoint serves a UI decoration, not a
// critical path, so a slow/unreachable Supabase project must never stall the
// storage-universe canvas from loading.
async function pingSupabase(): Promise<boolean> {
  if (!config.supabaseEnabled) return false;
  try {
    const r = await fetch(`${config.supabaseUrl}/rest/v1/`, {
      method: "HEAD",
      headers: { apikey: config.supabaseSecretKey },
      signal: AbortSignal.timeout(2000),
    });
    return r.ok || r.status === 404; // PostgREST root 404s with no default route configured — still proves reachability
  } catch {
    return false;
  }
}

// One place the storage-universe visualization (KnowledgeGraph's hub nodes)
// hits to render real health per backend instead of a static mock. Google
// Drive has no code yet (docs/naxie-storage-architecture.md Phase 2) — it
// always reports configured:false so the UI can render it as dormant rather
// than missing entirely. Supabase credentials exist but the RAG/MAG pipeline
// itself is still Phase 2 — configured reflects credential presence, not a
// working integration.
// Shared by GET /status below and the Files explorer (routes/files.ts) so
// both surfaces agree on what's configured/reachable per backend.
export async function computeStorageBackends(): Promise<StorageBackendStatus[]> {
  const vaultHealth = getVaultHealth();
  const pull = getVaultPullStatus();
  const commits = vaultCommitStats();

  const local: StorageBackendStatus = {
    id: "local",
    label: "Local drive",
    configured: true,
    reachable: vaultHealth.exists,
    detail: vaultHealth.exists ? config.vaultPath : (vaultHealth.reason ?? "vault path unreachable"),
  };

  const obsidian: StorageBackendStatus = {
    id: "obsidian",
    label: "Obsidian vault",
    configured: true,
    reachable: vaultHealth.exists && (vaultHealth.gitRepo || !!process.env.NEUROWORKS_VAULT_ALLOW_NO_GIT),
    detail: vaultHealth.index ? `${vaultHealth.index.docs} note(s) indexed` : "index not built yet",
  };

  const githubConfigured = config.vaultRepo.length > 0 && config.githubToken.length > 0;
  const github: StorageBackendStatus = {
    id: "github",
    label: "GitHub vault repo",
    configured: githubConfigured,
    reachable: githubConfigured && vaultHealth.gitRepo && pull.lastPullResult.ok,
    detail: !githubConfigured
      ? "VAULT_REPO / GITHUB_TOKEN not set"
      : `${commits.pendingWrites} pending write(s); last pull ${pull.lastPullResult.at}`,
  };

  // Net-new (docs/naxie-storage-architecture.md Phase 2) — no credentials
  // wired yet on this machine, so always report not-configured.
  const drive: StorageBackendStatus = {
    id: "drive",
    label: "Google Drive",
    configured: false,
    reachable: false,
    detail: "not configured — see docs/naxie-storage-architecture.md §9",
  };

  const supabase: StorageBackendStatus = {
    id: "supabase",
    label: "Supabase",
    configured: config.supabaseEnabled,
    reachable: await pingSupabase(),
    detail: config.supabaseEnabled
      ? "credentials stored — RAG/MAG pipeline not built yet (Phase 2)"
      : "not configured — see docs/naxie-storage-architecture.md §9",
  };

  return [local, obsidian, github, drive, supabase];
}

storageRouter.get("/status", async (_req, res) => {
  res.json({ backends: await computeStorageBackends() });
});
