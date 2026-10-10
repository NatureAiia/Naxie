// Company database registry. Persists connection metadata at
// .naxion/data-sources.json (outside the vault, since it carries
// credentials). Lazy-imports the engine driver on first query so the server
// boots without pg/mysql2/better-sqlite3 installed — the missing-driver
// error tells the operator which `pnpm add` to run.
//
// Default contract: read-only. The SQL gate rejects anything that looks
// like a DDL/DML statement so an agent mistake can't trash production.
// The operator can flip readonly=false per source for trusted write paths.

import { dirname, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { encryptSecret, decryptSecret, isEncrypted } from "./secret-box.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_DIR = resolve(__dirname, "../../../.naxion");
const CONFIG_PATH = resolve(CONFIG_DIR, "data-sources.json");

export type DataSourceKind = "postgres" | "mysql" | "sqlite" | "mssql" | "mongodb" | "excel" | "csv";

export type DataSource = {
  id: string;
  label: string;
  kind: DataSourceKind;
  connection: string;
  notes?: string;
  department?: string;   // optional: tag this connection to an org department
  readonly: boolean;
  createdAt: string;
};

// On disk the `connection` string (which carries DB credentials) is encrypted
// at rest via the shared secret box. load() returns runtime objects with the
// connection DECRYPTED so the rest of the module works unchanged; save()
// re-encrypts. Legacy plaintext records are transparently migrated to encrypted
// on first load.
function load(): DataSource[] {
  try {
    if (!existsSync(CONFIG_PATH)) return [];
    const parsed = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (!Array.isArray(parsed)) return [];
    let sawPlaintext = false;
    const list = (parsed as DataSource[]).map(s => {
      if (s && typeof s.connection === "string") {
        if (isEncrypted(s.connection)) {
          try { return { ...s, connection: decryptSecret(s.connection) }; }
          catch { return s; } // wrong/rotated key — leave blob; query will error clearly
        }
        sawPlaintext = true; // legacy unencrypted record
      }
      return s;
    });
    if (sawPlaintext) { try { save(list); } catch { /* best-effort migration */ } }
    return list;
  } catch { return []; }
}

function save(list: DataSource[]): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = list.map(s => ({
    ...s,
    connection: isEncrypted(s.connection) ? s.connection : encryptSecret(s.connection),
  }));
  writeFileSync(CONFIG_PATH, JSON.stringify(onDisk, null, 2), { encoding: "utf8", mode: 0o600 });
}

export function listSources(): DataSource[] { return load(); }

export function getSource(id: string): DataSource | undefined {
  return load().find(s => s.id === id);
}

