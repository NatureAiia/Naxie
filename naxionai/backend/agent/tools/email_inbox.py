"""
NAXIONAI — Agent Email Inbox Poller

Connects to the inbox specified in .env via IMAP.
Polls every 60 seconds for UNSEEN replies to agent emails.
Matches the [Ref: TOKEN] in the subject, parses 'approve' or 'skip',
and marks the DB record. Also pushes a chat message so the standard
agency loop (daemon/agent) picks up the approval.
"""

import asyncio
import imaplib
import email
import logging
import re
from datetime import datetime
from email.header import decode_header

from config import get_settings
from database import async_session, PendingEmailApproval, ChatMessage

logger = logging.getLogger(__name__)
settings = get_settings()

POLL_INTERVAL_SEC = 120


def _get_imap_host() -> str:
    """Derive IMAP host from SMTP host (e.g. smtp.gmail.com -> imap.gmail.com)"""
    if "gmail.com" in settings.smtp_host:
        return "imap.gmail.com"
    return settings.smtp_host.replace("smtp", "imap")


def _decode_str(s: str) -> str:
    if not s:
        return ""
    decoded, charset = decode_header(s)[0]
    if isinstance(decoded, bytes):
        try:
            return decoded.decode(charset or 'utf-8')
        except Exception:
            return decoded.decode('utf-8', errors='ignore')
    return str(decoded)


def _extract_text_body(msg) -> str:
    if msg.is_multipart():
        for part in msg.walk():
            ctype = part.get_content_type()
            cdispo = str(part.get('Content-Disposition'))
            if ctype == 'text/plain' and 'attachment' not in cdispo:
                try:
                    return part.get_payload(decode=True).decode()
                except Exception:
                    pass
    else:
        try:
            return msg.get_payload(decode=True).decode()
        except Exception:
            pass
    return ""


async def poll_email_inbox():
    """Background task to poll the inbox via IMAP."""
    if not settings.smtp_username or not settings.smtp_password:
        logger.warning("[InboxPoller] Email not configured — poller disabled.")
        return

    host = _get_imap_host()
    logger.info(f"[InboxPoller] Started polling {host} for replies to {settings.smtp_username}")

    while True:
        try:
            await asyncio.to_thread(_check_inbox, host)
        except Exception as e:
            logger.error(f"[InboxPoller] Error during poll: {e}")
        
        await asyncio.sleep(POLL_INTERVAL_SEC)


def _clean_email_body(text: str) -> str:
    cleaned = []
    for line in text.split('\n'):
        line_clean = line.strip().lower()
        if not line_clean: continue
        if line_clean.startswith('>'): continue
        if re.match(r'^on\s+.*wrote:.*$', line_clean): break
        if re.match(r'^from:\s+.*$', line_clean): break
        if "original message" in line_clean: break
        cleaned.append(line_clean)
    return " ".join(cleaned)

def _count_unread(host: str) -> int:
    """Blocking IMAP UNSEEN count, runs in a thread. Returns 0 on any failure
    (no mailbox configured, offline, wrong creds) — this feeds an optional
    digest line, never something worth surfacing an error for."""
    import socket
    socket.setdefaulttimeout(15)
    try:
        mail = imaplib.IMAP4_SSL(host)
        mail.login(settings.smtp_username, settings.smtp_password)
        mail.select('inbox', readonly=True)
        _, search_data = mail.search(None, 'UNSEEN')
        count = len(search_data[0].split()) if search_data and search_data[0] else 0
        mail.close()
        mail.logout()
        return count
    except Exception as e:
        logger.info(f"[InboxPoller] Unread count check skipped: {e}")
        return 0


async def get_unread_count() -> int:
    """Non-blocking wrapper around _count_unread — returns 0 if SMTP/IMAP
    credentials aren't configured at all, without ever raising."""
    if not settings.smtp_username or not settings.smtp_password:
        return 0
    return await asyncio.to_thread(_count_unread, _get_imap_host())


