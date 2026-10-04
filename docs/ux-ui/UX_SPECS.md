# UX/UI Design Specs — Core Flows

**Date:** Oct 2026 | **Format:** Markdown specs + ASCII wireframes | **Status:** MVP-ready

> No production UI artifacts existed for review (per research). These specs define
> what gets built — aligned with the 8-week roadmap and 2-3 engineer team.

---

## Design System Baseline

### Colors (dark-first, light mode later)

| Token | Value | Use |
|-------|-------|-----|
| `--bg` | `#0a0a0f` | App background |
| `--bg-surface` | `#12121a` | Cards, panels |
| `--bg-elevated` | `#1a1a24` | Modals, dropdowns |
| `--border` | `#2a2a3a` | Dividers, inputs |
| `--text` | `#e8e8f0` | Primary text |
| `--text-muted` | `#8888a0` | Secondary text |
| `--accent` | `#6c5ce7` | Primary action, links |
| `--success` | `#00b894` | Health OK, completed |
| `--warning` | `#fdcb6e` | Degraded, queued |
| `--danger` | `#ff7675` | Errors, failed |

### Typography

| Role | Font | Size | Weight |
|------|------|------|--------|
| Body | Inter / system | 14px | 400 |
| Heading | Inter | 18-24px | 600 |
| Mono | JetBrains Mono | 13px | 400 |
| Code | JetBrains Mono | 13px | 400 |

### Spacing (4px grid)

`4 / 8 / 12 / 16 / 24 / 32 / 48 / 64`

### Components (use existing web/src/components)

- Button (primary, secondary, ghost, danger)
- Input / Textarea
- Modal / Drawer
- Toast (bottom-right, 4s auto-dismiss)
- Badge (status, color-coded)
- Card
- Skeleton loaders (match content dimensions)

---

## Flow 1: First-Run Onboarding

**Owner:** ENG-025 (Sprint 4) | **Effort:** 3 days

### Screen 1 — Welcome

```
┌──────────────────────────────────────────┐
│                                          │
│              [ Naxie Logo ]              │
│                                          │
│        Your local-first AI agent         │
│     that works on your machine.          │
│                                          │
│     ┌──────────────────────────────┐     │
│     │      ⚡ Get Started          │     │
│     └──────────────────────────────┘     │
│                                          │
│     Already configured?  Skip →          │
│                                          │
└──────────────────────────────────────────┘
```

**Behavior:**
- "Get Started" → Step 2
- "Skip" → normal app (degraded, shows setup banner)
- Trigger: no `.naxion/onboarding.json` OR `config.ready === false`

---

### Screen 2 — Vault Location

```
┌──────────────────────────────────────────┐
│  ← Back                Step 2 of 5      │
│                                          │
│  Where should Naxie store your notes?    │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ 📁 ./vault                      │  │
│  │    (default — inside install)     │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ 📁 Browse…                       │  │
│  │    Choose an existing folder       │  │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ ✨ Create new vault              │  │
│  │    We'll set up a fresh Obsidian-  │  │
│  │    compatible structure            │  │
│  └────────────────────────────────────┘  │
│                                          │
│           ┌──────────────┐               │
│           │   Continue   │               │
│           └──────────────┘               │
└──────────────────────────────────────────┘
```

**Behavior:**
- Default path pre-selected; POST `/api/vault/setup { path }`
- Browse opens native file picker (`showDirectoryPicker()` or Electron dialog)
- Creates `.naxion/vault-path.json`
- Validates: writable, not inside node_modules

---

### Screen 3 — Model Setup

```
┌──────────────────────────────────────────┐
│  ← Back                Step 3 of 5      │
│                                          │
│  Choose your AI model                    │
│                                          │
│  ┌── LOCAL (free, private) ──────────┐   │
│  │ ✅ Ollama running                 │   │
│  │    qwen2.5:3b  —  loaded ✓        │   │
│  │                                   │   │
│  │ [Change model ▾]                  │   │
│  └────────────────────────────────────┘  │
│                                          │
│  ┌── CLOUD (faster, costs money) ────┐   │
│  │ ⬜ OpenRouter API key              │   │
│  │    sk-or-v1-...                    │   │
│  │    [Test connection]               │   │
│  └────────────────────────────────────┘  │
│                                          │
│  💡 You can always add cloud later.      │
│     Local works offline.                 │
│                                          │
│           ┌──────────────┐               │
│           │   Continue   │               │
│           └──────────────┘               │
└──────────────────────────────────────────┘
```

