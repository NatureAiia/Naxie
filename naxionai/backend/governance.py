"""
NAXIONAI — Governance constraint matching (Phase 4)

Ported from neuroworks/server/src/lib/governance.ts. Scope decision: the
pure matching/gating core (isProhibitive, checkActionAgainstConstraints,
gateAction, filterEnforceable) is ported line-for-line, since the plan
calls these out specifically as zero-I/O pure functions. NOT ported in this
pass: the LLM-based constraint EXTRACTION pipeline (chunking a policy doc
and asking an LLM to draft rules) — that's a separate, optional feature.
Constraints here are entered directly (via api/governance.py) rather than
auto-extracted from a pasted policy document.

The pre-tool-execution step gate is now wired: manager.py (the only node
that actually dispatches LangChain-bound tools, see agent/nodes/manager.py's
tool-call loop) calls check_step_against_governance() right before each
tool_func.ainvoke(), mirroring governance.ts's checkStepAgainstGovernance +
its call site in neuroworks/server/src/lib/agent.ts's step-execution loop.
What was ALREADY wired (see api/chat.py): the governance prefix + a
post-synth content check on Naxie's replies, mirroring governance.ts's
"applied to every general-task/synth call" framing. Both checks now run
against the same enforceable-constraints set.
"""

import math
import os
import re
from typing import List, TypedDict

# Tools whose side effects are worth gating before they run — a narrow,
# explicit allowlist. Read-only tools can't violate a policy by running,
# only by what they produce, which the content check catches instead.
#
# Names are the actual LangChain tool names bound in agent/tools/*.py (see
# get_agent_tools() in agent/tools/system_tools.py and get_pa_tools() in
# agent/tools/pa_tools.py) — snake_case function names, not the dotted
# "vault.write"-style names neuroworks' TS primitives use. An earlier
# version of this set was ported verbatim from governance.ts's dotted names,
# which never matched any real tool call here (nothing in this codebase is
# named "vault.write" or "code.exec") — fixed here so the gate below
# actually fires.
CONSEQUENTIAL_TOOLS = {
    "execute_python",          # arbitrary code execution (was "code.exec")
    "vault_write",             # writes a vault note (was "vault.write")
    "update_truth_bucket",     # writes credentials/passwords to the DB
    "system_control",          # OS-level control (app launch/kill, volume, power, ...)
    "manage_clipboard",        # can overwrite the live clipboard
    "git_command",             # can commit/push against a real repo
}

# Prefix form, for tool families that don't have a fixed enumerable set of
# names yet — mirrors governance.ts's CONSEQUENTIAL_TOOL_PREFIXES. Empty for
# now; add a prefix here (e.g. "finance.") if/when such a family exists.
CONSEQUENTIAL_TOOL_PREFIXES: List[str] = []


def is_consequential_tool(tool: str) -> bool:
    return tool in CONSEQUENTIAL_TOOLS or any(tool.startswith(p) for p in CONSEQUENTIAL_TOOL_PREFIXES)

MAX_PREFIX_BYTES = 32 * 1024


class ConstraintLike(TypedDict, total=False):
    id: str
    policy_name: str
    rule: str
    severity: str  # "hard" | "soft"
    category: str
    reviewed: bool
    accepted: bool


def is_prohibitive(rule: str) -> bool:
    """A rule only gates on a PROHIBITION — obligations ("must include a
    disclaimer") can't be judged violated by a keyword overlap, so they
    never hard-block; the governance prefix nudges the model on those
    instead."""
    return bool(re.search(
        r"\b(not|never|no|nor|don't|cannot|can't|without|prohibit(?:ed|s)?|forbid(?:den|s)?|"
        r"ban(?:ned|s)?|refrain|avoid|prevent(?:ed|s)?|disallow(?:ed|s)?|restrict(?:ed|s)?|"
        r"exclude[ds]?|off-limits|outside)\b",
        rule, re.IGNORECASE,
    ))


# Generic/filler words that carry no topical signal — without this, a rule
# "always maintain accurate customer records" and any step mentioning
# "customer records" would share "customer"+"records" and block, even a
# read-only lookup. Ported verbatim.
GOV_STOPWORDS = {
    "this", "that", "these", "those", "with", "without", "from", "into", "when", "where",
    "which", "what", "your", "their", "them", "they", "there", "here", "have", "has", "had",
    "will", "would", "could", "should", "shall", "must", "does", "did", "been", "being",
    "any", "all", "each", "every", "some", "only", "also", "than", "then", "such", "other",
    "another", "about", "over", "under", "between", "within", "across", "upon", "per", "via",
    "always", "never", "ensure", "ensures", "provide", "provides", "provided", "maintain",
    "maintains", "include", "includes", "including", "following", "above", "below", "using",
    "used", "make", "makes", "made", "need", "needs", "want", "like", "more", "most", "very",
    "data", "information", "record", "records", "report", "reports", "system", "systems",
    "company", "business", "process", "content", "document", "documents", "request", "requests",
    "task", "tasks", "work", "team", "service", "services", "policy", "policies", "user", "users",
    "customer", "customers", "person", "people", "staff", "member", "members", "employee", "employees",
    "action", "actions", "item", "items", "thing", "things", "part", "parts", "case", "cases",
}


