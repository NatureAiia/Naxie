"""
NAXIONAI — Filesystem/SSRF security gates.

Ported from neuroworks/server/src/lib/security-gates.ts. Small, focused
checks applied at the boundary of any tool that can read arbitrary disk
paths or fetch arbitrary URLs — the LLM drives the args, so prompt injection
(a malicious web page or note tricks the model into reading .ssh/id_rsa or
hitting the AWS metadata service) is a real threat surface.

Each gate has an explicit opt-out setting for a power user with genuine
need. Default is locked-down.
"""

import ipaddress
import re
import socket
from pathlib import Path
from typing import NamedTuple, Optional
from urllib.parse import urlparse

from config import get_settings

settings = get_settings()

# Path patterns that look like they target known sensitive files. Matched
# against the FULL resolved path so a caller that hands us "../../.env"
# gets normalized first.
_SENSITIVE_PATH_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(?:^|[\\/])\.env(?:\.\w+)?$", re.I), ".env files often contain API keys and secrets"),
    (re.compile(r"(?:^|[\\/])\.ssh[\\/]", re.I), "SSH key directory"),
    (re.compile(r"(?:^|[\\/])\.gnupg[\\/]", re.I), "GnuPG keyring directory"),
    (re.compile(r"(?:^|[\\/])\.aws[\\/](?:credentials|config)$", re.I), "AWS credentials file"),
    (re.compile(r"(?:^|[\\/])\.kube[\\/]config$", re.I), "Kubernetes config (cluster credentials)"),
    (re.compile(r"(?:^|[\\/])\.docker[\\/]config\.json$", re.I), "Docker registry credentials"),
    (re.compile(r"(?:^|[\\/])\.npmrc$", re.I), "npm auth tokens"),
    (re.compile(r"(?:^|[\\/])\.pypirc$", re.I), "PyPI auth tokens"),
    (re.compile(r"(?:^|[\\/])\.netrc$", re.I), "netrc credentials"),
    (re.compile(r"id_(?:rsa|ed25519|ecdsa|dsa)(?:\.pub)?$", re.I), "SSH private/public key"),
    (re.compile(r"(?:^|[\\/])(?:Cookies|Login Data|Web Data|History|Bookmarks)$", re.I), "Browser profile data (cookies, saved logins, history)"),
    (re.compile(r"(?:^|[\\/])(?:wallet|keystore)\.(?:dat|json)$", re.I), "Crypto wallet file"),
    (re.compile(r"(?:^|[\\/])master\.key$", re.I), "Application master key"),
    (re.compile(r"[\\/]Windows[\\/]System32[\\/]config[\\/](?:SAM|SECURITY|SYSTEM)$", re.I), "Windows registry hive (credentials)"),
    (re.compile(r"\.keychain(?:-db)?$", re.I), "macOS Keychain"),
    (re.compile(r"^/etc/(?:shadow|sudoers|gshadow)$", re.I), "POSIX credential file"),
]


class SensitivePathCheck(NamedTuple):
    blocked: bool
    reason: Optional[str] = None
    pattern: Optional[str] = None


def check_sensitive_path(raw_path: str) -> SensitivePathCheck:
    """Returns blocked=True when the path matches a sensitive pattern AND
    settings.fs_unrestricted is NOT set. The override is explicit and global
    so a debugging session that genuinely needs to read a local .env can,
    consciously."""
    if settings.fs_unrestricted:
        return SensitivePathCheck(False)
    try:
        full = str(Path(raw_path).resolve())
    except Exception:
        return SensitivePathCheck(False)
    name = Path(full).name
    for pattern, reason in _SENSITIVE_PATH_PATTERNS:
        if pattern.search(full) or pattern.search(name):
            return SensitivePathCheck(True, reason, pattern.pattern)
    return SensitivePathCheck(False)


def assert_safe_external_path(raw_path: str) -> None:
    check = check_sensitive_path(raw_path)
    if check.blocked:
        raise PermissionError(
            f'Refused to read "{raw_path}" — {check.reason}. '
            "If you genuinely need this, set FS_UNRESTRICTED=true to lift the gate (logged)."
        )


