"""
NAXIONAI — Central Configuration
All environment variables, loaded once, cached globally.
"""

from pydantic_settings import BaseSettings
from pydantic import Field
from functools import lru_cache
from typing import Optional
import os

# Placeholder secrets shipped as dev defaults. Hoisted to module constants so the
# production fail-fast in get_settings() can compare against the exact same value
# the field defaults to — the check can never drift from the default.
_DEFAULT_JWT_SECRET = "CHANGE-THIS-IN-PRODUCTION-USE-256-BIT-KEY"
_DEFAULT_ENCRYPTION_KEY = "CHANGE-THIS-32-BYTE-KEY-IN-PROD!!"


class Settings(BaseSettings):
    # ── App ──────────────────────────────────────────────
    app_name: str = "NaxionAI"
    app_version: str = "1.0.0"
    environment: str = "development"  # development | staging | production
    # Default OFF: debug enables SQLAlchemy echo (logs every statement, possibly
    # sensitive values) and verbose errors. Turn on explicitly via DEBUG=true in dev.
    debug: bool = False
    base_url: str = "http://localhost:8000"
    frontend_url: str = "http://localhost:3000"

    # ── Security ─────────────────────────────────────────
    jwt_secret_key: str = _DEFAULT_JWT_SECRET
    jwt_algorithm: str = "HS256"
    jwt_expiration_minutes: int = 1440   # 24 hours
    encryption_key: str = _DEFAULT_ENCRYPTION_KEY
    # Default OFF: get_current_user() keeps returning the single seeded local
    # user regardless of Authorization header, matching today's behavior.
    # Flip to true only once the frontend's NEXT_PUBLIC_REAL_AUTH is also on
    # and a real login has been completed — turning this on first locks
    # every request out (no valid token exists yet).
    require_auth: bool = False

    # ── Database ─────────────────────────────────────────
    # PostgreSQL for production, SQLite for dev
    database_url: str = "sqlite+aiosqlite:///./naxionai.db"
    # PostgreSQL example:
    # database_url: str = "postgresql+asyncpg://user:pass@localhost:5432/naxionai"

    # ── Redis ─────────────────────────────────────────────
    redis_url: str = "redis://localhost:6379/0"
    redis_password: Optional[str] = None

    # ── AI Ecosystem: Groq Cluster (9 Models Cascade) ─────
    groq_api_key_1: str = ""
    groq_api_key_2: str = ""
    groq_api_key_3: str = ""

    groq_primary_model: str = "llama-3.3-70b-versatile"
    groq_secondary_model: str = "mixtral-8x7b-32768"
    groq_fallback_model: str = "groq/compound"

    groq_max_tokens: int = 4096
    groq_temperature: float = 0.7

    # ── LLM provider — local Ollama by default, Groq kept as an escape hatch ──
    llm_provider: str = "ollama"          # "ollama" | "groq"
    ollama_host: str = "http://127.0.0.1:11434"
    ollama_model: str = "qwen2.5:3b"
    ollama_vision_model: str = ""         # optional; blank = vision features (DOM self-heal) no-op

    # ── Voice: local STT (faster-whisper) + TTS ─────
    whisper_model_size: str = "base"      # CPU-only machine; start small
    tts_engine: str = "elevenlabs"        # "elevenlabs" | "piper" | "pyttsx3"
    piper_voice: str = "en_US-amy-medium"  # female — the real offline voice when there's no internet for ElevenLabs
    elevenlabs_voice_id: str = "EXAVITQu4vr4xnSDxMaL"  # Sarah — premade voice, works on free-tier API
    elevenlabs_api_key: str = ""
    wake_word_default: str = "Hey Naxie"  # surfaced to frontend; not enforced server-side

    # ── Vector DB: Qdrant ─────────────────────────────────
    qdrant_url: str = ""                          # Cloud: https://xxx.qdrant.io
    qdrant_api_key: str = ""
    qdrant_local_path: str = "./qdrant_data"     # Local fallback
    # Collections
    qdrant_knowledge_collection: str = "df-knowledge"
    qdrant_media_collection: str = "df-media"
    qdrant_brand_collection: str = "df-brand"
    qdrant_dimension: int = 384                  # all-MiniLM-L6-v2

    # ── Publishing: Buffer API ────────────────────────────
    buffer_access_token: str = ""
    buffer_api_url: str = "https://api.bufferapp.com/1"

    # ── Publishing: Facebook Graph API ───────────────────
    facebook_page_id: str = ""
    facebook_access_token: str = ""
    facebook_api_version: str = "v21.0"

    # ── Image Generation ──────────────────────────────────
    stability_api_key: str = ""               # Stable Diffusion alternative

    # ── Image Storage ─────────────────────────────────────
    # Local storage (default) or S3/R2
    storage_backend: str = "local"           # local | s3 | r2
    media_upload_dir: str = "./media/uploads"
    media_processed_dir: str = "./media/processed"
    s3_bucket: str = ""
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    r2_account_id: str = ""
    r2_access_key: str = ""
    r2_secret_key: str = ""
    r2_bucket: str = ""

    # ── Email (for approval notifications) ───────────────
    smtp_host: str = "smtp.gmail.com"
    smtp_port: int = 587
    smtp_username: str = ""
    smtp_password: str = ""
    smtp_from_name: str = "NaxionAI"
    smtp_from_email: str = "noreply@naxionai.app"
    target_notification_emails: str = ""

    # ── SkillForge (E2B Sandbox) ──────────────────────────
    e2b_api_key: str = ""
    skillforge_enabled: bool = True
    # `execute_python` / generated-skill code currently runs in a LOCAL subprocess
    # as this OS user — no real isolation. Running agent-authored (LLM/prompt-
    # injectable) code on the host in production is arbitrary RCE, so it is refused
    # in production unless the operator explicitly opts in here (accepting the risk)
    # or a real isolated sandbox is wired. Dev is permitted so the app runs locally.
    allow_host_code_exec: bool = False

    # ── PA Tools (system control) ─────────────────────────
    # `system_control` / `manage_clipboard` let the agent launch processes and
    # read/write the Windows clipboard on this host. Same reasoning as
    # allow_host_code_exec above: the inputs driving these tools flow through
    # prompt-injectable text (chat, RAG, web content), so refuse in production
    # unless the operator explicitly opts in. Dev is permitted by default.
    allow_system_control: bool = False

    # ── Web Research ──────────────────────────────────────
    tavily_api_key: str = ""                  # Tavily Search API
    serpapi_key: str = ""                     # SerpAPI alternative

    # ── Agent Configuration ───────────────────────────────
    agent_max_iterations: int = 10
    agent_timeout_seconds: int = 300
    # Per-LLM-request timeout. Without it a hung Groq socket stalls the agent /
    # daemon indefinitely; this bounds each individual call so the cascade can
    # fail over instead of hanging.
    llm_request_timeout_seconds: int = 60
    approval_token_expires_hours: int = 48

    # ── CORS ─────────────────────────────────────────────
    cors_origins: str = "http://localhost:3000,http://127.0.0.1:3000"

    @property
    def cors_origins_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",")]

    @property
    def is_production(self) -> bool:
        return self.environment == "production"

    @property
    def qdrant_use_cloud(self) -> bool:
        return bool(self.qdrant_url and self.qdrant_api_key)

    class Config:
        env_file = os.path.join(os.path.dirname(__file__), "..", ".env")
        env_file_encoding = "utf-8"
        case_sensitive = False
        extra = "ignore"


@lru_cache()
def get_settings() -> Settings:
    """Cached settings singleton — loaded once at startup.

    Fails fast in production if security-critical secrets are still the shipped
    placeholder values: a default JWT signing key lets anyone forge an admin
    token, and a default encryption key makes every stored credential blob
    decryptable by anyone with the source. In development the placeholders are
    allowed so the app runs out-of-the-box.
    """
    s = Settings()
    if s.is_production:
        placeholders = []
        if s.jwt_secret_key == _DEFAULT_JWT_SECRET:
            placeholders.append("JWT_SECRET_KEY")
        if s.encryption_key == _DEFAULT_ENCRYPTION_KEY:
            placeholders.append("ENCRYPTION_KEY")
        if placeholders:
            raise RuntimeError(
                "Refusing to start in production with default placeholder secret(s): "
                f"{', '.join(placeholders)}. Set each to a strong, unique value via the "
                "environment or .env before deploying."
            )
    return s
