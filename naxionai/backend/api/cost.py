"""
NAXIONAI — Cost API (Phase 4)
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from cost_tracker import get_cost_summary

router = APIRouter(prefix="/api/cost", tags=["cost"])


@router.get("/summary")
async def cost_summary(since_days: Optional[int] = Query(None, ge=1, le=365), user: dict = Depends(get_current_user)):
    return await get_cost_summary(since_days=since_days)
