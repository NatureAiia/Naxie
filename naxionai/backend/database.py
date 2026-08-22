"""
NAXIONAI — Database Models & Session Management
Full SQLAlchemy async ORM with all core models.
"""

from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship
from sqlalchemy import (
    String, Float, Boolean, Integer, Text, DateTime,
    ForeignKey, JSON, BigInteger, Enum, UniqueConstraint
)
from datetime import datetime
from typing import Optional
import uuid
import logging

from config import get_settings

logger = logging.getLogger(__name__)


class Base(DeclarativeBase):
    pass


# ═══════════════════════════════════════════════════════════
# AUTH
# ═══════════════════════════════════════════════════════════

class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    username: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    email: Mapped[str] = mapped_column(String(255), unique=True, index=True)
    hashed_password: Mapped[str] = mapped_column(String(255))
    # superadmin | admin | staff (legacy operator/viewer resolve to staff — see
    # auth.layer_of_role()). Real multi-user auth (api/auth.py) is dormant
    # until settings.require_auth is turned on.
    role: Mapped[str] = mapped_column(String(50), default="operator")
    full_name: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    avatar_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    last_login: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # ── Multi-user auth fields (Phase 1) ──────────────────────
    # active | pending | disabled. Bootstrap: the first account to ever set a
    # real password becomes active/superadmin; every later signup lands
    # pending until an admin approves it.
    status: Mapped[str] = mapped_column(String(20), default="active")
    department: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    title: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    work_mode: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)  # agent | hybrid | human
    salary_monthly: Mapped[Optional[float]] = mapped_column(Float, nullable=True)
    reports_to: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    # False for the legacy single-user seed (random unusable password) until
    # someone actually claims the account via POST /api/auth/signup.
    has_set_password: Mapped[bool] = mapped_column(Boolean, default=False)


# ═══════════════════════════════════════════════════════════
# GOALS — The top-level mission objects
# ═══════════════════════════════════════════════════════════

class Goal(Base):
    __tablename__ = "goals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(500))           # Short label
    description: Mapped[str] = mapped_column(Text)            # Full natural language goal
    platforms: Mapped[Optional[str]] = mapped_column(Text, nullable=True)        # JSON list: ["linkedin","facebook","tiktok"]
    assets: Mapped[Optional[str]] = mapped_column(Text, nullable=True)           # JSON list of MediaAsset IDs to use
    deadline: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    success_metrics: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON: {"followers": 10000}
    constraints: Mapped[Optional[str]] = mapped_column(Text, nullable=True)      # JSON: {"no_weekends": true}
    priority: Mapped[str] = mapped_column(String(20), default="normal")          # low | normal | high | urgent

    # Status lifecycle
    status: Mapped[str] = mapped_column(
        String(50), default="briefing"
    )
    # briefing → planning → awaiting_approval → executing → monitoring → complete | paused | failed

    # The agent's plan (set by Strategist agent)
    plan: Mapped[Optional[str]] = mapped_column(Text, nullable=True)             # JSON structured campaign plan

    # Human approval
    approval_token: Mapped[Optional[str]] = mapped_column(String(255), nullable=True, index=True)
    approval_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # Human feedback
    approved_by: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    approved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Progress tracking
    tasks_total: Mapped[int] = mapped_column(Integer, default=0)
    tasks_completed: Mapped[int] = mapped_column(Integer, default=0)
    tasks_failed: Mapped[int] = mapped_column(Integer, default=0)
    progress_percent: Mapped[float] = mapped_column(Float, default=0.0)
    last_monitor_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    replan_count: Mapped[int] = mapped_column(Integer, default=0)

    # Metadata
    created_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # Relationships
    tasks: Mapped[list["AgentTask"]] = relationship(back_populates="goal", cascade="all, delete-orphan")
    logs: Mapped[list["AgentLog"]] = relationship(back_populates="goal", cascade="all, delete-orphan")


# ═══════════════════════════════════════════════════════════
# AGENT TASKS — Atomic units of work the agents execute
# ═══════════════════════════════════════════════════════════

