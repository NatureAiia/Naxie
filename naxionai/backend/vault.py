"""
NAXIONAI — Personal knowledge vault (Phase 6).

Ported from neuroworks/server/src/lib/{vault,vault-index}.ts: a git-backed,
Obsidian-compatible folder of markdown notes that the agent (and the
operator, via Obsidian directly) reads and writes.

Scope trimmed from the original for a single-operator local app:
  - No fs.watch external-edit detection — a short in-memory TTL cache
    (SEARCH_CACHE_TTL_SECONDS) is invalidated on every write instead. An
    Obsidian edit made while the server is running is picked up once the
    cache expires, or immediately after any write-triggered invalidation.
  - No auto-rebase-with-sidestepped-conflicts recovery. Matches the
    conservative philosophy already established for agent/tools/pa_tools.py's
    git_command tool: pull is --ff-only and refuses rather than silently
    resolving a conflict. Commit+push likewise fails loudly instead of
    attempting a rebase.
  - Search index is a simple in-memory inverted index (token -> doc ids)
    rather than a MiniSearch-equivalent library — adequate at personal-vault
    scale and avoids a new dependency.
"""

import re
import subprocess
import time
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional

from config import get_settings
from security_scan import scan_for_security_risks

settings = get_settings()

HIDDEN_PREFIXES = (".obsidian", ".git", "node_modules")
TEXT_EXTS = {".md", ".markdown", ".txt", ".canvas"}
MAX_INDEXED_FILE_BYTES = 1_000_000
SEARCH_CACHE_TTL_SECONDS = 60
GIT_TIMEOUT_SECONDS = 30


def _vault_root() -> Path:
    return Path(settings.vault_path).resolve()


class VaultUnreachable(Exception):
    def __init__(self, vault_path: Path):
        super().__init__(f'vault path "{vault_path}" is unreachable (drive unmounted, path renamed, or VAULT_PATH misconfigured)')
        self.vault_path = vault_path


class VaultSecurityRefusal(Exception):
    def __init__(self, findings: list[dict]):
        types = ", ".join(f["type"] for f in findings)
        super().__init__(f"refusing vault write — {len(findings)} high-severity finding(s): {types}")
        self.findings = findings


def _assert_vault_exists() -> Path:
    root = _vault_root()
    if not root.exists():
        raise VaultUnreachable(root)
    return root


def _ensure_inside_vault(root: Path, full: Path) -> None:
    try:
        full.resolve().relative_to(root.resolve())
    except ValueError:
        raise PermissionError(f"path escapes vault: {full}")


def get_vault_health() -> dict:
    root = _vault_root()
    exists = root.exists()
    reason = None
    git_repo = False
    if not exists:
        reason = f'vault path "{root}" not found (drive unmounted, path renamed, or VAULT_PATH misconfigured)'
    elif not root.is_dir():
        exists = False
        reason = f'vault path "{root}" exists but is not a directory'
    else:
        git_repo = (root / ".git").exists()
        if not git_repo:
            reason = "vault directory exists but contains no .git — git sync will not work until you run `git init` in this folder"
    return {
        "ok": exists and git_repo,
        "vault_path": str(root),
        "exists": exists,
        "git_repo": git_repo,
        "reason": reason,
        "index": _index_stats(),
    }


def list_vault(rel: str = "") -> list[dict]:
    root = _assert_vault_exists()
    full = (root / rel).resolve()
    _ensure_inside_vault(root, full)
    if not full.exists():
        return []
    entries = sorted(
        (e for e in full.iterdir() if not any(e.name.startswith(p) for p in HIDDEN_PREFIXES)),
        key=lambda e: (not e.is_dir(), e.name.lower()),
    )
    out = []
    for e in entries:
        child_rel = e.resolve().relative_to(root).as_posix()
        out.append({"name": e.name, "path": child_rel, "type": "dir" if e.is_dir() else "file"})
    return out


def read_vault_file(rel: str) -> str:
    root = _assert_vault_exists()
    full = (root / rel).resolve()
    _ensure_inside_vault(root, full)
    return full.read_text(encoding="utf-8")


def write_vault_file(rel: str, content: str) -> None:
    root = _assert_vault_exists()
    full = (root / rel).resolve()
    _ensure_inside_vault(root, full)
    if settings.vault_scan_enabled:
        findings = scan_for_security_risks(content, "note")
        high = [f for f in findings if f.severity == "high"]
        if high:
            # Refuse outright — never commit a secret. The caller can scan
            # explicitly, redact, and retry if the write is genuinely needed.
            raise VaultSecurityRefusal([{"type": f.type, "severity": f.severity, "reason": f.reason} for f in high])
    full.parent.mkdir(parents=True, exist_ok=True)
    full.write_text(content, encoding="utf-8")
    if not _is_machine_state_path(rel):
        _invalidate_search_cache()


