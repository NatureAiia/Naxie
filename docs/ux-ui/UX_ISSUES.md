# UX/UI — GitHub Issue Templates

---

## UX-001: Chat Interface (Messages, Streaming, Input)
**Labels:** `ux-ui`, `frontend`, `critical`, `sprint-1`
**Assignee:** @eng-2
**Estimate:** 3 days
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 2

### Tasks
- [ ] `ChatView` with virtualized message list (react-window)
- [ ] Streaming via SSE with markdown incremental render
- [ ] Message actions: copy, retry, thumbs, edit-resend
- [ ] Auto-resizing textarea; Enter/Shift+Enter behavior
- [ ] `@vault` toggle chip with retrieval count
- [ ] Persona selector dropdown (from `/api/personas`)
- [ ] Model badge in header
- [ ] Keyboard shortcuts (Cmd+K, Cmd+N, Cmd+B, Escape)
- [ ] Mobile: bottom tab bar, 44px touch targets
- [ ] Loading skeleton during initial fetch
- [ ] Error toast with retry on SSE failure

**Acceptance:**
- [ ] Streaming tokens appear <100ms after server emit
- [ ] Markdown renders correctly (bold, lists, code, tables)
- [ ] Works at 375px viewport
- [ ] Keyboard-only navigation passes

---

## UX-002: First-Run Onboarding (5 Steps)
**Labels:** `ux-ui`, `frontend`, `critical`, `sprint-4`
**Assignee:** @eng-2
**Estimate:** 3 days
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 1

### Tasks
- [ ] Welcome screen with logo + CTA
- [ ] Vault path picker (default, browse, create)
- [ ] Model setup (Ollama status + OpenRouter key input + test)
- [ ] First chat test (pre-filled message, streaming response)
- [ ] Completion screen with "What's next" cards
- [ ] Skip flow → banner in main app
- [ ] Progress indicator (Step X of 5)
- [ ] Back navigation preserves state
- [ ] `.naxion/onboarding.json` write on completion
- [ ] Responsive (works on mobile)

**Acceptance:**
- [ ] Fresh install → working chat in <3 minutes
- [ ] Each step shows clear success/failure
- [ ] Skip path produces functional app

---

## UX-003: Health Dashboard (Subsystem Status)
**Labels:** `ux-ui`, `frontend`, `high`, `sprint-1`
**Assignee:** @eng-2
**Estimate:** 2 days
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 5

### Tasks
- [ ] 2×2 grid of status cards: LLM, Vault, Jobs, Peers
- [ ] Color-coded badges: ✅ green, ⚠️ yellow, ❌ red, ⬜ gray
- [ ] Storage panel: disk usage, vault size, cache size
- [ ] Cost panel: 30-day total, sparkline, breakdown by type
- [ ] Auto-refresh: 30s poll + SSE for jobs
- [ ] Click each panel → detail modal with raw JSON + actions
- [ ] "Resolve" button on vault conflict → opens conflict modal
- [ ] Mobile: single column stack

**Acceptance:**
- [ ] All subsystems visible at a glance
- [ ] Degraded state shows actionable error message
- [ ] Auto-refresh without manual reload

---

## UX-004: Vault File Explorer (Tree + Editor)
**Labels:** `ux-ui`, `frontend`, `critical`, `sprint-2`
**Assignee:** @eng-2
**Estimate:** 3 days
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 3

### Tasks
- [ ] 3-panel layout: sidebar (240) + tree (280) + editor (flex)
- [ ] Tree: lazy-load folders, collapse/expand, git status dots
- [ ] Tree: context menu (new file/folder, rename, delete, copy path)
- [ ] Tree: drag-drop move between folders
- [ ] Search: debounced 300ms, highlights matches, keyboard nav
- [ ] Editor: Monaco markdown with syntax highlighting
- [ ] Auto-save debounced 2s → PATCH `/api/vault/files/:path`
- [ ] Preview toggle (split-pane or full)
- [ ] Word count + reading time in status bar
- [ ] Backlinks panel (notes linking to current file)
- [ ] New file/folder modal with path validation
- [ ] Delete with confirmation (move to trash first)
- [ ] Mobile: full-screen editor, back to tree button

**Acceptance:**
- [ ] 10k files loads in <2s (lazy tree)
- [ ] Edit → save → refresh shows changes
- [ ] Works on mobile (touch-friendly)