class AgentTask(Base):
    __tablename__ = "agent_tasks"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    goal_id: Mapped[str] = mapped_column(String(36), ForeignKey("goals.id"), index=True)

    # Task identity
    task_type: Mapped[str] = mapped_column(String(100))
    # generate_content | post_content | research | analyze | notify | forge_skill | monitor | adapt_asset
    agent: Mapped[str] = mapped_column(String(100))
    # orchestrator | strategist | researcher | content_director | visual_designer | publisher | skillforge | monitor
    description: Mapped[str] = mapped_column(Text)
    rationale: Mapped[Optional[str]] = mapped_column(Text, nullable=True)        # Why the agent chose this task

    # Tool execution
    tool_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    tool_params: Mapped[Optional[str]] = mapped_column(Text, nullable=True)      # JSON
    result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)           # JSON output
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Scheduling — agent decides these
    depends_on: Mapped[Optional[str]] = mapped_column(Text, nullable=True)       # JSON list of task IDs
    scheduled_for: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    platform: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)  # target platform
    connection_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("platform_connections.id"), nullable=True) # specific account

    # Status
    status: Mapped[str] = mapped_column(String(50), default="pending_approval")
    # pending_approval | approved | queued | executing | done | failed | skipped | cancelled
    priority: Mapped[int] = mapped_column(Integer, default=5)   # 1=highest, 10=lowest
    retry_count: Mapped[int] = mapped_column(Integer, default=0)
    max_retries: Mapped[int] = mapped_column(Integer, default=3)

    # Timing
    executed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # Relationships
    goal: Mapped["Goal"] = relationship(back_populates="tasks")


# ═══════════════════════════════════════════════════════════
# AGENT LOGS — Full transparency of agent thinking
# ═══════════════════════════════════════════════════════════

class AgentLog(Base):
    __tablename__ = "agent_logs"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    goal_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("goals.id"), nullable=True, index=True)
    task_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("agent_tasks.id"), nullable=True)
    agent: Mapped[str] = mapped_column(String(100))          # Which agent
    level: Mapped[str] = mapped_column(String(20), default="info")  # info | thinking | action | error | success
    thought: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Agent reasoning
    action: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    observation: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # Tool output / result
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)

    # ── Audit fields (Phase 4) ─────────────────────────────────
    # Additive — the admin/audit-log view reads these on top of the existing
    # agent/level/thought/action/observation fields, rather than a parallel
    # AuditEvent table (this row already IS an audit event: agent=actor,
    # action=action, observation~=detail).
    target: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    result: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)  # success | failure | pending

    # Relationships
    goal: Mapped[Optional["Goal"]] = relationship(back_populates="logs")


# ═══════════════════════════════════════════════════════════
# GENERATED SKILLS — SkillForge output
# ═══════════════════════════════════════════════════════════

class GeneratedSkill(Base):
    __tablename__ = "generated_skills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)     # Python function name
    display_name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    code: Mapped[str] = mapped_column(Text)                  # The actual Python function
    input_schema: Mapped[Optional[str]] = mapped_column(Text, nullable=True)    # JSON schema
    output_schema: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # JSON schema
    sandbox_test_result: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # E2B test output
    test_passed: Mapped[bool] = mapped_column(Boolean, default=False)
    created_by_goal_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    avg_execution_ms: Mapped[float] = mapped_column(Float, default=0.0)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


# ═══════════════════════════════════════════════════════════
# MEDIA ASSETS — Media library
# ═══════════════════════════════════════════════════════════

