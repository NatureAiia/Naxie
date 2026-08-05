# Graph Report - NaxionAI-Powered-by-Neuroworks  (2026-08-05)

## Corpus Check
- 315 files · ~260,394 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 2664 nodes · 3962 edges · 255 communities (231 shown, 24 thin omitted)
- Extraction: 97% EXTRACTED · 3% INFERRED · 0% AMBIGUOUS · INFERRED: 110 edges (avg confidence: 0.56)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `c7ef39c7`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- schedules.py
- PA Tools
- Knowledge Management
- graph.py
- Security Scanner
- Development Dependencies
- Task Manager
- agency_daemon.py
- skillforge.py
- researcher.py
- Department Management
- database.py
- Wake-Word Detection
- Playbook Skills
- voice.ts
- personas.py
- Type Definitions
- Graphify CLI
- api/auth.py
- connectors.py
- api/governance.py
- Team Template
- Sidebar
- chat/page.tsx
- web_search.py
- api.ts
- Document Export
- Goal Tracking
- get_settings
- media.py
- Models API
- main.py
- cost_tracker.py
- Governance Constraints
- Security Watchdog
- accounts.py
- Settings API
- Document Skills
- Sidebar.tsx
- Vault API
- Layout Components
- data_source_client.py
- API Design Guide
- CSS Animations
- UX Master Prompt
- Objection Handling
- chat_push
- Email Inbox Poller
- Model Provider API
- audit.py
- backend/model_providers.py
- Announcement Writing
- Feedback Giving
- Testing Strategy
- Implementation Plan
- Ghost Browser
- chat.py
- OKR Writing
- 1:1 Prep
- knowledge/page.tsx
- NEUROWORKS Dropped Features
- Intro Email
- Renewal Conversation
- Root Cause Analysis
- analytics/page.tsx
- Model Router
- Commit Message Writing
- Decline Politely
- Email Writing
- Loading State Design
- Settings Page
- Export Steps
- Debugging Help
- Fact-Checking
- Image Prompting
- Meeting Agenda
- Motion Design Pass
- Primary Source Check
- Reconciliation
- Risk Assessment
- Source Triangulation
- Content Director
- Skill Management
- Benchmark Lookup
- Churn Risk Flag
- Code Writing
- Competitive Analysis
- Competitor Summary
- Contract Summary
- Daily Briefing
- Database Lookup
- Difficult Conversation Script
- Direct Answer
- End-of-Day Handoff
- Follow-Up Cadence
- Landscape Scan
- Launch Positioning
- Lead Qualification
- Microinteraction Spec
- Performance Review
- Deep Research
- Risk Register
- Standup Summary
- Status Update
- Vault Org
- Weekly Review
- Monitor Agent
- Action Item Extraction
- Caveman Mode
- Channel Notify
- Code Review
- Company Lookup
- Onboarding Brief
- Comparison
- Compliance Check
- Crisis Comm
- CRM Update
- Customer 360
- CV Screening
- Decision Doc
- Design Doc
- Discovery Prep
- Edit Pass
- Email Triage
- Expense Report
- Feedback Trends
- Fin Stmt Sum
- Human Handoff
- Incident PM
- Inventory Analysis
- Investor Update
- Invoice Statement
- JD to Tasks
- KB Article
- List Making
- MEDDIC Qual
- Meeting Actions
- Meeting Prep
- Multimedia Pack
- Music Brief
- P&L Summary
- Pipeline Review
- Planning Doc
- PR Desc Write
- Pre-Read
- Precedent Finder
- Pricing Proposal
- Procurement Req
- Product Spec
- Project Status
- Proposal Writing
- RAID Log
- Release Notes
- Report Writing
- Retry Diff Approach
- Slide Outline
- SOP Writing
- Summarization
- Support Escalation
- Support Themes
- Table Making
- Timesheet Fill
- Tomorrow Plan
- Training Quiz
- Translation
- Travel Itinerary
- User Stories
- UX Critique
- Vendor Comparison
- Video Prompt
- Voiceover Script
- TasksPage
- Graphify Query
- A/B Test Read
- Access Provisioning
- Audit Prep
- BRD Writing
- Brief Writing
- Cold Outreach
- Dataset Publish
- Device Setup
- Event Runsheet
- Facilitator Guide
- Fulfillment Plan
- HR Policy
- JD Writing
- Logistics Exception
- Meeting Notes
- Memo Writing
- Negotiation Brief
- Press Release
- Process Mapping
- Project Plan
- Prospect Research
- RFQ/RFP Writing
- Runbook Writing
- Send Attachment
- Trade-off Memo
- Training Curriculum
- Unit Economics
- UI Components
- Orchestration Logic
- Research System
- Campaign Strategy
- Admin API
- Load More
- Text Lift
- Platform Capabilities
- Add Watch
- Git Hooks
- Update Process
- strategist_node
- Frontend Setup
- Dynamic Text
- Glitter Background
- Kinetic Grid
- Multi Step Loader
- Noise Background
- Weight Hover
- CLAUDE Integration
- GitHub Merge
- Transcription
- Persona Catalog
- Settings
- File Upload
- Link Preview
- Magnetic Row
- Particle Mark
- Text Morph
- Graphify Docs
- Extraction Prompt
- Knowledge Vault
- ESLint Config
- Next Config
- PostCSS Config
- Task List
- new/page.tsx
- BackgroundTasks

## God Nodes (most connected - your core abstractions)
1. `get_settings()` - 39 edges
2. `Base` - 29 edges
3. `get_current_user()` - 28 edges
4. `AgentState` - 26 edges
5. `chat_push()` - 25 edges
6. `generate_completion()` - 22 edges
7. `agent_thought_push()` - 19 edges
8. `get_db()` - 18 edges
9. `generate_json()` - 16 edges
10. `skillforge_node()` - 16 edges

## Surprising Connections (you probably didn't know these)
- `build_neural_graph()` --indirect_call--> `auditor_node()`  [INFERRED]
  naxionai/backend/agent/graph.py → naxionai/backend/agent/nodes/auditor.py
- `build_neural_graph()` --indirect_call--> `publisher_node()`  [INFERRED]
  naxionai/backend/agent/graph.py → naxionai/backend/agent/nodes/publisher.py
