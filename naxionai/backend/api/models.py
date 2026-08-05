"""
NAXIONAI — Models API (Phase 5)
"""

from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from auth import get_current_user
import model_router as mr

router = APIRouter(prefix="/api/models", tags=["models"])


@router.get("/")
async def list_models(user: dict = Depends(get_current_user)):
    return await mr.list_models()


@router.get("/pick")
async def pick_model_for_profile(
    profile: str = Query(..., description="planning | synthesis | triage | extraction | balanced"),
    fallback: Optional[str] = None,
    user: dict = Depends(get_current_user),
):
    if profile not in mr.TASK_PROFILES:
        raise HTTPException(400, f"profile must be one of {', '.join(mr.TASK_PROFILES)}")
    name = await mr.pick_model_for(profile, fallback)
    return {"profile": profile, "model": name}


@router.post("/invalidate-cache")
async def invalidate_cache(user: dict = Depends(get_current_user)):
    mr.invalidate_model_pick_cache()
    return {"status": "invalidated"}
