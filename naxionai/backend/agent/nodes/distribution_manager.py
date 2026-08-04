import logging
from agent.state import AgentState
from database import PlatformConnection, AgentTask
from sqlalchemy import select
from langgraph.constants import Send
import random
from datetime import datetime, timedelta

logger = logging.getLogger(__name__)

async def distribution_manager_node(state: AgentState):
    """
    Distribution Manager Node (Fleet Commander)
    Takes generated tasks (from content director) and maps them to multiple accounts
    for the target platform, applying time jittering and preventing shadowbans.
    """
    logger.info("📡 Distribution Manager active: Load balancing content across swarm...")
    
    current_id = state.get("current_task_id")
    tasks = state.get("tasks", [])

    # This node runs fanned out via Send() (parallel branches, one per task).
    # next_agent/tasks are plain unreduced state channels — two or more
    # branches writing the same key in one superstep raises LangGraph's
    # InvalidUpdateError and crashes the whole run. Control already returns
    # to "manager" via the static graph edge, so next_agent is never needed
    # here. Task mutations go out as a delta via distribution_results
    # (properly reduced) instead of the whole tasks list; manager_node
    # stitches those deltas back into state["tasks"] the same way it already
    # does for content_swarm_results.
    if not current_id:
        return {}

    current_task = next((t for t in tasks if t["id"] == current_id), None)
    if not current_task:
        return {}

    platform = current_task.get("platform")
    if not platform:
        logger.warning(f"Task {current_id} has no platform. Skipping distribution.")
        return {}

    from database import async_session
    async with async_session() as session:
        # Fetch all available accounts for this platform
        stmt = select(PlatformConnection).where(PlatformConnection.platform == platform, PlatformConnection.is_enabled == True)
        result = await session.execute(stmt)
        accounts = result.scalars().all()
        
        if not accounts:
            logger.error(f"No active accounts found for platform {platform}.")
            fail_result = f"Failed to distribute: No attached accounts for {platform} in settings."

            # Update DB task
            db_task = await session.get(AgentTask, current_id)
            if db_task:
                db_task.status = "failed"
                db_task.result = fail_result
                await session.commit()

            # Delta-only: reduce_list folds this against the base state AND
            # every sibling branch's own delta. Returning state.get(...) + [id]
            # here (instead of just [id]) would re-include the base list on
            # every branch and duplicate entries once the reducer merges them.
            return {
                "distribution_results": [{"id": current_id, "status": "failed", "result": fail_result}],
                "failed_task_ids": [current_id],
            }
        
        # Apply mathematical distribution logic
        # 1. Round robin / random load balancing
        account = random.choice(accounts)
        
        # 2. Time Jittering: random offset to prevent "bot" footprint (-15 to +15 mins)
        base_time = current_task.get("scheduled_for")
        new_dt = None
        if base_time:
            if isinstance(base_time, str):
                try:
                    dt = datetime.fromisoformat(base_time.replace('Z', '+00:00'))
                    jitter_mins = random.randint(-15, 15)
                    new_dt = dt + timedelta(minutes=jitter_mins)
                    current_task["scheduled_for"] = new_dt.isoformat()
                    current_task["time_jittered"] = jitter_mins
                except Exception:
                    pass
            
        current_task["connection_id"] = account.id
        current_task["account_label"] = account.account_label
        
        # Hand off to auditor / publisher pipeline
        current_task["status"] = "pending_approval"
        
        # Reflect in database immediately
        db_task = await session.get(AgentTask, current_id)
        if db_task:
            if new_dt:
                db_task.scheduled_for = new_dt
            db_task.connection_id = account.id
            db_task.status = "pending_approval"
            await session.commit()
            
    logger.info(f"🕸️ Distributed task {current_id} to [{platform}] account '{account.account_label}'")

    return {
        "distribution_results": [{
            "id": current_id,
            "status": "pending_approval",
            "connection_id": account.id,
            "account_label": account.account_label,
            "scheduled_for": current_task.get("scheduled_for"),
            "time_jittered": current_task.get("time_jittered"),
        }],
        "completed_task_ids": [current_id],
    }