**Behavior:**
- GET `/api/status/llm` on mount → show Ollama state
- If Ollama down → show "Install Ollama" link + troubleshooting
- If model not pulled → "Pull model" button (POST `/api/models/pull`)
- OpenRouter: paste key → POST `/api/models/test` → show ✅/❌
- "Continue" works even without OpenRouter (local-only OK)

---

### Screen 4 — First Chat Test

```
┌──────────────────────────────────────────┐
│  ← Back                Step 4 of 5      │
│                                          │
│  Let's test! Say hello to Naxie.         │
│                                          │
│  ┌────────────────────────────────────┐  │
│  │ Hello Naxie!                      │  │
│  │ (pre-filled, editable)            │  │
│  └────────────────────────────────────┘  │
│                                          │
│         ┌──────────────┐                 │
│         │    Send      │                 │
│         └──────────────┘                 │
│                                          │
│  ── Response (streaming) ──────────────   │
│  │ Hi there! I'm Naxie, your local   │  │
│  │ assistant. I can help you with...  │  │
│  │ (token by token)                  │  │
│                                          │
│           ┌──────────────┐               │
│           │  Looks good! │               │
│           └──────────────┘               │
└──────────────────────────────────────────┘
```

**Behavior:**
- Auto-send after mount (no need to click)
- Streaming via SSE; show token-by-token
- Response <3s = ✅; >10s = show "Still thinking…" animation
- "Looks good" enabled only after full response received
- If error → show retry + link to troubleshooting

---

### Screen 5 — Done

```
┌──────────────────────────────────────────┐
│                                          │
│              ✅ All set!                 │
│                                          │
│       Naxie is ready to work with you.   │
│                                          │
│  ┌── What's next ─────────────────────┐  │
│  │ 📝 Open Vault — browse your notes  │  │
│  │ 💬 Start Chatting — ask Naxie      │  │
│  │ ⚙️  Settings — add integrations     │  │
│  └────────────────────────────────────┘  │
│                                          │
│           ┌──────────────┐               │
│           │  Launch App  │               │
│           └──────────────┘               │
│                                          │
└──────────────────────────────────────────┘
```

**Behavior:**
- Writes `.naxion/onboarding.json`
- "Launch App" → redirect to `/chat`
- Each "What's next" card deep-links to feature

---

## Flow 2: Chat Interface

**Owner:** ENG-002 + ENG-003 (Sprint 1) | **Effort:** 5 days