// Resolve a source by label OR id. The planner is TOLD the label AND the id
// (the companyDataContext hint lists "id=…"), and it frequently passes the id
// even when the task named the label — every db.* call then failed with
// "source not found" and the agent aborted (live 2026-07-13). Accept exact id,
// exact label (case-insensitive), then a substring label match so a slightly
// off label ("Neon" for "Neon Cloud DB") still resolves.
export function getSourceByLabel(label: string): DataSource | undefined {
  const raw = label.trim();
  const lower = raw.toLowerCase();
  const list = load();
  const hit = list.find(s => s.id === raw)
    ?? list.find(s => s.label.toLowerCase() === lower)
    ?? list.find(s => s.label.toLowerCase().includes(lower) || lower.includes(s.label.toLowerCase()));
  if (hit) return hit;
  // Reverse-direction match: does the QUERY contain a source's IDENTIFYING
  // tokens? Requiring every query token to appear in the source (the earlier
  // approach) broke the moment a task carried payload words — "create a $12
  // requisition for a test mop" has "test"/"mop"/"priority" that are nowhere
  // in any source's metadata, so nothing resolved (live 2026-07-13). Instead:
  // each source contributes distinctive tokens from its label + notes (minus
  // generic DB nouns); the source with the most of those present in the query
  // wins, as long as at least one distinctive token hits.
  const GENERIC = new Set(["db", "database", "cloud", "data", "source", "the", "system", "external", "test", "aws", "postgres", "postgresql", "mysql", "sqlite", "server", "prod", "production", "staging"]);
  const qWords = new Set(lower.split(/[^a-z0-9]+/).filter(Boolean));
  let best: DataSource | undefined;
  let bestScore = 0;
  for (const s of list) {
    const idTokens = `${s.label} ${s.notes ?? ""}`.toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(t => t.length >= 3 && !GENERIC.has(t) && !/^\d+$/.test(t));
    const uniq = new Set(idTokens);
    let score = 0;
    for (const t of uniq) if (qWords.has(t)) score += 1;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore >= 1 ? best : undefined;
}

export function addSource(input: Omit<DataSource, "id" | "createdAt">): DataSource {
  const list = load();
  const ds: DataSource = { ...input, id: randomUUID(), createdAt: new Date().toISOString() };
  list.push(ds);
  save(list);
  return ds;
}

export function removeSource(id: string): boolean {
  const list = load();
  const next = list.filter(s => s.id !== id);
  if (next.length === list.length) return false;
  save(next);
  invalidateSchemaCache(id); // drop any cached schema for the deleted source
  return true;
}

// Resolve which database a Mongo query targets: explicit `db` wins, else the
// connection string's default path. Throws instead of silently landing on
// "test" when neither exists. Pure — unit-tested without a cluster.
export function resolveMongoDbName(connection: string, qDb: unknown): string {
  if (qDb) return String(qDb);
  const m = /mongodb(?:\+srv)?:\/\/[^/]*\/([^?]*)/.exec(connection);
  const dbName = (m?.[1] ?? "").trim();
  if (!dbName) {
    throw new Error('mongodb query needs a "db" — e.g. {"db":"naxionai","collection":"vault_chunks","filter":{}} (connection string has no default database)');
  }
  return dbName;
}
// Blunt keyword gate for read-only sources. Errs on the side of blocking: a
// false positive (a token appearing inside a string literal) just refuses the
// query — the operator can set readonly=false for a trusted write path. The
// list covers DDL/DML PLUS the file-access + table-materialising forms that
// would otherwise sneak a write/exfil past a "SELECT-looks-safe" check:
//   • INTO OUTFILE / DUMPFILE (MySQL) and SELECT … INTO (PG/MSSQL) → write
//   • LOAD_FILE / LOAD DATA INFILE (MySQL) → read host files
//   • lo_import/lo_export, pg_read_file/pg_read_binary_file/pg_ls_dir/
//     pg_write_file (Postgres) → read/write host files
const WRITE_KEYWORDS = /\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|exec|execute|merge|replace|attach|copy|vacuum|reindex|into|outfile|dumpfile|infile|load_file|load\s+data|lo_import|lo_export|pg_read_file|pg_read_binary_file|pg_ls_dir|pg_write_file|xp_cmdshell|sp_configure)\b/i;
export function isReadOnlySql(sql: string): boolean {
  return !WRITE_KEYWORDS.test(sql);
}

export type QueryResult = { rows: any[]; columns: string[]; rowCount: number; truncated: boolean };

// Hard cap on a single db.query. Without it a slow/blocked query (a missing
// index, a lock wait, a Neon cold-start that never wakes) runs UNBOUNDED —
// observed live 2026-07-21 at 90s and again mid-180s. Two layers: the driver's
// native server-side statement_timeout (Postgres/MySQL actually KILL the query,
// freeing the connection) plus a client wall-clock race (covers drivers/paths
// that ignore the native option, and connection hangs before a query even
// runs). Tunable via env; default 30s — long enough for a heavy analytical
// query, short enough that a hang surfaces as a clear error instead of a wedge.
const DB_QUERY_TIMEOUT_MS = Number(process.env.NAXION_DB_QUERY_TIMEOUT_MS ?? "30000") || 30000;

