"""
NAXIONAI — Personal to-do list API (Phase 6).

Ported from neuroworks/server/src/{lib,routes}/my-tasks.ts: lists, sub-
steps, due date, reminder, repeat, importance, "My Day". Distinct from
/api/goals (the agent's own job queue) — this is the operator's own list.
"""

import json
import uuid
from datetime import date, datetime, timedelta
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from database import get_db, PersonalTaskList, PersonalTaskItem
from auth import get_current_user

router = APIRouter(prefix="/api/my-tasks", tags=["my-tasks"])


# ── Schemas ──────────────────────────────────────────────────────────────

class TaskListOut(BaseModel):
    id: str
    name: str
    color: Optional[str] = None
    order: int


class TaskStep(BaseModel):
    id: str
    title: str
    done: bool = False


class RepeatRule(BaseModel):
    freq: str  # daily | weekly | monthly
    interval: int = 1


class TaskItemOut(BaseModel):
    id: str
    list_id: str
    title: str
    notes: Optional[str] = None
    steps: List[TaskStep] = []
    due_date: Optional[str] = None
    reminder_at: Optional[str] = None
    repeat: Optional[RepeatRule] = None
    important: bool
    my_day: Optional[str] = None
    completed: bool
    completed_at: Optional[str] = None
    order: int


def _list_out(l: PersonalTaskList) -> TaskListOut:
    return TaskListOut(id=l.id, name=l.name, color=l.color, order=l.order)


def _item_out(i: PersonalTaskItem) -> TaskItemOut:
    return TaskItemOut(
        id=i.id, list_id=i.list_id, title=i.title, notes=i.notes,
        steps=[TaskStep(**s) for s in json.loads(i.steps)] if i.steps else [],
        due_date=i.due_date,
        reminder_at=i.reminder_at.isoformat() if i.reminder_at else None,
        repeat=RepeatRule(freq=i.repeat_freq, interval=i.repeat_interval or 1) if i.repeat_freq else None,
        important=i.important, my_day=i.my_day, completed=i.completed,
        completed_at=i.completed_at.isoformat() if i.completed_at else None,
        order=i.order,
    )


async def _ensure_default_list(db: AsyncSession, owner_id: Optional[str]) -> PersonalTaskList:
    existing = (await db.execute(
        select(PersonalTaskList).where(PersonalTaskList.owner_id == owner_id).order_by(PersonalTaskList.order)
    )).scalars().first()
    if existing:
        return existing
    row = PersonalTaskList(id=str(uuid.uuid4()), owner_id=owner_id, name="Tasks", order=0)
    db.add(row)
    await db.commit()
    return row


# ── Lists ────────────────────────────────────────────────────────────────

