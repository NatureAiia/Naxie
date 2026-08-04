# Graph Report - backend  (2026-08-04)

## Corpus Check
- 64 files · ~37,733 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 580 nodes · 1258 edges · 41 communities
- Extraction: 95% EXTRACTED · 5% INFERRED · 0% AMBIGUOUS · INFERRED: 62 edges (avg confidence: 0.62)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `52211ffe`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- get_settings
- chat.py
- system_tools.py
- voice.py
- agency_daemon.py
- AgentState
- goals.py
- skillforge.py
- agency.py
- training.py
- email_notify.py
- chat_push
- media.py
- settings.py
- main.py
- database.py
- generate_completion
- email_inbox.py
- GhostBrowser
- stream.py
- generate_json
- publisher.py
- skills.py
- auth.py
- researcher.py
- Content Standards — NON-NEGOTIABLE
- Assessment Standards
- orchestrator.md
- Digital Force — Researcher Agent System Prompt
- Your Core Competencies:

## God Nodes (most connected - your core abstractions)
1. `get_settings()` - 32 edges
2. `AgentState` - 28 edges
3. `chat_push()` - 27 edges
4. `generate_completion()` - 21 edges
5. `agent_thought_push()` - 20 edges
6. `generate_json()` - 20 edges
7. `skillforge_node()` - 16 edges
8. `Base` - 16 edges
9. `build_neural_graph()` - 15 edges
10. `get_current_user()` - 15 edges

## Surprising Connections (you probably didn't know these)
- `BriefSlot` --uses--> `Goal`  [INFERRED]
  api/agency.py → database.py
- `AgencySettingsUpdate` --uses--> `Goal`  [INFERRED]
  api/agency.py → database.py
- `ChatMessageBody` --uses--> `AgencySettings`  [INFERRED]
  api/chat.py → database.py
- `ChatMessageBody` --uses--> `AgentLog`  [INFERRED]
  api/chat.py → database.py
- `ChatMessageBody` --uses--> `Goal`  [INFERRED]
  api/chat.py → database.py

## Import Cycles
- None detected.

## Communities (41 total, 0 thin omitted)

### Community 0 - "get_settings"
Cohesion: 0.05
Nodes (45): Digital Force — Agent Web Search Tool Powered by Tavily API. Available to ALL…, Extract the raw content of a specific URL using Tavily's extract API. Bypasses…, Search the web via Tavily and return structured results. Returns: { "success":…, Search the web specifically to find a solution to a technical error. Returns a…, scrape_website(), search_for_solution(), web_search(), BaseSettings (+37 more)

### Community 1 - "chat.py"
Cohesion: 0.09
Nodes (37): AccountCreate, AccountUpdate, create_account(), delete_account(), _is_admin(), list_accounts(), _owner_scope(), AsyncSession (+29 more)

### Community 2 - "system_tools.py"
Cohesion: 0.09
Nodes (32): browser_open(), get_pa_tools(), get_weather(), manage_clipboard(), Digital Force — Naxie Personal Assistant (PA) Tools Native tools for desktop…, Fetch live weather conditions and forecast for a city or current location…, Set a desktop notification reminder for the user. title: Notification header…, Perform OS system actions on Windows. action: 'open_app'… (+24 more)

### Community 3 - "voice.py"
Cohesion: 0.08
Nodes (30): _build_grammar(), get_vosk_model(), NaxionAI — Offline Wake-Word Detection (Vosk) Fully local, free, open-source…, Lazily load the Vosk model once and cache it. Returns None (not raises) if the…, Expand a wake phrase into itself plus in-vocabulary phonetic near-misses for…, One instance per connected WebSocket client. Feeds 16kHz mono PCM16 audio into…, Feed one chunk of raw 16-bit PCM audio. Returns True the moment any wake-phrase…, WakeWordSession (+22 more)

### Community 4 - "agency_daemon.py"
Cohesion: 0.12
Nodes (30): _check_brief_schedule(), _check_idle_chat_nudge(), _nudge_approval(), _phase_execute_goals(), _phase_retry_failed_posts(), _process_user(), _push_chat_checkin(), _push_execution_status() (+22 more)