- `build_neural_graph()` --indirect_call--> `researcher_node()`  [INFERRED]
  naxionai/backend/agent/graph.py → naxionai/backend/agent/nodes/researcher.py
- `build_neural_graph()` --indirect_call--> `skillforge_node()`  [INFERRED]
  naxionai/backend/agent/graph.py → naxionai/backend/agent/nodes/skillforge.py
- `build_neural_graph()` --indirect_call--> `strategist_node()`  [INFERRED]
  naxionai/backend/agent/graph.py → naxionai/backend/agent/nodes/strategist.py

## Import Cycles
- None detected.

## Communities (255 total, 24 thin omitted)

### Community 0 - "schedules.py"
Cohesion: 0.06
Nodes (62): BackgroundTasks, MIMEMultipart, _deliver_schedule_result(), _fire_schedule(), next_fire_at(), datetime, NAXIONAI — Schedule tick loop (Phase 4) Ported from…, Poll the fired goal to completion (up to 15 min), then email the synthesized… (+54 more)

### Community 1 - "PA Tools"
Cohesion: 0.06
Nodes (55): NamedTuple, browser_open(), get_pa_tools(), get_todays_calendar_events(), get_weather(), git_command(), manage_clipboard(), organize_downloads() (+47 more)

### Community 2 - "Knowledge Management"
Cohesion: 0.07
Nodes (54): delete_knowledge(), get_knowledge_item(), ingest_url(), _is_admin(), list_knowledge(), _process_knowledge_item(), AsyncSession, BackgroundTasks (+46 more)

### Community 3 - "graph.py"
Cohesion: 0.11
Nodes (27): build_neural_graph(), manager_router(), NAXIONAI — LangGraph Agent Graph (Neural Supervisor) Hub-and-spoke architecture…, Read the routing decision made by the manager_node or executive_node., Unified Hub-and-Spoke topology starting with the Executive. Executive evaluates…, content_director_node(), Processes the current task's content brief and writes platform-optimized…, distribution_manager_node() (+19 more)

### Community 4 - "Security Scanner"
Cohesion: 0.09
Nodes (42): CompletedProcess, Kind, NAXIONAI — Conservative secret/risk detector. Ported from…, redact_high_severity(), scan_for_security_risks(), SecurityFinding, _assert_vault_exists(), build_index() (+34 more)

### Community 5 - "Development Dependencies"
Cohesion: 0.05
Nodes (42): cmdk, eslint, eslint-config-next, framer-motion, lucide-react, dependencies, cmdk, framer-motion (+34 more)

### Community 6 - "Task Manager"
Cohesion: 0.18
Nodes (39): add_step(), AddStepRequest, _advance_date(), create_item(), create_list(), CreateItemRequest, CreateListRequest, _ensure_default_list() (+31 more)

### Community 7 - "agency_daemon.py"
Cohesion: 0.12
Nodes (30): _check_brief_schedule(), _check_idle_chat_nudge(), _nudge_approval(), _phase_execute_goals(), _phase_retry_failed_posts(), _process_user(), _push_chat_checkin(), _push_execution_status() (+22 more)

### Community 8 - "skillforge.py"
Cohesion: 0.11
Nodes (28): generate_json(), Generate and natively parse a JSON object from the AI., _determine_platform_rules(), Dynamically deduce optimal platform algorithms and character constraints using…, NAXIONAI — SkillForge Agent Node Creates new Python skills on-demand using E2B…, Identifies skill gaps from failed tasks, searches the web for solutions,…, skillforge_node(), _hot_patch_skill() (+20 more)

### Community 9 - "researcher.py"
Cohesion: 0.21
Nodes (11): ghost_visual_research(), NAXIONAI — Researcher Agent Node Gathers real-time market intelligence using…, Uses Ghost Browser and Llama-Vision to scrape walled-gardens natively., _host_exec_allowed(), is_playwright_used(), NAXIONAI — Sandbox Execution Tool Provides a Local subprocess runner for all…, Guard: this "sandbox" is a plain local subprocess as the current OS user — no…, Detect if the generated script uses Playwright. (+3 more)

### Community 10 - "Department Management"
Cohesion: 0.13
Nodes (33): create_department(), create_department_datum(), CreateDepartmentDatumRequest, CreateDepartmentRequest, _datum_out(), delete_department(), delete_department_datum(), DepartmentDatumOut (+25 more)

### Community 11 - "database.py"
Cohesion: 0.13
Nodes (23): DeclarativeBase, FastAPI, NAXIONAI — Analytics API Aggregates real-time KPIs from the database for the…, NAXIONAI — Skills API (SkillForge viewer), NAXIONAI — SSE Stream for real-time agent activity feed., AgentLog, AgentTask, Base (+15 more)

### Community 12 - "Wake-Word Detection"
Cohesion: 0.08
Nodes (30): _build_grammar(), get_vosk_model(), NaxionAI — Offline Wake-Word Detection (Vosk) Fully local, free, open-source…, Lazily load the Vosk model once and cache it. Returns None (not raises) if the…, Expand a wake phrase into itself plus in-vocabulary phonetic near-misses for…, One instance per connected WebSocket client. Feeds 16kHz mono PCM16 audio into…, Feed one chunk of raw 16-bit PCM audio. Returns True the moment any wake-phrase…, WakeWordSession (+22 more)

### Community 13 - "Playbook Skills"
Cohesion: 0.13
Nodes (32): create_playbook(), CreatePlaybookRequest, delete_playbook(), get_all_playbook_skills(), get_playbook(), list_playbooks(), PlaybookOut, AsyncSession (+24 more)

### Community 14 - "voice.ts"
Cohesion: 0.16
Nodes (15): loadTurns(), NaxiePage(), Turn, HistoryItem, TTSPage(), authHeaders(), AudioQueue, NOTE: the wake-word listener uses the browser's SpeechRecognition API. In (+7 more)

### Community 15 - "personas.py"
Cohesion: 0.09
Nodes (52): add_brief_slot(), agency_status(), AgencySettingsUpdate, BriefSlot, delete_brief_slot(), get_agency_settings(), _get_or_create_settings(), AsyncSession (+44 more)

