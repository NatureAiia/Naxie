"""
NAXIONAI — Schedules API (Phase 4)
"""

import json
import uuid
from datetime import datetime
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, desc
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, Schedule
from auth import get_current_user
from agent.scheduler import next_fire_at

router = APIRouter(prefix="/api/schedules", tags=["schedules"])


class ScheduleOut(BaseModel):
    id: str
    name: str
    description: str
    days_of_week: List[int]
    hour: int
    minute: int
    enabled: bool
    deliver_email: Optional[str] = None
    last_fired_at: Optional[str] = None
    last_job_id: Optional[str] = None
    last_error: Optional[str] = None
    fire_count: int
    next_fire_at: Optional[str] = None


def _out(s: Schedule) -> ScheduleOut:
    days = json.loads(s.days_of_week) if s.days_of_week else []
    nxt = next_fire_at(days, s.hour, s.minute, s.last_fired_at or s.created_at)
    return ScheduleOut(
        id=s.id, name=s.name, description=s.description, days_of_week=days,
        hour=s.hour, minute=s.minute, enabled=s.enabled, deliver_email=s.deliver_email,
        last_fired_at=s.last_fired_at.isoformat() if s.last_fired_at else None,
        last_job_id=s.last_job_id, last_error=s.last_error, fire_count=s.fire_count,
        next_fire_at=nxt.isoformat() if nxt else None,
    )


@router.get("/", response_model=List[ScheduleOut])
async def list_schedules(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    rows = (await db.execute(
        select(Schedule).where(Schedule.owner_id == user.get("sub")).order_by(desc(Schedule.created_at))
    )).scalars().all()
    return [_out(s) for s in rows]


class CreateScheduleRequest(BaseModel):
    name: str
    description: str
    days_of_week: List[int] = []
    hour: int = 8
    minute: int = 0
    enabled: bool = True
    deliver_email: Optional[str] = None


@router.post("/", response_model=ScheduleOut)
async def create_schedule(body: CreateScheduleRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    if not (0 <= body.hour <= 23) or not (0 <= body.minute <= 59):
        raise HTTPException(400, "hour must be 0-23 and minute 0-59")
    if any(d < 0 or d > 6 for d in body.days_of_week):
        raise HTTPException(400, "days_of_week entries must be 0 (Sun) through 6 (Sat)")
    row = Schedule(
        id=str(uuid.uuid4()), owner_id=user.get("sub"), name=body.name, description=body.description,
        days_of_week=json.dumps(body.days_of_week), hour=body.hour, minute=body.minute,
        enabled=body.enabled, deliver_email=body.deliver_email,
    )
    db.add(row)
    await db.commit()
    return _out(row)


class UpdateScheduleRequest(BaseModel):
    name: Optional[str] = None
    description: Optional[str] = None
    days_of_week: Optional[List[int]] = None
    hour: Optional[int] = None
    minute: Optional[int] = None
    enabled: Optional[bool] = None
    deliver_email: Optional[str] = None


@router.patch("/{schedule_id}", response_model=ScheduleOut)
async def update_schedule(schedule_id: str, body: UpdateScheduleRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(Schedule).where(Schedule.id == schedule_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Schedule not found")
    if body.name is not None:
        row.name = body.name
    if body.description is not None:
        row.description = body.description
    if body.days_of_week is not None:
        row.days_of_week = json.dumps(body.days_of_week)
    if body.hour is not None:
        row.hour = body.hour
    if body.minute is not None:
        row.minute = body.minute
    if body.enabled is not None:
        row.enabled = body.enabled
    if body.deliver_email is not None:
        row.deliver_email = body.deliver_email or None
    await db.commit()
    return _out(row)


@router.delete("/{schedule_id}")
async def delete_schedule(schedule_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(Schedule).where(Schedule.id == schedule_id))).scalars().first()
    if not row or row.owner_id != user.get("sub"):
        raise HTTPException(404, "Schedule not found")
    await db.delete(row)
    await db.commit()
    return {"status": "deleted"}
