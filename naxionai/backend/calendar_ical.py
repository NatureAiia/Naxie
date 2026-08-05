"""
NAXIONAI — Lightweight iCal reader (Phase 6).

Ported from neuroworks/server/src/lib/calendar-ical.ts. Fetches an iCal
feed URL (Google Calendar public feed, Outlook publish link) or reads a
local .ics file, returning VEVENTs. No external iCal-parsing dependency —
covers the 80% case with a small regex-based parser.
"""

import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path
from typing import Optional

from security_gates import assert_safe_public_url

_DATE_RE = re.compile(r"(\d{8})(?:T(\d{6}))?(Z)?$")


@dataclass
class CalEvent:
    summary: str
    start: datetime
    end: Optional[datetime] = None
    location: Optional[str] = None
    description: Optional[str] = None


def _unfold(text: str) -> str:
    """iCal folds lines >75 chars with CRLF/LF + a leading space/tab."""
    return re.sub(r"\r?\n[ \t]", "", text)


def _parse_ical_date(raw: str) -> Optional[datetime]:
    m = _DATE_RE.search(raw)
    if not m:
        return None
    d, t, is_utc = m.group(1), m.group(2) or "000000", bool(m.group(3))
    try:
        dt = datetime(int(d[0:4]), int(d[4:6]), int(d[6:8]), int(t[0:2]), int(t[2:4]), int(t[4:6]))
        return dt.replace(tzinfo=timezone.utc) if is_utc else dt
    except ValueError:
        return None


def parse_ical(source: str) -> list[CalEvent]:
    text = _unfold(source)
    events: list[CalEvent] = []
    blocks = text.split("BEGIN:VEVENT")
    for block in blocks[1:]:
        body = block.split("END:VEVENT")[0]

        def get(key: str) -> Optional[str]:
            m = re.search(rf"^{key}(?:;[^:\n]*)?:(.+)$", body, re.M)
            return m.group(1).strip() if m else None

        dtstart = get("DTSTART")
        if not dtstart:
            continue
        start = _parse_ical_date(dtstart)
        if not start:
            continue
        dtend = get("DTEND")
        end = _parse_ical_date(dtend) if dtend else None
        description = get("DESCRIPTION")
        events.append(CalEvent(
            summary=get("SUMMARY") or "(no title)",
            start=start, end=end, location=get("LOCATION"),
            description=description[:400] if description else None,
        ))
    return events


async def read_ical_source(source: str) -> list[CalEvent]:
    if Path(source).is_file():
        raw = Path(source).read_text(encoding="utf-8")
    elif re.match(r"^https?://", source, re.I):
        assert_safe_public_url(source, resolve_dns=True)
        import httpx
        async with httpx.AsyncClient(timeout=15) as client:
            resp = await client.get(source)
            resp.raise_for_status()
            raw = resp.text
    else:
        raise ValueError("source must be an http(s) URL or a path to a local .ics file")
    return parse_ical(raw)


def todays_events(events: list[CalEvent]) -> list[CalEvent]:
    today = date.today()
    def on_today(e: CalEvent) -> bool:
        s = e.start.astimezone().date() if e.start.tzinfo else e.start.date()
        return s == today
    return sorted((e for e in events if on_today(e)), key=lambda e: e.start)
