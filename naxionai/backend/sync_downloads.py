"""
NAXIONAI — Downloads folder organizer (Phase 6).

Ported from neuroworks/server/src/lib/sync-downloads.ts. Walks the user's
Downloads folder (or another source dir), copies files into the vault under
_knowledge/downloads/files/<category>/ (originals are never moved or
deleted), and writes an inventory.md index. Skips anything already copied
and unchanged (by size + mtime) on repeat runs.
"""

import json
import shutil
from dataclasses import dataclass, field
from pathlib import Path

from config import get_settings

_CATEGORIES: dict[str, set[str]] = {
    "Documents": {".pdf", ".docx", ".doc", ".md", ".txt", ".rtf", ".odt", ".epub"},
    "Slides": {".pptx", ".ppt", ".key", ".odp"},
    "Spreadsheets": {".xlsx", ".xls", ".csv", ".ods", ".numbers"},
    "Images": {".png", ".jpg", ".jpeg", ".webp", ".gif", ".svg", ".heic", ".cr2", ".raw", ".bmp", ".tiff"},
    "Video": {".mp4", ".mov", ".avi", ".mkv", ".webm", ".m4v"},
    "Audio": {".mp3", ".wav", ".m4a", ".ogg", ".flac", ".aac"},
    "Archives": {".zip", ".tar", ".gz", ".rar", ".7z", ".bz2"},
    "Web": {".html", ".htm"},
    "Code": {".js", ".ts", ".tsx", ".jsx", ".json", ".py", ".rb", ".go", ".rs", ".sh", ".yaml", ".yml"},
}
_SKIP_NAMES = {".DS_Store", "Thumbs.db", "desktop.ini"}
_MAX_BYTES = 90 * 1024 * 1024  # matches the vault-is-a-git-repo blob cap (GitHub hard-rejects >100MB)
_MAX_DEPTH = 4


def _categorize(name: str) -> str:
    ext = Path(name).suffix.lower()
    for cat, exts in _CATEGORIES.items():
        if ext in exts:
            return cat
    return "Other"


def _fmt_size(n: int) -> str:
    if n < 1024:
        return f"{n} B"
    if n < 1024 * 1024:
        return f"{n / 1024:.1f} KB"
    if n < 1024 * 1024 * 1024:
        return f"{n / 1024 / 1024:.1f} MB"
    return f"{n / 1024 / 1024 / 1024:.2f} GB"


def _walk(root: Path, depth: int = 0):
    if depth > _MAX_DEPTH:
        return
    try:
        entries = list(root.iterdir())
    except OSError:
        return
    for e in entries:
        if e.name.startswith(".") or e.name in _SKIP_NAMES:
            continue
        if e.is_dir():
            yield from _walk(e, depth + 1)
        elif e.is_file():
            yield e


@dataclass
class SyncResult:
    source: str
    total_files: int
    by_category: dict[str, list[dict]] = field(default_factory=dict)
    copied_this_run: list[dict] = field(default_factory=list)
    copy_errors: list[dict] = field(default_factory=list)
    bytes_copied: int = 0


def sync_downloads(source: str | None = None) -> SyncResult:
    settings = get_settings()
    src_root = Path(source).expanduser() if source else Path.home() / "Downloads"
    if not src_root.exists():
        raise FileNotFoundError(f"source not found: {src_root}")

    dst_base = Path(settings.vault_path).resolve() / "_knowledge" / "downloads"
    files_base = dst_base / "files"
    state_file = dst_base / ".sync-state.json"
    files_base.mkdir(parents=True, exist_ok=True)

    try:
        state: dict[str, list[float]] = json.loads(state_file.read_text()) if state_file.exists() else {}
    except (OSError, ValueError):
        state = {}
    new_state: dict[str, list[float]] = {}

    by_category: dict[str, list[dict]] = {}
    copied: list[dict] = []
    errors: list[dict] = []
    bytes_copied = 0
    total = 0

    for full in _walk(src_root):
        name = full.name
        try:
            st = full.stat()
        except OSError:
            continue
        if st.st_size > _MAX_BYTES:
            errors.append({"name": name, "error": f"over {_fmt_size(_MAX_BYTES)} cap"})
            continue

        total += 1
        cat = _categorize(name)
        cat_dir = files_base / cat
        cat_dir.mkdir(parents=True, exist_ok=True)
        dst = cat_dir / name
        rel_path = f"files/{cat}/{name}"
        size_mtime = [st.st_size, int(st.st_mtime)]

        prev = state.get(name)
        unchanged = prev == size_mtime and dst.exists()
        if not unchanged:
            try:
                shutil.copyfile(full, dst)
                copied.append({"name": name, "size": st.st_size})
                bytes_copied += st.st_size
            except OSError as e:
                errors.append({"name": name, "error": str(e)})
                continue

        new_state[name] = size_mtime
        by_category.setdefault(cat, []).append({"name": name, "rel_path": rel_path, "size": st.st_size, "mtime": st.st_mtime})

    for xs in by_category.values():
        xs.sort(key=lambda x: x["mtime"], reverse=True)

    state_file.write_text(json.dumps(new_state, indent=2))

    inventory = _render_inventory(str(src_root), by_category, copied, errors, bytes_copied)
    (dst_base / "inventory.md").write_text(inventory, encoding="utf-8")

    return SyncResult(source=str(src_root), total_files=total, by_category=by_category, copied_this_run=copied, copy_errors=errors, bytes_copied=bytes_copied)


def _render_inventory(source: str, by_category: dict[str, list[dict]], copied: list[dict], errors: list[dict], bytes_copied: int) -> str:
    from datetime import date
    today = date.today().isoformat()
    cats = sorted(by_category.keys(), key=lambda c: -len(by_category[c]))
    total = sum(len(xs) for xs in by_category.values())

    lines = [
        "---", f"title: Downloads inventory ({today})", "tags: [downloads, inventory, naxie]",
        f"created: {today}", "source: naxie sync-downloads", "---", "",
        "# Downloads inventory", "",
        f"Mirror of `{source}` on {today}. Files are **copied** into `files/<category>/` so the vault "
        "has a self-contained archive — originals are never moved or deleted.", "",
        f"Total files: **{total}** across **{len(cats)}** categories. Copied this run: **{len(copied)}** "
        f"({_fmt_size(bytes_copied)}). Copy errors: **{len(errors)}**.", "",
    ]
    if copied:
        lines.append(f"## New / changed since last sync ({len(copied)})")
        lines.append("")
        for c in copied[:60]:
            lines.append(f"- `{c['name']}`")
        if len(copied) > 60:
            lines.append(f"- _…and {len(copied) - 60} more_")
        lines.append("")
    if errors:
        lines.append(f"## Copy errors ({len(errors)})")
        lines.append("")
        for e in errors[:40]:
            lines.append(f"- `{e['name']}` — {e['error']}")
        lines.append("")
    for cat in cats:
        xs = by_category[cat]
        lines.append(f"## {cat} ({len(xs)})")
        lines.append("")
        lines.append("| File | Size | Modified |")
        lines.append("|---|---|---|")
        from datetime import datetime
        for x in xs[:250]:
            mod = datetime.fromtimestamp(x["mtime"]).date().isoformat()
            lines.append(f"| [{x['name']}]({x['rel_path']}) | {_fmt_size(x['size'])} | {mod} |")
        if len(xs) > 250:
            lines.append(f"| _…{len(xs) - 250} more not listed_ | | |")
        lines.append("")
    return "\n".join(lines)
