"""Heuristic planner — turns raw intent into an executable CognitivePlan.

No LLM needed: regex/intent signals map to registry tools. When no tool
fits, the plan carries a `suggest_subagent` step so the executor returns an
explicit delegation suggestion instead of a chatty guess.
"""
from __future__ import annotations

import re
import uuid
from typing import Any, Dict, List

from src.core.models import CognitivePlan
from src.agents.subagents import suggest_subagents

# file path with extension: src/x.py, ./x, quoted "some file"
FILE_RE = re.compile(r"""(?P<q>["'`])(?P<qp>[\w\-./\\]+\.\w+)(?P=q)|(?P<p>(?:src|naxionai|config|docs|tests?)/[\w\-./\\]+\.\w+|\./[\w\-./\\]+)""")
# generic fallback: any path with a slash + extension (scratch/out.txt, data/a.json)
GENERIC_PATH_RE = re.compile(r"([\w\-.]+/[\w\-./\\]*\.\w+)")
# bare directory mention: "in src/tools", "src/agents folder"
DIR_RE = re.compile(r"\b(?:in|of|at|under)\s+((?:src|naxionai|config|docs|tests?)(?:/[\w\-.]+)*)", re.I)
CODE_VERBS = re.compile(r"\b(read|show|open|list|find|search|write|create|edit|update|fix|refactor|implement|delete|run|execute|test|analyze|analyse|audit|fetch|get)\b", re.I)
URL_RE = re.compile(r"https?://\S+")


def _extract_path(intent: str) -> str | None:
    m = FILE_RE.search(intent)
    if m:
        return ((m.group("qp") or m.group("p")) or "").strip("\"'`")
    g = GENERIC_PATH_RE.search(intent)
    if g:
        return g.group(1).strip("\"'`")
    # Secret/dotfile mention with no slash (".env") — return it so the tool
    # layer explicitly denies it instead of silently treating it as chatter.
    dot = re.search(r"(^|\s)(\.env(?:\.\w+)?)\b", intent)
    if dot:
        return dot.group(2)
    d = DIR_RE.search(intent)
    if d:
        return d.group(1).strip("\"'`")
    return None


def _parse_delay_seconds(lower: str) -> int:
    m = re.search(r"in\s+(\d+)\s*(second|minute|hour)", lower)
    if not m:
        return 0
    n = int(m.group(1))
    unit = m.group(2)
    return n if unit.startswith("second") else n * 60 if unit.startswith("minute") else n * 3600


def _extract_location(text: str) -> str:
    m = re.search(r"weather\s+(?:in|for|at)\s+([A-Za-z][\w\s.-]{1,60})", text, re.I)
    return m.group(1).strip() if m else "auto"


