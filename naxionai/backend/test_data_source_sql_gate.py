"""
Tests for data_source_client.py's read-only SQL gate (data_source_client.py:
14-31, 83-100) — a regex keyword blocklist, NOT a SQL parser. Several tests
below document known bypass shapes rather than fixing them (out of scope
for this pass; the regex-vs-parser trade-off is inherited from the ported
TS original).
"""

import os
import sqlite3
import tempfile

import pytest

import data_source_client as dsc


class TestIsReadOnlySql:
    @pytest.mark.parametrize("sql", [
        "SELECT * FROM users",
        "WITH t AS (SELECT 1) SELECT * FROM t",
        "SHOW TABLES",
        "EXPLAIN SELECT * FROM users",
        "PRAGMA table_info(users)",
    ])
    def test_read_statements_pass(self, sql):
        assert dsc.is_read_only_sql(sql) is True

    @pytest.mark.parametrize("sql,keyword", [
        ("INSERT INTO users VALUES (1)", "insert"),
        ("UPDATE users SET x=1", "update"),
        ("DELETE FROM users", "delete"),
        ("DROP TABLE users", "drop"),
        ("ALTER TABLE users ADD COLUMN x INT", "alter"),
        ("TRUNCATE TABLE users", "truncate"),
        ("CREATE TABLE x (id INT)", "create"),
        ("GRANT ALL ON users TO bob", "grant"),
        ("REVOKE ALL ON users FROM bob", "revoke"),
        ("EXEC sp_configure", "exec"),
        ("EXECUTE some_proc", "execute"),
        ("MERGE INTO users USING x ON (1=1)", "merge/into"),
        ("REPLACE INTO users VALUES (1)", "replace/into"),
        ("ATTACH DATABASE 'x.db' AS x", "attach"),
        ("COPY users TO '/tmp/x.csv'", "copy"),
        ("VACUUM", "vacuum"),
        ("REINDEX users", "reindex"),
        ("SELECT * INTO OUTFILE '/tmp/x' FROM users", "outfile"),
        ("SELECT load_file('/etc/passwd')", "load_file"),
        ("SELECT * FROM users; LOAD DATA INFILE '/tmp/x' INTO TABLE users", "load data/infile/into"),
        ("SELECT pg_read_file('/etc/passwd')", "pg_read_file"),
        ("SELECT pg_ls_dir('/etc')", "pg_ls_dir"),
        ("EXEC xp_cmdshell 'dir'", "xp_cmdshell"),
        ("EXEC sp_configure 'show advanced options', 1", "sp_configure"),
    ])
    def test_write_or_dangerous_statements_are_blocked(self, sql, keyword):
        assert dsc.is_read_only_sql(sql) is False, f"expected block for {keyword}: {sql}"

    def test_documented_bypass_sql_comment_split_keyword(self):
        # \b word-boundary matching means splitting a keyword with an inline
        # comment defeats the regex entirely — a real, known gap. Uses UPDATE
        # (not INSERT) specifically so the statement doesn't incidentally
        # contain another blocked word like "into" that would mask the bypass.
        sneaky = "UPD/**/ATE users SET x=1 WHERE id=1"
        assert dsc.is_read_only_sql(sneaky) is True  # WRONGLY treated as read-only

    def test_documented_bypass_fullwidth_unicode_keyword(self):
        # Full-width Unicode characters don't match the ASCII keyword regex.
        # Uses DROP (not INSERT) so the statement doesn't incidentally contain
        # another blocked ASCII word like "into".
        sneaky = "ＤＲＯＰ TABLE users"
        assert dsc.is_read_only_sql(sneaky) is True  # WRONGLY treated as read-only

    def test_benign_into_false_positive_is_blocked_anyway(self):
        # "INTO" is blocked unconditionally (to catch SELECT...INTO OUTFILE),
        # so a completely benign SELECT ... INTO also trips it — a documented
        # false positive, safe-by-default rather than a real gap.
        assert dsc.is_read_only_sql("SELECT * FROM t INTO x") is False


class TestRunQueryGate:
    @pytest.mark.asyncio
    async def test_run_query_raises_on_write_when_readonly(self):
        with pytest.raises(ValueError, match="read-only"):
            await dsc.run_query("sqlite", ":memory:", "DROP TABLE users", readonly=True)

    @pytest.mark.asyncio
    async def test_mysql_reports_missing_driver_not_a_crash(self):
        with pytest.raises(ValueError, match="mysql driver not installed"):
            await dsc.run_query("mysql", "mysql://x", "SELECT 1", readonly=True)

    @pytest.mark.asyncio
    async def test_mssql_reports_missing_driver_not_a_crash(self):
        with pytest.raises(ValueError, match="mssql driver not installed"):
            await dsc.run_query("mssql", "mssql://x", "SELECT 1", readonly=True)

    @pytest.mark.asyncio
    async def test_mongodb_reports_missing_driver_not_a_crash(self):
        with pytest.raises(ValueError, match="mongodb driver not installed"):
            await dsc.run_query("mongodb", "mongodb://x", "{}", readonly=True)


class TestSqliteReadOnlySecondLayer:
    @pytest.fixture
    def sample_db(self):
        fd, path = tempfile.mkstemp(suffix=".db")
        os.close(fd)
        conn = sqlite3.connect(path)
        conn.execute("CREATE TABLE t (id INTEGER, name TEXT)")
        conn.execute("INSERT INTO t VALUES (1, 'a')")
        conn.commit()
        conn.close()
        yield path
        os.remove(path)

    @pytest.mark.asyncio
    async def test_select_works_through_readonly_uri(self, sample_db):
        result = await dsc.run_query("sqlite", sample_db, "SELECT * FROM t", readonly=True)
        assert result["row_count"] == 1
        assert result["rows"][0]["name"] == "a"

    def test_os_level_write_attempt_on_readonly_connection_raises(self, sample_db):
        # A second, independent enforcement layer specific to sqlite: opening
        # the file itself in `mode=ro` (data_source_client.py:85) means even a
        # write statement that somehow got past the regex gate is rejected by
        # SQLite itself at the OS/driver level.
        uri = f"file:{sample_db}?mode=ro"
        conn = sqlite3.connect(uri, uri=True)
        try:
            with pytest.raises(sqlite3.OperationalError):
                conn.execute("INSERT INTO t VALUES (2, 'b')")
                conn.commit()
        finally:
            conn.close()


class TestRedactConnection:
    def test_credentials_redacted_for_networked_sources(self):
        redacted = dsc.redact_connection("postgresql://user:secretpass@host:5432/db", "postgres")
        assert "secretpass" not in redacted
        assert "user" in redacted

    @pytest.mark.parametrize("kind", ["sqlite", "excel", "csv"])
    def test_file_based_sources_are_not_touched(self, kind):
        conn = "/some/local/path.db"
        assert dsc.redact_connection(conn, kind) == conn
