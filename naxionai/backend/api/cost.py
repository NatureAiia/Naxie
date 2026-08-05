"""
NAXIONAI — Cost API (Phase 4)
"""

from typing import Optional

from fastapi import APIRouter, Depends, Query

from auth import get_current_user
from cost_tracker import get_cost_summary, check_spend_cap, DOMAINS

router = APIRouter(prefix="/api/cost", tags=["cost"])


@router.get("/summary")
async def cost_summary(
    since_days: Optional[int] = Query(None, ge=1, le=365),
    domain: Optional[str] = Query(None),
    user: dict = Depends(get_current_user),
):
    return await get_cost_summary(since_days=since_days, domain=domain)


@router.get("/caps")
async def cost_caps(user: dict = Depends(get_current_user)):
    """Current spend-cap config plus today's spend for each life-domain, so
    the operator can see where they stand without digging through logs."""
    return {d: await check_spend_cap(d) for d in DOMAINS}