def _is_machine_state_path(rel: str) -> bool:
    """_naxionai/ is this app's own audit/state tree inside the vault, not
    user knowledge — writes there (e.g. job journals) must not bust the
    search cache on every single one."""
    norm = rel.replace("\\", "/").lstrip("./")
    return norm == "_naxionai" or norm.startswith("_naxionai/")


def import_binary_into_vault(rel: str, source_abs_path: str) -> dict:
    """Copy a binary file (PDF, image, etc.) into the vault. Skips the
    secret scan (binaries aren't text) but still enforces containment.
    Copies, never moves — the source is left in place."""
    import shutil

    root = _assert_vault_exists()
    full = (root / rel).resolve()
    _ensure_inside_vault(root, full)
    src = Path(source_abs_path)
    if not src.is_file():
        raise FileNotFoundError(f"source is not a file: {src}")
    full.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(src, full)
    _invalidate_search_cache()
    return {"rel": rel, "abs": str(full), "size": full.stat().st_size}


# ── Search ───────────────────────────────────────────────────────────────

@dataclass
class SearchHit:
    path: str
    line: int
    preview: str


@dataclass
class _Index:
    docs: dict[str, str] = field(default_factory=dict)          # rel path -> full text
    postings: dict[str, set[str]] = field(default_factory=lambda: defaultdict(set))  # token -> rel paths
    built_at: float = 0.0


_index: Optional[_Index] = None
_search_cache: dict[str, tuple[float, list[SearchHit]]] = {}
_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> set[str]:
    return set(_TOKEN_RE.findall(text.lower()))


def _walk_text_files(root: Path):
    for p in root.rglob("*"):
        if any(part.startswith(HIDDEN_PREFIXES) for part in p.relative_to(root).parts):
            continue
        if p.is_file() and p.suffix.lower() in TEXT_EXTS:
            yield p


def build_index() -> None:
    global _index
    root = _vault_root()
    if not root.exists():
        return
    idx = _Index()
    for full in _walk_text_files(root):
        try:
            if full.stat().st_size > MAX_INDEXED_FILE_BYTES:
                continue
            body = full.read_text(encoding="utf-8", errors="ignore")
            rel = full.resolve().relative_to(root).as_posix()
            idx.docs[rel] = body
            for tok in _tokenize(body):
                idx.postings[tok].add(rel)
        except Exception:
            continue  # one bad file must not take the whole index down
    idx.built_at = time.time()
    _index = idx


def _index_stats() -> dict:
    return {
        "ready": _index is not None,
        "docs": len(_index.docs) if _index else 0,
        "age_seconds": (time.time() - _index.built_at) if _index else -1,
    }


def _invalidate_search_cache() -> None:
    _search_cache.clear()
    global _index
    _index = None


def _preview_for(body: str, query_terms: list[str]) -> tuple[int, str]:
    lines = body.split("\n")
    for i, line in enumerate(lines):
        lower = line.lower()
        if any(t in lower for t in query_terms):
            return i + 1, line[:200]
    return 1, lines[0][:200] if lines else ""


def search_vault(query: str, limit: int = 50) -> list[SearchHit]:
    _assert_vault_exists()
    q = query.lower().strip()
    key = f"{q}|{limit}"
    cached = _search_cache.get(key)
    if cached and time.time() - cached[0] < SEARCH_CACHE_TTL_SECONDS:
        return cached[1]

    if _index is None:
        build_index()
    assert _index is not None

    terms = [t for t in _TOKEN_RE.findall(q) if t]
    if terms:
        matching_sets = [_index.postings.get(t, set()) for t in terms]
        candidates = set.intersection(*matching_sets) if matching_sets else set()
    else:
        candidates = set()

    results: list[SearchHit] = []
    for rel in sorted(candidates)[: limit * 3]:  # over-fetch slightly before per-doc preview filtering
        if len(results) >= limit:
            break
        line, preview = _preview_for(_index.docs[rel], terms)
        results.append(SearchHit(path=rel, line=line, preview=preview))

    # Fallback: substring walk if the AND-tokenized index found nothing —
    # catches queries that are substrings within a single token (e.g. "vau").
    if not results:
        root = _vault_root()
        for full in _walk_text_files(root):
            if len(results) >= limit:
                break
            try:
                body = full.read_text(encoding="utf-8", errors="ignore")
            except Exception:
                continue
            rel = full.resolve().relative_to(root).as_posix()
            for i, line in enumerate(body.split("\n")):
                if q in line.lower():
                    results.append(SearchHit(path=rel, line=i + 1, preview=line[:200]))
                    break

    _search_cache[key] = (time.time(), results)
    return results