# ── SSRF: private/loopback address detection ────────────────────────────
# Covers IPv4 private ranges, loopback, link-local (incl. cloud metadata
# 169.254.169.254), IPv6 loopback/link-local/unique-local, localhost names,
# and internal-only TLDs. Override via settings.web_allow_private for
# legitimate use cases like fetching from a local dev server.

_INTERNAL_TLDS = (".internal", ".local", ".lan", ".intranet")


class PrivateAddressCheck(NamedTuple):
    blocked: bool
    reason: Optional[str] = None
    host: Optional[str] = None


def _is_private_ip(ip_str: str) -> Optional[str]:
    try:
        ip = ipaddress.ip_address(ip_str)
    except ValueError:
        return None
    if ip.is_loopback:
        return "loopback"
    if ip.is_link_local:
        return "link-local (incl. cloud metadata)"
    if ip.is_private:
        return "private range"
    if ip.is_unspecified:
        return "wildcard/unspecified"
    if isinstance(ip, ipaddress.IPv6Address) and ip.is_private:
        return "IPv6 unique-local"
    return None


def check_private_address(url: str) -> PrivateAddressCheck:
    if settings.web_allow_private:
        return PrivateAddressCheck(False)
    try:
        u = urlparse(url)
    except Exception:
        return PrivateAddressCheck(False)
    if u.scheme not in ("http", "https"):
        return PrivateAddressCheck(True, f"unsupported scheme {u.scheme} (only http/https allowed)", u.hostname)
    host = (u.hostname or "").lower()
    if not host:
        return PrivateAddressCheck(False)

    if host == "localhost" or host == "localhost.localdomain" or host.endswith(".localhost"):
        return PrivateAddressCheck(True, "localhost target", host)
    if host.endswith(_INTERNAL_TLDS):
        return PrivateAddressCheck(True, f"internal-only TLD (.{host.rsplit('.', 1)[-1]})", host)

    why = _is_private_ip(host.strip("[]"))
    if why:
        return PrivateAddressCheck(True, why, host)
    return PrivateAddressCheck(False)


def check_private_address_async(url: str) -> PrivateAddressCheck:
    """Also resolves the hostname and re-checks the resolved IP(s) against
    the private ranges — a public hostname pointing at 169.254.169.254 /
    127.0.0.1 / 10.x would slip past the sync check and hit cloud metadata
    or an internal service. Not fully TOCTOU-proof (DNS can change between
    this check and the actual fetch), but strong defense-in-depth.

    Despite the name, this runs a blocking DNS lookup synchronously —
    callers on the async path should run it via asyncio.to_thread()."""
    sync = check_private_address(url)
    if sync.blocked:
        return sync
    if settings.web_allow_private:
        return PrivateAddressCheck(False)
    try:
        host = (urlparse(url).hostname or "").lower()
    except Exception:
        return PrivateAddressCheck(False)
    if not host or _is_private_ip(host) is not None or ":" in host:
        return PrivateAddressCheck(False)

    try:
        addrs = {info[4][0] for info in socket.getaddrinfo(host, None)}
    except Exception:
        return PrivateAddressCheck(False)  # resolution failure → let the fetch fail naturally

    for addr in addrs:
        why = _is_private_ip(addr)
        if why:
            return PrivateAddressCheck(True, f"{host} resolves to {addr} ({why})", host)
    return PrivateAddressCheck(False)


def assert_safe_public_url(url: str, *, resolve_dns: bool = False) -> None:
    check = check_private_address_async(url) if resolve_dns else check_private_address(url)
    if check.blocked:
        raise PermissionError(
            f'Refused to fetch "{url}" — target {check.host or "address"} is {check.reason}. '
            "Agent web tools are restricted to the public internet to prevent SSRF. "
            "Set WEB_ALLOW_PRIVATE=true if you genuinely need to reach internal hosts."
        )
