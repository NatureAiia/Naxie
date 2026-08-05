"""
NAXIONAI — Security watchdog: request-level attack detection + auto-block.

Ported from neuroworks/server/src/lib/security-watch.ts as a Starlette/
FastAPI middleware. Watches every request for the patterns real attacks
leave in traffic (scanner probes, path traversal, SQLi/XSS signatures,
auth-failure bursts, request-rate floods) and auto-blocks the source IP for
a cooldown window once its score crosses a threshold.

Loopback (127.0.0.1 / ::1) is NEVER blocked or rate-scored — this app is a
single-operator local assistant, and self-blocking the operator's own
requests would be a self-inflicted denial of service. Loopback hits still
LOG, since a compromised local process is worth knowing about.

Events persist to a JSON ring buffer next to the DB file; admins read them
via GET /api/security/events and unblock via POST /api/security/unblock.
"""

import json
import logging
import re
import time
from pathlib import Path
from typing import Literal, Optional

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import JSONResponse

from config import get_settings

logger = logging.getLogger(__name__)
settings = get_settings()

STATE_DIR = Path(__file__).parent / ".naxionai_state"
EVENTS_PATH = STATE_DIR / "security-events.json"
MAX_EVENTS = 500

SCORE_HALF_LIFE_SECONDS = 10 * 60
FLOOD_WINDOW_SECONDS = 60
AUTH_FAIL_WINDOW_SECONDS = 5 * 60
AUTH_FAIL_LIMIT = 10
SEVERITY_SCORE = {"low": 3, "medium": 8, "high": 15}

# Paths only scanners/exploit kits request. Prefix-anchored so real app
# routes can never collide.
_PROBE_PATHS = re.compile(
    r"^/(?:wp-(?:admin|login|content|includes)|\.env|\.git(?:/|$)|\.aws|\.ssh|phpmyadmin|pma|mysql|"
    r"admin\.php|xmlrpc\.php|vendor/phpunit|cgi-bin|owa/|autodiscover|actuator|jenkins|manager/html|"
    r"solr|console/|_ignition|telescope|debug/default|server-status|HNAP1|boaform|shell|id_rsa)",
    re.I,
)
_TRAVERSAL = re.compile(r"(?:\.\.[\\/]|\.\.%2f|\.\.%5c|%2e%2e(?:%2f|%5c|/|\.)?|%c0%ae|/etc/passwd|\\windows\\system32|%00)", re.I)
_INJECTION = re.compile(
    r"(?:\bunion\s+(?:all\s+)?select\b|\bor\s+1\s*=\s*1\b|['\"]\s*or\s*['\"]?1['\"]?\s*=|"
    r"\bsleep\s*\(\s*\d|benchmark\s*\(|xp_cmdshell|information_schema|load_file\s*\(|"
    r"<script[\s>]|javascript:\s*[a-z]|onerror\s*=|\$\{jndi:)",
    re.I,
)

EventKind = Literal["scanner-probe", "traversal", "injection", "auth-failure-burst", "flood", "blocked-request"]


class _IpState:
    __slots__ = ("score", "score_at", "hits", "flood_flagged", "auth_fails", "blocked_until")

    def __init__(self) -> None:
        self.score = 0.0
        self.score_at = time.time()
        self.hits: list[float] = []
        self.flood_flagged = False
        self.auth_fails: list[float] = []
        self.blocked_until: Optional[float] = None


_ips: dict[str, _IpState] = {}
_events: list[dict] = []
_loaded = False


def _load_events() -> None:
    global _loaded, _events
    if _loaded:
        return
    _loaded = True
    try:
        if EVENTS_PATH.exists():
            arr = json.loads(EVENTS_PATH.read_text(encoding="utf-8"))
            if isinstance(arr, list):
                _events = arr[-MAX_EVENTS:]
    except Exception:
        _events = []


def _save_events() -> None:
    try:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        EVENTS_PATH.write_text(json.dumps(_events[-MAX_EVENTS:], indent=2), encoding="utf-8")
    except Exception:
        pass  # the watchdog must never take the app down


def _state_for(ip: str) -> _IpState:
    s = _ips.get(ip)
    if s is None:
        s = _IpState()
        _ips[ip] = s
    return s


