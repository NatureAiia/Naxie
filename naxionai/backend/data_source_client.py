"""
NAXIONAI — Data source query engine (Phase 5)

Ported from neuroworks/server/src/lib/data-sources.ts. Read-only gate
(is_read_only_sql) is ported verbatim. Query execution is implemented for
postgres (asyncpg), sqlite (built-in), excel/csv (pandas/openpyxl) — all
already naxionai dependencies. mysql/mssql/mongodb follow the TS original's
own graceful-degradation pattern: a clear "driver not installed, pip install
X" error instead of a hard crash, since those drivers aren't naxionai
dependencies (adding 3 new DB driver packages speculatively was out of
scope for this pass).
"""

import re
from typing import Any, Dict, List, Optional

from security_gates import assert_safe_external_path

DB_QUERY_TIMEOUT_SECONDS = 30

# Same coverage as the TS original: DDL/DML plus the file-access/table-
# materialising forms that would sneak a write/exfil past a naive
# "SELECT-looks-safe" check.
WRITE_KEYWORDS = re.compile(
    r"\b(insert|update|delete|drop|alter|truncate|create|grant|revoke|exec|execute|merge|replace|attach|"
    r"copy|vacuum|reindex|into|outfile|dumpfile|infile|load_file|load\s+data|lo_import|lo_export|"
    r"pg_read_file|pg_read_binary_file|pg_ls_dir|pg_write_file|xp_cmdshell|sp_configure)\b",
    re.IGNORECASE,
)


def is_read_only_sql(sql: str) -> bool:
    return not WRITE_KEYWORDS.search(sql or "")


class QueryResult(Dict[str, Any]):
    pass


def _result(rows: List[dict], columns: List[str], truncated: bool) -> dict:
    return {"rows": rows, "columns": columns, "row_count": len(rows), "truncated": truncated}


async def run_query(kind: str, connection: str, sql: str, readonly: bool, limit: int = 200) -> dict:
    if kind == "excel":
        return _run_excel_query(connection, sql, limit)
    if kind == "csv":
        return _run_csv_query(connection, sql, limit)
    if kind == "mongodb":
        raise ValueError("mongodb driver not installed — run `pip install pymongo` in the backend environment")

    if readonly and not is_read_only_sql(sql):
        raise ValueError("source is read-only — only SELECT / WITH / SHOW / EXPLAIN / DESCRIBE / PRAGMA allowed")

    trimmed = sql.strip().rstrip(";")

    if kind == "postgres":
        return await _run_postgres_query(connection, trimmed, limit, readonly)
    if kind == "sqlite":
        return _run_sqlite_query(connection, trimmed, limit, readonly)
    if kind == "mysql":
        raise ValueError("mysql driver not installed — run `pip install aiomysql` in the backend environment")
    if kind == "mssql":
        raise ValueError("mssql driver not installed — run `pip install pyodbc` (plus a system ODBC driver) in the backend environment")
    raise ValueError(f"unsupported data source kind: {kind}")


async def _run_postgres_query(connection: str, sql: str, limit: int, readonly: bool = True) -> dict:
    try:
        import asyncpg
    except ImportError:
        raise ValueError("asyncpg not installed — run `pip install asyncpg`")
    import asyncio
    conn = await asyncio.wait_for(asyncpg.connect(connection), timeout=DB_QUERY_TIMEOUT_SECONDS)
    try:
        # readonly is enforced server-side by Postgres itself (not a text
        # scan of `sql`) — any write attempt, including one hidden inside a
        # SELECTed function call (e.g. `SELECT setval(...)`), fails at the
        # DB level because the whole transaction is READ ONLY. The
        # is_read_only_sql() keyword check above is defense-in-depth /
        # a friendlier error message, not the actual gate.
        async def _fetch():
            stmt = await conn.prepare(sql)
            all_rows = await stmt.fetch()
            columns = [a.name for a in stmt.get_attributes()] if all_rows else []
            return all_rows, columns

        if readonly:
            async with conn.transaction(readonly=True):
                all_rows, columns = await asyncio.wait_for(_fetch(), timeout=DB_QUERY_TIMEOUT_SECONDS)
        else:
            all_rows, columns = await asyncio.wait_for(_fetch(), timeout=DB_QUERY_TIMEOUT_SECONDS)
        rows = [dict(r) for r in all_rows[:limit]]
        return _result(rows, columns, len(all_rows) > limit)
    finally:
        await conn.close()


def _run_sqlite_query(connection: str, sql: str, limit: int, readonly: bool) -> dict:
    import sqlite3
    assert_safe_external_path(connection)
    uri = f"file:{connection}?mode=ro" if readonly else connection
    conn = sqlite3.connect(uri, uri=readonly)
    conn.row_factory = sqlite3.Row
    try:
        cur = conn.cursor()
        cur.execute(sql)
        is_select = bool(re.match(r"^\s*(select|with|pragma|explain)\b", sql, re.IGNORECASE))
        if is_select:
            all_rows = cur.fetchall()
            rows = [dict(r) for r in all_rows[:limit]]
            columns = [d[0] for d in cur.description] if cur.description else []
            return _result(rows, columns, len(all_rows) > limit)
        conn.commit()
        return {"rows": [], "columns": [], "row_count": cur.rowcount, "truncated": False}
    finally:
        conn.close()


