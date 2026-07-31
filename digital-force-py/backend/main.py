"""
Digital Force — Main FastAPI Application
"""

import sys
import asyncio

if sys.platform == 'win32':
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

import logging
from contextlib import asynccontextmanager
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pathlib import Path

from config import get_settings
from database import init_db

# API Routers
from api.goals import router as goals_router
from api.training import router as training_router
from api.media import router as media_router
from api.stream import router as stream_router
from api.skills import router as skills_router
from api.analytics import router as analytics_router
from api.settings import router as settings_router
from api.chat import router as chat_router
from api.agency import router as agency_router
from api.accounts import router as accounts_router
from api.voice import router as voice_router

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)
settings = get_settings()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Startup and shutdown events."""
    logger.info("🚀 Digital Force starting up...")
    await init_db()
    logger.info("✅ Database initialized")

    # Single-user local mode: no login. Seed/reuse the one local user.
    from database import ensure_default_user
    from auth import set_local_user
    local_user = await ensure_default_user()
    set_local_user(local_user)
    logger.info(f"👤 Running as local user: {local_user['username']} ({local_user['role']})")

    # Ensure Qdrant collections exist
    try:
        from rag.retriever import ensure_collections
        await ensure_collections()
        logger.info("✅ Qdrant collections ready")
    except Exception as e:
        logger.warning(f"⚠️  Qdrant not available: {e}")

    # Ensure media directories exist
    Path(settings.media_upload_dir).mkdir(parents=True, exist_ok=True)
    Path(settings.media_processed_dir).mkdir(parents=True, exist_ok=True)
    logger.info("✅ Media directories ready")

    logger.info(f"🧠 LLM cascade: Groq Keys: {[bool(settings.groq_api_key_1), bool(settings.groq_api_key_2), bool(settings.groq_api_key_3)]}")
    logger.info(f"📡 Publishing: Buffer={bool(settings.buffer_access_token)} | Facebook={bool(settings.facebook_access_token)}")

    # 👻 Start the Ghost Browser (Persistent Session Playwright)
    from agent.browser.ghost import ghost
    await ghost.start()

    # Hold strong refs to long-lived background tasks. asyncio keeps only weak
    # refs, so an un-referenced create_task() can be GC'd and silently cancelled
    # mid-run. We also cancel them explicitly on shutdown.
    background_tasks: list[asyncio.Task] = []

    # 🤖 Start the Agency Daemon — 24/7 autonomous agent heartbeat
    from agent.agency_daemon import agency_daemon
    background_tasks.append(asyncio.create_task(agency_daemon()))
    logger.info("🤖 Agency Daemon scheduled — Digital Force is autonomous")

    # 📧 Start the Inbox Poller — listining for user email replies
    from agent.tools.email_inbox import poll_email_inbox
    background_tasks.append(asyncio.create_task(poll_email_inbox()))
    logger.info("📧 IMAP Inbox Poller scheduled")

    logger.info("✨ Digital Force is ready.")

    yield

    logger.info("👋 Digital Force shutting down...")

    # Cancel background tasks so they don't outlive the app or block shutdown.
    for t in background_tasks:
        t.cancel()
    try:
        await asyncio.gather(*background_tasks, return_exceptions=True)
    except Exception:
        pass

    # Clean up browser persistence
    await ghost.stop()


app = FastAPI(
    title="NeuroWorks API",
    description="Autonomous Social Media Intelligence Agency",
    version="1.0.0",
    lifespan=lifespan,
    docs_url="/api/docs",
    redoc_url="/api/redoc",
)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Static files for media
media_dir = Path(settings.media_upload_dir)
media_dir.mkdir(parents=True, exist_ok=True)
app.mount("/media", StaticFiles(directory=str(media_dir)), name="media")

# Routers
app.include_router(goals_router)
app.include_router(training_router)
app.include_router(media_router)
app.include_router(stream_router)
app.include_router(skills_router)
app.include_router(analytics_router)
app.include_router(settings_router)
app.include_router(chat_router)
app.include_router(agency_router)
app.include_router(accounts_router)
app.include_router(voice_router)


@app.get("/api/health")
async def health():
    return {
        "status": "online",
        "service": "NeuroWorks",
        "version": "1.0.0",
        "llm": {
            "groq_1": bool(settings.groq_api_key_1),
            "groq_2": bool(settings.groq_api_key_2),
            "groq_3": bool(settings.groq_api_key_3),
        },
        "publishing": {
            "buffer": bool(settings.buffer_access_token),
            "facebook": bool(settings.facebook_access_token),
        },
    }


if __name__ == "__main__":
    import uvicorn
    # Auto-reload is a dev-only feature; never run the reloader in production.
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=settings.debug)