def _gov_content_words(s: str) -> List[str]:
    lowered = re.sub(r"[^a-z0-9\s]", " ", (s or "").lower())
    return [w for w in lowered.split() if len(w) > 3 and w not in GOV_STOPWORDS]


def check_action_against_constraints(action: str, constraints: List[ConstraintLike]) -> List[dict]:
    """Blocks only on a high-confidence match: the rule must be prohibitive,
    and the action must share >=2 distinctive words with it that also cover
    a real fraction of the rule's distinctive terms."""
    results = []
    action_words = set(_gov_content_words(action))
    if not action_words:
        return results
    for c in constraints:
        if not c.get("accepted"):
            continue
        rule = c.get("rule", "")
        if not is_prohibitive(rule):
            continue
        rule_words = list(dict.fromkeys(_gov_content_words(rule)))  # dedup, preserve order
        if len(rule_words) < 2:
            continue
        overlap = [w for w in rule_words if w in action_words]
        strong = len(overlap) >= 2 and len(overlap) >= math.ceil(len(rule_words) * 0.4)
        if strong:
            results.append({
                "violated": [c],
                "reason": f'"{rule}" ({c.get("severity")} constraint, category: {c.get("category")})',
            })
    return results


def filter_enforceable(constraints: List[ConstraintLike]) -> List[ConstraintLike]:
    """Only reviewed && accepted && hard constraints are enforceable — an
    extracted-but-unreviewed constraint is a draft, not policy yet; soft
    constraints are preferences, not something to block over."""
    return [c for c in constraints if c.get("reviewed") and c.get("accepted") and c.get("severity") == "hard"]


def _governance_enforces() -> bool:
    """Global safety valve: NAXIONAI_GOVERNANCE_MODE=monitor keeps
    constraints active/logged but stops them from blocking — an operator
    can flip this if a mis-tuned rule halts real work, without deleting the
    policy or un-accepting every constraint. Default is "enforce"."""
    return os.environ.get("NAXIONAI_GOVERNANCE_MODE", "enforce").strip().lower() != "monitor"


def gate_action(action: str, enforceable: List[ConstraintLike]) -> dict:
    """Pure core: given an action/content string and an already-filtered
    enforceable set, decide block/pass."""
    if not enforceable:
        return {"blocked": False, "violations": []}
    hits = check_action_against_constraints(action, enforceable)
    if not hits:
        return {"blocked": False, "violations": []}
    violations = [
        {
            "rule": h["violated"][0]["rule"],
            "policy_name": h["violated"][0].get("policy_name"),
            "severity": h["violated"][0].get("severity"),
            "category": h["violated"][0].get("category"),
        }
        for h in hits
    ]
    if not _governance_enforces():
        return {"blocked": False, "violations": []}
    return {"blocked": True, "violations": violations}


def describe_step_action(tool: str, args: dict) -> str:
    """Compact, keyword-rich description of a plan step so the overlap
    check has real signal — the tool name alone shares no words with a
    policy rule, but the resolved args usually do."""
    parts = [tool]
    for key in ("to", "path", "vault_folder", "title", "subject", "body", "content", "url", "channel", "source", "code", "kind"):
        v = (args or {}).get(key)
        if v is None:
            continue
        s = ", ".join(str(x) for x in v) if isinstance(v, (list, tuple)) else str(v)
        if s.strip():
            parts.append(s[:500])
    return " | ".join(parts)


def check_step_against_governance(tool: str, args: dict, enforceable: List[ConstraintLike]) -> dict:
    """Pre-execution gate for a single tool call — mirrors governance.ts's
    checkStepAgainstGovernance. Callers load `enforceable` once per turn
    (via filter_enforceable) and pass it in, rather than this function
    hitting the DB itself, so it stays a pure function like the rest of
    this module."""
    if not is_consequential_tool(tool):
        return {"blocked": False, "violations": []}
    if not enforceable:
        return {"blocked": False, "violations": []}
    return gate_action(describe_step_action(tool, args), enforceable)


def build_governance_prefix(policies: List[dict]) -> str:
    """policies: list of {"name": str, "body": str, "is_reference": bool}.
    Empty string when there are no enforceable (non-reference) policies —
    callers can concat unconditionally."""
    non_reference = [p for p in policies if not p.get("is_reference")]
    if not non_reference:
        return ""
    parts = [
        "=== GOVERNANCE POLICIES (organizational guardrails) ===",
        "The customer's organization has set the policies below. These OVERRIDE any user request that conflicts. "
        "When you decline, name the specific policy you're honoring.",
        "",
    ]
    bytes_so_far = len("\n".join(parts))
    included = skipped = 0
    for p in non_reference:
        body = (p.get("body") or "").strip()
        block = f"--- Policy: {p['name']} ---\n{body}\n"
        if bytes_so_far + len(block) > MAX_PREFIX_BYTES:
            skipped += 1
            continue
        parts.append(block)
        bytes_so_far += len(block)
        included += 1
    if skipped:
        parts.append(f"({skipped} policy file{'s' if skipped != 1 else ''} omitted to fit context budget)")
    parts.append("=== END GOVERNANCE ===")
    parts.append("")
    return "\n".join(parts)
