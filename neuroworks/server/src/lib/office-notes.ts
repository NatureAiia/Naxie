// Office dashboard — manual custom stat lines per department (e.g. "emails
// sent: 128"). Unlike the department's real agent/task counts (computed live
// from personas + jobs), these are free text the operator types in and edits
// themselves; we just store and echo them back. Persisted outside the vault,
// same convention as department-data.ts.

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.neuroworks");
const CONFIG_PATH = resolve(CONFIG_DIR, "office-notes.json");

const MAX_LINES = 2;
const MAX_LINE_LEN = 60;

type Store = Record<string, string[]>; // departmentId -> up to MAX_LINES short strings

function load(): Store {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch { return {}; }
}

function save(store: Store): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_PATH, JSON.stringify(store, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function listOfficeNotes(): Store {
  return load();
}

export function setOfficeNotes(departmentId: string, lines: string[]): string[] {
  const id = String(departmentId ?? "").trim();
  if (!id) throw new Error("departmentId is required");
  const clean = (Array.isArray(lines) ? lines : [])
    .map(l => String(l ?? "").trim().slice(0, MAX_LINE_LEN))
    .filter(Boolean)
    .slice(0, MAX_LINES);
  const store = load();
  if (clean.length === 0) delete store[id];
  else store[id] = clean;
  save(store);
  return clean;
}
