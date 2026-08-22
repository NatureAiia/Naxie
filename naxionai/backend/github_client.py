"""
NAXIONAI — GitHub client

Reuses connector_client.py's SSRF-safe origin-lock pattern (resolve_url):
every call resolves against `settings.github_api_url`, which is operator-
configured (like `git_repo_path`/`local_documents_root`), never LLM-supplied.

`publish_repo_folder` is deliberately NOT exposed as an agent tool (contrast
with agent/tools/pa_tools.py's `git_command`, which is LLM-callable but
locked to ONE pre-configured repo). This feature's whole point is an
arbitrary, human-chosen local folder, so it only exists as a human-initiated,
admin-gated API route (see api/github.py) — never something an LLM's own
output could trigger.
"""

import logging
import subprocess
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Optional

import httpx

from config import get_settings
from connector_client import ConnectorError, resolve_url

logger = logging.getLogger(__name__)

GITHUB_TIMEOUT_SECONDS = 30.0


class GitHubError(Exception):
    pass


def _headers() -> dict:
    settings = get_settings()
    headers = {"accept": "application/vnd.github+json", "x-github-api-version": "2022-11-28"}
    if settings.github_token:
        headers["authorization"] = f"Bearer {settings.github_token}"
    return headers


async def _request(method: str, path: str, **kwargs) -> httpx.Response:
    settings = get_settings()
    try:
        url = resolve_url(settings.github_api_url, path)
    except ConnectorError as e:
        raise GitHubError(str(e))
    async with httpx.AsyncClient(timeout=GITHUB_TIMEOUT_SECONDS) as client:
        resp = await client.request(method, url, headers=_headers(), **kwargs)
    if resp.status_code == 404:
        raise GitHubError(f"GitHub returned 404 for {path} — check the repo name and token scope")
    if resp.status_code == 403:
        raise GitHubError("GitHub rate-limited or refused this request — check GITHUB_TOKEN and its scopes")
    if resp.status_code >= 400:
        raise GitHubError(f"GitHub API error for {path}: HTTP {resp.status_code} — {resp.text[:300]}")
    return resp


async def get_repo_activity(owner: str, repo: str, days: int = 7) -> dict:
    """Recent commits, open issues, and open PRs for owner/repo over the last `days`."""
    since = (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    commits_resp = await _request("GET", f"/repos/{owner}/{repo}/commits", params={"since": since, "per_page": 50})
    commits = [
        {
            "sha": c["sha"][:7],
            "message": c["commit"]["message"].splitlines()[0],
            "author": (c["commit"].get("author") or {}).get("name"),
            "date": (c["commit"].get("author") or {}).get("date"),
        }
        for c in commits_resp.json()
    ]

    issues_resp = await _request("GET", f"/repos/{owner}/{repo}/issues", params={"state": "open", "per_page": 30})
    issues, pulls = [], []
    for item in issues_resp.json():
        entry = {"number": item["number"], "title": item["title"], "url": item["html_url"], "created_at": item["created_at"]}
        (pulls if "pull_request" in item else issues).append(entry)

    return {"owner": owner, "repo": repo, "since": since, "commits": commits, "open_issues": issues, "open_pull_requests": pulls}


async def create_repo(name: str, private: bool = True, description: str = "") -> dict:
    settings = get_settings()
    if not settings.github_token:
        raise GitHubError("GITHUB_TOKEN not configured — cannot create a repository")
    resp = await _request("POST", "/user/repos", json={"name": name, "private": private, "description": description})
    data = resp.json()
    return {"full_name": data["full_name"], "clone_url": data["clone_url"], "html_url": data["html_url"]}


def push_folder_to_repo(folder: Path, clone_url: str, github_token: str) -> str:
    """Init (if needed)/commit/push a local folder to an already-created
    remote repo. Runs synchronously via the `git` CLI — same subprocess
    approach as agent/tools/pa_tools.py's `git_command`, no GitPython
    dependency needed. The token is injected into the remote URL for this
    push only and never logged."""
    if not clone_url.startswith("https://"):
        raise GitHubError("Expected an https:// clone URL")
    authed_url = clone_url.replace("https://", f"https://x-access-token:{github_token}@", 1)

    def _run(args: list[str]) -> subprocess.CompletedProcess:
        return subprocess.run(args, cwd=str(folder), capture_output=True, text=True, timeout=120)

    if not (folder / ".git").is_dir():
        r = _run(["git", "init"])
        if r.returncode != 0:
            raise GitHubError(f"git init failed: {r.stderr.strip()}")
        _run(["git", "checkout", "-B", "main"])

    _run(["git", "add", "-A"])
    commit = _run(["git", "commit", "-m", "Initial publish via NaxionAI"])
    # A commit "failing" because there's nothing new to commit is not an error.
    if commit.returncode != 0 and "nothing to commit" not in (commit.stdout + commit.stderr).lower():
        raise GitHubError(f"git commit failed: {commit.stderr.strip()}")

    remote_check = _run(["git", "remote"])
    if "origin" in remote_check.stdout.split():
        _run(["git", "remote", "set-url", "origin", authed_url])
    else:
        _run(["git", "remote", "add", "origin", authed_url])

    push = _run(["git", "push", "-u", "origin", "HEAD:main"])
    if push.returncode != 0:
        # Strip the token out of anything that might echo the remote URL back.
        safe_err = push.stderr.replace(github_token, "***")
        raise GitHubError(f"git push failed: {safe_err.strip()}")
    return "pushed"
