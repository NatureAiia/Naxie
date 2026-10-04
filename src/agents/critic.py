from typing import Tuple
from src.core.models import CognitivePlan

class CriticAgent:
    def __init__(self, allowed_tools: list[str]):
        self.allowed_tools = set(allowed_tools)

    def review_plan(self, plan: CognitivePlan) -> Tuple[bool, str]:
        if not plan.steps:
            return False, "Plan contains zero executable steps."

        for idx, step in enumerate(plan.steps):
            tool = step.get("tool")
            if not tool:
                return False, f"Step {idx} missing required 'tool' designation."
            if tool not in self.allowed_tools:
                return False, f"Step {idx} requests unauthorized tool '{tool}'."
            if "payload" not in step:
                return False, f"Step {idx} missing parameter payload."

        return True, "Plan approved for sandboxed execution."
