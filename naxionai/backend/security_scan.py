"""
NAXIONAI — Conservative secret/risk detector.

Ported from neuroworks/server/src/lib/security.ts. Each finding has a
severity the caller uses to decide whether to refuse the write (high),
redact it (medium), or just log it (low). Patterns are intentionally
specific — better to miss a fuzzy match than false-positive on user prose.
"""

import re
from dataclasses import dataclass
from typing import Literal

Severity = Literal["high", "medium", "low"]
Kind = Literal["note", "code", "commit-message"]


@dataclass
class SecurityFinding:
    type: str
    match: str
    severity: Severity
    reason: str


# High-severity: real-looking secrets. Prefixes are the strongest signal
# because issuers document them; length lower-bounds cut false positives on
# prose.
_SECRET_PATTERNS: list[tuple[str, re.Pattern, str]] = [
    ("github_pat", re.compile(r"\bghp_[A-Za-z0-9]{36,}\b"), "GitHub personal access token"),
    ("github_fine_grained", re.compile(r"\bgithub_pat_[A-Za-z0-9_]{60,}\b"), "GitHub fine-grained PAT"),
    ("openai_key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b"), "OpenAI API key"),
    ("anthropic_key", re.compile(r"\bsk-ant-[A-Za-z0-9_-]{20,}\b"), "Anthropic API key"),
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "AWS access key id"),
    ("google_api_key", re.compile(r"\bAIza[0-9A-Za-z_-]{35}\b"), "Google API key"),
    ("slack_token", re.compile(r"\bxox[abprs]-[A-Za-z0-9-]{10,}\b"), "Slack token"),
    ("private_key_pem", re.compile(r"-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----"), "PEM private key block"),
    ("jwt", re.compile(r"\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b"), "JWT-shaped token"),
]

_URL_RE = re.compile(r"\bhttps?://([^\s)\]\"']+)", re.I)
_DODGY_TLDS = {"tk", "ml", "ga", "cf", "click", "zip", "mov"}
_IP_HOST_RE = re.compile(r"^(\d{1,3}\.){3}\d{1,3}$")

_INJECT_PATTERNS = [
    (re.compile(r"\b(?:rm\s+-rf\s+/|:\s*\(\s*\)\s*\{)"), "destructive shell pattern"),
    (re.compile(r"\b(?:curl|wget)\s+\S+\s*\|\s*(?:bash|sh|zsh)\b"), "remote-pipe-execute"),
]


def scan_for_security_risks(content: str, kind: Kind = "note") -> list[SecurityFinding]:
    out: list[SecurityFinding] = []
    seen: set[str] = set()

    def add(finding: SecurityFinding) -> None:
        key = f"{finding.type}:{finding.match}"
        if key in seen:
            return
        seen.add(key)
        out.append(finding)

    for type_, pattern, reason in _SECRET_PATTERNS:
        for m in pattern.finditer(content):
            add(SecurityFinding(type_, m.group(0), "high", reason))

    for m in _URL_RE.finditer(content):
        host = m.group(1).split("/")[0].lower()
        tld = host.rsplit(".", 1)[-1] if "." in host else ""
        if _IP_HOST_RE.match(host):
            add(SecurityFinding("ip_url", m.group(0), "medium", "URL points at a raw IP"))
        elif tld in _DODGY_TLDS:
            add(SecurityFinding("dodgy_tld", m.group(0), "medium", f"URL TLD .{tld} is commonly abused"))

    if kind in ("code", "commit-message"):
        for pattern, reason in _INJECT_PATTERNS:
            for m in pattern.finditer(content):
                add(SecurityFinding("command_injection", m.group(0), "low", reason))

    return out


def redact_high_severity(content: str, findings: list[SecurityFinding]) -> str:
    out = content
    for f in findings:
        if f.severity == "high" and f.match:
            out = out.replace(f.match, f"[REDACTED:{f.type}]")
    return out
