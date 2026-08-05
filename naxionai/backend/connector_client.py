"""
NAXIONAI — Connector client (Phase 5)

Ported from neuroworks/server/src/lib/connectors.ts. Safety model preserved
exactly:
  - Calls are READ-ONLY by default (only GET/HEAD/OPTIONS) — the operator
    flips write_enabled per connector to allow POST/PUT/PATCH/DELETE.
  - SSRF guard — a call's resolved URL host+scheme MUST equal the configured
    base_url's host+scheme. A path that tries to jump to another origin is
    rejected before any request is made.
  - Redirects are followed MANUALLY, confined to the same origin at every
    hop — an open redirect on the target can't pivot the request off-host.
  - Secrets never appear in the returned URL (redacted).

Descoped from this port (flagged, not silently dropped): the OAuth2
device-code flow (Microsoft identity platform) — a large, provider-specific
subsystem. auth_type supports none/api_key/bearer/basic/header; oauth2 is
not yet implemented.
"""

import logging
from typing import Any, Dict, Optional
from urllib.parse import urljoin, urlparse, urlunparse, parse_qsl, urlencode

import httpx

logger = logging.getLogger(__name__)

MAX_BODY_CHARS = 20000
DEFAULT_TIMEOUT_SECONDS = 30.0
MAX_REDIRECTS = 5


class ConnectorError(Exception):
    pass


def resolve_url(base_url: str, path: str) -> str:
    """Resolve a call's path against the connector's base_url and hard-fail
    if it escapes the configured origin (SSRF guard)."""
    base = urlparse(base_url)
    joined = urljoin(base_url if base_url.endswith("/") else base_url + "/", path or "")
    target = urlparse(joined)
    if target.netloc != base.netloc or target.scheme != base.scheme:
        raise ConnectorError(
            f'path "{path}" resolves to {target.scheme}://{target.netloc}, '
            f"which is outside the connector's base origin {base.scheme}://{base.netloc}"
        )
    return joined


def apply_auth(auth_type: str, secret: Optional[str], auth_name: Optional[str], auth_username: Optional[str],
                url: str, headers: Dict[str, str]) -> str:
    """Returns the (possibly query-modified) url; mutates headers in place."""
    if auth_type == "bearer" and secret:
        headers["authorization"] = f"Bearer {secret}"
    elif auth_type == "basic" and (auth_username or secret):
        import base64
        token = base64.b64encode(f"{auth_username or ''}:{secret or ''}".encode()).decode()
        headers["authorization"] = f"Basic {token}"
    elif auth_type == "api_key" and secret:
        name = auth_name or "X-API-Key"
        # `in` (header vs query) is encoded by the caller passing name=None to
        # mean "query" — see api/connectors.py's _apply_auth_in dispatch.
        headers[name] = secret
    elif auth_type == "header" and auth_name and secret:
        headers[auth_name] = secret
    return url


def redact_url(url: str, auth_type: str, auth_name: Optional[str]) -> str:
    """Strip credential material from a URL before it's ever returned/logged."""
    parsed = urlparse(url)
    if auth_type == "api_key" and auth_name:
        params = parse_qsl(parsed.query)
        if any(k == auth_name for k, _ in params):
            params = [(k, "REDACTED" if k == auth_name else v) for k, v in params]
            parsed = parsed._replace(query=urlencode(params))
    parsed = parsed._replace(netloc=parsed.hostname or parsed.netloc)  # drop userinfo
    return urlunparse(parsed)