def _decay_score(s: _IpState) -> None:
    now = time.time()
    elapsed = now - s.score_at
    if elapsed > 0 and s.score > 0:
        s.score = s.score * (0.5 ** (elapsed / SCORE_HALF_LIFE_SECONDS))
    s.score_at = now


def _is_loopback(ip: str) -> bool:
    return ip in ("127.0.0.1", "::1", "::ffff:127.0.0.1") or ip.startswith("127.")


def _record(ip: str, kind: EventKind, path: str, severity: str, detail: str = "", blocked: bool = False) -> None:
    _load_events()
    ev = {
        "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "ip": ip,
        "kind": kind,
        "path": path[:300],
        "severity": severity,
    }
    if detail:
        ev["detail"] = detail[:200]
    if blocked:
        ev["blocked"] = True
    _events.append(ev)
    _save_events()
    if severity == "high" or blocked:
        logger.error(f"[security-watch] {kind} from {ip} on {path[:200]} — {detail or kind}{' (auto-blocked)' if blocked else ''}")
    else:
        logger.warning(f"[security-watch] {kind} from {ip} on {path[:120]}{' — BLOCKED' if blocked else ''}")


def _maybe_block(ip: str, s: _IpState, path: str) -> bool:
    if s.score < settings.secwatch_block_score or _is_loopback(ip):
        return False
    if s.blocked_until and time.time() < s.blocked_until:
        return True
    s.blocked_until = time.time() + settings.secwatch_block_minutes * 60
    _record(ip, "blocked-request", path, "high", f"score {s.score:.1f} >= {settings.secwatch_block_score} — blocked {settings.secwatch_block_minutes}m", blocked=True)
    return True


class SecurityWatchMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        ip = request.client.host if request.client else "?"
        local = _is_loopback(ip)
        s = _state_for(ip)
        now = time.time()

        if not local and s.blocked_until and now < s.blocked_until:
            _record(ip, "blocked-request", str(request.url.path), "low")
            return JSONResponse({"error": "forbidden"}, status_code=403)

        _decay_score(s)
        url = str(request.url)
        path = request.url.path
        hit_severity: Optional[str] = None

        if _PROBE_PATHS.search(path):
            _record(ip, "scanner-probe", url, "medium")
            hit_severity = "medium"
        elif _TRAVERSAL.search(url):
            _record(ip, "traversal", url, "high")
            hit_severity = "high"
        elif _INJECTION.search(url):
            _record(ip, "injection", url, "high")
            hit_severity = "high"

        if not local:
            s.hits.append(now)
            s.hits = [t for t in s.hits if now - t < FLOOD_WINDOW_SECONDS]
            if len(s.hits) >= settings.secwatch_flood_per_min and not s.flood_flagged:
                s.flood_flagged = True
                _record(ip, "flood", url, "medium", f"{len(s.hits)} requests in 60s")
                hit_severity = hit_severity or "medium"
            elif len(s.hits) < settings.secwatch_flood_per_min:
                s.flood_flagged = False

        if hit_severity and not local:
            s.score += SEVERITY_SCORE[hit_severity]
            if _maybe_block(ip, s, url):
                return JSONResponse({"error": "forbidden"}, status_code=403)

        response = await call_next(request)

        if response.status_code in (401, 403, 429) and not local:
            t = time.time()
            s.auth_fails.append(t)
            s.auth_fails = [x for x in s.auth_fails if t - x < AUTH_FAIL_WINDOW_SECONDS]
            if len(s.auth_fails) == AUTH_FAIL_LIMIT:
                _record(ip, "auth-failure-burst", url, "high", f"{len(s.auth_fails)} auth failures in 5m")
                s.score += SEVERITY_SCORE["high"]
                _maybe_block(ip, s, url)

        return response


def security_status() -> dict:
    _load_events()
    now = time.time()
    blocked = [
        {"ip": ip, "until": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(s.blocked_until)), "score": round(s.score, 1)}
        for ip, s in _ips.items()
        if s.blocked_until and s.blocked_until > now
    ]
    return {"events": list(reversed(_events))[:200], "blocked": blocked, "watching": len(_ips)}


def unblock_ip(ip: str) -> bool:
    s = _ips.get(ip)
    if not s or not s.blocked_until:
        return False
    s.blocked_until = None
    s.score = 0.0
    return True