@router.get("/lists", response_model=List[TaskListOut])
async def list_lists(db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    owner_id = user.get("sub")
    await _ensure_default_list(db, owner_id)
    rows = (await db.execute(
        select(PersonalTaskList).where(PersonalTaskList.owner_id == owner_id).order_by(PersonalTaskList.order)
    )).scalars().all()
    return [_list_out(r) for r in rows]


class CreateListRequest(BaseModel):
    name: str


@router.post("/lists", response_model=TaskListOut)
async def create_list(body: CreateListRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    name = body.name.strip()
    if not name:
        raise HTTPException(400, "name is required")
    owner_id = user.get("sub")
    count = len((await db.execute(select(PersonalTaskList).where(PersonalTaskList.owner_id == owner_id))).scalars().all())
    row = PersonalTaskList(id=str(uuid.uuid4()), owner_id=owner_id, name=name, order=count)
    db.add(row)
    await db.commit()
    return _list_out(row)


class RenameListRequest(BaseModel):
    name: str


@router.patch("/lists/{list_id}", response_model=TaskListOut)
async def rename_list(list_id: str, body: RenameListRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(PersonalTaskList).where(PersonalTaskList.id == list_id, PersonalTaskList.owner_id == user.get("sub")))).scalars().first()
    if not row:
        raise HTTPException(404, "list not found")
    if body.name.strip():
        row.name = body.name.strip()
    await db.commit()
    return _list_out(row)


@router.delete("/lists/{list_id}")
async def remove_list(list_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = (await db.execute(select(PersonalTaskList).where(PersonalTaskList.id == list_id, PersonalTaskList.owner_id == user.get("sub")))).scalars().first()
    if not row:
        raise HTTPException(404, "list not found")
    await db.delete(row)
    await db.commit()
    return {"ok": True}


# ── Items ────────────────────────────────────────────────────────────────

@router.get("/items", response_model=List[TaskItemOut])
async def list_items(
    list_id: Optional[str] = None,
    my_day: Optional[bool] = None,
    important: Optional[bool] = None,
    completed: Optional[bool] = None,
    db: AsyncSession = Depends(get_db),
    user: dict = Depends(get_current_user),
):
    q = select(PersonalTaskItem).where(PersonalTaskItem.owner_id == user.get("sub"))
    if list_id:
        q = q.where(PersonalTaskItem.list_id == list_id)
    if my_day:
        q = q.where(PersonalTaskItem.my_day == date.today().isoformat())
    if important is not None:
        q = q.where(PersonalTaskItem.important == important)
    if completed is not None:
        q = q.where(PersonalTaskItem.completed == completed)
    rows = (await db.execute(q.order_by(PersonalTaskItem.order))).scalars().all()
    return [_item_out(r) for r in rows]


class CreateItemRequest(BaseModel):
    list_id: Optional[str] = None
    title: str
    notes: Optional[str] = None
    due_date: Optional[str] = None
    reminder_at: Optional[datetime] = None
    repeat: Optional[RepeatRule] = None
    important: bool = False
    my_day: bool = False


@router.post("/items", response_model=TaskItemOut)
async def create_item(body: CreateItemRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "title is required")
    owner_id = user.get("sub")
    list_id = body.list_id or (await _ensure_default_list(db, owner_id)).id
    count = len((await db.execute(
        select(PersonalTaskItem).where(PersonalTaskItem.owner_id == owner_id, PersonalTaskItem.list_id == list_id)
    )).scalars().all())
    row = PersonalTaskItem(
        id=str(uuid.uuid4()), list_id=list_id, owner_id=owner_id, title=title, notes=body.notes,
        due_date=body.due_date, reminder_at=body.reminder_at,
        repeat_freq=body.repeat.freq if body.repeat else None,
        repeat_interval=body.repeat.interval if body.repeat else None,
        important=body.important, my_day=date.today().isoformat() if body.my_day else None,
        order=count,
    )
    db.add(row)
    await db.commit()
    return _item_out(row)


class UpdateItemRequest(BaseModel):
    title: Optional[str] = None
    notes: Optional[str] = None
    due_date: Optional[str] = None
    reminder_at: Optional[datetime] = None
    repeat: Optional[RepeatRule] = None
    important: Optional[bool] = None
    list_id: Optional[str] = None


async def _get_owned_item(db: AsyncSession, item_id: str, owner_id: Optional[str]) -> PersonalTaskItem:
    row = (await db.execute(select(PersonalTaskItem).where(PersonalTaskItem.id == item_id, PersonalTaskItem.owner_id == owner_id))).scalars().first()
    if not row:
        raise HTTPException(404, "task not found")
    return row


@router.patch("/items/{item_id}", response_model=TaskItemOut)
async def update_item(item_id: str, body: UpdateItemRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _get_owned_item(db, item_id, user.get("sub"))
    if body.title is not None and body.title.strip():
        row.title = body.title.strip()
    if body.notes is not None:
        row.notes = body.notes or None
    if body.due_date is not None:
        row.due_date = body.due_date or None
    if body.reminder_at is not None:
        row.reminder_at = body.reminder_at
    if body.repeat is not None:
        row.repeat_freq = body.repeat.freq
        row.repeat_interval = body.repeat.interval
    if body.important is not None:
        row.important = body.important
    if body.list_id is not None:
        owned = (await db.execute(select(PersonalTaskList).where(PersonalTaskList.id == body.list_id, PersonalTaskList.owner_id == user.get("sub")))).scalars().first()
        if owned:
            row.list_id = body.list_id
    await db.commit()
    return _item_out(row)


@router.delete("/items/{item_id}")
async def remove_item(item_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _get_owned_item(db, item_id, user.get("sub"))
    await db.delete(row)
    await db.commit()
    return {"ok": True}


def _advance_date(date_str: str, freq: str, interval: int) -> str:
    """Advance a YYYY-MM-DD date by a repeat rule. Month-end overflow clamps
    to the last valid day of the target month rather than rolling over."""
    d = date.fromisoformat(date_str)
    if freq == "daily":
        return (d + timedelta(days=interval)).isoformat()
    if freq == "weekly":
        return (d + timedelta(weeks=interval)).isoformat()
    # monthly
    total_month = d.month - 1 + interval
    target_year = d.year + total_month // 12
    target_month = total_month % 12 + 1
    next_month_first = date(target_year + (1 if target_month == 12 else 0), (target_month % 12) + 1, 1)
    last_day_of_target = (next_month_first - timedelta(days=1)).day
    return date(target_year, target_month, min(d.day, last_day_of_target)).isoformat()


@router.post("/items/{item_id}/toggle", response_model=TaskItemOut)
async def toggle_item(item_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    """Toggling a repeating task complete doesn't mark it done — it rolls the
    due date forward and stays open, matching Microsoft To Do's recurring-
    task behavior (the series never "completes", each occurrence resets)."""
    row = await _get_owned_item(db, item_id, user.get("sub"))
    if not row.completed and row.repeat_freq and row.due_date:
        row.due_date = _advance_date(row.due_date, row.repeat_freq, row.repeat_interval or 1)
        if row.steps:
            steps = json.loads(row.steps)
            for s in steps:
                s["done"] = False
            row.steps = json.dumps(steps)
    else:
        row.completed = not row.completed
        row.completed_at = datetime.utcnow() if row.completed else None
    await db.commit()
    return _item_out(row)


class MyDayRequest(BaseModel):
    on: bool = True


@router.post("/items/{item_id}/my-day", response_model=TaskItemOut)
async def set_my_day(item_id: str, body: MyDayRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _get_owned_item(db, item_id, user.get("sub"))
    row.my_day = date.today().isoformat() if body.on else None
    await db.commit()
    return _item_out(row)


class AddStepRequest(BaseModel):
    title: str


@router.post("/items/{item_id}/steps", response_model=TaskItemOut)
async def add_step(item_id: str, body: AddStepRequest, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    title = body.title.strip()
    if not title:
        raise HTTPException(400, "title is required")
    row = await _get_owned_item(db, item_id, user.get("sub"))
    steps = json.loads(row.steps) if row.steps else []
    steps.append({"id": str(uuid.uuid4()), "title": title, "done": False})
    row.steps = json.dumps(steps)
    await db.commit()
    return _item_out(row)


@router.patch("/items/{item_id}/steps/{step_id}", response_model=TaskItemOut)
async def toggle_step(item_id: str, step_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _get_owned_item(db, item_id, user.get("sub"))
    steps = json.loads(row.steps) if row.steps else []
    step = next((s for s in steps if s["id"] == step_id), None)
    if not step:
        raise HTTPException(404, "step not found")
    step["done"] = not step["done"]
    row.steps = json.dumps(steps)
    await db.commit()
    return _item_out(row)


@router.delete("/items/{item_id}/steps/{step_id}", response_model=TaskItemOut)
async def remove_step(item_id: str, step_id: str, db: AsyncSession = Depends(get_db), user: dict = Depends(get_current_user)):
    row = await _get_owned_item(db, item_id, user.get("sub"))
    steps = json.loads(row.steps) if row.steps else []
    row.steps = json.dumps([s for s in steps if s["id"] != step_id])
    await db.commit()
    return _item_out(row)