function withTimeout<T>(p: Promise<T>, ms: number, label: string, onTimeout?: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      try { onTimeout?.(); } catch { /* best-effort abort */ }
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s (NAXION_DB_QUERY_TIMEOUT_MS) — the query is too slow or the connection hung; add an index, narrow the query, or raise the timeout`));
    }, ms);
    p.then(v => { clearTimeout(timer); resolve(v); }, e => { clearTimeout(timer); reject(e); });
  });
}

export async function runQuery(source: DataSource, sql: string, limit = 200): Promise<QueryResult> {
  // File-based sources (Excel/CSV) — handle before the SQL keyword gate since
  // they use a simplified query syntax, not full SQL.
  if (source.kind === "excel") return runExcelQuery(source, sql, limit);
  if (source.kind === "csv") return runCsvQuery(source, sql, limit);

  // MongoDB takes a JSON query document, not SQL — handle it before the
  // SQL-keyword read-only gate (which would false-positive on field values
  // like {"status":"create"}). Read-only is enforced structurally instead:
  // only find / aggregate / count / distinct are ever executed.
  if (source.kind === "mongodb") return runMongoQuery(source, sql, limit);

  if (source.readonly && !isReadOnlySql(sql)) {
    throw new Error("source is read-only — only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / PRAGMA allowed");
  }
  const trimmed = sql.trim().replace(/;\s*$/, "");
  switch (source.kind) {
    case "postgres": {
      let pg: any;
      try { pg = await import("pg"); }
      catch { throw new Error("postgres driver not installed — run `pnpm -C server add pg`"); }
      const Client = (pg.default ?? pg).Client;
      // Native caps: statement_timeout makes Postgres itself abort a query that
      // exceeds the budget (frees the server + connection); the *_timeout knobs
      // stop a dead connection from hanging the connect/query call client-side.
      const client = new Client({
        connectionString: source.connection,
        statement_timeout: DB_QUERY_TIMEOUT_MS,
        query_timeout: DB_QUERY_TIMEOUT_MS,
        connectionTimeoutMillis: Math.min(15_000, DB_QUERY_TIMEOUT_MS),
      });
      try {
        // Wall-clock race covers the connect() hang too (before statement_timeout
        // can apply); on timeout we destroy the socket so nothing leaks.
        return await withTimeout((async () => {
          await client.connect();
          const r = await client.query(trimmed);
          const all = Array.isArray(r.rows) ? r.rows : [];
          const rows = all.slice(0, limit);
          const truncated = all.length > limit;
          const columns = Array.isArray(r.fields) && r.fields.length > 0
            ? r.fields.map((f: any) => f.name)
            : (rows[0] ? Object.keys(rows[0]) : []);
          return { rows, columns, rowCount: rows.length, truncated };
        })(), DB_QUERY_TIMEOUT_MS, "db.query (postgres)", () => { try { (client as any).connection?.stream?.destroy?.(); } catch { /* ignore */ } });
      } finally { try { await client.end(); } catch { /* tolerate */ } }
    }
    case "mysql": {
      let mysql: any;
      try { mysql = await import("mysql2/promise"); }
      catch { throw new Error("mysql driver not installed — run `pnpm -C server add mysql2`"); }
      const mod = mysql.default ?? mysql;
      // MySQL server-side cap via an optimizer hint on SELECTs (ms). Belt-and-
      // braces with the wall-clock race below for connection hangs.
      const capped = /^\s*select\b/i.test(trimmed)
        ? trimmed.replace(/^\s*select\b/i, `SELECT /*+ MAX_EXECUTION_TIME(${DB_QUERY_TIMEOUT_MS}) */`)
        : trimmed;
      const conn = await mod.createConnection(source.connection);
      try {
        return await withTimeout((async () => {
          const [rowsRaw, fields] = await conn.execute(capped);
          const all = Array.isArray(rowsRaw) ? rowsRaw : [];
          const rows = all.slice(0, limit);
          const truncated = all.length > limit;
          const columns = Array.isArray(fields)
            ? fields.map((f: any) => f.name)
            : (rows[0] ? Object.keys(rows[0]) : []);
          return { rows, columns, rowCount: rows.length, truncated };
        })(), DB_QUERY_TIMEOUT_MS, "db.query (mysql)", () => { try { conn.destroy(); } catch { /* ignore */ } });
      } finally { try { await conn.end(); } catch { /* tolerate */ } }
    }
    case "sqlite": {
      let mod: any;
      try { mod = await import("better-sqlite3"); }
      catch { throw new Error("sqlite driver not installed — run `pnpm -C server add better-sqlite3`"); }
      const Db = mod.default ?? mod;
      const db = new Db(source.connection, { readonly: source.readonly, fileMustExist: true });
      try {
        const stmt = db.prepare(trimmed);
        const isSelect = /^\s*(select|with|pragma|explain)\b/i.test(trimmed);
        if (isSelect) {
          const all: any[] = stmt.all();
          const rows = all.slice(0, limit);
          const truncated = all.length > limit;
          const columns = rows[0] ? Object.keys(rows[0]) : [];
          return { rows, columns, rowCount: rows.length, truncated };
        }
        const info = stmt.run();
        return { rows: [], columns: [], rowCount: info.changes ?? 0, truncated: false };
      } finally { try { db.close(); } catch { /* tolerate */ } }
    }
    case "mssql": {
      let mssql: any;
      try { mssql = await import("mssql"); }
      catch { throw new Error("mssql driver not installed — run `pnpm -C server add mssql`"); }
      const mod = mssql.default ?? mssql;
      const pool = new mod.ConnectionPool(source.connection);
      try {
        return await withTimeout((async () => {
          await pool.connect();
          const r = await pool.request().query(trimmed);
          const all = Array.isArray(r.recordset) ? r.recordset : [];
          const rows = all.slice(0, limit);
          const truncated = all.length > limit;
          const colMeta = r.recordset?.columns;
          const columns = colMeta && typeof colMeta === "object"
            ? Object.keys(colMeta)
            : (rows[0] ? Object.keys(rows[0]) : []);
          return { rows, columns, rowCount: rows.length, truncated };
        })(), DB_QUERY_TIMEOUT_MS, "db.query (mssql)", () => { try { pool.close(); } catch { /* ignore */ } });
      } finally { try { await pool.close(); } catch { /* tolerate */ } }
    }
    // mongodb is handled by the early return at the top of runQuery.
  }
}

// MongoDB read path. The `sql` argument carries a JSON query document:
//   { "collection": "users", "filter": {…}, "projection": {…}, "sort": {…}, "limit": N }
//   { "collection": "orders", "aggregate": [ {"$group": …}, … ] }
//   { "collection": "users", "count": true, "filter": {…} }
//   { "collection": "users", "distinct": "country", "filter": {…} }
// Only reads run — aggregation stages that write ($out / $merge) are rejected.
async function runMongoQuery(source: DataSource, raw: string, limit: number): Promise<QueryResult> {
  let q: any;
  try { q = JSON.parse(raw); }
  catch { throw new Error('mongodb query must be JSON — e.g. {"collection":"users","filter":{"active":true},"limit":50}'); }
  if (!q || typeof q !== "object" || !q.collection) {
    throw new Error('mongodb query needs a "collection" — e.g. {"collection":"users","filter":{}}');
  }
  let mongodb: any;
  try { mongodb = await import("mongodb"); }
  catch { throw new Error("mongodb driver not installed — run `pnpm -C server add mongodb`"); }
  const { MongoClient } = mongodb.default ?? mongodb;
  const dbName = resolveMongoDbName(source.connection, q.db);
  const client = new MongoClient(source.connection);
  try {
    await client.connect();
    const db = client.db(dbName);
    const coll = db.collection(String(q.collection));

    const pipeline = q.aggregate ?? q.pipeline;
    if (Array.isArray(pipeline)) {
      if (/\$out|\$merge/.test(JSON.stringify(pipeline))) {
        throw new Error("source is read-only — aggregation $out / $merge (which write) are not allowed");
      }
      const all = await coll.aggregate(pipeline).toArray();
      const rows = all.slice(0, limit);
      return { rows, columns: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, truncated: all.length > limit };
    }
    if (q.count) {
      const n = await coll.countDocuments(q.filter ?? {});
      return { rows: [{ count: n }], columns: ["count"], rowCount: 1, truncated: false };
    }
    if (q.distinct) {
      const vals = await coll.distinct(String(q.distinct), q.filter ?? {});
      const rows = (Array.isArray(vals) ? vals : []).slice(0, limit).map((v: any) => ({ [String(q.distinct)]: v }));
      return { rows, columns: [String(q.distinct)], rowCount: rows.length, truncated: Array.isArray(vals) && vals.length > limit };
    }
    // Default: find.
    const all = await coll.find(q.filter ?? {}, { projection: q.projection, sort: q.sort })
      .limit(Math.max(1, Math.min(limit, Number(q.limit) || limit)) + 1)
      .toArray();
    const rows = all.slice(0, limit);
    return { rows, columns: rows[0] ? Object.keys(rows[0]) : [], rowCount: rows.length, truncated: all.length > limit };
  } finally { try { await client.close(); } catch { /* tolerate */ } }
}

// Excel query handler. sql is a simplified lookup: { sheet, filter, limit }
// or just the sheet name. Uses SheetJS (xlsx) to parse on every call so
// file changes are reflected immediately — no cache invalidation headache.
async function runExcelQuery(source: DataSource, raw: string, limit: number): Promise<QueryResult> {
  let q: any;
  try { q = JSON.parse(raw); }
  catch {
    // Treat bare string as sheet name.
    q = typeof raw === "string" ? { sheet: raw.trim() } : {};
  }
  if (!q || !q.sheet) {
    // If no sheet specified, use the first sheet.
    q = { sheet: null, filter: q?.filter, limit: q?.limit };
  }
  let XLSX: any;
  try { XLSX = await import("xlsx"); }
  catch { throw new Error("xlsx package not installed — run `pnpm -C server add xlsx`"); }
  if (!existsSync(source.connection)) {
    throw new Error(`Excel file not found: ${source.connection}`);
  }
  // Buffer read — the xlsx ESM build has no fs wired, so XLSX.readFile throws
  // "Cannot access file" even on files that exist. Same fix in doc-extractor.
  const wb = XLSX.read(readFileSync(source.connection), { type: "buffer" });
  const sheetName = q.sheet ?? wb.SheetNames[0];
  if (!sheetName || !wb.Sheets[sheetName]) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(", ")}`);
  }
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (!Array.isArray(json) || json.length === 0) {
    return { rows: [], columns: [], rowCount: 0, truncated: false };
  }
  const columns = Object.keys(json[0] as Record<string, unknown>);
  let rows = json as Record<string, unknown>[];

  // Optional filter: { col: "Status", op: "eq", val: "Active" }
  if (q.filter && typeof q.filter === "object") {
    const f = q.filter;
    const col = String(f.col ?? "");
    const op = String(f.op ?? "eq");
    const val = f.val;
    if (col && columns.includes(col)) {
      rows = rows.filter(r => {
        const cell = r[col];
        switch (op) {
          case "eq": return cell == val;
          case "neq": return cell != val;
          case "gt": return Number(cell) > Number(val);
          case "gte": return Number(cell) >= Number(val);
          case "lt": return Number(cell) < Number(val);
          case "lte": return Number(cell) <= Number(val);
          case "contains": return String(cell ?? "").toLowerCase().includes(String(val ?? "").toLowerCase());
          default: return true;
        }
      });
    }
  }

  const all = rows;
  rows = all.slice(0, limit);
  const truncated = all.length > limit;
  return { rows, columns, rowCount: rows.length, truncated };
}