async def call_connector(
    base_url: str, write_enabled: bool, auth_type: str, secret: Optional[str],
    auth_name: Optional[str], auth_in: str, auth_username: Optional[str],
    static_headers: Optional[Dict[str, str]],
    method: str, path: str, query: Optional[Dict[str, Any]] = None, body: Any = None,
    extra_headers: Optional[Dict[str, str]] = None,
) -> dict:
    method = (method or "GET").upper()
    is_read = method in ("GET", "HEAD", "OPTIONS")
    if not is_read and not write_enabled:
        return {"ok": False, "status": 0, "url": "", "method": method, "body": None,
                "error": f"connector is read-only — {method} is blocked. Enable writes on the connector to allow it."}

    try:
        url = resolve_url(base_url, path or "")
    except ConnectorError as e:
        return {"ok": False, "status": 0, "url": "", "method": method, "body": None, "error": str(e)}

    headers = {"accept": "application/json", **(static_headers or {})}
    if extra_headers:
        headers.update(extra_headers)

    if auth_type == "api_key" and auth_in == "query" and secret:
        parsed = urlparse(url)
        params = parse_qsl(parsed.query)
        params.append((auth_name or "api_key", secret))
        url = urlunparse(parsed._replace(query=urlencode(params)))
    else:
        apply_auth(auth_type, secret, auth_name, auth_username, url, headers)

    if query:
        parsed = urlparse(url)
        params = parse_qsl(parsed.query) + [(k, str(v)) for k, v in query.items()]
        url = urlunparse(parsed._replace(query=urlencode(params)))

    content = None
    if not is_read and body is not None:
        if isinstance(body, str):
            content = body
            headers.setdefault("content-type", "text/plain")
        else:
            import json as _json
            content = _json.dumps(body)
            headers.setdefault("content-type", "application/json")

    base_parsed = urlparse(base_url)
    try:
        async with httpx.AsyncClient(timeout=DEFAULT_TIMEOUT_SECONDS, follow_redirects=False) as client:
            target = url
            for hop in range(MAX_REDIRECTS + 1):
                r = await client.request(method, target, headers=headers, content=content)
                if r.status_code in (301, 302, 303, 307, 308) and "location" in r.headers:
                    if hop >= MAX_REDIRECTS:
                        return {"ok": False, "status": r.status_code, "url": redact_url(target, auth_type, auth_name),
                                "method": method, "body": None, "error": "too many redirects"}
                    dest = urljoin(target, r.headers["location"])
                    dest_parsed = urlparse(dest)
                    if dest_parsed.netloc != base_parsed.netloc or dest_parsed.scheme != base_parsed.scheme:
                        return {"ok": False, "status": r.status_code, "url": redact_url(target, auth_type, auth_name),
                                "method": method, "body": None,
                                "error": f"blocked redirect to {dest_parsed.scheme}://{dest_parsed.netloc}, outside the connector's origin {base_parsed.scheme}://{base_parsed.netloc}"}
                    target = dest
                    continue
                break

            content_type = r.headers.get("content-type", "")
            raw = r.text
            truncated = len(raw) > MAX_BODY_CHARS
            slice_ = raw[:MAX_BODY_CHARS] if truncated else raw
            parsed_body: Any = slice_
            if "application/json" in content_type:
                try:
                    import json as _json
                    parsed_body = _json.loads(slice_)
                except Exception:
                    parsed_body = slice_
            looks_html = "text/html" in content_type or (
                isinstance(parsed_body, str) and parsed_body.strip()[:15].lower().lstrip().startswith(("<!doctype html", "<html", "<?xml"))
            )
            warning = (
                "endpoint returned an HTML page, not JSON/data — the connector's base URL or path is likely wrong, "
                "or the endpoint requires auth (login page). Do not treat this markup as the answer."
            ) if looks_html else None
            return {
                "ok": r.is_success, "status": r.status_code, "url": redact_url(target, auth_type, auth_name),
                "method": method, "content_type": content_type or None, "body": parsed_body,
                "truncated": truncated or None, "warning": warning,
                "error": None if r.is_success else f"HTTP {r.status_code}",
            }
    except httpx.TimeoutException:
        return {"ok": False, "status": 0, "url": redact_url(url, auth_type, auth_name), "method": method, "body": None,
                "error": f"request timed out after {int(DEFAULT_TIMEOUT_SECONDS)}s"}
    except Exception as e:
        return {"ok": False, "status": 0, "url": redact_url(url, auth_type, auth_name), "method": method, "body": None, "error": str(e)}


