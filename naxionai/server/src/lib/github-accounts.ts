// Multi-account GitHub credentials — personal/work/business accounts each
// carry their own fine-grained PAT, so a project's commits get watched under
// the right identity instead of assuming one global GITHUB_TOKEN (see
// github.ts, which still owns that single default client for every existing
// caller). Persisted at .naxion/github-accounts.json, encrypted at rest —
// same pattern as connectors.ts (secret-box.ts, atomic write, never returns
// the raw token to the API/UI, only a tokenSet boolean).

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { Octokit } from "@octokit/rest";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const CONFIG_PATH = resolve(CONFIG_DIR, "github-accounts.json");

export type GithubAccount = {
  id: string;
  label: string;       // e.g. "Personal", "Work", "Business"
  token: string;        // fine-grained PAT — encrypted at rest
  createdAt: string;
  lastRotatedAt?: string;
};

export type GithubAccountPublic = Omit<GithubAccount, "token"> & { tokenSet: boolean };

function load(): GithubAccount[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    let sawPlaintext = false;
    const list = (parsed as GithubAccount[]).map(a => {
      let token = a.token ?? "";
      if (token) {
        if (isEncrypted(token)) {
          try { token = decryptSecret(token); }
          catch { /* wrong/rotated key — leave blob; octokitFor will fail clearly */ }
        } else {
          sawPlaintext = true;
        }
      }
      return { ...a, token };
    });
    if (sawPlaintext) { try { save(list); } catch { /* best-effort migration */ } }
    return list;
  } catch { return []; }
}

function save(list: GithubAccount[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = list.map(a => ({
    ...a,
    token: a.token && !isEncrypted(a.token) ? encryptSecret(a.token) : a.token,
  }));
  const tmp = `${CONFIG_PATH}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
  renameSync(tmp, CONFIG_PATH);
}

function toPublic(a: GithubAccount): GithubAccountPublic {
  const { token, ...rest } = a;
  return { ...rest, tokenSet: !!token };
}

export function listAccounts(): GithubAccountPublic[] {
  return load().map(toPublic);
}

export function getAccount(id: string): GithubAccount | undefined {
  return load().find(a => a.id === id);
}

export function addAccount(label: string, token: string): GithubAccountPublic {
  const cleanLabel = String(label ?? "").trim();
  const cleanToken = String(token ?? "").trim();
  if (!cleanLabel) throw new Error("label is required");
  if (!cleanToken) throw new Error("token is required");
  const account: GithubAccount = { id: randomUUID(), label: cleanLabel, token: cleanToken, createdAt: new Date().toISOString() };
  const list = load();
  list.push(account);
  save(list);
  return toPublic(account);
}

export function updateAccount(id: string, patch: { label?: string }): GithubAccountPublic | null {
  const list = load();
  const a = list.find(x => x.id === id);
  if (!a) return null;
  if (patch.label !== undefined) a.label = String(patch.label).trim() || a.label;
  save(list);
  clientCache.delete(id);
  return toPublic(a);
}

export function rotateAccountToken(id: string, newToken: string): GithubAccountPublic | null {
  const list = load();
  const a = list.find(x => x.id === id);
  if (!a) return null;
  const clean = String(newToken ?? "").trim();
  if (!clean) throw new Error("token is required");
  a.token = clean;
  a.lastRotatedAt = new Date().toISOString();
  save(list);
  clientCache.delete(id);
  return toPublic(a);
}

export function removeAccount(id: string): boolean {
  const list = load();
  const next = list.filter(a => a.id !== id);
  if (next.length === list.length) return false;
  save(next);
  clientCache.delete(id);
  return true;
}

// One Octokit client per account, rebuilt on token rotation/removal (see the
// clientCache.delete(...) calls above).
const clientCache = new Map<string, Octokit>();

export function octokitFor(accountId: string): Octokit {
  const cached = clientCache.get(accountId);
  if (cached) return cached;
  const account = getAccount(accountId);
  if (!account) throw new Error(`github account not found: ${accountId}`);
  const client = new Octokit({ auth: account.token });
  clientCache.set(accountId, client);
  return client;
}