// CSV query handler. Same simplified syntax as Excel: { sheet, filter, limit }.
// CSV files have a single implicit sheet named after the file (no extension).
async function runCsvQuery(source: DataSource, raw: string, limit: number): Promise<QueryResult> {
  let XLSX: any;
  try { XLSX = await import("xlsx"); }
  catch { throw new Error("xlsx package not installed — run `pnpm -C server add xlsx` (SheetJS handles CSV too)"); }
  if (!existsSync(source.connection)) {
    throw new Error(`CSV file not found: ${source.connection}`);
  }
  // SheetJS reads CSV natively — same code path as Excel (buffer read: the
  // ESM build has no fs, XLSX.readFile would throw "Cannot access file").
  const wb = XLSX.read(readFileSync(source.connection), { type: "buffer", raw: true });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
  if (!Array.isArray(json) || json.length === 0) {
    return { rows: [], columns: [], rowCount: 0, truncated: false };
  }
  const columns = Object.keys(json[0] as Record<string, unknown>);
  let rows = json as Record<string, unknown>[];

  // Optional filter (same shape as Excel).
  let q: any;
  try { q = JSON.parse(raw); }
  catch { q = {}; }
  if (q.filter && typeof q.filter === "object") {
    const f = q.filter;
    const col = String(f.col ?? "");
    const op = String(f.op ?? "eq");
    const val = f.val;
    if (col && columns.includes(col)) {
      rows = rows.filter(r => {
        const cell = r[col];
        switch (op) {
          case "eq": return cell == val;
          case "neq": return cell != val;
          case "gt": return Number(cell) > Number(val);
          case "gte": return Number(cell) >= Number(val);
          case "lt": return Number(cell) < Number(val);
          case "lte": return Number(cell) <= Number(val);
          case "contains": return String(cell ?? "").toLowerCase().includes(String(val ?? "").toLowerCase());
          default: return true;
        }
      });
    }
  }

  const all = rows;
  rows = all.slice(0, limit);
  const truncated = all.length > limit;
  return { rows, columns, rowCount: rows.length, truncated };
}