### Community 16 - "Type Definitions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 17 - "Graphify CLI"
Cohesion: 0.07
Nodes (26): For /graphify add and --watch, For /graphify query, For the commit hook and native CLAUDE.md integration, For --update and --cluster-only, /graphify, Honesty Rules, Interpreter guard for subcommands, Part A - Structural extraction for code files (+18 more)

### Community 18 - "api/auth.py"
Cohesion: 0.15
Nodes (27): approve_pending(), auth_state(), list_pending(), login(), LoginRequest, me(), AsyncSession, BaseModel (+19 more)

### Community 19 - "connectors.py"
Cohesion: 0.11
Nodes (39): call_connector_endpoint(), CallRequest, ConnectorAuthIn, ConnectorOut, create_connector(), CreateConnectorRequest, delete_connector(), _is_admin() (+31 more)

### Community 20 - "api/governance.py"
Cohesion: 0.10
Nodes (42): DataSource, GovernanceConstraint, create_source(), CreateDataSourceRequest, DataSourceOut, delete_source(), describe_source(), list_sources() (+34 more)

### Community 21 - "Team Template"
Cohesion: 0.20
Nodes (24): _all_templates(), create_team_template(), CreateTeamTemplateRequest, delete_team_template(), get_team(), list_team_templates(), list_teams(), preview_team_tasks() (+16 more)

### Community 22 - "Sidebar"
Cohesion: 0.20
Nodes (7): STATUS_CONFIG, Goal, PLATFORM_ICONS, STATUS_CONFIG, makeWorkspaceNav(), Sidebar(), api

### Community 23 - "chat/page.tsx"
Cohesion: 0.16
Nodes (15): AGENT_CONFIG, Bubble, ChatPage(), Chip, Domain, DOMAINS, hexToRgb(), historyToMessage() (+7 more)

### Community 24 - "web_search.py"
Cohesion: 0.24
Nodes (9): NAXIONAI — Agent Web Search Tool Powered by Tavily API. Available to ALL agents…, Search for trending content, hashtags, and strategies for a specific topic.…, Extract the raw content of a specific URL using Tavily's extract API. Bypasses…, Search the web via Tavily and return structured results. Returns: { "success":…, Search the web specifically to find a solution to a technical error. Returns a…, scrape_website(), search_for_solution(), search_social_trends() (+1 more)

### Community 25 - "api.ts"
Cohesion: 0.15
Nodes (15): CONTENT_TYPE_COLORS, PLATFORM_EMOJI, AgentLog, ApiError, AuthUser, CampaignPlan, CampaignTask, DEL() (+7 more)

### Community 26 - "Document Export"
Cohesion: 0.15
Nodes (20): Document, export_docx(), export_docx_from_vault(), export_pdf(), export_pdf_from_vault(), ExportRequest, BaseModel, get (+12 more)

### Community 27 - "Goal Tracking"
Cohesion: 0.14
Nodes (16): AGENT_COLORS, AGENT_INITIALS, AGENT_LABELS, AgentLogEntry, Goal, GoalDetailPage(), STATUS_MAP, Layer (+8 more)

### Community 28 - "get_settings"
Cohesion: 0.11
Nodes (25): _call_byo_provider(), generate_completion(), _get_cascade_configs(), get_llm_client(), _get_ollama_chat(), get_tool_llm(), heal_dom_selector(), NAXIONAI — Agent LLM Client Local Ollama by default (LLM_PROVIDER=ollama);… (+17 more)

### Community 29 - "media.py"
Cohesion: 0.20
Nodes (17): delete_media(), _is_admin(), list_media(), AsyncSession, BaseModel, delete, get, patch (+9 more)

### Community 30 - "Models API"
Cohesion: 0.12
Nodes (17): HTTPAuthorizationCredentials, invalidate_cache(), list_models(), pick_model_for_profile(), get, post, NAXIONAI — Models API (Phase 5), get_events() (+9 more)

