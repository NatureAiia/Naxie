"""
NAXIONAI Agent State
Shared TypedDict state flowing through the LangGraph agent graph.
"""

import operator
from typing import TypedDict, Annotated, Optional, Any
from langgraph.graph.message import add_messages
from datetime import datetime

def reduce_list(left: list, right: list) -> list:
    """Safely merge lists for map-reduce parallel swarms."""
    if not left: left = []
    if not right: right = []
    return left + right


class AgentState(TypedDict):
    # ── Identity ────────────────────────────────────────
    goal_id: str
    goal_description: str
    created_by: str           # User ID — so agents can push to chat
    platforms: list[str]
    deadline: Optional[str]
    success_metrics: dict
    constraints: dict
    asset_ids: list[str]          # Media library asset IDs provided
    domain: Optional[str]         # business | work | personal | general — which life-domain this run belongs to

    # ── Conversation / Messages ──────────────────────────
    messages: Annotated[list, add_messages]

    # ── Research outputs ─────────────────────────────────
    research_findings: dict       # trends, competitor intel, audience data

    # ── Strategy / Plan ─────────────────────────────────
    campaign_plan: dict           # Full structured plan from Strategist
    tasks: list[dict]             # List of AgentTask dicts to create

    # ── Execution state ──────────────────────────────────
    current_task_id: Optional[str]
    completed_task_ids: Annotated[list[str], reduce_list]
    failed_task_ids: Annotated[list[str], reduce_list]
    # failed_task_ids only ever grows (reduce_list = left + right, no removal
    # is possible through a reducer). SkillForge "fixing" a failed task can't
    # un-fail it by filtering failed_task_ids — the filtered-down list just
    # gets concatenated back onto the unfiltered original by the reducer, so
    # the id never actually disappears. Track fixes here instead; consumers
    # that gate on failed_task_ids should treat an id in resolved_task_ids as
    # no longer failed.
    resolved_task_ids: Annotated[list[str], reduce_list]
    content_swarm_results: Annotated[list[dict], reduce_list] # Stores generated content from parallel nodes
    distribution_results: Annotated[list[dict], reduce_list] # Per-task account/schedule deltas from parallel distribution_manager branches

    # ── Monitor ──────────────────────────────────────────
    kpi_snapshot: dict            # Latest analytics vs targets
    needs_replan: bool
    # Both of these were read/written by monitor.py/researcher.py without
    # being declared here. LangGraph silently drops any key a node returns
    # that isn't part of the declared state schema, so replan_count always
    # evaluated to 0 on every invocation — the ">= 3" safety cap in
    # monitor.py that's supposed to stop an endless replan loop never
    # actually engaged.
    replan_count: int
    needs_replanning_research: bool

    # ── Human approval ───────────────────────────────────
    approval_status: str          # pending | approved | rejected | modified
    human_feedback: Optional[str]

    # ── Skills ───────────────────────────────────────────
    new_skills_created: list[str]  # Names of skills forged this run

    # ── Control flow ─────────────────────────────────────
    next_agent: Optional[str]     # Which agent to route to next
    target_agent: Optional[str]   # Where the manager wanted to go before Auditor intercepted
    risk_score: Optional[int]     # 0-100 risk grading
    error: Optional[str]
    iteration_count: int

    # ── Tool scoping ──────────────────────────────────────
    # Set by chat.py's first-layer intent classifier before the graph even
    # starts. Lets manager_node bind a narrower tool set for turns that are
    # clearly just host-control requests ("open notepad", "mute volume"),
    # instead of always exposing the full agency tool surface (execute_python,
    # route_to_agent, update_truth_bucket, ...) to every ReAct loop. Missing/
    # unrecognized values default to "full" so non-chat entry points (e.g. the
    # agency daemon invoking the graph directly) keep today's behavior.
    tool_scope: Optional[str]     # "host_control" | "full"
