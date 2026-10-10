"""Delegating executor — runs a critic-approved plan step by step.

Each step routes through SelfHealingHarness + the real tool registry.
`suggest_subagent` steps are handled natively (no shell/file access) and
surface as explicit delegation suggestions in the result.
"""
from __future__ import annotations

import time
from typing import Any, Dict, List

from src.core.models import CognitivePlan, ExecutionResult
from src.agents.critic import CriticAgent
from src.agents.self_healing import SelfHealingHarness
from src.tools.registry import get_tool
from src.agents.subagents import CATALOG


async def _run_suggest(payload: Dict[str, Any]) -> Dict[str, Any]:
    candidates = payload.get("candidates", [])
    roster = [
        {"key": a.key, "title": a.title, "description": a.description, "tools": a.tools}
        for a in CATALOG if not candidates or a.key in candidates
    ]
    return {
        "delegated": False,
        "message": (
            "No direct tool fits this intent. Suggested subagents: "
            + ", ".join(f"{a['key']} ({a['title']})" for a in roster)
            + ". Re-ask via the owning subagent or narrow the request to a file/command."
        ),
        "candidates": roster,
    }


class DelegatingExecutor:
    def __init__(self, critic: CriticAgent, max_retries: int = 3):
        # suggest_subagent is a native delegation step, always allowed.
        if "suggest_subagent" not in critic.allowed_tools:
            critic.allowed_tools.add("suggest_subagent")
        self.critic = critic
        self.harness = SelfHealingHarness(max_retries=max_retries)

    async def execute(self, plan: CognitivePlan) -> ExecutionResult:
        start = time.time()
        approved, notes = self.critic.review_plan(plan)
        if not approved:
            return ExecutionResult(success=False, error=f"Plan rejected: {notes}")

        step_results: List[Dict[str, Any]] = []
        for idx, step in enumerate(plan.steps):
            tool = step.get("tool", "")
            payload = dict(step.get("payload", {}))
            if tool == "suggest_subagent":
                try:
                    data = await _run_suggest(payload)
                    step_results.append({"step": idx, "tool": tool, "success": True, "data": data})
                except Exception as e:  # pragma: no cover
                    step_results.append({"step": idx, "tool": tool, "success": False, "error": str(e)})
                continue
            try:
                fn = get_tool(tool)
            except KeyError as e:
                step_results.append({"step": idx, "tool": tool, "success": False, "error": str(e)})
                break
            # Skip placeholder edits with empty old_string — report what to do next.
            if tool == "file_edit" and not payload.get("old_string"):
                prev = step_results[-1] if step_results else {}
                step_results.append({
                    "step": idx, "tool": tool, "success": False,
                    "error": "file_edit needs old_string/new_string — read the file first (see prior step), then retry with the exact block to replace.",
                    "context": prev.get("data"),
                })
                break
            res = await self.harness.execute(fn, payload)
            entry: Dict[str, Any] = {"step": idx, "tool": tool, "success": res.success}
            if res.success:
                entry["data"] = res.data
            else:
                entry["error"] = res.error
                step_results.append(entry)
                break
            step_results.append(entry)

        elapsed = (time.time() - start) * 1000
        ok = bool(step_results) and all(s["success"] for s in step_results)
        err = None if ok else "; ".join(s.get("error", "step failed") for s in step_results if not s["success"])
        return ExecutionResult(success=ok, data={"steps": step_results, "notes": notes},
                               error=err, execution_time_ms=elapsed)