// Schema cache — describeSource runs a full information_schema scan against
// the remote DB, and db.query question-mode calls it on EVERY question. That
// scan is a network round-trip (a Neon serverless cold start can add several
// seconds on its own) for a schema that changes rarely. Cache the described
// schema per source with a short TTL so back-to-back questions (and the common
// "ask, then follow up") reuse it. Keyed by source id so editing a source's
// connection string doesn't serve a stale schema for long. Measured cost of a
// question-mode db.query was 31–90s (2026-07-20 journal); this removes one of
// the two round-trips (the other is the LLM SQL generation).
type DescribedSchema = { tables: { name: string; columns: { name: string; type: string }[] }[] };
const SCHEMA_CACHE = new Map<string, { at: number; schema: DescribedSchema }>();
const SCHEMA_CACHE_TTL_MS = Number(process.env.NAXION_DB_SCHEMA_CACHE_MS ?? String(5 * 60_000)) || 5 * 60_000;

export function invalidateSchemaCache(sourceId?: string): void {
  if (sourceId) SCHEMA_CACHE.delete(sourceId);
  else SCHEMA_CACHE.clear();
}

export async function describeSource(source: DataSource): Promise<DescribedSchema> {
  const cacheKey = source.id;
  if (cacheKey) {
    const hit = SCHEMA_CACHE.get(cacheKey);
    if (hit && Date.now() - hit.at < SCHEMA_CACHE_TTL_MS) return hit.schema;
  }
  const schema = await describeSourceUncached(source);
  if (cacheKey) SCHEMA_CACHE.set(cacheKey, { at: Date.now(), schema });
  return schema;
}