class MediaAsset(Base):
    __tablename__ = "media_assets"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    filename: Mapped[str] = mapped_column(String(500))
    original_filename: Mapped[str] = mapped_column(String(500))
    file_path: Mapped[str] = mapped_column(String(1000))
    public_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    file_size_bytes: Mapped[int] = mapped_column(BigInteger, default=0)
    mime_type: Mapped[str] = mapped_column(String(100))
    asset_type: Mapped[str] = mapped_column(String(50))  # image | video | audio | pdf | document

    # Media dimensions
    width: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    height: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    duration_seconds: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    # AI-generated metadata
    auto_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)        # JSON list of tags
    ai_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # GPT-4o Vision description
    platform_suitability: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON {"linkedin": 0.9}
    dominant_colors: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Manual metadata
    manual_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    alt_text: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    campaign_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    # Qdrant embedding
    embedding_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # Qdrant point ID

    # Usage tracking
    usage_count: Mapped[int] = mapped_column(Integer, default=0)
    last_used_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    uploaded_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# KNOWLEDGE ITEMS — RAG training data
# ═══════════════════════════════════════════════════════════

class KnowledgeItem(Base):
    __tablename__ = "knowledge_items"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    title: Mapped[str] = mapped_column(String(500))
    source_type: Mapped[str] = mapped_column(String(50))
    # pdf | url | image | video | audio | csv | text | docx | youtube

    source_path: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)  # file path or URL
    source_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)

    # Parsed content
    raw_content: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    content_summary: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # AI-generated summary

    # Vector storage
    qdrant_ids: Mapped[Optional[str]] = mapped_column(Text, nullable=True)       # JSON list of point IDs
    chunk_count: Mapped[int] = mapped_column(Integer, default=0)

    # Categorization
    category: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    # brand_voice | product_info | competitor | market_research | content_examples | other
    tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)             # JSON list

    # Processing state
    processing_status: Mapped[str] = mapped_column(String(50), default="pending")
    # pending | processing | indexed | failed
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    processed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    uploaded_by: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# PUBLISHED POSTS — Record of all posts sent to platforms
# ═══════════════════════════════════════════════════════════

class PublishedPost(Base):
    __tablename__ = "published_posts"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    goal_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("goals.id"), nullable=True)
    task_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("agent_tasks.id"), nullable=True)

    # Content
    caption: Mapped[str] = mapped_column(Text)
    hook: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    hashtags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)     # JSON list
    cta: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    media_asset_ids: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON list

    # Platform
    platform: Mapped[str] = mapped_column(String(50))  # linkedin | facebook | twitter | tiktok | instagram
    connection_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("platform_connections.id"), nullable=True) # specific account
    platform_post_id: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    platform_url: Mapped[Optional[str]] = mapped_column(String(1000), nullable=True)
    publisher: Mapped[str] = mapped_column(String(50), default="buffer")  # buffer | facebook_graph

    # Status
    status: Mapped[str] = mapped_column(String(50), default="queued")
    # queued | published | failed | deleted
    scheduled_for: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    published_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Analytics snapshot (updated by Monitor agent)
    impressions: Mapped[int] = mapped_column(Integer, default=0)
    likes: Mapped[int] = mapped_column(Integer, default=0)
    comments: Mapped[int] = mapped_column(Integer, default=0)
    shares: Mapped[int] = mapped_column(Integer, default=0)
    clicks: Mapped[int] = mapped_column(Integer, default=0)
    reach: Mapped[int] = mapped_column(Integer, default=0)
    engagement_rate: Mapped[float] = mapped_column(Float, default=0.0)
    analytics_updated_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# PLATFORM CONNECTIONS
# ═══════════════════════════════════════════════════════════

