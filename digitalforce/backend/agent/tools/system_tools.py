"""
Digital Force — Native System Tools
First-class tools for the Omni-Hub ReAct loop.
"""

from langchain_core.tools import tool
import logging

logger = logging.getLogger(__name__)

def get_agent_tools(state: dict):
    
    @tool
    async def execute_python(code: str) -> str:
        """Executes arbitrary Python code in a local subprocess and returns stdout/stderr. Use exactly when you need to parse data, hit external APIs, or scrape."""
        try:
            from agent.tools.sandbox import run_in_e2b
            res = await run_in_e2b(code)
            if res.get("success"):
                return f"Execution Succeeded:\n{res.get('output')}"
            return f"Execution Failed:\n{res.get('error')}\n{res.get('output')}"
        except Exception as e:
            return f"Sandbox Error: {e}"

    @tool
    async def read_system_context() -> str:
        """Reads live counts of goals, accounts, and tasks from the SQL database to give you system awareness."""
        try:
            from database import async_session, Goal, PlatformConnection, AgentTask
            from sqlalchemy import select, func
            async with async_session() as db:
                g = await db.scalar(select(func.count(Goal.id)))
                p = await db.scalar(select(func.count(PlatformConnection.id)))
                t = await db.scalar(select(func.count(AgentTask.id)))
                return f"Database Context: {g} total goals. {p} platform connections. {t} executed tasks globally."
        except Exception as e:
            return f"Database Error: {e}"

    @tool
    async def query_knowledge(query: str) -> str:
        """Queries the Qdrant Vector database for historic memory, brand guidelines, or training data."""
        try:
            from rag.retriever import retrieve
            docs = await retrieve(query)
            if not docs:
                return "No memories found."
            return "\n\n".join([f"[{d['score']:.2f}] {d['text']}" for d in docs])
        except Exception as e:
            return f"RAG Error: {e}"

    @tool
    async def push_to_chat(message: str) -> str:
        """Pushes a message instantly to the user's UI. VERY IMPORTANT: Use this before running heavy tools to tell the user what you are doing (e.g. 'I am reviewing your database now...')."""
        try:
            from agent.chat_push import chat_push
            user_id = state.get("created_by", "")
            goal_id = state.get("goal_id", "")
            await chat_push(user_id=user_id, content=message, agent_name="neuroworks - omni", goal_id=goal_id)
            return "Message pushed to user UI."
        except Exception as e:
            return f"Push Error: {e}"

    @tool
    def route_to_agent(target_agent: str) -> str:
        """Routes execution to a specialized worker sub-agent. Valid agents: orchestrator, researcher, strategist, content_director, distribution_manager, publisher, skillforge, monitor, reflector. DO NOT use if you can solve the task quickly with execute_python."""
        # target_agent is LLM-generated free text with no schema enforcement.
        # graph.py's conditional-edge mapping raises an uncaught KeyError for
        # any name it doesn't recognize, which crashes the whole run. Validate
        # against the actual routable set and hand the LLM a normal tool
        # result (not a ROUTING_REQUESTED directive) on a miss, so it can
        # retry with a valid name within the same ReAct loop instead of
        # crashing the graph.
        valid_agents = {
            "orchestrator", "researcher", "strategist", "content_director",
            "distribution_manager", "publisher", "skillforge", "monitor", "reflector",
        }
        normalized = (target_agent or "").strip().lower()
        if normalized not in valid_agents:
            return (
                f"Invalid routing target '{target_agent}'. Valid agents are: "
                f"{', '.join(sorted(valid_agents))}. Choose one of these, or use "
                f"execute_python/halt_execution instead."
            )
        return f"ROUTING_REQUESTED:{normalized}"
        
    @tool
    def halt_execution() -> str:
        """Stops the loop and halts execution, waiting for the human user to reply."""
        return "ROUTING_REQUESTED:__end__"

    @tool
    async def remember_preference(key: str, value: str) -> str:
        """Save a lasting fact or preference about the user (name, communication style,
        recurring habit) so future conversations don't start cold. Use a short
        snake_case key (e.g. 'preferred_name') and a free-text value."""
        try:
            from database import set_user_preference
            user_id = state.get("created_by", "")
            await set_user_preference(user_id, key[:100], value)
            return f"Remembered: {key} = {value}"
        except Exception as e:
            return f"Failed to save preference: {e}"

    @tool
    async def recall_preferences() -> str:
        """Return everything saved about the user via remember_preference."""
        try:
            from database import get_user_preferences
            user_id = state.get("created_by", "")
            prefs = await get_user_preferences(user_id)
            if not prefs:
                return "No preferences saved yet."
            return "\n".join(f"{k}: {v}" for k, v in prefs.items())
        except Exception as e:
            return f"Failed to load preferences: {e}"

    @tool
    async def update_truth_bucket(account_name_match: str, text_to_append: str) -> str:
        """Safely appends authentication credentials, passwords, or recovery codes to a managed account's truth bucket in the SQL Database. Use this whenever the user gives you a password!"""
        try:
            from database import async_session, PlatformConnection
            from sqlalchemy import select, or_
            from encryption import encrypt_value, decrypt_value
            async with async_session() as session:
                # account_name_match is LLM-generated free text; escape SQL LIKE
                # metacharacters so a stray '%'/'_' can't broaden the match to
                # an unintended account.
                escaped = account_name_match.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
                match_str = f"%{escaped}%"
                stmt = select(PlatformConnection).where(
                    or_(
                        PlatformConnection.account_label.ilike(match_str, escape="\\"),
                        PlatformConnection.display_name.ilike(match_str, escape="\\")
                    )
                )
                conn = (await session.execute(stmt)).scalars().first()
                if conn:
                    try:
                        current = decrypt_value(conn.auth_data) if conn.auth_data else ""
                    except Exception:
                        current = ""  # legacy/plaintext or corrupt value — don't propagate it
                    updated = f"{current}\n[Agent Auto-Saved]: {text_to_append}".strip()
                    conn.auth_data = encrypt_value(updated)
                    await session.commit()
                    return f"Successfully updated Truth Bucket for {conn.account_label}"
                return "Failed: No account found matching that name."
        except Exception as e:
            return f"Database Error: {e}"

    from agent.tools.pa_tools import get_pa_tools
    pa_tools = get_pa_tools()

    # tool_scope is set by chat.py's first-layer intent classifier. For turns
    # that are clearly just host-control requests ("open notepad", "mute
    # volume"), bind only the PA tools plus the minimum needed to talk back
    # to the user — not the full agency surface (execute_python,
    # route_to_agent, update_truth_bucket, query_knowledge, ...), which that
    # kind of request never needs and which only widens what an LLM steered
    # by prompt-injected content could reach for. Anything else (including
    # non-chat entry points that never set tool_scope) keeps the full set.
    if state.get("tool_scope") == "host_control":
        return [push_to_chat, halt_execution, remember_preference, recall_preferences] + pa_tools

    return [execute_python, read_system_context, query_knowledge, push_to_chat, route_to_agent, halt_execution, update_truth_bucket, remember_preference, recall_preferences] + pa_tools
