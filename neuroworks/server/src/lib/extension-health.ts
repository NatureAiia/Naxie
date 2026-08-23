import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync, renameSync } from "node:fs";
import { resolve, join } from "node:path";
import { config } from "../config.js";

export type HealthSample = {
  id: string;
  ok: boolean;
  detail: string;
  latencyMs?: number;
  ts: string;
};

const REL = "_neuroworks/extension-health.jsonl";

function healthPath(): string {
  return resolve(config.vaultPath, REL);
}

export function recordHealth(id: string, ok: boolean, detail: string, latencyMs?: number): void {
  const full = healthPath();
  try { mkdirSync(join(full, ".."), { recursive: true }); } catch {}
  const rec: HealthSample = { id, ok, detail: detail.slice(0, 300), latencyMs, ts: new Date().toISOString() };
  try { appendFileSync(full, JSON.stringify(rec) + "\n", "utf8"); } catch {}
  // trim to last 5000 lines to keep file bounded
  try {
    const st = statSync(full);
    if (st.size > 2_000_000) {
      const lines = readFileSync(full, "utf8").trim().split("\n");
      const keep = lines.slice(-5000);
      const tmp = full + ".tmp";
      writeFileSync(tmp, keep.join("\n") + "\n", "utf8");
      renameSync(tmp, full);
    }
  } catch {}
}

export function getHealthHistory(sinceIso?: string, id?: string): HealthSample[] {
  const full = healthPath();
  if (!existsSync(full)) return [];
  try {
    const lines = readFileSync(full, "utf8").trim().split("\n").filter(Boolean);
    let recs: HealthSample[] = lines.map(l => JSON.parse(l));
    if (sinceIso) {
      const since = new Date(sinceIso).getTime();
      recs = recs.filter(r => new Date(r.ts).getTime() >= since);
    }
    if (id) recs = recs.filter(r => r.id === id);
    return recs;
  } catch { return []; }
}

export type HealthSummary = {
  id: string;
  total: number;
  ok: number;
  fail: number;
  uptimePct: number; // 0-100
  lastOk?: string;
  lastFail?: string;
  recent: HealthSample[]; // last 20
  spark: number[]; // 0/1 per sample last 20
  alert?: string; // e.g. "3 fails in last 5"
};

export function getHealthSummaries(days = 7): HealthSummary[] {
  const sinceIso = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString();
  const all = getHealthHistory(sinceIso);
  const byId = new Map<string, HealthSample[]>();
  for (const r of all) {
    const arr = byId.get(r.id) ?? [];
    arr.push(r);
    byId.set(r.id, arr);
  }
  const out: HealthSummary[] = [];
  for (const [id, arr] of byId) {
    const total = arr.length;
    const ok = arr.filter(x => x.ok).length;
    const fail = total - ok;
    const uptimePct = total ? Math.round((ok / total) * 1000) / 10 : 100;
    const sorted = [...arr].sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime());
    const recent = sorted.slice(-20);
    const spark = recent.map(x => x.ok ? 1 : 0);
    let alert: string | undefined;
    const last5 = recent.slice(-5);
    const fails5 = last5.filter(x => !x.ok).length;
    if (fails5 >= 3) alert = `${fails5}/5 recent checks failed`;
    else if (fail && total >= 3 && uptimePct < 80) alert = `${uptimePct}% uptime last ${days}d`;
    const lastOk = [...sorted].reverse().find(x => x.ok)?.ts;
    const lastFail = [...sorted].reverse().find(x => !x.ok)?.ts;
    out.push({ id, total, ok, fail, uptimePct, lastOk, lastFail, recent, spark, alert });
  }
  return out;
}