def _apply_filter(rows: List[dict], columns: List[str], filt: Optional[dict]) -> List[dict]:
    if not filt or not isinstance(filt, dict):
        return rows
    col, op, val = filt.get("col"), filt.get("op", "eq"), filt.get("val")
    if not col or col not in columns:
        return rows
    def keep(r):
        cell = r.get(col)
        if op == "eq": return cell == val
        if op == "neq": return cell != val
        if op == "gt": return _num(cell) > _num(val)
        if op == "gte": return _num(cell) >= _num(val)
        if op == "lt": return _num(cell) < _num(val)
        if op == "lte": return _num(cell) <= _num(val)
        if op == "contains": return str(val or "").lower() in str(cell or "").lower()
        return True
    return [r for r in rows if keep(r)]


def _num(v) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return 0.0


def _run_excel_query(path: str, raw: str, limit: int) -> dict:
    try:
        import openpyxl
    except ImportError:
        raise ValueError("openpyxl not installed — run `pip install openpyxl`")
    import os
    import json as _json
    assert_safe_external_path(path)
    if not os.path.exists(path):
        raise ValueError(f"Excel file not found: {path}")
    try:
        q = _json.loads(raw)
    except Exception:
        q = {"sheet": raw.strip()} if raw and raw.strip() else {}
    wb = openpyxl.load_workbook(path, data_only=True, read_only=True)
    sheet_name = q.get("sheet") or wb.sheetnames[0]
    if sheet_name not in wb.sheetnames:
        raise ValueError(f'Sheet "{sheet_name}" not found. Available: {", ".join(wb.sheetnames)}')
    ws = wb[sheet_name]
    all_rows_raw = list(ws.iter_rows(values_only=True))
    if not all_rows_raw:
        return _result([], [], False)
    columns = [str(c) if c is not None else f"col{i}" for i, c in enumerate(all_rows_raw[0])]
    rows = [dict(zip(columns, r)) for r in all_rows_raw[1:]]
    rows = _apply_filter(rows, columns, q.get("filter"))
    truncated = len(rows) > limit
    return _result(rows[:limit], columns, truncated)


def _run_csv_query(path: str, raw: str, limit: int) -> dict:
    import csv as csv_mod
    import os
    import json as _json
    assert_safe_external_path(path)
    if not os.path.exists(path):
        raise ValueError(f"CSV file not found: {path}")
    with open(path, "r", encoding="utf-8", newline="") as f:
        reader = csv_mod.DictReader(f)
        columns = reader.fieldnames or []
        rows = list(reader)
    try:
        q = _json.loads(raw)
    except Exception:
        q = {}
    rows = _apply_filter(rows, columns, q.get("filter"))
    truncated = len(rows) > limit
    return _result(rows[:limit], columns, truncated)


async def describe_source(kind: str, connection: str) -> dict:
    """Schema introspection — tables/columns for SQL sources, sheet/column
    names for excel/csv. No caching (naxionai's data volumes don't yet
    warrant the TTL cache the TS original added for a slow remote scan)."""
    if kind == "postgres":
        r = await _run_postgres_query(connection, """
            SELECT table_schema, table_name, column_name, data_type
            FROM information_schema.columns
            WHERE table_schema NOT IN ('pg_catalog','information_schema')
            ORDER BY table_schema, table_name, ordinal_position
        """, 10000)
        return _rows_to_tables(r["rows"], "table_schema", "table_name", "column_name", "data_type")
    if kind == "sqlite":
        r = _run_sqlite_query(connection, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name", 1000, True)
        tables = []
        for row in r["rows"]:
            tname = row["name"]
            if tname.startswith("sqlite_"):
                continue
            cols = _run_sqlite_query(connection, f'PRAGMA table_info("{tname}")', 1000, True)
            tables.append({"name": tname, "columns": [{"name": c["name"], "type": c["type"]} for c in cols["rows"]]})
        return {"tables": tables}
    if kind in ("mysql", "mssql", "mongodb"):
        raise ValueError(f"{kind} driver not installed — see run_query's error for the install command")
    if kind == "excel":
        r = _run_excel_query(connection, "{}", 1)
        return {"tables": [{"name": "sheet1", "columns": [{"name": c, "type": "unknown"} for c in r["columns"]]}]}
    if kind == "csv":
        r = _run_csv_query(connection, "{}", 1)
        return {"tables": [{"name": "data", "columns": [{"name": c, "type": "unknown"} for c in r["columns"]]}]}
    raise ValueError(f"unsupported data source kind: {kind}")


def _rows_to_tables(rows: List[dict], schema_key: str, table_key: str, col_key: str, type_key: str) -> dict:
    by_table: Dict[str, List[dict]] = {}
    for row in rows:
        key = f"{row[schema_key]}.{row[table_key]}"
        by_table.setdefault(key, []).append({"name": row[col_key], "type": row[type_key]})
    return {"tables": [{"name": k, "columns": v} for k, v in by_table.items()]}


def redact_connection(conn: str, kind: str) -> str:
    if kind in ("sqlite", "excel", "csv"):
        return conn
    return re.sub(r"(://[^:@]+:)([^@]+)(@)", r"\1***\3", conn)
