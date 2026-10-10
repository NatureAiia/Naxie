"""Subagent catalog — roles Naxie can delegate to or suggest.

Mirrors docs/naxie-architecture.md §3 (scheduler/researcher/executor/admin/
architect) plus code-specific workers so code tasks get a real owner.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import List


@dataclass(frozen=True)
class Subagent:
    key: str
    title: str
    description: str
    tools: List[str]


CATALOG: List[Subagent] = [
    Subagent("scheduler", "Scheduler", "Reminders, calendar, time-triggered nudges.",
             ["get_time", "set_reminder", "list_reminders", "notify_toast", "file_read", "file_write", "bash_run"]),
    Subagent("researcher", "Researcher", "Lookups, summarization, briefings.",
             ["web_retrieval", "get_weather", "file_read", "code_analysis"]),
    Subagent("coder", "Coder", "Read, write, edit and analyze code in the workspace.",
             ["file_read", "file_list", "file_write", "file_edit", "code_analysis", "bash_run", "git_command"]),
    Subagent("reviewer", "Reviewer", "Critique plans and diffs before they run.",
             ["file_read", "code_analysis"]),
    Subagent("executor", "Executor", "Multi-step projects needing a plan + check-ins.",
             ["file_read", "file_list", "file_write", "file_edit", "bash_run", "web_retrieval", "code_analysis",
              "get_time", "calculate", "system_status", "get_weather", "notify_toast", "set_reminder",
              "list_reminders", "system_control", "manage_clipboard", "git_command", "browser_open", "speak",
              "host_settings"]),
    Subagent("admin", "Admin", "Recurring bounded ops tasks that finish quickly.",
             ["file_read", "bash_run", "database_query", "get_time", "system_status", "notify_toast"]),
    Subagent("architect", "Architect", "Self-improvement proposals (read-only, always needs approval).",
             ["file_read", "file_list", "code_analysis"]),
]

_KEYWORDS = {
    "scheduler": ("remind", "schedule", "calendar", "cron", "daily", "reminder", "notify", "toast"),
    "researcher": ("research", "summar", "lookup", "search", "brief", "compare", "what is", "weather", "forecast"),
    "coder": ("code", "edit", "fix", "bug", "refactor", "implement", "function", "class",
              "file", ".py", ".ts", ".tsx", "debug", "test", "commit", "repo", "git"),
    "reviewer": ("review", "audit", "critique", "check my"),
    "architect": ("improve yourself", "self-improv", "architect", "redesign naxie"),
    "admin": ("triage", "inbox", "track", "report status", "system status", "battery", "clipboard"),
}


def suggest_subagents(intent: str, top_n: int = 2) -> List[Subagent]:
    text = intent.lower()
    scored = []
    for agent in CATALOG:
        kws = _KEYWORDS.get(agent.key, ())
        score = sum(1 for k in kws if k in text)
        # Code-like intent defaults to coder even without exact keyword hit.
        if agent.key == "coder" and ("```" in intent or "def " in intent or "import " in intent):
            score += 2
        if agent.key == "executor" and len(text.split()) > 30:
            score += 1
        scored.append((score, agent))
    scored.sort(key=lambda t: t[0], reverse=True)
    best = [a for s, a in scored if s > 0][:top_n]
    if not best:
        # Default: executor owns anything project-shaped, researcher otherwise.
        fallback = "executor" if len(text.split()) > 15 else "researcher"
        best = [a for a in CATALOG if a.key == fallback]
    # Architect is never auto-delegated — suggest only, approval required.
    return best


def get_subagent(key: str) -> Subagent:
    for a in CATALOG:
        if a.key == key:
            return a
    raise KeyError(f"Unknown subagent '{key}'")