def _check_inbox(host: str):
    """Blocking IMAP check, runs in a thread."""
    import socket
    socket.setdefaulttimeout(30)
    try:
        mail = imaplib.IMAP4_SSL(host)
        mail.login(settings.smtp_username, settings.smtp_password)
        mail.select('inbox')

        _, search_data = mail.search(None, 'UNSEEN')
        for num in search_data[0].split():
            _, data = mail.fetch(num, '(RFC822)')
            msg = email.message_from_bytes(data[0][1])
            subject = _decode_str(msg.get("Subject", ""))
            
            # Check if this is a reply to one of our approval emails
            token_match = re.search(r'Ref:\s*([A-Z0-9]{8,})', subject)
            if not token_match:
                continue
                
            token = token_match.group(1)
            from_addr = email.utils.parseaddr(msg.get("From", ""))[1].strip().lower()
            body = _extract_text_body(msg)

            clean_body = _clean_email_body(body)

            # Negation / rejection is evaluated FIRST so "do not approve" / "don't
            # approve" resolves to skipped, not approved. Only an explicit,
            # non-negated approval counts as approval.
            resolution = None
            if re.search(r"\b(skip|drop|reject|rejected|decline|declined|do not|don'?t|no|cancel)\b", clean_body):
                resolution = "skipped"
            elif re.search(r'\b(approve|approved|go ahead|yes|do it|confirm|confirmed)\b', clean_body):
                resolution = "approved"

            if resolution:
                logger.info(f"[InboxPoller] Received '{resolution}' for token {token} from {from_addr or 'unknown'}")
                # We need an event loop to run async DB ops
                try:
                    loop = asyncio.get_running_loop()
                except RuntimeError:
                    loop = None

                if loop and loop.is_running():
                    asyncio.run_coroutine_threadsafe(_process_approval_reply(token, resolution, from_addr), loop)
                else:
                    asyncio.run(_process_approval_reply(token, resolution, from_addr))

        mail.close()
        mail.logout()
    except Exception as e:
        if "EOF" in str(e):
            logger.info(f"[InboxPoller] IMAP timeout/EOF (expected if no new mail). Retrying next cycle.")
        else:
            logger.error(f"[InboxPoller] IMAP connection failed: {e}")


async def _process_approval_reply(token: str, resolution: str, from_addr: str = ""):
    """Process an approval reply found via IMAP and resume the agent."""
    from sqlalchemy import select
    from database import User
    try:
        async with async_session() as session:
            stmt = select(PendingEmailApproval).where(PendingEmailApproval.token == token)
            result = await session.execute(stmt)
            pending = result.scalar_one_or_none()

            if not pending or pending.resolved:
                logger.info(f"[InboxPoller] Token {token} already resolved or not found in DB.")
                return

            # Verify the reply actually came from the user who owns this approval.
            # Without this, anyone who learns/guesses a token (or is forwarded the
            # email) could authorize a high-risk action by replying "approve".
            owner = (await session.execute(select(User).where(User.id == pending.user_id))).scalar_one_or_none()
            owner_email = (owner.email if owner else "").strip().lower()
            if not from_addr or not owner_email or from_addr != owner_email:
                logger.warning(
                    "[InboxPoller] Rejecting approval for token %s: sender %r does not match owner %r",
                    token, from_addr, owner_email,
                )
                return

            # Mark it
            pending.resolved = True
            pending.resolution = resolution
            pending.resolved_at = datetime.utcnow()
            
            # Insert a ChatMessage from the user so the agent picks it up
            # This simulates the user typing "approve" or "skip" in the dashboard
            import uuid
            msg_content = "approve" if resolution == "approved" else "skip"
            
            msg = ChatMessage(
                id=str(uuid.uuid4()),
                user_id=pending.user_id,
                role="user",
                agent_name=None,
                goal_id=pending.goal_id,
                content=msg_content,
            )
            session.add(msg)
            await session.commit()
            
            logger.info(f"[InboxPoller] ✅ Successfully processed email {resolution} for goal {pending.goal_id}")
            
    except Exception as e:
        logger.error(f"[InboxPoller] Failed to process approval reply: {e}")