async function describeSourceUncached(source: DataSource): Promise<DescribedSchema> {
  switch (source.kind) {
    case "postgres": {
      const r = await runQuery(source, `
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('pg_catalog','information_schema')
        ORDER BY table_schema, table_name, ordinal_position
      `, 10000);
      const byTable = new Map<string, { name: string; type: string }[]>();
      for (const row of r.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!byTable.has(key)) byTable.set(key, []);
        byTable.get(key)!.push({ name: String(row.column_name), type: String(row.data_type) });
      }
      return { tables: [...byTable.entries()].map(([name, columns]) => ({ name, columns })) };
    }
    case "mysql": {
      const r = await runQuery(source, `
        SELECT table_schema, table_name, column_name, column_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('mysql','information_schema','performance_schema','sys')
        ORDER BY table_schema, table_name, ordinal_position
      `, 10000);
      const byTable = new Map<string, { name: string; type: string }[]>();
      for (const row of r.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!byTable.has(key)) byTable.set(key, []);
        byTable.get(key)!.push({ name: String(row.column_name), type: String(row.column_type) });
      }
      return { tables: [...byTable.entries()].map(([name, columns]) => ({ name, columns })) };
    }
    case "sqlite": {
      const r = await runQuery(source, `SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`, 1000);
      const tables: { name: string; columns: { name: string; type: string }[] }[] = [];
      for (const row of r.rows) {
        const tname = String(row.name);
        if (tname.startsWith("sqlite_")) continue;
        const cols = await runQuery(source, `PRAGMA table_info("${tname.replace(/"/g, '""')}")`, 1000);
        tables.push({
          name: tname,
          columns: cols.rows.map((c: any) => ({ name: String(c.name), type: String(c.type) })),
        });
      }
      return { tables };
    }
    case "mssql": {
      const r = await runQuery(source, `
        SELECT table_schema, table_name, column_name, data_type
        FROM information_schema.columns
        WHERE table_schema NOT IN ('sys','INFORMATION_SCHEMA')
        ORDER BY table_schema, table_name, ordinal_position
      `, 10000);
      const byTable = new Map<string, { name: string; type: string }[]>();
      for (const row of r.rows) {
        const key = `${row.table_schema}.${row.table_name}`;
        if (!byTable.has(key)) byTable.set(key, []);
        byTable.get(key)!.push({ name: String(row.column_name), type: String(row.data_type) });
      }
      return { tables: [...byTable.entries()].map(([name, columns]) => ({ name, columns })) };
    }
    case "mongodb": {
      // No fixed schema — list collections and infer columns from a sample doc.
      let mongodb: any;
      try { mongodb = await import("mongodb"); }
      catch { throw new Error("mongodb driver not installed — run `pnpm -C server add mongodb`"); }
      const { MongoClient } = mongodb.default ?? mongodb;
      const client = new MongoClient(source.connection);
      try {
        await client.connect();
        const db = client.db();
        const colls = await db.listCollections().toArray();
        const tables: { name: string; columns: { name: string; type: string }[] }[] = [];
        for (const c of colls) {
          const name = String(c.name);
          if (name.startsWith("system.")) continue;
          const doc = await db.collection(name).findOne();
          const columns = doc
            ? Object.entries(doc).map(([k, v]) => ({ name: k, type: Array.isArray(v) ? "array" : v === null ? "null" : typeof v }))
            : [];
          tables.push({ name, columns });
        }
        return { tables };
      } finally { try { await client.close(); } catch { /* tolerate */ } }
    }
    case "excel": {
      let XLSX: any;
      try { XLSX = await import("xlsx"); }
      catch { throw new Error("xlsx package not installed"); }
      if (!existsSync(source.connection)) {
        throw new Error(`Excel file not found: ${source.connection}`);
      }
      const wb = XLSX.read(readFileSync(source.connection), { type: "buffer" });
      const tables: { name: string; columns: { name: string; type: string }[] }[] = [];
      for (const sheetName of wb.SheetNames) {
        const sheet = wb.Sheets[sheetName];
        const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
        const columns = Array.isArray(json) && json.length > 0
          ? Object.keys(json[0] as Record<string, unknown>).map(k => ({ name: k, type: inferType((json[0] as Record<string, unknown>)[k]) }))
          : [];
        tables.push({ name: sheetName, columns });
      }
      return { tables };
    }
    case "csv": {
      let XLSX: any;
      try { XLSX = await import("xlsx"); }
      catch { throw new Error("xlsx package not installed"); }
      if (!existsSync(source.connection)) {
        throw new Error(`CSV file not found: ${source.connection}`);
      }
      const wb = XLSX.read(readFileSync(source.connection), { type: "buffer", raw: true });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: null });
      const columns = Array.isArray(json) && json.length > 0
        ? Object.keys(json[0] as Record<string, unknown>).map(k => ({ name: k, type: inferType((json[0] as Record<string, unknown>)[k]) }))
        : [];
      // Use the filename (without ext) as the table name.
      const tableName = basename(source.connection).replace(extname(source.connection), "");
      return { tables: [{ name: tableName, columns }] };
    }
  }
}

function inferType(val: unknown): string {
  if (val === null || val === undefined) return "null";
  if (typeof val === "number") return Number.isInteger(val) ? "integer" : "number";
  if (typeof val === "boolean") return "boolean";
  if (val instanceof Date || (!isNaN(Date.parse(String(val))) && /^\d{4}-\d{2}-\d{2}/.test(String(val)))) return "date";
  return "string";
}

export function redactConnection(conn: string, kind: DataSourceKind): string {
  if (kind === "sqlite" || kind === "excel" || kind === "csv") return conn;
  return conn.replace(/(:\/\/[^:@]+:)([^@]+)(@)/, "$1***$3");
}