class PlatformConnection(Base):
    __tablename__ = "platform_connections"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    # Tenancy — the user who registered this connection. Nullable for legacy rows
    # (backfilled/None); all access is scoped to the owner (see api/accounts.py).
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    platform: Mapped[str] = mapped_column(String(50), index=True)
    display_name: Mapped[str] = mapped_column(String(200))
    account_label: Mapped[str] = mapped_column(String(100), default="Primary")
    account_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    account_id: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)

    # Encrypted credentials
    access_token_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    refresh_token_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    api_key_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    # Truth bucket & Headless Config
    auth_data: Mapped[Optional[str]] = mapped_column(Text, nullable=True) # Free-text notes / truth bucket
    proxy_session_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True) 
    
    # Headless browser fallback credentials
    web_username: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    web_password_encrypted: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Generic HTTP connector fields (Phase 5) ─────────────────
    # Used when platform="custom_connector" — a self-describing handle to an
    # external HTTP API, ported from neuroworks' connectors.ts. Reuses
    # api_key_encrypted above for the connector's secret (token/password/api
    # key value, depending on auth_type) rather than adding another encrypted
    # column. See connector_client.py for the SSRF guard / call logic.
    base_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    auth_type: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)  # none|api_key|bearer|basic|header
    write_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    endpoints: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON list of {name, method, path, description, query, body}

    extra_config: Mapped[Optional[str]] = mapped_column(Text, nullable=True)     # JSON for platform-specific

    # Status
    is_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    connection_status: Mapped[str] = mapped_column(String(50), default="disconnected")
    # connected | disconnected | error | token_expired
    last_verified_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Publishing config
    posts_per_day_limit: Mapped[int] = mapped_column(Integer, default=10)
    preferred_post_times: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# NOTIFICATIONS
# ═══════════════════════════════════════════════════════════

class Notification(Base):
    __tablename__ = "notifications"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True)
    goal_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    type: Mapped[str] = mapped_column(String(50))
    # plan_ready | milestone | goal_complete | goal_failed | replan_needed | skill_created
    title: Mapped[str] = mapped_column(String(500))
    message: Mapped[str] = mapped_column(Text)
    action_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    is_read: Mapped[bool] = mapped_column(Boolean, default=False)
    sent_via_email: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# CHAT MESSAGES — Persistent conversation memory per user
# ═══════════════════════════════════════════════════════════

class ChatMessage(Base):
    __tablename__ = "chat_messages"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)  # owner of this thread

    # role: "user" | "assistant" | "agent"
    # "agent" = autonomous LangGraph agent pushed this (e.g. Strategist reporting back)
    role: Mapped[str] = mapped_column(String(20))

    content: Mapped[str] = mapped_column(Text)

    # Set when role == "agent" — which agent sent this (e.g. "strategist", "publisher")
    agent_name: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)

    # If this message relates to a specific campaign goal
    goal_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    # JSON dict for extra context (action taken, metrics, etc.)
    meta: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# MESSAGING LINKS — Telegram/WhatsApp identity ↔ NAXIONAI user
# ═══════════════════════════════════════════════════════════

class MessagingLink(Base):
    """Maps an external channel identity (a Telegram chat_id or a WhatsApp
    phone number) to the local NAXIONAI user it should chat as/notify. Kept
    deliberately minimal — naxionai defaults to single-user local mode, so an
    admin sets this once via Settings rather than through a per-message
    linking flow."""
    __tablename__ = "messaging_links"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    channel: Mapped[str] = mapped_column(String(20))  # "telegram" | "whatsapp"
    external_id: Mapped[str] = mapped_column(String(200), index=True)  # chat_id or phone number
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# AGENCY SETTINGS — Per-user autonomous mode & brief schedule
# ═══════════════════════════════════════════════════════════

class AgencySettings(Base):
    __tablename__ = "agency_settings"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True, unique=True)

    # ── Autonomous mode ───────────────────────────────────────
    autonomous_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    risk_tolerance: Mapped[int] = mapped_column(Integer, default=70) # 0-100 scale

    # ── Timezone & Brief schedule ─────────────────────────────
    # IANA timezone string e.g. "Africa/Harare", "Europe/London", "America/New_York"
    timezone: Mapped[str] = mapped_column(String(60), default="UTC")

    # JSON array of brief slot objects:
    # [{ "id": uuid, "label": "Morning Brief", "time": "08:00",
    #    "recurrence": "daily"|"weekdays"|"weekly"|"once",
    #    "date": "YYYY-MM-DD" (for "once" only, else null) }]
    brief_slots: Mapped[str] = mapped_column(Text, default="[]")

    # ── Industry / brand context (for proactive research) ─────
    # Inferred from training docs + conversations; editable by user
    industry: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    brand_voice: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    
    # ── NAXIONAI Persona ─────────────────────────────────
    agent_tone: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # ── Daemon tracking timestamps ────────────────────────────
    daemon_last_ran: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_brief_sent: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_proactive_research: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Throttle for the chat-inactivity nudge (distinct from the goal-based idle
    # report above) — last time we proactively pinged the user for going quiet
    # in chat, regardless of whether any goal/campaign is active.
    last_idle_chat_nudge: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)

    # ── Active persona (Phase 3b) ──────────────────────────────
    # When set, chat.py folds this persona's voice/responsibilities into the
    # Naxie synthesis prompt as additional context — no separate execution
    # path, just framing (see api/chat.py's persona_context block).
    active_persona_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# USER PREFERENCES — persistent key/value memory across sessions