### Community 5 - "AgentState"
Cohesion: 0.13
Nodes (23): build_neural_graph(), manager_router(), Digital Force — LangGraph Agent Graph (Neural Supervisor) Hub-and-spoke…, Read the routing decision made by the manager_node or executive_node., Unified Hub-and-Spoke topology starting with the Executive. Executive evaluates…, distribution_manager_node(), Distribution Manager Node (Fleet Commander) Takes generated tasks (from content…, manager_node() (+15 more)

### Community 6 - "goals.py"
Cohesion: 0.16
Nodes (27): approve_goal(), approve_via_token(), ApproveGoalRequest, create_goal(), CreateGoalRequest, get_goal(), _is_admin(), list_goals() (+19 more)

### Community 7 - "skillforge.py"
Cohesion: 0.14
Nodes (23): Digital Force — SkillForge Agent Node Creates new Python skills on-demand using…, Identifies skill gaps from failed tasks, searches the web for solutions,…, skillforge_node(), _hot_patch_skill(), _import_skill(), list_skills(), _load_skill_index(), Digital Force — Skill Registry & Dynamic Loader This is the bridge that was… (+15 more)

### Community 8 - "agency.py"
Cohesion: 0.17
Nodes (24): add_brief_slot(), agency_status(), AgencySettingsUpdate, BriefSlot, delete_brief_slot(), get_agency_settings(), _get_or_create_settings(), AsyncSession (+16 more)

### Community 9 - "training.py"
Cohesion: 0.18
Nodes (24): delete_knowledge(), get_knowledge_item(), ingest_url(), _is_admin(), list_knowledge(), _process_knowledge_item(), AsyncSession, BackgroundTasks (+16 more)

### Community 10 - "email_notify.py"
Cohesion: 0.15
Nodes (21): _generate_neural_email(), _get_user_email(), _new_approval_token(), notify_api_key_needed(), notify_campaign_complete(), notify_high_risk_approval(), Digital Force — Agent Email Notification Utility Sends branded HTML emails…, Notify about a missing API credential. Returns the approval token (stored in DB… (+13 more)

### Community 11 - "chat_push"
Cohesion: 0.18
Nodes (14): agent_thought_push(), chat_push(), Digital Force — Agent→Chat Push Utility Any LangGraph agent node can call…, Post a message from an autonomous agent into the user's chat feed. Called by…, Rapidly uses a lightweight LLM to generate a dynamic, first-person thought…, auditor_node(), Digital Force — Auditor Node Dynamic Risk Vector Topology. Grades risk and…, executive_node() (+6 more)

### Community 12 - "media.py"
Cohesion: 0.20
Nodes (17): delete_media(), _is_admin(), list_media(), AsyncSession, BaseModel, delete, get, patch (+9 more)

### Community 13 - "settings.py"
Cohesion: 0.17
Nodes (17): get_settings(), _load_overrides(), _mask(), BaseModel, delete, get, put, Digital Force — Settings API Read and write application configuration at… (+9 more)

### Community 14 - "main.py"
Cohesion: 0.15
Nodes (15): agency_daemon(), Entry point — called from main.py lifespan as asyncio.create_task(). Runs…, set_local_user(), init_db(), _migrate_add_columns(), Idempotent lightweight migration: `create_all` never ALTERs existing tables, so…, Create all tables on startup, then apply idempotent column migrations., FastAPI (+7 more)

### Community 15 - "database.py"
Cohesion: 0.21
Nodes (15): Digital Force — Analytics API Aggregates real-time KPIs from the database for…, hash_password(), Hash a password using bcrypt directly (avoids passlib/Python 3.14 compat…, AgentTask, Base, ensure_default_user(), GeneratedSkill, MediaAsset (+7 more)

### Community 16 - "generate_completion"
Cohesion: 0.21
Nodes (15): generate_completion(), _get_cascade_configs(), get_llm_client(), _get_ollama_chat(), get_tool_llm(), heal_dom_selector(), Digital Force — Agent LLM Client Local Ollama by default (LLM_PROVIDER=ollama);…, Legacy single-turn stream (kept for compatibility). Prefer… (+7 more)

### Community 17 - "email_inbox.py"
Cohesion: 0.23
Nodes (12): _check_inbox(), _clean_email_body(), _decode_str(), _extract_text_body(), _get_imap_host(), poll_email_inbox(), _process_approval_reply(), Digital Force — Agent Email Inbox Poller Connects to the inbox specified in… (+4 more)

### Community 18 - "GhostBrowser"
Cohesion: 0.17
Nodes (6): GhostBrowser, Digital Force — Ghost Browser Persistent headless Playwright session that holds…, Initialise the Playwright engine without immediately launching browsers. On…, Cleanly shutdown all browser contexts., Retrieves a new tab in the persistent context isolated for this account. Spawns…, Page

### Community 19 - "stream.py"
Cohesion: 0.22
Nodes (10): _is_admin(), AsyncSession, get, Digital Force — SSE Stream for real-time agent activity feed., SSE endpoint — streams agent log updates for a specific goal., stream_goal_activity(), decode_token(), Decode and validate a JWT token. Raises ValueError on failure. (+2 more)

### Community 20 - "generate_json"
Cohesion: 0.29
Nodes (9): generate_json(), Generate and natively parse a JSON object from the AI., content_director_node(), _determine_platform_rules(), _fetch_brand_context(), Digital Force — Content Director Agent Node Writes platform-optimized social…, Dynamically deduce optimal platform algorithms and character constraints using…, Query RAG memory for brand voice and relevant past content. (+1 more)

### Community 21 - "publisher.py"
Cohesion: 0.27
Nodes (9): _buffer_post(), _facebook_post(), _get_buffer_profiles(), publisher_node(), Digital Force — Publisher Agent Node Posts content to all platforms via Buffer…, Takes approved tasks marked as 'post_content', resolves content + assets, and…, Get all connected Buffer profile IDs keyed by service., Post to a Buffer profile. (+1 more)

### Community 22 - "skills.py"
Cohesion: 0.33
Nodes (9): delete_skill(), get_skill(), list_skills(), AsyncSession, delete, get, patch, Digital Force — Skills API (SkillForge viewer) (+1 more)

### Community 23 - "auth.py"
Cohesion: 0.20
Nodes (9): get_current_user(), Digital Force Auth — JWT, password hashing, user dependency., Verify a plaintext password against a bcrypt hash., Single-user local mode: no token validation. Every request is the one local…, Single-user local mode: no role gating, everyone is the local superadmin., require_role(), verify_password(), HTTPAuthorizationCredentials (+1 more)

### Community 24 - "researcher.py"
Cohesion: 0.32
Nodes (7): ghost_visual_research(), Digital Force — Researcher Agent Node Gathers real-time market intelligence…, Leverages Ghost Browser Vision for Walled Gardens, and robust Tavily Web Search…, Uses Ghost Browser and Llama-Vision to scrape walled-gardens natively., researcher_node(), Search for trending content, hashtags, and strategies for a specific topic.…, search_social_trends()

### Community 25 - "Content Standards — NON-NEGOTIABLE"
Cohesion: 0.25
Nodes (7): Content Standards — NON-NEGOTIABLE, Digital Force — Content Director Agent System Prompt, Hook Rules (first line is everything), Platform-Specific Rules, Tone Guidelines by Brand Voice, What NEVER to write, Your Output Format

### Community 26 - "Assessment Standards"
Cohesion: 0.29
Nodes (6): Assessment Standards, Digital Force — Monitor Agent System Prompt, Performance benchmarks by platform:, When NOT to replan:, When to trigger a replan:, Your Decision Framework

### Community 27 - "orchestrator.md"
Cohesion: 0.40
Nodes (4): Goal Types:, Output Format (JSON):, Platform Intelligence:, Your responsibilities:

### Community 28 - "Digital Force — Researcher Agent System Prompt"
Cohesion: 0.40
Nodes (4): Digital Force — Researcher Agent System Prompt, Platform Knowledge, Research Standards, Your Research Outputs

### Community 29 - "Your Core Competencies:"
Cohesion: 0.40
Nodes (4): Content Mix Framework (vary this for every campaign):, Output Format (JSON):, Platform Psychology (apply this to EVERY decision):, Your Core Competencies:

## Knowledge Gaps
- **20 isolated node(s):** `Config`, `Your Output Format`, `Hook Rules (first line is everything)`, `Platform-Specific Rules`, `Tone Guidelines by Brand Voice` (+15 more)
  These have ≤1 connection - possible missing edges or undocumented components.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `get_settings()` connect `get_settings` to `chat.py`, `system_tools.py`, `voice.py`, `goals.py`, `skillforge.py`, `training.py`, `email_notify.py`, `media.py`, `settings.py`, `main.py`, `database.py`, `generate_completion`, `email_inbox.py`, `generate_json`, `publisher.py`, `auth.py`, `researcher.py`?**
  _High betweenness centrality (0.207) - this node is a cross-community bridge._
- **Why does `get_current_user()` connect `auth.py` to `chat.py`, `voice.py`, `goals.py`, `agency.py`, `training.py`, `media.py`, `settings.py`, `database.py`, `stream.py`, `skills.py`?**
  _High betweenness centrality (0.029) - this node is a cross-community bridge._
- **What connects `Config`, `Your Output Format`, `Hook Rules (first line is everything)` to the rest of the system?**
  _20 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `get_settings` be split into smaller, more focused modules?**
  _Cohesion score 0.05380852550663871 - nodes in this community are weakly interconnected._
- **Should `chat.py` be split into smaller, more focused modules?**
  _Cohesion score 0.08974358974358974 - nodes in this community are weakly interconnected._
- **Should `system_tools.py` be split into smaller, more focused modules?**
  _Cohesion score 0.08907563025210084 - nodes in this community are weakly interconnected._
- **Should `voice.py` be split into smaller, more focused modules?**
  _Cohesion score 0.08377896613190731 - nodes in this community are weakly interconnected._