```
┌────────┬──────────────────────────────────────────────┐
│        │  [Naxie ▾]  [Model: qwen2.5:3b]   [⚙] [⋯]  │
│   ◉    ├──────────────────────────────────────────────┤
│  Chat  │                                              │
│  ────  │  User                                        │
│  Vault │  ┌──────────────────────────────────────┐    │
│  Jobs  │  │ What are the key findings in the Q3  │    │
│  Tasks │  │ financial report?                    │    │
│  ────  │  └──────────────────────────────────────┘    │
│  Agent │                                              │
│  ────  │  Naxie  [qwen2.5:3b · 1.2s · 340 tok]      │
│  Cost  │  ┌──────────────────────────────────────┐    │
│  ⚙     │  Based on the Q3 report, the three key │    │
│        │  findings are:                         │    │
│        │                                        │    │
│        │  1. **Revenue up 23%** vs Q2, driven   │    │
│        │     by the new API product line        │    │
│        │                                        │    │
│        │  2. Churn dropped to 4.1% after the    │    │
│        │     onboarding redesign [1]            │    │
│        │                                        │    │
│        │  3. Infrastructure costs rose 18% —    │    │
│        │     mostly Ollama GPU upgrade          │    │
│        │                                        │    │
│        │  Sources: vault/finance/q3-report.md   │    │
│        └──────────────────────────────────────┘    │
│                                                      │
│  ┌──────────────────────────────────────────────┐    │
│  │ @vault  Type a message…              [Send] │    │
│  └──────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

### Left Sidebar (240px, collapsible)

| Item | Icon | Action |
|------|------|--------|
| Chat | 💬 | New conversation |
| Vault | 📝 | File explorer |
| Jobs | 📋 | OrgTask board |
| Tasks | ✅ | My tasks |
| ──── | | |
| Agent | 🤖 | Agent config |
| Cost | 💰 | Cost dashboard |
| ──── | | |
| Settings | ⚙ | Settings page |

**Behavior:**
- Collapsible to icon-only (48px) on mobile / narrow screens
- Active item highlighted with accent color
- Badge on Jobs = pending approvals count

### Chat Header

| Element | Behavior |
|---------|----------|
| Persona selector | Dropdown: Naxie, Executive Assistant, Research Analyst + custom. Switching shows toast "Persona changed" and resets context |
| Model badge | Shows active model. Click → model selector modal |
| ⚙ button | Chat settings: temperature, max tokens, system prompt override |
| ⋯ button | Export, clear history, share, delete |

### Message Components

**User message:**
```
┌─────────────────────────────────────┐
│ User                    14:32       │
│ What are the key findings…          │
└─────────────────────────────────────┘
```
- Right-aligned (accent border-left)
- Edit button on hover (re-send modified)

**Assistant message:**
```
┌─────────────────────────────────────┐
│ Naxie                    14:32      │
│ [qwen2.5:3b · 1.2s · 340 tok]     │
│                                     │
│ Based on the Q3 report…            │
│                                     │
│ Sources: vault/finance/q3-report.md │
│                                     │
│ [Copy] [Retry] [👍] [👎]           │
└─────────────────────────────────────┘
```
- Left-aligned (surface background)
- Metadata line: model, latency, token count
- Sources: clickable → opens file in vault editor
- Actions: Copy, Retry, thumbs up/down (feeds quality feedback)

### Streaming Behavior

1. Show `▍` cursor while streaming
2. Render markdown incrementally (bold, lists, code blocks)
3. On completion: fade in metadata + actions (300ms)
4. On error mid-stream: show partial + "Error: … [Retry]"
5. Stop button replaces Send during generation

### Input Area

```
┌──────────────────────────────────────────────┐
│ [@vault] Type a message…              [🎙] [➤] │
└──────────────────────────────────────────────┘
```

| Element | Behavior |
|---------|----------|
| `@vault` chip | Toggle: include vault RAG in prompt. Shows count of docs retrieved |
| Textarea | Auto-resize (1-6 lines); Enter=send, Shift+Enter=newline |
| 🎙 voice | Hold-to-talk (TTS/STT); shows waveform |
| ➤ send | Disabled while streaming; replaces with ■ stop |

### Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Send message |
| `Shift+Enter` | New line |
| `Escape` | Stop generation / close modal |
| `Cmd/Ctrl+K` | Command palette |
| `Cmd/Ctrl+N` | New chat |
| `Cmd/Ctrl+B` | Toggle sidebar |
| `/` | Quick commands (when input empty) |

---

## Flow 3: Vault File Explorer

**Owner:** ENG-009 (Sprint 2) | **Effort:** 3 days

```
┌────────┬──────────────────┬─────────────────────────────┐
│        │ 📁 vault         │  projects/q3-report.md     │
│   ◉    │ ├─ 📁 projects   ├─────────────────────────────┤
│  Chat  │ │  ├─ q3-report   │  # Q3 Financial Report     │
│  ────  │ │  └─ competitor  │                             │
│  Vault │ │  ├─ 📁 finance  │  ## Revenue                │
│  ────  │ │  │  └─ q3.md    │  Revenue up **23%** vs Q2  │
│  Jobs  │ │  ├─ 📁 _naxion  │  driven by API product...  │
│  ────  │ │  └─ 📄 README   │                             │
│        │ │                 │  ## Key Findings            │
│        │ │                 │  1. Revenue growth          │
│        ├──────────────────┤  2. Churn reduction          │
│        │ 🔍 Search vault   │  3. Infra cost increase      │
│        │ [____________]    │                             │
│        │                   │  ---                        │
│        │ [+ New] [⬆ Up]   │  ## Recommendations          │
│        │                   │  - Scale API product         │
│        │                   │  - Monitor Ollama costs      │
└────────┴──────────────────┴─────────────────────────────┘
```

### Layout: 3-panel

| Panel | Width | Content |
|-------|-------|---------|
| Sidebar | 240px | Nav (collapsible) |
| File Tree | 280px | Tree + search + actions |
| Editor | flex | Monaco/CodeMirror with markdown preview |

### File Tree Behavior

- **Lazy load:** folders expand on click (GET `/api/vault/tree?path=`)
- **Search:** debounced 300ms; highlights matches; keyboard nav
- **Context menu:** right-click → New File, New Folder, Rename, Delete, Copy Path, Open in Git
- **Drag-drop:** move files between folders
- **Git status:** colored dots (green=new, yellow=modified, red=conflict)

### Editor Behavior

| Feature | Implementation |
|---------|----------------|
| Syntax highlighting | Monaco markdown language |
| Preview toggle | Split-pane or full preview (Cmd+Shift+P) |
| Auto-save | Debounced 2s → PATCH `/api/vault/files/:path` |
| Word count | Status bar: "1,247 words · 8 min read" |
| Find/Replace | Cmd+F with regex support |
| Backlinks | Right panel: notes linking to this one |

### Search Results

```
┌──────────────────────────────────┐
│ 🔍 "revenue growth"             │
│    12 results in 8 files        │
│                                  │
│ 📄 projects/q3-report.md        │
│    ## Revenue                    │
│    Revenue up **23%** vs Q2...  │
│                                  │
│ 📄 finance/monthly-summary.md   │
│    Revenue growth slowed to...  │
│                                  │
│ 📄 _naxion/reflections/2026...  │
│    ...revenue growth metrics... │
└──────────────────────────────────┘
```

---

## Flow 4: OrgTask Board (Kanban)

**Owner:** ENG-018 (Sprint 3) | **Effort:** 3 days

```
┌────────┬──────────────────────────────────────────────┐
│        │  OrgTask Board          [+ New Task] [Filter]│
│        ├──────────────┬──────────────┬────────────────┤
│  Chat  │  BACKLOG     │ IN PROGRESS  │ DONE           │
│  ────  │ (3)          │ (2)          │ (12)           │
│  Vault │              │              │                │
│  ────  │ ┌──────────┐ │ ┌──────────┐ │ ┌──────────┐  │
│  Jobs  │ │Research  │ │ │Analyze   │ │ │Weekly    │  │
│  ────  │ │Q4 market │ │ │Q3 finan- │ │ │rollup    │  │
│        │ │          │ │ │ces       │ │ │          │  │
│        │ │ 🤖 Exec  │ │ │          │ │ │ ✅ Done  │  │
│        │ │ P: High  │ │ │ ▓▓▓░░ 60%│ │ │ 2h ago   │  │
│        │ │ ⏳ ETA 5m │ │ │ 🤖 Naxie │ │ │          │  │
│        │ └──────────┘ │ │ P: Normal│ │ └──────────┘  │
│        │              │ └──────────┘ │                │
│        │ ┌──────────┐ │              │                │
│        │ │Draft     │ │              │                │
│        │ │launch    │ │              │                │
│        │ │blog post │ │              │                │
│        │ │          │ │              │                │
│        │ │ 🤖 Naxie │ │              │                │
│        │ │ P: Low   │ │              │                │
│        │ └──────────┘ │              │                │
└────────┴──────────────┴──────────────┴────────────────┘
```

### Card Anatomy

| Element | Data | Behavior |
|---------|------|----------|
| Title | `task.title` | Click → detail drawer |
| Persona avatar | `task.persona` | Badge with color |
| Priority | `task.priority` | Red (high), Yellow (normal), Gray (low) |
| Progress | `job.progress` | 0-100% bar, animated |
| ETA | Estimated from steps | "ETA 5m" / "ETA…" (calculating) |
| Status icon | `job.status` | ⏳ queued, ▶ running, ✅ done, ❌ failed |

### Drag & Drop

- Drag between columns → update `task.status`
- Optimistic UI: move immediately, roll back on API error
- Snap-to-grid; show drop indicator line
- Keyboard alternative: focus card → `Cmd+←/→` to move

### Detail Drawer (right slide-in, 480px)

```
┌────────────────────────────────────────┐
│ Analyze Q3 finances              [✕]  │
├────────────────────────────────────────┤
│ Status: ▶ In Progress                  │
│ Persona: Naxie                         │
│ Created: Oct 4, 14:32                  │
│                                        │
│ ── Plan (3 steps) ──────────────────   │
│ ✅ 1. Fetch Q3 report from vault       │
│ ▶  2. Calculate growth metrics         │
│ ⬜ 3. Generate summary + chart         │
│                                        │
│ ── Live Progress ───────────────────   │
│ ┌────────────────────────────┐         │
│ │ ▓▓▓▓▓▓▓▓░░░░░░ 60%       │         │
│ └────────────────────────────┘         │
│                                        │
│ ── Log ────────────────────────────    │
│ [14:32] Job created                    │
│ [14:32] Step 1: vault.read q3.md ✓    │
│ [14:33] Step 2: llm.generate (running) │
│                                        │
│ ── Actions ────────────────────────    │
│ [⏸ Pause]  [⏹ Stop]  [🔄 Retry]      │
│ [📋 View Output]                       │
└────────────────────────────────────────┘
```

### New Task Modal

```
┌─────────────────────────────────────────────┐
│ New Task                              [✕]  │
├─────────────────────────────────────────────┤
│                                             │
│ What do you want Naxie to do?               │
│ ┌─────────────────────────────────────────┐ │
│ │ Research Q4 competitors and create a   │ │
│ │ comparison table with pricing,         │ │
│ │ features, and target market            │ │
│ └─────────────────────────────────────────┘ │
│                                             │
│ Persona:  [Naxie ▾]                         │
│ Priority: [Normal ▾]                        │
│                                             │
│ ── Preview (generated) ─────────────────    │
│ Plan: 4 steps · Est. 3 min · Cost ~$0.02   │
│                                             │
│ [Cancel]              [Create & Start ▸]    │
└─────────────────────────────────────────────┘
```

**Behavior:**
- User types natural language → `POST /api/tasks/preview` → shows plan
- "Create & Start" → POST → immediately runs
- Plan preview optional (can skip with "Quick start")

---

## Flow 5: Health Dashboard

**Owner:** ENG-006 (Sprint 1) | **Effort:** 2 days

```
┌────────┬──────────────────────────────────────────────┐
│        │  System Health                   [Refresh ⟳] │
│        ├──────────────────────────────────────────────┤
│  Chat  │                                              │
│  ────  │  ┌─ LLM ──────────┐  ┌─ Vault ──────────┐  │
│  Vault │  │ ✅ Ollama       │  │ ✅ Synced        │  │
│  ────  │  │ qwen2.5:3b      │  │ Last: 2m ago     │  │
│  Jobs  │  │ Loaded · 42ms   │  │ 3 pending push   │  │
│  ────  │  │                 │  │                  │  │
│        │  │ ✅ OpenRouter   │  │ ⚠️ 1 conflict    │  │
│        │  │ gpt-4o-mini     │  │ [Resolve →]      │  │
│        │  │ Healthy · 310ms │  │                  │  │
│        │  └─────────────────┘  └──────────────────┘  │
│        │                                              │
│        │  ┌─ Jobs ──────────┐  ┌─ Peers ──────────┐  │
│        │  │ Queue: 2 running│  │ ✅ worker-0       │  │
│        │  │ 5 waiting       │  │    7472 · 2 jobs  │  │
│        │  │ 0 failed        │  │ ✅ worker-1       │  │
│        │  │ p95: 45s        │  │    7473 · 0 jobs  │  │
│        │  │                 │  │ ⬜ worker-2       │  │
│        │  │ [View Jobs →]   │  │    offline        │  │
│        │  └─────────────────┘  └──────────────────┘  │
│        │                                              │
│        │  ┌─ Storage ────────────────────────────┐    │
│        │  │ Disk: 45GB / 100GB (45%) ████████░░  │    │
│        │  │ Vault: 124 MB · 1,847 files          │    │
│        │  │ TTS cache: 89 MB · 412 entries       │    │
│        │  │ Jobs log: 23 MB                      │    │
│        │  └──────────────────────────────────────┘    │
│        │                                              │
│        │  ┌─ Cost (30 days) ─────────────────────┐    │
│        │  │ $12.40 total   [142 requests]        │    │
│        │  │ ▁▂▃▅▇█▇▅▃▂▁▂▃▅▇█▇▅▃▂▁               │    │
│        │  │ OpenRouter: $8.20 (66%)              │    │
│        │  │ Embeddings: $3.10 (25%)              │    │
│        │  │ TTS: $1.10 (9%)                      │    │
│        │  └──────────────────────────────────────┘    │
└────────────────┴──────────────────────────────────────┘
```

### Behavior

| Panel | Source | Refresh |
|-------|--------|---------|
| LLM | GET `/api/status/llm` | 30s poll + SSE |
| Vault | GET `/api/status/vault` | 60s poll |
| Jobs | GET `/api/jobs/status` | SSE stream |
| Peers | GET `/api/peers` | 30s poll |
| Storage | GET `/api/status/storage` | 60s poll |
| Cost | GET `/api/cost?range=30d` | On load only |

**Color coding:**
- ✅ Green: healthy, <200ms
- ⚠️ Yellow: degraded, >500ms, has conflicts
- ❌ Red: down, unreachable, >1000ms
- ⬜ Gray: not configured / offline

**Click behavior:**
- Each panel click → detail modal with full JSON, logs, actions
- "Resolve" on vault conflict → opens conflict resolution modal (TA-008)
- "View Jobs" → OrgTask board filtered to active

---

## Flow 6: Command Palette (Cmd+K)

**Owner:** ENG-002 (Sprint 1) | **Effort:** 0.5 day

```
┌──────────────────────────────────────────────┐
│ 🔍 Type a command or search…                 │
├──────────────────────────────────────────────┤
│                                              │
│ RECENT                                        │
│ 💬 New chat                    Cmd+N         │
│ 📝 Open vault/finance/q3.md                 │
│ 📋 Create new task                         │
│                                              │
│ ACTIONS                                       │
│ ⚡ Switch persona: Executive Assistant       │
│ 🔄 Restart server                          │
│ 💰 View cost dashboard                     │
│ ⬇️  Pull model: qwen3.5:0.8b               │
│                                              │
│ NAVIGATE                                      │
│ 🏠 Home                         Cmd+1       │
│ 📝 Vault                         Cmd+2       │
│ 📋 Tasks                         Cmd+3       │
│ ⚙️  Settings                      Cmd+,      │
│                                              │
└──────────────────────────────────────────────┘
```

**Behavior:**
- `Cmd+K` opens, `Escape` closes
- Fuzzy match across commands, files, tasks, personas
- Arrow keys navigate, Enter selects
- Recent items ranked by usage frequency

---

## Mobile Responsiveness (≤768px)

| Desktop | Mobile |
|---------|--------|
| 3-panel layout | Single panel, swipe navigation |
| Sidebar 240px | Bottom tab bar (Chat, Vault, Jobs, More) |
| Split editor | Full-screen editor, back button |
| Kanban 3 columns | Horizontal scroll or tab per column |
| Hover actions | Long-press context menu |

**Touch targets:** minimum 44×44px (Apple HIG)
**Safe areas:** respect `env(safe-area-inset-*)` for notched devices

---

## Accessibility (WCAG 2.1 AA)

| Requirement | Implementation |
|-------------|----------------|
| Keyboard navigation | All interactive elements focusable; visible focus ring |
| Screen reader | ARIA labels on icon buttons; live regions for streaming |
| Color contrast | ≥4.5:1 for text; ≥3:1 for UI components |
| Reduced motion | `prefers-reduced-motion` → disable animations |
| Captions | Audio/video has transcripts |

---

## Implementation Priority

| Priority | Flow | Sprint | Effort |
|----------|------|--------|--------|
| P0 | Chat Interface | 1 | 5d |
| P0 | Onboarding (basic) | 1 | 2d (trim scope) |
| P0 | Health Dashboard | 1 | 2d |
| P1 | Vault Explorer | 2 | 3d |
| P1 | Command Palette | 2 | 0.5d |
| P1 | OrgTask Board | 3 | 3d |
| P2 | Full Onboarding (5 steps) | 4 | 3d |
| P2 | Mobile responsive pass | 4 | 2d |
| P3 | Voice input | v0.2 | 3d |
| P3 | Dark/light toggle | v0.2 | 1d |