# (e.g. preferred name, "likes bullet-point summaries") so Naxie
# doesn't start cold every conversation.
# ═══════════════════════════════════════════════════════════

class UserPreference(Base):
    __tablename__ = "user_preferences"
    __table_args__ = (UniqueConstraint("user_id", "key", name="uq_user_preference_key"),)

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id: Mapped[str] = mapped_column(String(36), index=True)
    key: Mapped[str] = mapped_column(String(100))
    value: Mapped[str] = mapped_column(Text)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# PLAYBOOK SKILLS — markdown prompt-guidance library (Phase 2).
# Distinct from GeneratedSkill (SkillForge's sandbox-tested Python tools):
# these are never executed, just injected into a synth prompt to bias output
# style/structure. 140 builtin playbooks ship as static .md files under
# backend/skills/; this table holds only user-authored/auto-drafted
# overrides — see backend/playbook_matcher.py.
# ═══════════════════════════════════════════════════════════

class PlaybookSkill(Base):
    __tablename__ = "playbook_skills"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    description: Mapped[str] = mapped_column(Text)
    applies_to: Mapped[Optional[str]] = mapped_column(Text, nullable=True)  # JSON list of intent labels
    body: Mapped[str] = mapped_column(Text)               # markdown body (post-frontmatter)
    source: Mapped[str] = mapped_column(String(10), default="user")  # user | auto
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# ORG MODELING — personas, departments, teams (Phase 3a). Built-in catalog
# entries (persona_catalog.py / org_catalog.py) are static Python data, not
# DB rows — these tables hold only operator-created/customized ones, seeded
# insert-if-missing on init_db() (see ensure_org_catalog_seeded below).
# NOTE (Phase 3b, not yet implemented): these are data models + CRUD only.
# Wiring an active persona into what the LangGraph agent graph actually
# executes is a separate architecture decision — naxionai's graph is a fixed
# topology (manager -> orchestrator -> ...), not a dynamic persona roster.
# ═══════════════════════════════════════════════════════════

class Persona(Base):
    __tablename__ = "personas"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    slug: Mapped[str] = mapped_column(String(100), unique=True, index=True)
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    role: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    job_description: Mapped[str] = mapped_column(Text)
    tone: Mapped[str] = mapped_column(String(300))
    responsibilities: Mapped[Optional[str]] = mapped_column(Text, nullable=True)       # JSON list
    system_prompt_override: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    work_mode: Mapped[str] = mapped_column(String(20), default="agent")  # agent | hybrid | human
    language: Mapped[Optional[str]] = mapped_column(String(10), nullable=True)
    is_builtin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class Department(Base):
    """Operator-created departments only — built-in DEPARTMENT_TEMPLATES
    (org_catalog.py) ship as static data and never get a row here."""
    __tablename__ = "departments"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(80))
    tagline: Mapped[str] = mapped_column(String(160), default="Custom department")
    description: Mapped[str] = mapped_column(Text)
    icon: Mapped[str] = mapped_column(String(40), default="Building2")
    color: Mapped[str] = mapped_column(String(40), default="violet")
    roles: Mapped[Optional[str]] = mapped_column(Text, nullable=True)   # JSON list of role titles
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


