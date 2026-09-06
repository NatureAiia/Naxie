// Vault-reachability banner — when the configured vault path doesn't resolve
// (drive unmounted, path renamed, env misconfigured) every brain endpoint
// 503s. Moved verbatim out of Knowledge.tsx; the health probe itself stays
// with the parent (Library.tsx) since it drives other UI too (deep-linking,
// which tree/search calls are safe to fire).
export type VaultHealth = { ok: boolean; vaultPath: string; exists: boolean; gitRepo: boolean; reason?: string };

export function VaultHealthBanner({ vaultHealth, onRetry }: { vaultHealth: VaultHealth | null; onRetry: () => void }) {
  if (!vaultHealth) return null;
  return (
    <>
      {!vaultHealth.exists && (
        <div className="bg-coral-500/10 border border-coral-500/30 rounded-lg px-4 py-3">
          <div className="flex items-start gap-3">
            <span aria-hidden className="text-coral-400 mt-0.5">⚠</span>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-coral-300 font-medium">Vault is not reachable.</div>
              <div className="text-xs text-cream-300/70 mt-1">
                Configured path: <span className="font-mono text-cream-100">{vaultHealth.vaultPath}</span>
              </div>
              <div className="text-xs text-cream-300/70 mt-1">
                {vaultHealth.reason ?? "The path does not resolve on this machine."}
              </div>
              <div className="text-[11px] text-cream-300/60 mt-2">
                Fix: mount the drive, restore the folder, or update <span className="font-mono">VAULT_PATH</span> in <span className="font-mono">.env</span> and restart the server. Until then, the knowledge tree, search, and capture endpoints will return 503.
              </div>
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="text-xs px-3 py-1 rounded border border-coral-500/40 text-coral-200 hover:bg-coral-500/10"
            >
              Retry
            </button>
          </div>
        </div>
      )}
      {vaultHealth.exists && !vaultHealth.gitRepo && (
        <div className="bg-flame-500/10 border border-flame-500/30 rounded-lg px-4 py-2">
          <div className="text-xs text-flame-300">
            Vault folder exists but has no <span className="font-mono">.git</span> — Obsidian sync over git won't work until you initialise the repo (run <span className="font-mono">git init</span> in <span className="font-mono">{vaultHealth.vaultPath}</span> and push to <span className="font-mono">origin</span>).
          </div>
        </div>
      )}
    </>
  );
}
