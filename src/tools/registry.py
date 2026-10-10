"""Real tool implementations for Naxie — file/code/shell/web.

All filesystem tools are sandboxed to the workspace root (repo root).
Secrets (.env, credentials, .git/) are never readable/writable.
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path
from typing import Any, Awaitable, Callable, Dict, List

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]

DENIED_NAMES = {".env", ".env.example", "credentials.json", "secrets.yaml", ".git"}
DENIED_PARTS = {".git", "__pycache__", "node_modules", ".venv", "venv"}

BASH_DENY_RE = re.compile(
    r"(rm\s+-rf|del\s+/[sf]|format\s+[a-z]:|shutdown|reboot|mkfs|diskpart|"
    r"takeown|icacls\s+.*\/grant|powershell\s+.*-EncodedCommand)",
    re.IGNORECASE,
)


def _safe_path(path: str) -> Path:
    p = (WORKSPACE_ROOT / path).resolve() if not Path(path).is_absolute() else Path(path).resolve()
    if WORKSPACE_ROOT not in p.parents and p != WORKSPACE_ROOT:
        raise PermissionError(f"Path escapes workspace: {path}")
    if p.name in DENIED_NAMES:
        raise PermissionError(f"Blocked secret file: {p.name}")
    if any(part in DENIED_PARTS for part in p.parts):
        raise PermissionError(f"Blocked directory in path: {path}")
    return p


async def file_read(path: str, max_chars: int = 20000) -> Dict[str, Any]:
    p = _safe_path(path)
    if not p.is_file():
        raise FileNotFoundError(f"Not a file: {path}")
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    truncated = len(text) > max_chars
    return {"path": str(p.relative_to(WORKSPACE_ROOT)), "content": text[:max_chars], "truncated": truncated}


async def file_list(directory: str = ".", pattern: str = "*") -> Dict[str, Any]:
    p = _safe_path(directory)
    if not p.is_dir():
        raise NotADirectoryError(f"Not a directory: {directory}")
    files = sorted(str(f.relative_to(WORKSPACE_ROOT)) for f in p.glob(pattern) if f.is_file())[:200]
    return {"directory": str(p.relative_to(WORKSPACE_ROOT)), "files": files}


async def file_write(path: str, content: str) -> Dict[str, Any]:
    p = _safe_path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(content, encoding="utf-8")
    return {"path": str(p.relative_to(WORKSPACE_ROOT)), "bytes": len(content.encode())}


async def file_edit(path: str, old_string: str, new_string: str) -> Dict[str, Any]:
    p = _safe_path(path)
    if not p.is_file():
        raise FileNotFoundError(f"Not a file: {path}")
    text = p.read_text(encoding="utf-8-sig", errors="replace")
    if old_string not in text:
        raise ValueError("old_string not found in file")
    text = text.replace(old_string, new_string, 1)
    p.write_text(text, encoding="utf-8")
    return {"path": str(p.relative_to(WORKSPACE_ROOT)), "edited": True}


async def code_analysis(target: str = ".", pattern: str = r"def |class |function ") -> Dict[str, Any]:
    """Grep-like static inspection over sandboxed files."""
    base = _safe_path(target) if Path(target).suffix or Path(target).exists() else WORKSPACE_ROOT
    if base.is_file():
        files = [base]
    else:
        files = [f for f in base.rglob("*.py") if not any(d in f.parts for d in DENIED_PARTS)][:100]
        files += [f for f in base.rglob("*.ts") if not any(d in f.parts for d in DENIED_PARTS)][:100]
    rx = re.compile(pattern)
    hits: List[Dict[str, Any]] = []
    for f in files[:200]:
        try:
            for i, line in enumerate(f.read_text(encoding="utf-8-sig", errors="replace").splitlines(), 1):
                if rx.search(line):
                    hits.append({"file": str(f.relative_to(WORKSPACE_ROOT)), "line": i, "text": line.strip()[:200]})
                    if len(hits) >= 100:
                        break
        except Exception:
            continue
    return {"target": target, "hits": hits, "files_scanned": len(files)}


async def bash_run(command: str, timeout_s: int = 30) -> Dict[str, Any]:
    if BASH_DENY_RE.search(command):
        raise PermissionError("Command blocked by denylist")
    proc = await asyncio.create_subprocess_shell(
        command,
        cwd=str(WORKSPACE_ROOT),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=timeout_s)
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError(f"Command timed out after {timeout_s}s")
    return {
        "command": command,
        "returncode": proc.returncode,
        "stdout": out.decode(errors="replace")[:8000],
        "stderr": err.decode(errors="replace")[:4000],
    }


async def web_retrieval(query: str, timeout_s: int = 10) -> Dict[str, Any]:
    """Fetch a URL directly, or report that live search is unconfigured."""
    import httpx

    q = query.strip()
    if re.match(r"https?://", q):
        async with httpx.AsyncClient(timeout=timeout_s, follow_redirects=True) as c:
            r = await c.get(q)
            return {"url": q, "status": r.status_code, "content": r.text[:8000]}
    return {
        "query": q,
        "results": [],
        "note": "Live web search not configured — pass a full https:// URL to fetch it.",
    }


async def database_query(query: str) -> Dict[str, Any]:
    return {"query": query, "rows": [], "note": "No database configured — stub."}


ToolFn = Callable[..., Awaitable[Dict[str, Any]]]

REGISTRY: Dict[str, ToolFn] = {
    "file_read": file_read,
    "file_list": file_list,
    "file_write": file_write,
    "file_edit": file_edit,
    "code_analysis": code_analysis,
    "bash_run": bash_run,
    "web_retrieval": web_retrieval,
    "database_query": database_query,
}

# JARVIS host skills (jarvis.py) — presence, awareness, host control.
# Imported lazily so a broken optional dep (httpx/psutil) can't take down
# the whole registry; missing skills simply stay unregistered.
def _register_jarvis() -> None:
    try:
        from src.tools import jarvis as _j
    except Exception:
        return
    for _name in ["get_time", "calculate", "system_status", "get_weather",
                  "notify_toast", "set_reminder", "list_reminders",
                  "system_control", "manage_clipboard", "git_command",
                  "browser_open", "speak", "host_settings"]:
        _fn = getattr(_j, _name, None)
        if callable(_fn):
            REGISTRY[_name] = _fn

_register_jarvis()

# Back-compat alias used by old plans.
REGISTRY["graph_search"] = web_retrieval


def get_tool(name: str) -> ToolFn:
    if name not in REGISTRY:
        raise KeyError(f"Unknown tool '{name}'. Available: {sorted(REGISTRY)}")
    return REGISTRY[name]


def allowed_tools() -> List[str]:
    return sorted(REGISTRY)