class DepartmentDatum(Base):
    """Lightweight per-department reference knowledge (e.g. "FY26 budget
    assumptions" under Finance) — distinct from KnowledgeItem's RAG-indexed
    documents; this is small free-text facts read directly, no embeddings."""
    __tablename__ = "department_data"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    department: Mapped[str] = mapped_column(String(120), index=True)
    title: Mapped[str] = mapped_column(String(120))
    content: Mapped[str] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class TeamTemplate(Base):
    """Operator-saved team briefs only — BUILTIN_TEAM_TEMPLATES (org_catalog.py)
    ship as static seeds and are listed alongside these, never stored here."""
    __tablename__ = "team_templates"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    team_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)  # links to BUILTIN_TEAMS
    tasks: Mapped[str] = mapped_column(Text)  # JSON list of {persona, content}
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# SCHEDULES — recurring auto-created goals (Phase 4). Ported from
# neuroworks/server/src/lib/schedules.ts's Schedule shape. naxionai has no
# "template" system to re-run, so `description` (the Goal description to
# submit on fire) replaces templateId/inputs — see agent/scheduler.py.
# ═══════════════════════════════════════════════════════════

class Schedule(Base):
    __tablename__ = "schedules"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    description: Mapped[str] = mapped_column(Text)
    days_of_week: Mapped[str] = mapped_column(Text, default="[]")  # JSON list 0(Sun)-6(Sat); [] = every day
    hour: Mapped[int] = mapped_column(Integer, default=8)
    minute: Mapped[int] = mapped_column(Integer, default=0)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    deliver_email: Mapped[Optional[str]] = mapped_column(String(255), nullable=True)
    last_fired_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_job_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)  # Goal.id
    last_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    fire_count: Mapped[int] = mapped_column(Integer, default=0)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# GOVERNANCE — operator-curated guardrail policies (Phase 4). Ported from
# governance.ts. neuroworks stores policies as vault markdown files; naxionai
# has no filesystem vault-of-markdown, so the policy body lives inline here
# (same precedent as KnowledgeItem.raw_content).
# ═══════════════════════════════════════════════════════════

class GovernancePolicy(Base):
    __tablename__ = "governance_policies"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    name: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(Text)
    is_reference: Mapped[bool] = mapped_column(Boolean, default=False)  # true = informational only, not a guardrail
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class GovernanceConstraint(Base):
    """A single extracted/authored rule under a policy. Only rows with
    reviewed=True, accepted=True, severity="hard" are enforceable (mirrors
    filterEnforceable() in governance.py)."""
    __tablename__ = "governance_constraints"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    policy_id: Mapped[str] = mapped_column(String(36), ForeignKey("governance_policies.id"), index=True)
    rule: Mapped[str] = mapped_column(Text)
    severity: Mapped[str] = mapped_column(String(10), default="soft")  # hard | soft
    category: Mapped[str] = mapped_column(String(50), default="other")
    details: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    reviewed: Mapped[bool] = mapped_column(Boolean, default=False)
    accepted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# COST RECORDS — per-LLM-call spend tracking (Phase 4). Net-new
# instrumentation — naxionai had zero cost tracking before this. Written
# from agent/llm.py's generate_completion() so every call is counted
# without touching individual node call sites (see cost_tracker.py).
# ═══════════════════════════════════════════════════════════

class CostRecord(Base):
    __tablename__ = "cost_records"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    job_id: Mapped[str] = mapped_column(String(64), default="adhoc", index=True)
    model: Mapped[str] = mapped_column(String(200))
    backend: Mapped[str] = mapped_column(String(30))       # ollama | groq | openrouter | anthropic | ...
    profile: Mapped[str] = mapped_column(String(50), default="none")
    input_tokens: Mapped[int] = mapped_column(Integer, default=0)
    output_tokens: Mapped[int] = mapped_column(Integer, default=0)
    cost_usd: Mapped[float] = mapped_column(Float, default=0.0)
    units: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, index=True)


