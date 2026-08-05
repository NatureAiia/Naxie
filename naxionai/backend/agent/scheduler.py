"""
NAXIONAI — Schedule tick loop (Phase 4)

Ported from neuroworks/server/src/lib/schedules.ts's tick()/
startScheduleScheduler(). naxionai has no "template" system to re-run on
fire — firing a schedule here means creating a Goal (with the schedule's
stored description) and kicking off the same planning agent create_goal()
already uses, then recording the fire like the TS original does.
"""

import asyncio
import json
import logging
import uuid
from datetime import datetime, timedelta
from typing import List, Optional

from sqlalchemy import select

logger = logging.getLogger(__name__)

TICK_SECONDS = 30


def next_fire_at(days_of_week: List[int], hour: int, minute: int, from_dt: datetime) -> Optional[datetime]:
    """Ported from nextFireAt — first candidate strictly after `from_dt`,
    trying today + each of the next 7 days. days_of_week: 0=Sun..6=Sat
    (matches Python's isoweekday-adjusted convention below); [] = every day.

    Uses server LOCAL time throughout (matching the TS original's
    new Date()/.getHours()/.getDay(), which are local-time), unlike the rest
    of this app's DB columns (UTC via datetime.utcnow()) — a schedule set
    for "8am" should mean 8am wall-clock time. `last_fired_at` is written in
    local time by this module; `created_at` still uses the shared UTC
    default, so the very first fire after creation may be computed against
    a UTC-stamped reference (a one-time, at-most-few-hours skew) until the
    real local last_fired_at takes over."""
    days = sorted(days_of_week) if days_of_week else list(range(7))
    if not days:
        return None
    for offset in range(8):
        candidate_date = from_dt + timedelta(days=offset)
        candidate = candidate_date.replace(hour=hour, minute=minute, second=0, microsecond=0)
        # Python's Monday=0..Sunday=6; JS's Date.getDay() is Sunday=0..Saturday=6.
        py_weekday = candidate.weekday()  # Mon=0..Sun=6
        js_weekday = (py_weekday + 1) % 7  # Sun=0..Sat=6
        if js_weekday not in days:
            continue
        if candidate <= from_dt:
            continue
        return candidate
    return None


async def _fire_schedule(schedule) -> None:
    from database import async_session, Goal, Schedule
    from api.goals import run_planning_agent

    goal_id = str(uuid.uuid4())
    try:
        async with async_session() as db:
            goal = Goal(
                id=goal_id, title=schedule.name, description=schedule.description,
                platforms="[]", assets="[]", success_metrics="{}", constraints="{}",
                priority="normal", status="planning", created_by=schedule.owner_id,
            )
            db.add(goal)
            await db.commit()

        initial_state = {
            "goal_id": goal_id, "goal_description": schedule.description,
            "platforms": [], "deadline": None, "asset_ids": [], "success_metrics": {}, "constraints": {},
            "messages": [], "research_findings": {}, "campaign_plan": {}, "tasks": [],
            "completed_task_ids": [], "failed_task_ids": [], "kpi_snapshot": {}, "needs_replan": False,
            "approval_status": "pending", "human_feedback": None, "new_skills_created": [],
            "next_agent": None, "error": None, "iteration_count": 0, "replan_count": 0, "current_task_id": None,
        }
        asyncio.create_task(run_planning_agent(goal_id, schedule.description, initial_state))

        async with async_session() as db:
            row = (await db.execute(select(Schedule).where(Schedule.id == schedule.id))).scalars().first()
            if row:
                row.last_fired_at = datetime.now()
                row.last_job_id = goal_id
                row.last_error = None
                row.fire_count = (row.fire_count or 0) + 1
                await db.commit()
        logger.info(f"[Scheduler] fired {schedule.id} ({schedule.name}) -> goal {goal_id[:8]}")

        if schedule.deliver_email:
            asyncio.create_task(_deliver_schedule_result(schedule, goal_id, schedule.deliver_email))
    except Exception as e:
        logger.warning(f"[Scheduler] fire crashed: {schedule.id} ({schedule.name}) — {e}")
        try:
            async with async_session() as db:
                row = (await db.execute(select(Schedule).where(Schedule.id == schedule.id))).scalars().first()
                if row:
                    row.last_error = str(e)[:500]
                    await db.commit()
        except Exception:
            pass


async def _deliver_schedule_result(schedule, goal_id: str, to_email: str) -> None:
    """Poll the fired goal to completion (up to 15 min), then email the
    synthesized answer. Best-effort — failures are logged, never crash the
    scheduler; the result still lives on the Tasks/Goals page regardless."""
    from database import async_session, Goal
    from agent.tools.email_notify import send_agent_email

    deadline = datetime.utcnow() + timedelta(minutes=15)
    answer = ""
    try:
        while datetime.utcnow() < deadline:
            await asyncio.sleep(5)
            async with async_session() as db:
                goal = (await db.execute(select(Goal).where(Goal.id == goal_id))).scalars().first()
            if not goal:
                continue
            if goal.status == "complete":
                answer = f'Your scheduled task "{schedule.name}" completed. Open the Goals page (job {goal_id[:8]}) to see the full result.'
                break
            if goal.status == "failed":
                answer = f'The scheduled task "{schedule.name}" didn\'t complete (failed).'
                break
        if not answer:
            answer = f'Your scheduled task "{schedule.name}" is still running — check the Goals page for the result.'
        await send_agent_email(subject=f"{schedule.name}", body_text=f"{answer}\n\n— Naxie", to_email=to_email)
        logger.info(f"[Scheduler] delivered {schedule.id} ({schedule.name}) result -> {to_email}")
    except Exception as e:
        logger.warning(f"[Scheduler] deliver failed for {schedule.id} ({schedule.name}): {e}")


async def schedule_tick_loop() -> None:
    """Runs forever alongside agency_daemon() — one immediate tick on boot
    (so anything due during downtime fires within seconds), then every
    TICK_SECONDS."""
    from database import async_session, Schedule

    async def tick():
        try:
            async with async_session() as db:
                rows = (await db.execute(select(Schedule).where(Schedule.enabled == True))).scalars().all()  # noqa: E712
            now = datetime.now()
            for s in rows:
                from_dt = s.last_fired_at or s.created_at
                days = json.loads(s.days_of_week) if s.days_of_week else []
                nxt = next_fire_at(days, s.hour, s.minute, from_dt)
                if nxt is not None and nxt <= now:
                    asyncio.create_task(_fire_schedule(s))
        except Exception as e:
            logger.warning(f"[Scheduler] tick failed: {e}")

    await asyncio.sleep(2)
    await tick()
    while True:
        await asyncio.sleep(TICK_SECONDS)
        await tick()
