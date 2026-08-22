"""NAXIONAI — GitHub API: repo summaries, activity digests, and publishing
a local folder as a new repo. See github_client.py for the HTTP/git layer."""

import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

import github_client as gh
import vault
from auth import get_current_user, layer_of_role

router = APIRouter(prefix="/api/github", tags=["github"])
logger = logging.getLogger(__name__)


def _is_admin(user) -> bool:
    return layer_of_role((user or {}).get("role")) in ("admin", "superadmin")


class SummarizeRepoRequest(BaseModel):
    owner: str
    repo: str
    days: int = 14


@router.post("/summarize-repo")
async def summarize_repo(body: SummarizeRepoRequest, user: dict = Depends(get_current_user)):
    try:
        activity = await gh.get_repo_activity(body.owner, body.repo, days=body.days)
    except gh.GitHubError as e:
        raise HTTPException(400, str(e))

    from agent.llm import generate_completion

    commit_lines = "\n".join(f"- {c['sha']} {c['message']} ({c['author']})" for c in activity["commits"][:50]) or "(no commits in this window)"
    prompt = (
        f"Summarize recent activity on {body.owner}/{body.repo} over the last {body.days} days for a project status note.\n\n"
        f"Commits:\n{commit_lines}\n\n"
        f"Open issues: {len(activity['open_issues'])}. Open pull requests: {len(activity['open_pull_requests'])}.\n\n"
        "Write 3-6 sentences: what's been happening, the overall direction, and anything that looks stalled or worth attention."
    )
    summary = await generate_completion(prompt, "You are a concise engineering status reporter.")

    note_path = f"github/{body.owner}-{body.repo}-summary.md"
    body_md = f"# {body.owner}/{body.repo} — summary\n\n{summary}\n\n## Recent commits\n{commit_lines}\n"
    saved = await vault.save_note(note_path, body_md, uploaded_by=user.get("sub"), category="github")
    return {"summary": summary, "activity": activity, "vault_note": saved["path"]}


class DigestRequest(BaseModel):
    repos: List[str]  # "owner/repo" strings
    days: int = 7


@router.post("/digest")
async def repo_digest(body: DigestRequest, user: dict = Depends(get_current_user)):
    sections = []
    errors = []
    for entry in body.repos:
        if "/" not in entry:
            errors.append(f"'{entry}' is not in owner/repo form — skipped")
            continue
        owner, repo = entry.split("/", 1)
        try:
            activity = await gh.get_repo_activity(owner, repo, days=body.days)
        except gh.GitHubError as e:
            errors.append(f"{entry}: {e}")
            continue
        sections.append(
            f"## {owner}/{repo}\n"
            f"{len(activity['commits'])} commits, {len(activity['open_issues'])} open issues, "
            f"{len(activity['open_pull_requests'])} open pull requests in the last {body.days} days."
        )

    digest_md = f"# Repo activity digest — last {body.days} days\n\n" + ("\n\n".join(sections) or "(nothing to report)")
    if errors:
        digest_md += "\n\n## Skipped\n" + "\n".join(f"- {e}" for e in errors)

    saved = await vault.save_note("github/digest.md", digest_md, uploaded_by=user.get("sub"), category="github")
    return {"digest": digest_md, "vault_note": saved["path"], "errors": errors}


class PublishFolderRequest(BaseModel):
    path: str
    name: Optional[str] = None
    private: bool = True
    confirmed: bool = False


@router.post("/publish-folder")
async def publish_folder(body: PublishFolderRequest, user: dict = Depends(get_current_user)):
    # Admin-only, and requires an explicit confirmation flag — mirrors
    # neuroworks' `requiresApproval: true` on this exact template. Unlike
    # `git_command` (agent/tools/pa_tools.py), which is LLM-callable but
    # locked to one fixed repo, this route accepts an arbitrary path chosen
    # by a human through the UI/API — never something an LLM can trigger.
    if not _is_admin(user):
        raise HTTPException(403, "Publishing a repo requires admin access")
    if not body.confirmed:
        raise HTTPException(400, "Set confirmed=true to publish this folder as a new GitHub repository")

    folder = Path(body.path)
    if not folder.is_dir():
        raise HTTPException(400, f"'{body.path}' does not exist or is not a directory on this machine")

    repo_name = (body.name or folder.name).strip()
    if not repo_name:
        raise HTTPException(400, "Could not derive a repo name — pass one explicitly")

    try:
        repo = await gh.create_repo(repo_name, private=body.private, description=f"Published from {folder.name} via NaxionAI")
    except gh.GitHubError as e:
        raise HTTPException(400, str(e))

    from config import get_settings
    settings = get_settings()
    try:
        gh.push_folder_to_repo(folder, repo["clone_url"], settings.github_token)
    except gh.GitHubError as e:
        raise HTTPException(500, f"Repo '{repo['full_name']}' was created but the push failed: {e}")

    return {"repo": repo}