# ═══════════════════════════════════════════════════════════
# DATA SOURCES — company database registry (Phase 5). Ported from
# data-sources.ts. Default contract is read-only; see data_source_client.py
# for the WRITE_KEYWORDS gate and per-kind query execution.
# ═══════════════════════════════════════════════════════════

class DataSource(Base):
    __tablename__ = "data_sources"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    owner_id: Mapped[Optional[str]] = mapped_column(String(36), ForeignKey("users.id"), nullable=True, index=True)
    label: Mapped[str] = mapped_column(String(200))
    kind: Mapped[str] = mapped_column(String(20))  # postgres | mysql | sqlite | mssql | mongodb | excel | csv
    connection_encrypted: Mapped[str] = mapped_column(Text)  # encrypt_value() of the connection string/file path
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    department: Mapped[Optional[str]] = mapped_column(String(120), nullable=True)
    readonly: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)


# ═══════════════════════════════════════════════════════════
# DATABASE ENGINE
# ═══════════════════════════════════════════════════════════


# ═══════════════════════════════════════════════════════════
# PENDING EMAIL APPROVALS — Track approval emails awaiting reply
# ═══════════════════════════════════════════════════════════

class PendingEmailApproval(Base):
    __tablename__ = "pending_email_approvals"

    id: Mapped[str] = mapped_column(String(36), primary_key=True, default=lambda: str(uuid.uuid4()))
    token: Mapped[str] = mapped_column(String(36), unique=True, index=True)  # embedded in subject
    user_id: Mapped[str] = mapped_column(String(36), index=True)

    # What kind of decision this is
    action_type: Mapped[str] = mapped_column(String(50))  # "high_risk" | "api_key_needed"

    # Context for when we process the reply
    skill_name: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    goal_id: Mapped[Optional[str]] = mapped_column(String(36), nullable=True)
    description: Mapped[str] = mapped_column(Text)

    resolved: Mapped[bool] = mapped_column(Boolean, default=False)
    resolution: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)  # "approved" | "skipped"

    expires_at: Mapped[datetime] = mapped_column(DateTime)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    resolved_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)


settings = get_settings()
engine = create_async_engine(
    settings.database_url,
    echo=settings.debug,
    pool_pre_ping=True,
)
async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


def _migrate_add_columns(sync_conn):
    """Idempotent lightweight migration: `create_all` never ALTERs existing
    tables, so columns added to a model after a DB already exists would be
    silently missing and fail at query time. Add any known-missing columns via
    a dialect-agnostic inspector check. (Full migrations would use Alembic.)"""
    from sqlalchemy import inspect as sa_inspect
    wanted = {
        # table → [(column, DDL type)]
        "platform_connections": [
            ("owner_id", "VARCHAR(36)"),
            ("base_url", "VARCHAR(500)"),
            ("auth_type", "VARCHAR(20)"),
            ("write_enabled", "BOOLEAN DEFAULT 0"),
            ("endpoints", "TEXT"),
        ],
        "media_assets": [("uploaded_by", "VARCHAR(36)")],
        "knowledge_items": [("uploaded_by", "VARCHAR(36)")],
        "goals": [("created_by", "VARCHAR(36)")],
        "agency_settings": [("last_idle_chat_nudge", "DATETIME"), ("active_persona_id", "VARCHAR(36)")],
        "agent_logs": [("target", "VARCHAR(500)"), ("result", "VARCHAR(10)")],
        "users": [
            ("status", "VARCHAR(20) DEFAULT 'active'"),
            ("department", "VARCHAR(120)"),
            ("title", "VARCHAR(120)"),
            ("work_mode", "VARCHAR(20)"),
            ("salary_monthly", "FLOAT"),
            ("reports_to", "VARCHAR(36)"),
            ("has_set_password", "BOOLEAN DEFAULT 0"),
        ],
    }
    insp = sa_inspect(sync_conn)
    for table, cols in wanted.items():
        if not insp.has_table(table):
            continue
        existing = {c["name"] for c in insp.get_columns(table)}
        for name, ddl in cols:
            if name not in existing:
                sync_conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {name} {ddl}")
                logger.info("[migrate] added column %s.%s", table, name)


