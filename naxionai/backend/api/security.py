"""
NAXIONAI — Security watchdog admin API (Phase 6).
Ported from neuroworks/server/src/routes (mounted under /api/security).
"""

from fastapi import APIRouter, Depends, HTTPException

from auth import get_current_user
import security_watch

router = APIRouter(prefix="/api/security", tags=["security"])


@router.get("/events")
async def get_events(user: dict = Depends(get_current_user)):
    return security_watch.security_status()


@router.post("/unblock")
async def unblock(payload: dict, user: dict = Depends(get_current_user)):
    ip = str(payload.get("ip") or "").strip()
    if not ip:
        raise HTTPException(400, "ip is required")
    ok = security_watch.unblock_ip(ip)
    if not ok:
        raise HTTPException(404, "ip is not currently blocked")
    return {"ok": True}