async def test_connector(base_url: str, write_enabled: bool, auth_type: str, secret: Optional[str],
                          auth_name: Optional[str], auth_in: str, auth_username: Optional[str],
                          static_headers: Optional[Dict[str, str]], probe_path: str = "/") -> dict:
    r = await call_connector(base_url, write_enabled, auth_type, secret, auth_name, auth_in, auth_username,
                              static_headers, "GET", probe_path)
    ok = r["status"] > 0 and r["status"] < 500
    if r["status"] == 0:
        detail = f"{r.get('error') or 'unreachable'} — {r.get('url') or base_url}"
    elif r["status"] in (401, 403):
        detail = f"reachable but auth rejected (HTTP {r['status']}) — check credentials"
    else:
        detail = f"reachable (HTTP {r['status']})"
    return {"ok": ok, "detail": detail}


# ─── Free, keyless public-API seeds (curated) ───
# All auth:"none", write_enabled:false — safe read-only backups an agent can
# reach for without any operator setup. Seeded once (idempotent by label).
PUBLIC_API_SEEDS = [
    {
        "label": "Frankfurter FX", "base_url": "https://api.frankfurter.dev",
        "description": "Free, keyless foreign-exchange rates (ECB). Use for currency conversion and historical rates.",
        "endpoints": [
            {"name": "latest", "method": "GET", "path": "/v1/latest", "description": "Latest reference rates.", "query": ["base", "symbols"]},
            {"name": "historical", "method": "GET", "path": "/v1/{date}", "description": "Rates for a past date (YYYY-MM-DD).", "query": ["base", "symbols"]},
            {"name": "currencies", "method": "GET", "path": "/v1/currencies", "description": "Every supported currency code to its name."},
        ],
    },
    {
        "label": "Open-Meteo Weather", "base_url": "https://api.open-meteo.com",
        "description": "Free, keyless weather forecast API for any coordinate worldwide.",
        "endpoints": [
            {"name": "forecast", "method": "GET", "path": "/v1/forecast", "description": "Weather forecast for a coordinate.", "query": ["latitude", "longitude", "current", "hourly", "daily", "timezone"]},
        ],
    },
    {
        "label": "World Bank Data", "base_url": "https://api.worldbank.org",
        "description": "Free, keyless World Bank open data — economic/development indicators by country. Always pass format=json.",
        "endpoints": [
            {"name": "indicator", "method": "GET", "path": "/v2/country/{iso2}/indicator/{indicatorCode}", "description": "Indicator time series for a country.", "query": ["format", "date", "per_page"]},
            {"name": "countries", "method": "GET", "path": "/v2/country", "description": "List/lookup countries and regions.", "query": ["format", "per_page"]},
            {"name": "indicators", "method": "GET", "path": "/v2/indicator", "description": "Search the indicator catalogue.", "query": ["format", "per_page"]},
        ],
    },
    {
        "label": "Wikipedia", "base_url": "https://en.wikipedia.org",
        "description": "Free, keyless Wikipedia REST content API for encyclopaedic lookups.",
        "endpoints": [
            {"name": "summary", "method": "GET", "path": "/api/rest_v1/page/summary/{title}", "description": "Short plain-text summary of a page."},
            {"name": "html", "method": "GET", "path": "/api/rest_v1/page/html/{title}", "description": "Full rendered HTML of a page."},
        ],
    },
    {
        "label": "CoinGecko Crypto", "base_url": "https://api.coingecko.com",
        "description": "Free, keyless cryptocurrency market data.",
        "endpoints": [
            {"name": "simple-price", "method": "GET", "path": "/api/v3/simple/price", "description": "Spot price of coins in fiat.", "query": ["ids", "vs_currencies"]},
            {"name": "markets", "method": "GET", "path": "/api/v3/coins/markets", "description": "Ranked market data.", "query": ["vs_currency", "order", "per_page", "page"]},
        ],
    },
    {
        "label": "Public Holidays", "base_url": "https://date.nager.at",
        "description": "Free, keyless public-holiday calendar (100+ countries).",
        "endpoints": [
            {"name": "holidays", "method": "GET", "path": "/api/v3/PublicHolidays/{year}/{countryCode}", "description": "Public holidays for a year + ISO country code."},
            {"name": "next-holidays", "method": "GET", "path": "/api/v3/NextPublicHolidays/{countryCode}", "description": "Upcoming holidays for a country."},
            {"name": "countries", "method": "GET", "path": "/api/v3/AvailableCountries", "description": "Countries the holiday API covers."},
        ],
    },
]