async def init_db():
    """Create all tables on startup, then apply idempotent column migrations."""
    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)
        await conn.run_sync(_migrate_add_columns)


async def ensure_default_user() -> dict:
    """Single-user local mode: reuse the earliest-created account, or seed one
    on a fresh DB. Mirrors the old first-user-becomes-superadmin bootstrap so
    existing data (chat history, goals, etc.) stays attached to the same user."""
    from sqlalchemy import select
    import secrets
    from auth import hash_password

    async with async_session() as db:
        user = (await db.execute(select(User).order_by(User.created_at.asc()))).scalars().first()
        if user is None:
            user = User(
                id=str(uuid.uuid4()),
                username="operator",
                email="local@naxie.local",
                full_name="Operator",
                hashed_password=hash_password(secrets.token_hex(16)),
                role="superadmin",
                is_active=True,
            )
            db.add(user)
            await db.commit()
            await db.refresh(user)

    return {
        "sub": user.id,
        "username": user.username,
        "role": user.role,
        "email": user.email,
        "full_name": user.full_name,
    }


async def ensure_builtin_personas_seeded() -> None:
    """Insert-if-missing seeding of the 36 built-in personas (persona_catalog.py)
    into the personas table — mirrors personas.ts's ensureBuiltinSeeded():
    insert when missing, sync only the display `name` on an existing row if
    the catalog's name changed, never touch fields a user may have edited."""
    from sqlalchemy import select
    import json as _json
    from persona_catalog import BUILTIN_PERSONAS

    async with async_session() as db:
        existing = (await db.execute(select(Persona).where(Persona.is_builtin == True))).scalars().all()  # noqa: E712
        existing_by_slug = {p.slug: p for p in existing}
        changed = False
        for b in BUILTIN_PERSONAS:
            row = existing_by_slug.get(b.id)
            if row is None:
                db.add(Persona(
                    id=str(uuid.uuid4()), slug=b.id, owner_id=None, name=b.name, role=b.role,
                    description=b.description, job_description=b.job_description, tone=b.tone,
                    responsibilities=_json.dumps(b.responsibilities),
                    system_prompt_override=b.system_prompt_override,
                    work_mode=b.work_mode or "agent", language=b.language, is_builtin=True,
                ))
                changed = True
            elif row.name != b.name:
                row.name = b.name
                changed = True
        if changed:
            await db.commit()


async def get_db():
    """FastAPI dependency: yields an async DB session."""
    async with async_session() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise
        finally:
            await session.close()


async def get_user_preferences(user_id: str) -> dict:
    """All saved preferences for a user, as a flat {key: value} dict."""
    from sqlalchemy import select

    async with async_session() as db:
        rows = (await db.execute(
            select(UserPreference).where(UserPreference.user_id == user_id)
        )).scalars().all()
    return {row.key: row.value for row in rows}


async def set_user_preference(user_id: str, key: str, value: str) -> None:
    """Upsert a single preference. `key` is a short slug like 'preferred_name'
    or 'summary_style'; `value` is free text."""
    from sqlalchemy import select
    from sqlalchemy.exc import IntegrityError

    async def _find(db):
        return (await db.execute(
            select(UserPreference).where(
                UserPreference.user_id == user_id,
                UserPreference.key == key,
            )
        )).scalars().first()

    async with async_session() as db:
        row = await _find(db)
        if row:
            row.value = value
            await db.commit()
            return
        db.add(UserPreference(user_id=user_id, key=key, value=value))
        try:
            await db.commit()
        except IntegrityError:
            # Select-then-insert isn't atomic: two concurrent callers can both
            # see no existing row and both try to insert for the same
            # (user_id, key) — the UniqueConstraint on the table lets exactly
            # one insert win. Whoever lost the race falls back to an update.
            await db.rollback()
            row = await _find(db)
            if row:
                row.value = value
                await db.commit()