def build_plan(intent: str) -> tuple[CognitivePlan, list[str]]:
    """Return (plan, suggested_subagent_keys)."""
    steps: List[Dict[str, Any]] = []
    text = intent.strip()
    lower = text.lower()
    path = _extract_path(text)
    url = URL_RE.search(text)

    # JARVIS senses first — specific intents beat the generic file/code verbs.
    if re.search(r"\bweather\b|\bforecast\b|\btemperature outside\b", lower):
        steps.append({"tool": "get_weather", "payload": {"location": _extract_location(text)}})
    elif re.search(r"\bwhat time\b|\bwhat day\b|\bcurrent time\b|\btime is it\b|\bwhat date\b|\btoday'?s date\b", lower):
        steps.append({"tool": "get_time", "payload": {}})
    elif re.search(r"\bremind me\b|\breminder\b|\bremind\b", lower):
        title = re.sub(r"^(please\s+)?remind me (to|about)\s+", "", text, flags=re.I).strip()[:200] or text[:200]
        steps.append({"tool": "set_reminder", "payload": {"title": title, "message": title, "delay_seconds": _parse_delay_seconds(lower)}})
    elif re.search(r"\blist\b.*\breminders\b|\bmy reminders\b|\breminders\b.*\blist\b", lower):
        steps.append({"tool": "list_reminders", "payload": {}})
    elif re.search(r"\bcalculate\b|\bcompute\b|\bsolve\b|\bmath\b", lower) or re.search(r"what is [\d\s+\-*/().^%]+$", lower):
        expr = re.search(r"(?:calculate|compute|solve|what is)\s+(.+)$", text, re.I)
        steps.append({"tool": "calculate", "payload": {"expression": (expr.group(1) if expr else text)[:200]}})
    elif re.search(r"\bbattery\b|\bcpu\b|\bmemory\b|\bdisk space\b|\bsystem status\b|\bhow is the system\b", lower):
        steps.append({"tool": "system_status", "payload": {}})
    elif re.search(r"\bscreenshot\b", lower):
        steps.append({"tool": "system_control", "payload": {"action": "take_screenshot"}})
    elif re.search(r"\bmute\b|\bunmute\b|\bvolume\b", lower):
        steps.append({"tool": "system_control", "payload": {"action": "volume_mute" if "unmute" not in lower else "volume_unmute"}})
    elif re.search(r"\bopen\b|\blaunch\b", lower) and re.search(r"\bapp\b|\bnotepad\b|\bcalc\b|\bchrome\b|\bedge\b|\bterminal\b|\bexplorer\b", lower):
        app = next((a for a in ["notepad", "calculator", "chrome", "edge", "terminal", "explorer", "files", "paint", "cmd"] if a in lower), "")
        steps.append({"tool": "system_control", "payload": {"action": "open_app", "target": app}})
    elif re.search(r"\bclipboard\b|\bcopy to clipboard\b|\bpaste\b", lower):
        if "read" in lower or "paste" in lower or "show" in lower:
            steps.append({"tool": "manage_clipboard", "payload": {"action": "read"}})
        else:
            m = re.search(r"(?:write|copy|set)\s+(?:to clipboard\s+)?(.+)$", text, re.I)
            steps.append({"tool": "manage_clipboard", "payload": {"action": "write", "text": (m.group(1) if m else "")[:2000]}})
    elif re.search(r"\bgit (status|pull)\b", lower):
        steps.append({"tool": "git_command", "payload": {"action": "pull" if "pull" in lower else "status"}})
    elif re.search(r"\bspeak\b|\bsay out loud\b|\bread aloud\b", lower):
        spoken = re.sub(r"^(please\s+)?(speak|says? out loud|read aloud)\s+", "", text, flags=re.I).strip()[:1000]
        steps.append({"tool": "speak", "payload": {"text": spoken or text[:1000]}})
    elif re.search(r"\bnotify\b|\btoast\b|\balert me\b|\bnotify me\b", lower):
        steps.append({"tool": "notify_toast", "payload": {"title": "Naxie", "message": text[:300]}})

    if steps:
        suggested = [a.key for a in suggest_subagents(text)]
        plan = CognitivePlan(plan_id=str(uuid.uuid4()), intent=text[:2000], steps=steps)
        return plan, suggested

    if re.search(r"\bedit\b|\bupdate\b|\bfix\b|\brefactor\b|\bimplement\b", lower) and path:
        # Read first so the edit has context, even though edit needs old_string.
        steps.append({"tool": "file_read", "payload": {"path": path}})
        steps.append({"tool": "file_edit", "payload": {"path": path, "old_string": "", "new_string": ""},
                      "note": "Fill old_string/new_string from file_read above before executing."})
    elif re.search(r"\bread\b|\bshow\b|\bopen\b|\bcat\b", lower) and path:
        steps.append({"tool": "file_read", "payload": {"path": path}})
    elif re.search(r"\blist\b|\bfiles\b|\btree\b", lower):
        steps.append({"tool": "file_list", "payload": {"directory": path or "."}})
    elif re.search(r"\bwrite\b|\bcreate\b.*\bfile\b", lower):
        steps.append({"tool": "file_write", "payload": {"path": path or "scratch/output.txt", "content": text}})
    elif re.search(r"\brun\b|\bexecute\b|\btest\b|\bpytest\b|\bnpm\b|\bpnpm\b", lower):
        cmd = text.split("run", 1)[-1].strip() if "run" in lower else text
        steps.append({"tool": "bash_run", "payload": {"command": cmd[:500]}})
    elif re.search(r"\banalyze\b|\banalyse\b|\baudit\b|\bgrep\b|\bsearch code\b", lower):
        steps.append({"tool": "code_analysis", "payload": {"target": path or ".", "pattern": "def |class |function "}})
    elif url or re.search(r"\bsearch\b|\blookup\b|\bresearch\b|\bwhat is\b|\bwho is\b", lower):
        if url and re.search(r"\bopen\b|\bbrowse\b|\bvisit\b|\bgo to\b", lower):
            steps.append({"tool": "browser_open", "payload": {"url_or_search": url.group(0)}})
        else:
            steps.append({"tool": "web_retrieval", "payload": {"query": url.group(0) if url else text[:500]}})
    elif path:
        steps.append({"tool": "file_read", "payload": {"path": path}})

    suggested = [a.key for a in suggest_subagents(text)]

    if not steps:
        # Nothing executable — explicit delegation suggestion, not a silent chat.
        steps.append({"tool": "suggest_subagent", "payload": {"intent": text[:500], "candidates": suggested}})

    plan = CognitivePlan(
        plan_id=str(uuid.uuid4()),
        intent=text[:2000],
        steps=steps,
    )
    return plan, suggested