def search_vault_filenames(query: str, limit: int = 5) -> list[SearchHit]:
    """Filename-only scan — never opens file contents. Used for cheap
    "do we already have notes on X?" probes."""
    root = _vault_root()
    if not root.exists():
        return []
    tokens = [t for t in re.split(r"[-_\s]+", query.lower()) if t]
    if not tokens:
        return []
    out: list[SearchHit] = []
    for full in root.rglob("*.md"):
        if len(out) >= limit:
            break
        if any(part.startswith(HIDDEN_PREFIXES) for part in full.relative_to(root).parts):
            continue
        normalized = re.sub(r"[-_]+", " ", full.stem.lower())
        if all(t in normalized for t in tokens):
            out.append(SearchHit(path=full.resolve().relative_to(root).as_posix(), line=0, preview=full.name))
    return out


# ── Git sync ─────────────────────────────────────────────────────────────
# Same conservative philosophy as agent/tools/pa_tools.py's git_command:
# never auto-merge, never silently resolve a conflict — fail loudly instead.

def _run_git(*args: str, timeout: int = GIT_TIMEOUT_SECONDS) -> subprocess.CompletedProcess:
    root = _vault_root()
    return subprocess.run(
        ["git", "-C", str(root), *args],
        capture_output=True, text=True, timeout=timeout,
    )


def clear_stale_vault_lock(stale_after_seconds: int = 60) -> dict:
    """Remove a `.git/index.lock` left behind by a crashed git process, but
    only if it's older than `stale_after_seconds` — a fresh lock means a
    real git operation is in flight."""
    lock = _vault_root() / ".git" / "index.lock"
    if not lock.exists():
        return {"cleared": False, "reason": "no lock present"}
    age = time.time() - lock.stat().st_mtime
    if age < stale_after_seconds:
        return {"cleared": False, "reason": f"lock is fresh ({age:.1f}s) — leaving alone", "age_seconds": age}
    try:
        lock.unlink()
        return {"cleared": True, "age_seconds": age}
    except OSError as e:
        return {"cleared": False, "reason": str(e), "age_seconds": age}


def vault_ahead_by() -> Optional[int]:
    """How many local commits haven't reached origin. None on any failure
    (not a git repo, transient lock, etc.)."""
    try:
        res = _run_git("status", "--porcelain=v1", "--branch")
        if res.returncode != 0:
            return None
        first_line = res.stdout.splitlines()[0] if res.stdout else ""
        m = re.search(r"ahead (\d+)", first_line)
        return int(m.group(1)) if m else 0
    except Exception:
        return None


def commit_and_push(message: str) -> dict:
    clear_stale_vault_lock()
    add = _run_git("add", ".")
    if add.returncode != 0:
        return {"committed": False, "error": add.stderr.strip()}

    status = _run_git("status", "--porcelain")
    if not status.stdout.strip():
        return {"committed": False}

    commit = _run_git("commit", "-m", message)
    if commit.returncode != 0:
        return {"committed": False, "error": commit.stderr.strip()}

    push = _run_git("push", "origin", "HEAD", timeout=GIT_TIMEOUT_SECONDS)
    if push.returncode == 0:
        return {"committed": True, "pushed": True}
    return {"committed": True, "pushed": False, "error": (push.stdout + push.stderr).strip()}


def push_only() -> dict:
    clear_stale_vault_lock()
    ahead = vault_ahead_by()
    push = _run_git("push", "origin", "HEAD")
    if push.returncode == 0:
        return {"pushed": True, "ahead_by": ahead}
    return {"pushed": False, "error": (push.stdout + push.stderr).strip(), "ahead_by": ahead}


def pull_from_origin() -> dict:
    """--ff-only, matching git_command's philosophy: refuse loudly on
    divergence instead of auto-rebasing over local history."""
    root = _vault_root()
    if not root.exists():
        return {"ok": False, "reason": f"vault path {root} not present (drive unmounted?)"}
    status = _run_git("status", "--porcelain")
    if status.stdout.strip():
        return {"ok": False, "reason": "local has uncommitted changes; pull skipped to avoid conflicts"}
    pull = _run_git("pull", "--ff-only", "origin", "HEAD", timeout=GIT_TIMEOUT_SECONDS)
    if pull.returncode == 0:
        out = (pull.stdout + pull.stderr).strip()
        pulled = "Already up to date" not in out
        if pulled:
            _invalidate_search_cache()
        return {"ok": True, "pulled": pulled, "detail": out}
    return {"ok": False, "reason": (pull.stdout + pull.stderr).strip()}