---

## UX-005: OrgTask Board (Kanban)
**Labels:** `ux-ui`, `frontend`, `high`, `sprint-3`
**Assignee:** @eng-2
**Estimate:** 3 days
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 4

### Tasks
- [ ] 3-column board: Backlog, In Progress, Done
- [ ] Drag-drop between columns (react-beautiful-dnd or @dnd-kit)
- [ ] Card: title, persona avatar, priority color, progress bar, ETA
- [ ] Click card → detail drawer (right slide-in, 480px)
- [ ] Detail: plan steps (✅/▶/⬜), live log, progress, actions (pause/stop/retry)
- [ ] New Task modal: natural language → plan preview → Create & Start
- [ ] Filter: by persona, status, date range
- [ ] Real-time updates via SSE (no polling)
- [ ] Keyboard: focus card → Cmd+←/→ to move
- [ ] Empty state: "No tasks yet — create one!"
- [ ] Mobile: horizontal scroll or tab per column

**Acceptance:**
- [ ] Drag card → column → status updates
- [ ] Progress bar reflects actual step completion
- [ ] Completed task shows artifact link

---

## UX-006: Command Palette (Cmd+K)
**Labels:** `ux-ui`, `frontend`, `medium`, `sprint-2`
**Assignee:** @eng-2
**Estimate:** 0.5 day
**Spec:** `docs/ux-ui/UX_SPECS.md` → Flow 6

### Tasks
- [ ] Cmd+K opens, Escape closes
- [ ] Sections: Recent, Actions, Navigate
- [ ] Fuzzy search across commands, files, tasks, personas
- [ ] Arrow keys navigate, Enter selects
- [ ] Recent items ranked by usage frequency (localStorage)
- [ ] Grouped results with type labels

**Acceptance:**
- [ ] Opens in <100ms
- [ ] Search returns results in <50ms
- [ ] Works with keyboard only

---

## UX-007: Design System Foundation
**Labels:** `ux-ui`, `frontend`, `high`, `sprint-1`
**Assignee:** @eng-2
**Estimate:** 1 day
**Spec:** `docs/ux-ui/UX_SPECS.md` → Design System Baseline

### Tasks
- [ ] CSS custom properties for colors, spacing, typography
- [ ] Tailwind config extending tokens
- [ ] Base components: Button, Input, Modal, Toast, Badge, Card, Skeleton
- [ ] Dark theme as default (light theme later)
- [ ] Icon system (Lucide or Heroicons)
- [ ] Figma token export (for future designers)

**Acceptance:**
- [ ] All tokens defined in one place (CSS vars)
- [ ] Components storybook or demo page
- [ ] Dark mode fully readable (WCAG AA contrast)

---

## UX-008: Mobile Responsive Pass
**Labels:** `ux-ui`, `frontend`, `medium`, `sprint-4`
**Assignee:** @eng-2
**Estimate:** 2 days

### Tasks
- [ ] Audit all pages at 375px, 768px, 1024px, 1440px
- [ ] Bottom tab bar for mobile navigation
- [ ] Sidebar collapses to icons / drawer
- [ ] Touch targets ≥44×44px
- [ ] Safe area insets for notched devices
- [ ] Landscape mode layouts
- [ ] Test on real devices (iOS Safari, Chrome Android)

**Acceptance:**
- [ ] No horizontal scroll at 375px
- [ ] All interactive elements touchable
- [ ] Lighthouse mobile score >90

---

## UX-009: Accessibility Audit (WCAG 2.1 AA)
**Labels:** `ux-ui`, `frontend`, `medium`, `sprint-4`
**Assignee:** @eng-2
**Estimate:** 1 day

### Tasks
- [ ] Keyboard navigation: all interactive elements reachable
- [ ] Focus management: modals trap focus, return on close
- [ ] ARIA labels on icon-only buttons
- [ ] Live regions for streaming content (`aria-live="polite"`)
- [ ] Color contrast: ≥4.5:1 text, ≥3:1 UI components
- [ ] `prefers-reduced-motion` → disable animations
- [ ] Screen reader test with NVDA/VoiceOver
- [ ] Alt text for all images
- [ ] Form labels and error messages associated

**Acceptance:**
- [ ] axe-core scan: 0 critical issues
- [ ] Keyboard-only: complete full flow (onboarding → chat → vault)
- [ ] Screen reader announces streaming responses