### Community 31 - "main.py"
Cohesion: 0.13
Nodes (20): agency_daemon(), Entry point — called from main.py lifespan as asyncio.create_task(). Runs…, Runs forever alongside agency_daemon() — one immediate tick on boot (so…, schedule_tick_loop(), set_local_user(), ensure_builtin_personas_seeded(), ensure_default_user(), init_db() (+12 more)

### Community 32 - "cost_tracker.py"
Cohesion: 0.17
Nodes (16): cost_caps(), cost_summary(), get, NAXIONAI — Cost API (Phase 4), Current spend-cap config plus today's spend for each life-domain, so the…, check_spend_cap(), cost_tier(), detect_backend() (+8 more)

### Community 33 - "Governance Constraints"
Cohesion: 0.15
Nodes (18): build_governance_prefix(), check_action_against_constraints(), ConstraintLike, describe_step_action(), filter_enforceable(), gate_action(), _gov_content_words(), _governance_enforces() (+10 more)

### Community 34 - "Security Watchdog"
Cohesion: 0.20
Nodes (14): BaseHTTPMiddleware, EventKind, _decay_score(), _IpState, _is_loopback(), _load_events(), _maybe_block(), Request (+6 more)

### Community 35 - "accounts.py"
Cohesion: 0.24
Nodes (16): AccountCreate, AccountUpdate, create_account(), delete_account(), _is_admin(), list_accounts(), _owner_scope(), AsyncSession (+8 more)

### Community 36 - "Settings API"
Cohesion: 0.17
Nodes (17): get_settings(), _load_overrides(), _mask(), BaseModel, delete, get, put, NAXIONAI — Settings API Read and write application configuration at runtime.… (+9 more)

### Community 37 - "Document Skills"
Cohesion: 0.11
Nodes (16): Goal, Output shape by doc type, Pitfalls, Process, Rules, Skill: Local document summary, Examples of triggering phrases, Goal (+8 more)

### Community 38 - "Sidebar.tsx"
Cohesion: 0.13
Nodes (15): Skill, stagger, BrandMark(), Item, Kbd(), MetaKey(), cubicBezier(), PixelDriftText() (+7 more)

### Community 39 - "Vault API"
Cohesion: 0.18
Nodes (16): health(), pull(), BaseModel, get, post, put, NAXIONAI — Personal knowledge vault API (Phase 6). Ported from…, read_file() (+8 more)

### Community 40 - "Layout Components"
Cohesion: 0.12
Nodes (7): metadata, ToastItem, _toastItems, ToastRack(), _toastSubscribers, ToastTone, CommandPalette()

### Community 41 - "data_source_client.py"
Cohesion: 0.26
Nodes (13): _apply_filter(), describe_source(), is_read_only_sql(), QueryResult, NAXIONAI — Data source query engine (Phase 5) Ported from…, Schema introspection — tables/columns for SQL sources, sheet/column names for…, _result(), _rows_to_tables() (+5 more)

### Community 42 - "API Design Guide"
Cohesion: 0.12
Nodes (15): Errors, Foundational principles, Goal, HTTP / REST conventions, Library / SDK conventions, Methods, Output shape (when designing an API), Pagination (+7 more)

### Community 43 - "CSS Animations"
Cohesion: 0.12
Nodes (15): breathing-glow (active state, e.g. running agent), fade-up (page / list entrance), Goal, Pitfalls, pop-check (success state), Process, Rules, scale-in (modal, popover, toast pop) (+7 more)

### Community 44 - "UX Master Prompt"
Cohesion: 0.12
Nodes (15): 1.1 Brand Identity Migration, 1.2 "The Obsidian & Neon" Design Language, 1.3 The Absolute Eradication of Emojis, 1. BRANDING, NAMING & IMMERSIVE AESTHETIC, 2.1 Navigation & The Command Center, 2.2 The Great "Knowledge" Consolidation, 2.3 The Ultimate Enterprise Landing Page (`/app/page.tsx` & `/app/login`), 2. STRUCTURAL & LAYOUT PARADIGM SHIFT (+7 more)

### Community 45 - "Objection Handling"
Cohesion: 0.14
Nodes (13): Goal, "I need to talk to my team", Library — common objections, "Not the right time", Pitfalls, Process for a NEW objection, Rules, "Send me more info" (+5 more)

### Community 46 - "chat_push"
Cohesion: 0.10
Nodes (24): AgentState, agent_thought_push(), chat_push(), NAXIONAI — Agent→Chat Push Utility Any LangGraph agent node can call…, Post a message from an autonomous agent into the user's chat feed. Called by…, Rapidly uses a lightweight LLM to generate a dynamic, first-person thought…, auditor_node(), NAXIONAI — Auditor Node Dynamic Risk Vector Topology. Grades risk and enforces… (+16 more)

### Community 47 - "Email Inbox Poller"
Cohesion: 0.23
Nodes (12): _check_inbox(), _clean_email_body(), _decode_str(), _extract_text_body(), _get_imap_host(), poll_email_inbox(), _process_approval_reply(), NAXIONAI — Agent Email Inbox Poller Connects to the inbox specified in .env via… (+4 more)

### Community 48 - "Model Provider API"
Cohesion: 0.23
Nodes (12): activate_provider(), add_provider(), AddProviderRequest, list_kinds(), list_providers(), AsyncSession, BaseModel, delete (+4 more)

### Community 49 - "audit.py"
Cohesion: 0.36
Nodes (7): AuditEventOut, _is_admin(), list_audit_events(), AsyncSession, BaseModel, get, NAXIONAI — Audit log API (Phase 4) Reads the same AgentLog table…

### Community 50 - "backend/model_providers.py"
Cohesion: 0.15
Nodes (26): Fernet, ModelProviderConfig, decrypt_value(), encrypt_value(), _get_cipher(), NAXIONAI — Symmetric encryption for stored credentials. Used to encrypt…, Encrypt a string value. Empty input returns empty output., Decrypt an encrypted string value. Empty input returns empty output. (+18 more)

### Community 51 - "Announcement Writing"
Cohesion: 0.15
Nodes (12): Departure announcement, Format, Goal, Hire announcement, Launch announcement, Length, Pitfalls, Policy / process change (+4 more)

### Community 52 - "Feedback Giving"
Cohesion: 0.15
Nodes (12): Example — corrective, Example — reinforcing (positive feedback that's actually useful), Goal, Hard feedback, How to ASK for feedback (the reverse skill), Output shape (when generating feedback for the customer to deliver), Pitfalls, Rules (+4 more)

### Community 53 - "Testing Strategy"
Cohesion: 0.15
Nodes (12): Decide per layer, End-to-end tests, Goal, Integration tests, Output shape (a testing plan for a feature), Pitfalls, Rules, Skill: Testing strategy (+4 more)

### Community 54 - "Implementation Plan"
Cohesion: 0.15
Nodes (12): 1. Segregating Knowledge & Training, 2. Agentic Hub Chat Additions, Automated Tests, Knowledge Base Segregation & Seamless Media Integration, Manual Verification, [MODIFY] `frontend/src/app/chat/page.tsx`, [MODIFY] `frontend/src/app/knowledge/page.tsx`, [NEW] `frontend/src/components/chat/AssetSelector.tsx` (Optional) (+4 more)

### Community 55 - "Ghost Browser"
Cohesion: 0.17
Nodes (6): GhostBrowser, NAXIONAI — Ghost Browser Persistent headless Playwright session that holds…, Initialise the Playwright engine without immediately launching browsers. On…, Cleanly shutdown all browser contexts., Retrieves a new tab in the persistent context isolated for this account. Spawns…, Page

### Community 56 - "chat.py"
Cohesion: 0.16
Nodes (19): chat_stream(), ChatMessageBody, clear_chat_history(), get_chat_history(), get_chat_updates(), AsyncSession, BaseModel, delete (+11 more)

### Community 57 - "OKR Writing"
Cohesion: 0.17
Nodes (11): Example (bad — common mistakes), Example (good), Format, Goal, Initiatives, Key Results, Objectives, Pitfalls (+3 more)

### Community 58 - "1:1 Prep"
Cohesion: 0.18
Nodes (11): Before the meeting, Draft an agenda (their items first, yours second), Goal, If you are the manager, If you are the report, Output shape (when generating a prep doc for the customer), Pitfalls, Questions a manager should keep in rotation (+3 more)

### Community 59 - "knowledge/page.tsx"
Cohesion: 0.25
Nodes (7): CATEGORIES, formatBytes(), KnowledgePage(), PrimaryMode, stagger, STATUS_COLORS, TrainingDoc

### Community 60 - "NEUROWORKS Dropped Features"
Cohesion: 0.17
Nodes (10): Enterprise-only (dropped — belongs to the multi-department product, not a personal assistant), Everything else evaluated (dropped — optional capabilities, not core to a personal assistant), neuroworks → naxionai merge: what was intentionally dropped, Verified before retirement, Getting started, History, License, NaxionAI (+2 more)

### Community 61 - "Intro Email"
Cohesion: 0.18
Nodes (10): A. Forward-style (double opt-in), B. Direct intro, Goal, Output shape — Direct intro (B), Output shape — Forward-style (A), Pitfalls, Process, Rules (+2 more)

### Community 62 - "Renewal Conversation"
Cohesion: 0.18
Nodes (10): At-risk — open with empathy, not the contract, Class-specific scripts, Easy renewal — open with confidence, Goal, Negotiation — open with outcomes, hold the price, Output shape, Pitfalls, Process (+2 more)

### Community 63 - "Root Cause Analysis"
Cohesion: 0.18
Nodes (10): Cross-checks (don't stop at the first plausible chain), Example: A site outage, Goal, Other techniques worth knowing, Output shape, Pitfalls, Rules, Skill: Root cause analysis (+2 more)

### Community 64 - "analytics/page.tsx"
Cohesion: 0.25
Nodes (4): PLATFORM_COLORS, PLATFORM_LABELS, STATUS_COLORS, AnalyticsOverview

### Community 65 - "Model Router"
Cohesion: 0.33
Nodes (8): get_context_window(), list_models(), ModelInfo, pick_model(), pick_model_for(), TypedDict, NAXIONAI — Capability-scored model router (Phase 5) Ported from…, score_model()

### Community 66 - "Commit Message Writing"
Cohesion: 0.20
Nodes (9): Body rules (when to include), Examples, Format, Goal, Pitfalls, Rules, Skill: Commit message writing, Subject line rules (+1 more)

### Community 67 - "Decline Politely"
Cohesion: 0.20
Nodes (9): Goal, Output — hard shape, Output — meeting decline, Output — soft shape, Pitfalls, Process, Rules, Skill: Decline politely (+1 more)

### Community 68 - "Email Writing"
Cohesion: 0.20
Nodes (9): Format, Goal, Pitfalls, Recipients (resolve real addresses), Rules, Skill: Email writing, Status / report email — required shape, Substance — every line must carry information (+1 more)

### Community 69 - "Loading State Design"
Cohesion: 0.20
Nodes (9): Optimistic UI checklist, Output shape, Pitfalls, Rules, Skeleton shape rules, Skill: Loading-state design, The four loading states, When NOT to use skeletons (+1 more)

### Community 70 - "Settings Page"
Cohesion: 0.24
Nodes (7): BriefSlot, FieldProps, getToken(), POPULAR_TIMEZONES, RECURRENCE_OPTIONS, SettingsPage(), Tab

### Community 71 - "Export Steps"
Cohesion: 0.22
Nodes (8): graphify reference: extra exports and benchmark, Step 6b - Wiki (only if --wiki flag), Step 7 - Neo4j export (only if --neo4j or --neo4j-push flag), Step 7a - FalkorDB export (only if --falkordb or --falkordb-push flag), Step 7b - SVG export (only if --svg flag), Step 7c - GraphML export (only if --graphml flag), Step 7d - MCP server (only if --mcp flag), Step 8 - Token reduction benchmark (only if total_words > 5000)

### Community 72 - "Debugging Help"
Cohesion: 0.22
Nodes (8): Common bug families to consider, Goal, Output shape, Pitfalls, Process, Rules, Skill: Debugging help, What to ask the customer

### Community 73 - "Fact-Checking"
Cohesion: 0.22
Nodes (8): Goal, Output shape, Pitfalls, Process, Rules, Skill: Fact-check, Verdict scale, When to reach for the web

### Community 74 - "Image Prompting"
Cohesion: 0.22
Nodes (8): Goal, Guardrails, Output shape (what you hand back), Pick the model to the job, Skill: Image prompting (studio generation), Tools, Worked example, Write the prompt: five layers, always concrete

### Community 75 - "Meeting Agenda"
Cohesion: 0.22
Nodes (8): Format, Goal, Item types, Output shape for a recurring meeting (e.g. weekly leadership), Pitfalls, Rules, Skill: Meeting agenda, When to NOT have the meeting

### Community 76 - "Motion Design Pass"
Cohesion: 0.22
Nodes (8): Duration cheat-sheet, Output shape, Pitfalls, Process, Property cheat-sheet, Rules, Skill: Motion design pass, When to use this

### Community 77 - "Primary Source Check"
Cohesion: 0.22
Nodes (8): Goal, Output shape, Pitfalls, Process, Rules, Skill: Primary source check, The source hierarchy, When this skill fires

### Community 78 - "Reconciliation"
Cohesion: 0.22
Nodes (8): Direction matters — which side does each item adjust?, Goal, Output shape, Pitfalls, Process, Rules, Skill: Reconciliation, Worked example (must tie to zero)

### Community 79 - "Risk Assessment"
Cohesion: 0.22
Nodes (8): Goal, Output shape, Pitfalls, Process, Rules, Severity × Likelihood matrix, Skill: Risk assessment, What counts as a risk

### Community 80 - "Source Triangulation"
Cohesion: 0.22
Nodes (8): Confidence verdicts, Goal, Output shape, Pitfalls, Process, Rules, Skill: Source triangulation, When this skill fires

### Community 81 - "Content Director"
Cohesion: 0.25
Nodes (7): Content Standards — NON-NEGOTIABLE, Hook Rules (first line is everything), NAXIONAI — Content Director Agent System Prompt, Platform-Specific Rules, Tone Guidelines by Brand Voice, What NEVER to write, Your Output Format

### Community 82 - "Skill Management"
Cohesion: 0.36
Nodes (8): delete_skill(), get_skill(), list_skills(), AsyncSession, delete, get, patch, toggle_skill()

### Community 83 - "Benchmark Lookup"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Benchmark lookup, When this skill fires

### Community 84 - "Churn Risk Flag"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Signals (in priority order), Skill: Churn risk flag

### Community 85 - "Code Writing"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Code writing, What to ask before writing

### Community 86 - "Competitive Analysis"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Competitive analysis, Web is required

### Community 87 - "Competitor Summary"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Competitor summary, When this fires (vs `competitive-analysis`)

### Community 88 - "Contract Summary"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Contract summary, Things to always flag (across contract types)

### Community 89 - "Daily Briefing"
Cohesion: 0.25
Nodes (7): Format, Goal, Length, Pitfalls, Rules, Skill: Daily briefing, Tone

### Community 90 - "Database Lookup"
Cohesion: 0.25
Nodes (7): Output shape, Pitfalls, Process, Query patterns, Rules, Skill: Database lookup, When to use this

### Community 91 - "Difficult Conversation Script"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Difficult-conversation script, When to use this

### Community 92 - "Direct Answer"
Cohesion: 0.25
Nodes (7): Goal, Length, Pitfalls, Rules, Shape, Skill: Direct answer, When to bail on direct-answer

### Community 93 - "End-of-Day Handoff"
Cohesion: 0.25
Nodes (7): Format, Goal, Length, Pitfalls, Rules, Skill: End-of-day handoff, Tone

### Community 94 - "Follow-Up Cadence"
Cohesion: 0.25
Nodes (7): Cadence table (default — adjust to context), Goal, Output shape, Pitfalls, Process, Rules, Skill: Follow-up cadence

### Community 95 - "Landscape Scan"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Landscape scan, When this skill fires

### Community 96 - "Launch Positioning"
Cohesion: 0.25
Nodes (7): Goal, Length guide, Pitfalls, Rules, Shape (in order), Skill: Launch positioning, Template

### Community 97 - "Lead Qualification"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Lead qualification, When this fires (vs `meddic-qualification`)

### Community 98 - "Microinteraction Spec"
Cohesion: 0.25
Nodes (7): Output shape, Pitfalls, Rules, Skill: Microinteraction spec, The 5-part spec, Timing budget, What's a microinteraction

### Community 99 - "Performance Review"
Cohesion: 0.25
Nodes (7): Goal, Manager-written review, Pitfalls, Rules for writing about specific moments, Self-review (writing about yourself), Skill: Performance review, Universal rules

### Community 100 - "Deep Research"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Skill: Deep research, When the web is REQUIRED (not optional)

### Community 101 - "Risk Register"
Cohesion: 0.25
Nodes (7): Goal, Output shape, Pitfalls, Process, Rules, Scoring, Skill: Risk register

### Community 102 - "Standup Summary"
Cohesion: 0.25
Nodes (7): Goal, Longer shape (when written report needed), Output shape (the actual standup message), Pitfalls, Process, Rules, Skill: Standup summary

### Community 103 - "Status Update"
Cohesion: 0.25
Nodes (7): Format, Goal, Length, Pitfalls, Rules, Skill: Status update, Tone

### Community 104 - "Vault Org"
Cohesion: 0.25
Nodes (7): Atomic-note rules (for 2-Permanent/), Folder map, Frontmatter, Linking conventions, Skill: Vault organization, What NOT to write to the vault, Where new content goes

### Community 105 - "Weekly Review"
Cohesion: 0.25
Nodes (7): Format, Goal, Output shape (generated for the customer), Pitfalls, Rules, Sections to consider adding (taste-dependent), Skill: Weekly review

### Community 106 - "Monitor Agent"
Cohesion: 0.29
Nodes (6): Assessment Standards, NAXIONAI — Monitor Agent System Prompt, Performance benchmarks by platform:, When NOT to replan:, When to trigger a replan:, Your Decision Framework

### Community 107 - "Action Item Extraction"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Action-item extraction

### Community 108 - "Caveman Mode"
Cohesion: 0.29
Nodes (6): Auto-clarity exception — drop compression for, Goal, Pitfalls, Rules, Skill: Caveman mode, When to use this

### Community 109 - "Channel Notify"
Cohesion: 0.29
Nodes (6): Message shape, Pitfalls, Process, Rules, Skill: Channel notify, When to use this

### Community 110 - "Code Review"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Priority order (review in this order, stop when each is satisfied), Rules, Skill: Code review

### Community 111 - "Company Lookup"
Cohesion: 0.29
Nodes (6): Output shape, Pitfalls, Process, Rules, Skill: Company-knowledge lookup, When to use this

### Community 112 - "Onboarding Brief"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Company onboarding brief

### Community 113 - "Comparison"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Comparison

### Community 114 - "Compliance Check"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Compliance check

### Community 115 - "Crisis Comm"
Cohesion: 0.29
Nodes (6): Anticipated Q&A, Goal, Holding statement (the one paragraph everyone uses), Pitfalls, Rules, Skill: Crisis holding statement + Q&A

### Community 116 - "CRM Update"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: CRM update from call notes

### Community 117 - "Customer 360"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Customer 360

### Community 118 - "CV Screening"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: CV screening

### Community 119 - "Decision Doc"
Cohesion: 0.29
Nodes (6): Format, Goal, Length, Pitfalls, Rules, Skill: Decision doc (ADR / RFD)

### Community 120 - "Design Doc"
Cohesion: 0.29
Nodes (6): Format, Goal, Length, Pitfalls, Rules, Skill: Design doc (RFC)

### Community 121 - "Discovery Prep"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Discovery call prep

### Community 122 - "Edit Pass"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Rules, Skill: Edit pass, What to fix (in order)

### Community 123 - "Email Triage"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Email triage

### Community 124 - "Expense Report"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Expense report

### Community 125 - "Feedback Trends"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Customer feedback trends

### Community 126 - "Fin Stmt Sum"
Cohesion: 0.29
Nodes (6): Goal, Key ratios (only the ones that matter), Pitfalls, Rules, Skill: Financial statement summary, Structure

### Community 127 - "Human Handoff"
Cohesion: 0.29
Nodes (6): Pitfalls, Process, Rules, Skill: Human hand-off (hybrid workforce), What good hand-offs look like, When to use this

### Community 128 - "Incident PM"
Cohesion: 0.29
Nodes (6): Format, Goal, Length, Pitfalls, Rules, Skill: Incident post-mortem

### Community 129 - "Inventory Analysis"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Rules, Skill: Inventory / reorder analysis, The calculations

### Community 130 - "Investor Update"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Investor update

### Community 131 - "Invoice Statement"
Cohesion: 0.29
Nodes (6): Goal, Invoice — required fields, Pitfalls, Rules, Skill: Invoice / statement, Statement (account activity) — shape

### Community 132 - "JD to Tasks"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: JD → role workflow

### Community 133 - "KB Article"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: KB article from solved ticket

### Community 134 - "List Making"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Rules, Skill: List making, When to use each shape

### Community 135 - "MEDDIC Qual"
Cohesion: 0.29
Nodes (6): Framework (MEDDIC, with PIC variants), Goal, Output structure, Pitfalls, Rules, Skill: MEDDIC qualification

### Community 136 - "Meeting Actions"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Meeting → action items

### Community 137 - "Meeting Prep"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Meeting prep pack

### Community 138 - "Multimedia Pack"
Cohesion: 0.29
Nodes (6): Output shape, Pitfalls, Process, Rules, Skill: Multimedia package, When to use this

### Community 139 - "Music Brief"
Cohesion: 0.29
Nodes (6): Pitfalls, Process, Prompt shape, Rules, Skill: Music brief + generation, When to use this

### Community 140 - "P&L Summary"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: P&L summary

### Community 141 - "Pipeline Review"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Pipeline review

### Community 142 - "Planning Doc"
Cohesion: 0.29
Nodes (6): Goal, Pitfalls, Rules, Sizing rule of thumb, Skill: Planning doc, Structure

### Community 143 - "PR Desc Write"
Cohesion: 0.29
Nodes (6): Format, Goal, Length, Pitfalls, Rules, Skill: PR description writing

### Community 144 - "Pre-Read"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Pre-read

### Community 145 - "Precedent Finder"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Precedent finder

### Community 146 - "Pricing Proposal"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Pricing proposal

### Community 147 - "Procurement Req"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Procurement request

### Community 148 - "Product Spec"
Cohesion: 0.29
Nodes (6): Format, Goal, Length, Pitfalls, Rules, Skill: Product spec (PRD)

### Community 149 - "Project Status"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Project status rollup

### Community 150 - "Proposal Writing"
Cohesion: 0.29
Nodes (6): Goal, Length, Pitfalls, Rules, Skill: Proposal writing, Structure

### Community 151 - "RAID Log"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Rules, Skill: RAID log, The four registers

### Community 152 - "Release Notes"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Release notes from commits

### Community 153 - "Report Writing"
Cohesion: 0.29
Nodes (6): Goal, Pitfalls, Rules, Skill: Report writing, Structure, Tone

### Community 154 - "Retry Diff Approach"
Cohesion: 0.29
Nodes (6): Anti-patterns to avoid, Goal, Pitfalls, Process, Skill: Retry with a different approach, What "different" means (pick at least one)

### Community 155 - "Slide Outline"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Slide outline

### Community 156 - "SOP Writing"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: SOP writing

### Community 157 - "Summarization"
Cohesion: 0.29
Nodes (6): Goal, Length cap, Output shape, Pitfalls, Principles, Skill: Summarization

### Community 158 - "Support Escalation"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Support escalation triage

### Community 159 - "Support Themes"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Support ticket clustering

### Community 160 - "Table Making"
Cohesion: 0.29
Nodes (6): Design rules, Goal, Output shape, Pitfalls, Skill: Table making, When NOT to use a table

### Community 161 - "Timesheet Fill"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Timesheet fill

### Community 162 - "Tomorrow Plan"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Tomorrow's work plan

### Community 163 - "Training Quiz"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Training quiz from a policy doc

### Community 164 - "Translation"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Translation + response draft

### Community 165 - "Travel Itinerary"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Travel itinerary

### Community 166 - "User Stories"
Cohesion: 0.29
Nodes (6): Format, Goal, Pitfalls, Rules, Skill: User stories + acceptance criteria, Splitting heuristics

### Community 167 - "UX Critique"
Cohesion: 0.29
Nodes (6): Goal, Pitfalls, Rules, Rules: what NOT to do, Skill: UX critique, Structure

### Community 168 - "Vendor Comparison"
Cohesion: 0.29
Nodes (6): Goal, Output shape, Pitfalls, Process, Rules, Skill: Vendor comparison + recommendation

### Community 169 - "Video Prompt"
Cohesion: 0.29
Nodes (6): Pitfalls, Process, Prompt shape, Rules, Skill: Video prompt + generation, When to use this

### Community 170 - "Voiceover Script"
Cohesion: 0.29
Nodes (6): Pitfalls, Process, Rules, Skill: Voiceover script + narration, When to use this, Writing for the ear

### Community 171 - "TasksPage"
Cohesion: 0.29
Nodes (5): Goal, PLATFORM_LABELS, PRIORITY_COLORS, stagger, STATUS_CONFIG

### Community 172 - "Graphify Query"
Cohesion: 0.33
Nodes (5): For /graphify explain, For /graphify path, graphify reference: query, path, explain, Step 0 — Constrained query expansion (REQUIRED before traversal), Step 1 — Traversal

### Community 173 - "A/B Test Read"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: A/B test read, Structure

### Community 174 - "Access Provisioning"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Access provisioning plan, Structure

### Community 175 - "Audit Prep"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Audit prep checklist, Structure

### Community 176 - "BRD Writing"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Business Requirements Document (BRD), Structure

### Community 177 - "Brief Writing"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: 1-page brief, Structure

### Community 178 - "Cold Outreach"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Sequence shape (3-5 touches), Skill: Cold outreach sequence

### Community 179 - "Dataset Publish"
Cohesion: 0.33
Nodes (5): Pitfalls, Process, Rules, Skill: Publish to Intellinexus, When to use this

### Community 180 - "Device Setup"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Device setup checklist, Structure

### Community 181 - "Event Runsheet"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Event run-sheet, Structure

### Community 182 - "Facilitator Guide"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Workshop facilitator guide, Structure

### Community 183 - "Fulfillment Plan"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Shipment / fulfillment plan, Structure

### Community 184 - "HR Policy"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: HR policy draft, Structure

### Community 185 - "JD Writing"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Job description writing, Structure

### Community 186 - "Logistics Exception"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Logistics exception resolution, Structure

### Community 187 - "Meeting Notes"
Cohesion: 0.33
Nodes (5): Goal, Output shape, Pitfalls, Rules, Skill: Meeting notes

### Community 188 - "Memo Writing"
Cohesion: 0.33
Nodes (5): Format, Goal, Pitfalls, Rules, Skill: Memo writing

### Community 189 - "Negotiation Brief"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Negotiation brief, Structure

### Community 190 - "Press Release"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Press release, Structure

### Community 191 - "Process Mapping"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: As-is / to-be process map, Structure

### Community 192 - "Project Plan"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Project plan, Structure

### Community 193 - "Prospect Research"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Prospect research + opener, What to gather

### Community 194 - "RFQ/RFP Writing"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: RFQ / RFP draft, Structure

### Community 195 - "Runbook Writing"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Runbook writing, Structure

### Community 196 - "Send Attachment"
Cohesion: 0.33
Nodes (5): Limits (fail loud, don't silently drop), Pitfalls, Process, Skill: Send document as attachment, When to use this

### Community 197 - "Trade-off Memo"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Trade-off memo, Structure

### Community 198 - "Training Curriculum"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: Training curriculum, Structure

### Community 199 - "Unit Economics"
Cohesion: 0.33
Nodes (5): Goal, Pitfalls, Rules, Skill: SaaS unit economics, Structure

### Community 200 - "UI Components"
Cohesion: 0.33
Nodes (4): Goal, PLATFORM_LABELS, stagger, STATUS_CONFIG

### Community 201 - "Orchestration Logic"
Cohesion: 0.40
Nodes (4): Goal Types:, Output Format (JSON):, Platform Intelligence:, Your responsibilities:

### Community 202 - "Research System"
Cohesion: 0.40
Nodes (4): NAXIONAI — Researcher Agent System Prompt, Platform Knowledge, Research Standards, Your Research Outputs

### Community 203 - "Campaign Strategy"
Cohesion: 0.40
Nodes (4): Content Mix Framework (vary this for every campaign):, Output Format (JSON):, Platform Psychology (apply this to EVERY decision):, Your Core Competencies:

### Community 204 - "Admin API"
Cohesion: 0.50
Nodes (5): _is_admin(), AsyncSession, get, SSE endpoint — streams agent log updates for a specific goal., stream_goal_activity()

### Community 207 - "Platform Capabilities"
Cohesion: 0.40
Nodes (4): Core Capabilities, NAXIONAI 🤖, Status, Tech Stack

### Community 208 - "Add Watch"
Cohesion: 0.50
Nodes (3): For /graphify add, For --watch, graphify reference: add a URL and watch a folder

### Community 209 - "Git Hooks"
Cohesion: 0.50
Nodes (3): For git commit hook, For native CLAUDE.md integration, graphify reference: commit hook and native CLAUDE.md integration

### Community 210 - "Update Process"
Cohesion: 0.50
Nodes (3): For --cluster-only, For --update (incremental re-extraction), graphify reference: incremental update and cluster-only

### Community 211 - "strategist_node"
Cohesion: 0.18
Nodes (11): _fetch_brand_context(), Query RAG memory for brand voice and relevant past content., Takes the parsed goal + research findings, produces a full campaign plan with…, strategist_node(), get_analytics_overview(), AsyncSession, get, Returns aggregated KPIs for the analytics dashboard. All data sourced from the… (+3 more)

### Community 212 - "Frontend Setup"
Cohesion: 0.50
Nodes (3): Deploy on Vercel, Getting Started, Learn More

### Community 215 - "Glitter Background"
Cohesion: 0.67
Nodes (3): GlitterBackground(), GlitterBackgroundProps, parseColor()

### Community 225 - "Settings"
Cohesion: 0.33
Nodes (3): BaseSettings, Config, Settings

### Community 253 - "new/page.tsx"
Cohesion: 0.40
Nodes (3): EXAMPLES, PLATFORM_OPTIONS, THINKING_STEPS

## Knowledge Gaps
- **1018 isolated node(s):** `QueryResult`, `PLATFORM_COLORS`, `PLATFORM_LABELS`, `STATUS_COLORS`, `Domain` (+1013 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **24 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `get_settings()` connect `get_settings` to `PA Tools`, `Knowledge Management`, `Security Scanner`, `skillforge.py`, `researcher.py`, `database.py`, `Wake-Word Detection`, `api/auth.py`, `web_search.py`, `media.py`, `main.py`, `cost_tracker.py`, `Security Watchdog`, `Settings API`, `chat_push`, `Email Inbox Poller`, `backend/model_providers.py`, `chat.py`, `Model Router`, `Settings`?**
  _High betweenness centrality (0.025) - this node is a cross-community bridge._
- **Why does `get_current_user()` connect `Models API` to `cost_tracker.py`, `schedules.py`, `Knowledge Management`, `accounts.py`, `Settings API`, `Task Manager`, `Vault API`, `Department Management`, `database.py`, `Wake-Word Detection`, `Playbook Skills`, `personas.py`, `Model Provider API`, `api/auth.py`, `Team Template`, `chat.py`, `Document Export`, `media.py`?**
  _High betweenness centrality (0.010) - this node is a cross-community bridge._
- **Why does `chat_push()` connect `chat_push` to `skillforge.py`, `researcher.py`, `graph.py`, `agency_daemon.py`?**
  _High betweenness centrality (0.006) - this node is a cross-community bridge._
- **What connects `QueryResult`, `PLATFORM_COLORS`, `PLATFORM_LABELS` to the rest of the system?**
  _1018 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `schedules.py` be split into smaller, more focused modules?**
  _Cohesion score 0.062004662004662 - nodes in this community are weakly interconnected._
- **Should `PA Tools` be split into smaller, more focused modules?**
  _Cohesion score 0.06370543541788427 - nodes in this community are weakly interconnected._
- **Should `Knowledge Management` be split into smaller, more focused modules?**
  _Cohesion score 0.06578947368421052 - nodes in this community are weakly interconnected._