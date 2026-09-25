// Custom error class so 404s on job polls can be detected by callers
// and surface a "server restarted" message instead of a bare "not found".
export class ApiError extends Error {
  status: number;
  hint?: string;
  serverBootAt?: string;
  constructor(status: number, message: string, opts?: { hint?: string; serverBootAt?: string }) {
    super(message);
    this.status = status;
    this.hint = opts?.hint;
    this.serverBootAt = opts?.serverBootAt;
  }
}

// Session token for the identity layer — stored client-side and sent on every
// request so the server can attribute activity to the logged-in user.
const TOKEN_KEY = "neuroworks.token";
export function getToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}
export function setToken(token: string | null): void {
  try { if (token) localStorage.setItem(TOKEN_KEY, token); else localStorage.removeItem(TOKEN_KEY); } catch { /* ignore */ }
}

// Identity of the signed-in user, kept client-side so per-user local state
// (chat cache, session ids) can be namespaced by user and never bleed across
// accounts sharing a browser. Set at login and refreshed whenever
// /api/auth/session resolves; cleared on sign-out.
const USER_ID_KEY = "neuroworks.userId";
export function getCurrentUserId(): string | null {
  try { return localStorage.getItem(USER_ID_KEY); } catch { return null; }
}
export function setCurrentUserId(id: string | null): void {
  try { if (id) localStorage.setItem(USER_ID_KEY, id); else localStorage.removeItem(USER_ID_KEY); } catch { /* ignore */ }
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const token = getToken();
  let r: Response;
  try {
    r = await fetch(path, { ...init, headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.headers ?? {}) } });
  } catch (e: any) {
    // fetch() rejects on network errors only (server down, DNS failure, CORS,
    // aborted). The browser gives us a cryptic TypeError with message like
    // "Failed to fetch" or "load failed" — unwrap to something actionable.
    const reason = e?.message ?? String(e);
    const isNetwork = e instanceof TypeError || /fetch|network|connect|abort|dns|econnrefused|enotfound/i.test(reason);
    throw new ApiError(0, isNetwork
      ? `Cannot reach the server at ${path}. Make sure the API server (port 7471) is running.`
      : reason);
  }
  if (!r.ok) {
    let msg = `${r.status} ${r.statusText}`;
    let hint: string | undefined;
    let serverBootAt: string | undefined;
    try {
      const body = await r.json();
      msg = body.error ?? msg;
      if (typeof body.hint === "string") hint = body.hint;
      if (typeof body.serverBootAt === "string") serverBootAt = body.serverBootAt;
    } catch {}
    throw new ApiError(r.status, msg, { hint, serverBootAt });
  }
  return r.json() as Promise<T>;
}

export type TemplateInput = {
  name: string; label: string;
  type: "text" | "number" | "boolean" | "repo-picker" | "textarea";
  required?: boolean; default?: string | number | boolean; placeholder?: string;
};
export type Template = {
  id: string; role: "Engineering" | "Knowledge" | "Operations" | "Insights";
  title: string; description: string; icon: string;
  inputs: TemplateInput[]; requiresApproval: boolean; estimateSeconds: number; agent: string;
};
export type Role = { id: string; label: string; description: string; count: number };

// Omnisignal — acquires raw signal (web/db/file/vault) and, via ADRS, publishes
// it as a dataset agents can RAG against. Surfaced on Library's Datasets tab.
export type OmniSourceKind = "web_search" | "web_page" | "db" | "local_file" | "vault" | "email";
export type OmniSourceKindInfo = { kind: OmniSourceKind; needs: string; description: string };
export type OmniSource = {
  id: string; name: string; category: string; kind: OmniSourceKind;
  query?: string; urls?: string[]; sourceLabel?: string; path?: string; feedId?: string; limit?: number;
  createdAt: string; lastAcquiredAt?: string;
};
export type OmniSpec = {
  sourceId?: string; kind?: OmniSourceKind; category?: string;
  query?: string; urls?: string[]; sourceLabel?: string; path?: string; feedId?: string; limit?: number;
};
export type OmniSourceReport = { source: string; kind: string; category: string; count: number; error?: string };
export type AcquireResult = { records: Record<string, unknown>[]; report: OmniSourceReport[]; total: number };
export type DatasetManifest = {
  id: string; name: string; sector?: string; source: string; createdAt: string;
  rawCount: number; recordCount: number; reviewQueue: number; ambiguousMatches: number;
  avgConfidence: number; rootHash: string; fields: string[];
  stages: { stage: string; in: number; out: number; note: string }[];
  outputs: { csv: string; jsonl: string; rag: string; card: string };
};
export type QualitySummary = {
  totalFlags: number;
  upvotes: number;
  downvotes: number;
  rate: number;
  topCategories: { category: string; count: number }[];
  recentFlags: {
    jobId: string;
    rating: "up" | "down";
    note?: string;
    persona?: string;
    category?: string;
    ts: string;
  }[];
};
export type HostToolsSettings = { allowSystemControl: boolean; allowClipboardAccess: boolean; allowNotifications: boolean; gitRepoPath: string };
export type DaemonSettings = { disabledLoops: string[] };
export type RosterRow = { name: string; providerKind?: string; providerLabel?: string; tier?: "small" | "large"; free: boolean; active: boolean; calls: number; costUsd: number; failed: number; failureRate: number };

export type OnboardingSector = {
  id: string; name: string; nameShona?: string; nameNdebele?: string; description: string; icon: string; contextNote: string;
  suggestedDepartments: string[]; suggestedIntegrations: string[]; suggestedTemplates: string[];
};
export type SectorBundleResult = {
  sectorId: string;
  departments: { id: string; departmentName: string; personaCount: number }[];
  suggestedConnectors: { label: string; hasTemplate: boolean }[];
};
export type OnboardingState = {
  completed: boolean;
  sector?: string;
  customSectorName?: string;
  language: "en";
  orgName?: string;
  responseStyle?: "standard" | "caveman";
  completedAt?: string;
  priorities?: string;
  communicationStyle?: string;
  notes?: string;
};
export type OperatorIdentity = {
  name: string; email: string; title?: string; sector?: string; orgName?: string; language: string; summary: string;
};

export type OrgRole = "scheduler" | "researcher" | "executor" | "admin" | "architect" | "hermes-reviewer" | "improver";
export type OrgTaskStatus = "backlog" | "active" | "blocked" | "waiting-on-approval" | "done";
export type OrgTaskPriority = "low" | "normal" | "high" | "urgent" | "crown";
export type OrgTask = {
  id: string;
  role: OrgRole;
  title: string;
  detail: string;
  status: OrgTaskStatus;
  priority: OrgTaskPriority;
  linkedTaskIds: string[];
  jobId?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: "naxie" | "user" | "daemon";
  pendingApproval?: { actionDescription: string; kind: string; requestedAt: string; diff?: string; improvement?: ImprovementProposal };
};

export type ImprovementKind = "schedule" | "code" | "mcp" | "cli" | "skill" | "retrieval" | "other";
export type ImprovementProposal = {
  kind: ImprovementKind;
  title: string;
  why: string;
  implementation: string[];
  effort: "S" | "M" | "L";
  payload?: Record<string, unknown>;
  reviewDate?: string;
};

export type WeeklyImprovementStatus = {
  last: { date: string; path: string; generatedAt: string; modelUsed?: string; proposals: { kind: ImprovementKind; title: string; effort: string }[]; taskIds: string[]; parseFailed: boolean } | null;
  nextFireAt: number | null;
};

export type OfflineModeState = { offline: boolean; since?: string };

export type QualityFlag = {
  jobId: string;
  rating: "up" | "down";
  note?: string;
  category?: string;
  persona?: string;
  template?: string;
  ts: string;
};

export const api = {
  health: () => req<{ ok: boolean; name: string; version: string; model: string; port: number; ready: boolean; missing: string[]; inflightJobs?: number; peers?: string[] }>("/api/health"),
  listRepos: () => req<{ repos: any[] }>("/api/repos"),
  getRepo: (owner: string, name: string) => req<any>(`/api/repos/${owner}/${name}`),
  listTemplates: (opts?: { includeHidden?: boolean }) =>
    req<{ roles: Role[]; templates: Template[] }>(`/api/templates${opts?.includeHidden ? "?includeHidden=1" : ""}`),
  runTemplate: (id: string, inputs: Record<string, any>) => req<{ jobId: string; requiresApproval: boolean; status: string }>(`/api/templates/run/${id}`, { method: "POST", body: JSON.stringify(inputs) }),
  getJob: (id: string) => req<any>(`/api/templates/jobs/${id}`),
  listJobs: () => req<{ jobs: any[] }>("/api/templates/jobs"),
  // Historical median durations per task type (+ global fallback) so a running
  // task can show an ETA. See server jobs.etaStats().
  taskEtaStats: () => req<{ byType: Record<string, { medianMs: number; count: number }>; globalMedianMs: number; count: number }>("/api/tasks/eta"),
  // Hybrid workforce — tasks waiting on the human, resume-with-input, and the
  // where-does-time-go decomposition (agent runtime vs waiting-on-human vs
  // logged human work).
  tasksWaiting: () => req<{ waiting: WaitingTask[] }>("/api/tasks/waiting"),
  submitHumanInput: (id: string, responses: { prompt: string; response: string }[], note?: string) =>
    req<{ jobId: string; continuesJobId: string }>(`/api/tasks/jobs/${encodeURIComponent(id)}/human-input`, { method: "POST", body: JSON.stringify({ responses, note }) }),
  timeAnalysis: (days = 30) => req<TimeAnalysis>(`/api/tasks/time-analysis?days=${days}`),
  // My Work — human-in-the-loop assignments (neuro/boss → human, work uploads).
  listAssignments: () => req<{ mine: Assignment[]; delegated: Assignment[]; all?: Assignment[] }>("/api/assignments"),
  assignmentsDirectory: () => req<{ people: AssignPerson[] }>("/api/assignments/directory"),
  createAssignment: (body: { title: string; details?: string; assignedToEmail: string; dueAt?: string; files?: { name: string; contentBase64: string }[] }) =>
    req<{ assignment: Assignment }>("/api/assignments", { method: "POST", body: JSON.stringify(body) }),
  submitAssignment: (id: string, body: { text?: string; files?: { name: string; contentBase64: string }[] }) =>
    req<{ assignment: Assignment }>(`/api/assignments/${encodeURIComponent(id)}/submit`, { method: "POST", body: JSON.stringify(body) }),
  setAssignmentStatus: (id: string, status: AssignmentStatus) =>
    req<{ assignment: Assignment }>(`/api/assignments/${encodeURIComponent(id)}/status`, { method: "POST", body: JSON.stringify({ status }) }),
  costTrend: (days = 14) => req<CostTrend>(`/api/cost/trend?days=${days}`),
  cacheStats: () => req<any>("/api/cost/cache-stats"),
  securityEvents: () => req<SecurityStatus>("/api/security/events"),
  unblockIp: (ip: string) => req<{ ok: boolean; unblocked: boolean }>("/api/security/unblock", { method: "POST", body: JSON.stringify({ ip }) }),
  updatePersona: (id: string, patch: { workMode?: WorkMode; tone?: string; description?: string; role?: string }) =>
    req<{ persona: any }>(`/api/personas/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  // First-run bootstrap: is the org empty (no accounts yet)?
  authState: () => req<{ needsBootstrap: boolean }>("/api/auth/state"),
  // Self-signup + admin approval + org management (Admin page). On first run the
  // response carries a token + firstUser:true (the owner is signed in at once).
  signup: (body: { name: string; email: string; password: string; department?: string; title?: string }) =>
    req<{ ok: true; user: User; message: string; firstUser?: boolean; token?: string }>("/api/auth/signup", { method: "POST", body: JSON.stringify(body) }),
  listPendingUsers: () => req<{ pending: User[] }>("/api/users/pending"),
  approveUser: (id: string, body: { role?: UserRole; department?: string; workMode?: WorkMode; title?: string } = {}) =>
    req<{ user: User }>(`/api/users/${encodeURIComponent(id)}/approve`, { method: "POST", body: JSON.stringify(body) }),
  rejectUser: (id: string) => req<{ ok: true }>(`/api/users/${encodeURIComponent(id)}/reject`, { method: "POST" }),
  listSessions: () => req<{ sessions: { id: string; userId: string; name?: string; email?: string; role?: UserRole; createdAt: string; lastSeenAt: string }[] }>("/api/users/sessions"),
  revokeSession: (id: string) => req<{ ok: true }>("/api/users/sessions/revoke", { method: "POST", body: JSON.stringify({ id }) }),
  // Task restrictions (company-structure guardrails).
  listRestrictions: () => req<{ restrictions: { id: string; scope: string; capability: string; note?: string; createdAt: string }[]; capabilities: string[] }>("/api/users/restrictions"),
  addRestriction: (body: { scope: string; capability: string; note?: string }) =>
    req<{ restriction: any }>("/api/users/restrictions", { method: "POST", body: JSON.stringify(body) }),
  removeRestriction: (id: string) => req<{ ok: true }>(`/api/users/restrictions/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // Layer bundles — what each access level sees (Add-user modal preview).
  accessLayers: () => req<{ layers: Record<AccessLayer, { label: string; sees: string[]; hidden: string[] }> }>("/api/auth/layers"),
  approveJob: (id: string, editedPlan?: any) =>
    req<{ jobId: string; status: string }>(`/api/templates/jobs/${id}/approve`, {
      method: "POST",
      ...(editedPlan ? { body: JSON.stringify({ plan: editedPlan }) } : {}),
    }),
  rejectJob: (id: string) => req<{ jobId: string; status: string }>(`/api/templates/jobs/${id}/reject`, { method: "POST" }),
  retryJob: (id: string) => req<{ jobId: string; retryOf: string }>(`/api/templates/jobs/${id}/retry`, { method: "POST" }),
  cancelJob: (id: string) => req<{ ok: boolean; jobId: string; status: string }>(`/api/tasks/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  intent: (text: string) => req<{ source: string; templateId: string | null; inputs: Record<string, any> }>("/api/templates/intent", { method: "POST", body: JSON.stringify({ text }) }),
  brainHealth: () => req<{ ok: boolean; vaultPath: string; exists: boolean; gitRepo: boolean; reason?: string }>("/api/brain/health"),
  brainTree: (path = "") => req<{ path: string; entries: { name: string; path: string; type: "dir" | "file" }[] }>(`/api/brain/tree?path=${encodeURIComponent(path)}`),
  brainFile: (path: string) => req<{ path: string; content: string }>(`/api/brain/file?path=${encodeURIComponent(path)}`),
  // Relative URL — downloads through the Vite proxy (same-origin). Works for text + binary.
  brainDownloadUrl: (path: string) => `/api/brain/download?path=${encodeURIComponent(path)}`,
  brainSearch: (q: string) => req<{ q: string; results: { path: string; line: number; preview: string }[] }>(`/api/brain/search?q=${encodeURIComponent(q)}`),
  brainGraph: () => req<{ nodes: { id: string; label: string; group: string; kind: "note" | "tag" }[]; links: { source: string; target: string }[]; docCount: number }>("/api/brain/graph"),
  brainHistory: (path: string, opts?: { limit?: number; before?: string }) => {
    const params = new URLSearchParams({ path });
    if (opts?.limit != null) params.set("limit", String(opts.limit));
    if (opts?.before) params.set("before", opts.before);
    return req<{ path: string; versions: { commitHash: string; commitDate: string; author: string; commitMessage: string }[]; hasMore: boolean }>(`/api/brain/history?${params.toString()}`);
  },
  brainDiff: (path: string, from: string, to = "WORKING") =>
    req<{ path: string; from: string; to: string; before: string | null; after: string | null }>(
      `/api/brain/diff?path=${encodeURIComponent(path)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  storageStatus: () => req<{ backends: { id: "local" | "obsidian" | "github" | "drive" | "supabase"; label: string; configured: boolean; reachable: boolean; detail: string }[] }>("/api/storage/status"),
  hostToolsSettings: () => req<{ settings: HostToolsSettings }>("/api/host-tools/settings"),
  updateHostToolsSettings: (patch: Partial<HostToolsSettings>) =>
    req<{ settings: HostToolsSettings }>("/api/host-tools/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  daemonSettings: () => req<{ settings: DaemonSettings }>("/api/daemon-settings/settings"),
  updateDaemonSettings: (patch: Partial<DaemonSettings>) =>
    req<{ settings: DaemonSettings }>("/api/daemon-settings/settings", { method: "PATCH", body: JSON.stringify(patch) }),
  launchHermesAgent: () => req<{ result: string }>("/api/host-tools/hermes/launch", { method: "POST" }),
  // Operator onboarding wizard — Naxie's identity/profile of the operator.
  onboardingSectors: () => req<{ sectors: OnboardingSector[] }>("/api/onboarding/sectors"),
  onboardingState: () => req<{ state: OnboardingState; operator: OperatorIdentity }>("/api/onboarding/state"),
  completeOnboarding: (body: {
    name: string; email?: string; title?: string; orgName?: string;
    sector?: string; customSectorName?: string; responseStyle?: "standard" | "caveman";
    priorities?: string; communicationStyle?: string; notes?: string;
  }) => req<{ ok: true; state: OnboardingState; operator: OperatorIdentity }>("/api/onboarding/complete", { method: "POST", body: JSON.stringify(body) }),
  applyOnboardingBundle: (sectorId: string) =>
    req<{ ok: true; result: SectorBundleResult }>("/api/onboarding/apply-bundle", { method: "POST", body: JSON.stringify({ sectorId }) }),
  orgTasks: (filter?: { role?: OrgRole; status?: OrgTaskStatus; priority?: OrgTaskPriority }) => {
    const q = new URLSearchParams();
    if (filter?.role) q.set("role", filter.role);
    if (filter?.status) q.set("status", filter.status);
    if (filter?.priority) q.set("priority", filter.priority);
    const qs = q.toString();
    return req<{ tasks: OrgTask[] }>(`/api/org-tasks${qs ? `?${qs}` : ""}`);
  },
  resolveOrgTaskApproval: (id: string, approved: boolean) =>
    req<{ task: OrgTask; outcome?: { ok: boolean; message: string } }>(`/api/org-tasks/${encodeURIComponent(id)}/resolve`, { method: "PATCH", body: JSON.stringify({ approved }) }),
  brainLatestDigest: () => req<{ content: string }>("/api/brain/digest/latest"),
  brainPromote: (path: string, opts?: { title?: string; tags?: string; keepOriginal?: boolean }) => req<{ promoted: true; from: string; to: string; archived: boolean }>("/api/brain/promote", { method: "POST", body: JSON.stringify({ path, ...opts }) }),
  brainDiscard: (path: string) => req<{ deleted: string[]; count: number }>("/api/brain/discard", { method: "POST", body: JSON.stringify({ path }) }),
  brainProcessImports: (folder = "_imports") => req<{ jobId: string }>("/api/brain/process-imports", { method: "POST", body: JSON.stringify({ folder }) }),
  vaultStats: () => req<{ lastCommit: any; totalCommits: number; coalescedSavings: number; pendingWrites: number; inFlight: boolean; debounceMs: number }>("/api/status/vault"),
  llmStatus: () => req<{
    ollama: { ok: boolean; model: string; error?: string };
    openrouter: { enabled: boolean; ok: boolean; model: string; error?: string };
    primary: "ollama" | "openrouter";
  }>("/api/status/llm"),
  vaultRetryPush: () => req<{ pushed: boolean; error?: string; aheadBy?: number }>("/api/status/vault/retry-push", { method: "POST" }),
  vaultClearLock: (force = false) => req<{ cleared: boolean; reason?: string; ageMs?: number; forced?: boolean }>(`/api/status/vault/clear-lock${force ? "?force=1" : ""}`, { method: "POST" }),
  listReflections: () => req<{ reflections: { date: string; path: string; preview: string; stats?: any }[]; last?: any; nextFireAt?: number | null }>("/api/reflection"),
  runReflection: (windowHours = 24) => req<{ date: string; path: string; stats: any; reflection: string; generatedAt: string; modelUsed?: string }>("/api/reflection/run", { method: "POST", body: JSON.stringify({ windowHours }) }),
  getReflection: (date: string) => req<{ date: string; path: string; body: string }>(`/api/reflection/${encodeURIComponent(date)}`),
  listInnovationScans: () => req<{ scans: { date: string; path: string; preview: string; stats?: any }[]; last?: any; nextFireAt?: number | null }>("/api/innovation-scan"),
  runInnovationScan: (force = false) => req<{ date: string; path: string; targeted: any; broad: any; digest: string; generatedAt: string; modelUsed?: string }>("/api/innovation-scan/run", { method: "POST", body: JSON.stringify({ force }) }),
  getInnovationScan: (date: string) => req<{ date: string; path: string; body: string }>(`/api/innovation-scan/${encodeURIComponent(date)}`),
  // Daily Rhythm — the two daemons with no other HTTP surface of their own.
  getTodoBriefStatus: () => req<{ last: any; nextFireAt: number | null }>("/api/todo-brief"),
  getWeeklyRollupStatus: () => req<{ last: any; nextFireAt: number | null }>("/api/weekly-rollup"),
  // Weekly self-improvement review ("Weekly Reflect") — proposals land in Agent Approvals.
  getWeeklyImprovementStatus: () => req<WeeklyImprovementStatus>("/api/weekly-improvement"),
  runWeeklyImprovement: () => req<{ date: string; path: string; proposals: number; taskIds: string[]; modelUsed?: string; parseFailed: boolean }>("/api/weekly-improvement/run", { method: "POST", body: JSON.stringify({}) }),
  // Offline mode — header "Go offline" switch (local + LAN only).
  offlineMode: () => req<OfflineModeState>("/api/offline-mode"),
  setOfflineMode: (offline: boolean) => req<OfflineModeState>("/api/offline-mode", { method: "POST", body: JSON.stringify({ offline }) }),
  listSystemAudits: () => req<{ audits: { date: string; path: string; preview: string; stats?: any }[]; last?: any; inventory: any }>("/api/system-audit"),
  runSystemAudit: () => req<{ date: string; path: string; stats: any; report: string; generatedAt: string; modelUsed?: string }>("/api/system-audit/run", { method: "POST", body: JSON.stringify({}) }),
  getSystemAudit: (date: string) => req<{ date: string; path: string; body: string }>(`/api/system-audit/${encodeURIComponent(date)}`),
  systemAuditInventory: () => req<{ inventory: { pages: number; routes: number; lib: number; templates: number; personas: number } }>("/api/system-audit/inventory"),
  systemAuditHealthTrend: () => req<{ trend: { date: string; healthScore: number }[] }>("/api/system-audit/health-trend"),
  systemAuditVaultHygiene: () => req<{ duplicates: { hash: string; files: string[] }[]; staleNotes: { path: string; daysOld: number }[]; totalNotes: number }>("/api/system-audit/vault-hygiene"),
  systemAuditDeadCode: () => req<{ deadCode: { file: string; reason: string }[] }>("/api/system-audit/dead-code"),
  systemAuditPersonaMerges: () => req<{ merges: { a: string; b: string; similarity: number; reason: string }[] }>("/api/system-audit/persona-merges"),
  systemAuditIntegrationHealth: () => req<{ health: { id: string; label: string; ok: boolean; detail: string }[] }>("/api/system-audit/integration-health"),
  systemAuditVoiceBriefing: () => req<{ ok: boolean; text?: string; error?: string }>("/api/system-audit/voice-briefing", { method: "POST", body: JSON.stringify({}) }),
  systemAuditArchitectPr: (finding: string) => req<{ created: boolean; taskId?: string; reason?: string; finding: string }>("/api/system-audit/architect-pr", { method: "POST", body: JSON.stringify({ finding }) }),
  triggerDigest: (lookbackDays = 7) => req<{ jobId: string }>("/api/tasks/digest", { method: "POST", body: JSON.stringify({ lookbackDays: String(lookbackDays) }) }),
  chat: (messages: { role: "user" | "assistant" | "system"; content: string }[], opts?: {
    attachments?: { contextId: string }[];
    persona?: string;
    continuesTaskRef?: { originalText: string; originalJobId?: string; summary?: string };
  }) => req<{
    kind: "message" | "task";
    text: string;
    jobId?: string;
    templateId?: string;
    requiresApproval?: boolean;
    brainHits?: { path: string; line: number; preview: string }[];
    handledBy?: { personaId: string; personaName: string; role?: string } | null;
    activePersona?: { id: string; name: string; role: string } | null;
    personaAutoRouted?: { personaId: string | null; score: number; matched: string[] } | null;
    needsContext?: boolean;
    clarification?: {
      originalText: string;
      summary?: string;
      missing?: { name: string; label: string }[];
      templateId?: string;
      intent?: string;
      followUpKind?: string;
      ambiguityKind?: string;
    };
  }>("/api/chat", { method: "POST", body: JSON.stringify({
    messages,
    ...(opts?.attachments ? { attachments: opts.attachments } : {}),
    ...(opts?.persona ? { persona: opts.persona } : {}),
    ...(opts?.continuesTaskRef ? { continuesTaskRef: opts.continuesTaskRef } : {}),
  }) }),
  // Board Meeting — LLM council (opinions → anonymized peer review → chairman synthesis).
  startBoard: (body: { topic: string; personaIds?: string[] }) =>
    req<{ runId: string; jobId: string; roster: { personaId: string; name: string; role: string }[] }>("/api/board", { method: "POST", body: JSON.stringify(body) }),
  listBoards: () => req<{ runs: BoardRun[] }>("/api/board"),
  getBoard: (id: string) => req<{ run: BoardRun }>(`/api/board/${encodeURIComponent(id)}`),
  correctBoard: (id: string, body: { targetPersonaId?: string; note: string }) =>
    req<{ run: BoardRun }>(`/api/board/${encodeURIComponent(id)}/correct`, { method: "POST", body: JSON.stringify(body) }),
  // Workforce contact book — AI agents + human team, grouped by department.
  getWorkforce: () => req<{ departments: WorkforceDepartment[]; counts: { agents: number; people: number; departments: number } }>("/api/workforce"),
  // Scan an uploaded doc (any type) for people and populate the contact book.
  importContacts: (body: { filename: string; contentBase64: string }) =>
    req<{ scanned: number; added: { name: string; email: string; department?: string }[]; skipped: { name: string; reason: string }[] }>("/api/workforce/import", { method: "POST", body: JSON.stringify(body) }),
  upload: (body: { filename: string; contentBase64: string; target: "context" | "vault"; vaultFolder?: string; mimeType?: string; ttlSeconds?: number }) => req<{
    ok: true;
    target: "context" | "vault";
    contextId?: string;
    filename?: string;
    bytes: number;
    vaultPath?: string;
    hasExtractedText?: boolean;
    extractedChars?: number;
    extractError?: string;
    ttlSeconds?: number;
    message?: string;
  }>("/api/uploads", { method: "POST", body: JSON.stringify(body) }),
  saveSession: (sessionId: string, messages: { role: string; content: string; jobId?: string }[]) => req<{ saved: true; path: string; sessionId: string }>("/api/chat/save-session", { method: "POST", body: JSON.stringify({ sessionId, messages }) }),
  listPersonas: () => req<{ personas: any[]; activeId: string | null; active: any }>("/api/personas"),
  activatePersona: (id: string | "default") => req<{ active: any }>(`/api/personas/${id}/activate`, { method: "POST" }),
  deactivatePersona: () => req<{ active: null }>("/api/personas/deactivate", { method: "POST" }),
  deletePersona: (id: string) => req<{ deleted: true; removedTemplates?: number }>(`/api/personas/${id}`, { method: "DELETE" }),
  refreshPersonaTemplates: (id: string) => req<{ persona: string; kept: number; added: number; removed: number; ids: string[] }>(`/api/personas/${id}/refresh-templates`, { method: "POST" }),
  listPersonaTemplates: (id: string) => req<{ templates: any[] }>(`/api/personas/${id}/templates`),
  peers: () => req<{ self: any; peers: any[]; registry?: any[] }>("/api/peers"),
  getFeedback: (jobId: string) => req<{ feedback: { rating: "up" | "down"; note?: string; ts: string } | null }>(`/api/feedback?jobId=${encodeURIComponent(jobId)}`),
  postFeedback: (body: { jobId: string; rating: "up" | "down"; note?: string; persona?: string; template?: string; score?: number }) => req<{ ok: true; path: string }>("/api/feedback", { method: "POST", body: JSON.stringify(body) }),
  retryFromFeedback: (jobId: string, note?: string) => req<{ newJobId: string; originalJobId: string }>("/api/feedback/retry", { method: "POST", body: JSON.stringify({ jobId, ...(note ? { note } : {}) }) }),
  calendarActivity: (from?: string, to?: string) => req<{ from: string; to: string; days: { date: string; jobs: { id: string; kind: string; template?: string; title?: string; personaName?: string; status: string; startedAt: string; finishedAt?: string; durationSec?: number; scoreOrNull?: number | null }[] }[] }>(`/api/calendar/activity${from || to ? "?" + new URLSearchParams({ ...(from ? { from } : {}), ...(to ? { to } : {}) }).toString() : ""}`),
  calendarAgenda: (date: string) => req<{ date: string; activity: any[]; meetings: { summary: string; start: string; end?: string; location?: string }[]; meetingsError?: string; schedules: any[] }>(`/api/calendar/agenda?date=${encodeURIComponent(date)}`),
  brainSave: (path: string, content: string) => req<{ ok: true; path: string; bytes: number }>("/api/brain/file", { method: "POST", body: JSON.stringify({ path, content }) }),
  brainEnsureSidecar: (path: string, force = false) => req<{ ok: true; sidecarPath: string; sourcePath: string; regenerated: boolean; reason?: string; bytes?: number }>("/api/brain/ensure-sidecar", { method: "POST", body: JSON.stringify({ path, force }) }),

  listDataSources: () => req<{ sources: DataSource[] }>("/api/data-sources"),
  addDataSource: (body: { label: string; kind: DataSourceKind; connection: string; notes?: string; department?: string; readonly: boolean }) =>
    req<{ source: DataSource }>("/api/data-sources", { method: "POST", body: JSON.stringify(body) }),
  // Department-specific company data.
  listDepartmentData: (department?: string) =>
    req<{ departments: { department: string; count: number }[]; data: DepartmentDatum[] }>(`/api/data-sources/departments${department ? `?department=${encodeURIComponent(department)}` : ""}`),
  addDepartmentDatum: (body: { department: string; title: string; content: string }) =>
    req<{ datum: DepartmentDatum }>("/api/data-sources/departments", { method: "POST", body: JSON.stringify(body) }),
  updateDepartmentDatum: (id: string, patch: { department?: string; title?: string; content?: string }) =>
    req<{ datum: DepartmentDatum }>(`/api/data-sources/departments/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeDepartmentDatum: (id: string) => req<{ ok: true }>(`/api/data-sources/departments/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // Scan an uploaded doc (any type) for department facts and populate the page.
  importDepartmentData: (body: { filename: string; contentBase64: string; department?: string }) =>
    req<{ scanned: number; added: DepartmentDatum[] }>("/api/data-sources/departments/import", { method: "POST", body: JSON.stringify(body) }),
  removeDataSource: (id: string) => req<{ ok: true }>(`/api/data-sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testDataSource: (id: string) => req<{ ok: boolean; rowCount?: number; error?: string }>(`/api/data-sources/${encodeURIComponent(id)}/test`, { method: "POST" }),
  queryDataSource: (id: string, sql: string, limit?: number) => req<{ rows: any[]; columns: string[]; rowCount: number; truncated: boolean }>(`/api/data-sources/${encodeURIComponent(id)}/query`, { method: "POST", body: JSON.stringify({ sql, ...(limit ? { limit } : {}) }) }),
  describeDataSource: (id: string) => req<{ tables: { name: string; columns: { name: string; type: string }[] }[] }>(`/api/data-sources/${encodeURIComponent(id)}/schema`),
  listCompanyFiles: () => req<{ entries: { name: string; path: string; type: "dir" | "file" }[]; note?: string }>("/api/data-sources/company-files"),

  // Files explorer — unified file manager across the vault, a sandboxed
  // local-disk folder, and (once connected) Google Drive / Supabase.
  filesBackends: () => req<{ backends: FileBackendInfo[] }>("/api/files/backends"),
  filesList: (backend: FileBackendId, path = "") => req<{ backend: string; path: string; entries: FileEntry[] }>(`/api/files/list?backend=${backend}&path=${encodeURIComponent(path)}`),
  // Data lineage for Library's hover tooltip — last commit that touched one
  // file. Vault-only; lazy/on-demand, never bulk-fetched for a whole folder.
  filesLineage: (backend: FileBackendId, path: string) =>
    req<{ lineage: { commitHash: string; commitDate: string; commitMessage: string } | null }>(`/api/files/lineage?backend=${backend}&path=${encodeURIComponent(path)}`),
  // Branch + dirty-file count for the IDE page's toolbar strip.
  filesGitStatus: (backend: FileBackendId) =>
    req<{ isRepo: boolean; branch?: string; dirtyCount?: number }>(`/api/files/git-status?backend=${backend}`),
  filesMkdir: (backend: FileBackendId, path: string) => req<{ ok: true }>("/api/files/mkdir", { method: "POST", body: JSON.stringify({ backend, path }) }),
  filesMove: (backend: FileBackendId, from: string, to: string) => req<{ ok: true }>("/api/files/move", { method: "POST", body: JSON.stringify({ backend, from, to }) }),
  filesTransfer: (srcBackend: FileBackendId, srcPath: string, dstBackend: FileBackendId, dstPath: string) =>
    req<{ ok: true }>("/api/files/transfer", { method: "POST", body: JSON.stringify({ srcBackend, srcPath, dstBackend, dstPath }) }),
  filesDelete: (backend: FileBackendId, path: string) => req<{ ok: true }>("/api/files/delete", { method: "POST", body: JSON.stringify({ backend, path }) }),
  filesUpload: (body: { backend: FileBackendId; path: string; filename: string; contentBase64: string }) =>
    req<{ ok: true; path: string }>("/api/files/upload", { method: "POST", body: JSON.stringify(body) }),
  filesDownloadUrl: (backend: FileBackendId, path: string) => `/api/files/download?backend=${backend}&path=${encodeURIComponent(path)}`,
  registerPeer: (url: string) => req<{ added: boolean; url: string }>("/api/peers/register", { method: "POST", body: JSON.stringify({ url }) }),
  deregisterPeer: (url: string) => req<{ removed: boolean }>(`/api/peers/register?url=${encodeURIComponent(url)}`, { method: "DELETE" }),
  discoverPeers: () => req<{ found: number; tried: number }>("/api/peers/discover", { method: "POST" }),
  workerStatus: () => req<{ running: boolean; managed: boolean; url?: string; port?: number; pid?: number; uptimeMs?: number }>("/api/peers/worker"),
  startWorker: () => req<{ url: string; spawned: boolean; status: any }>("/api/peers/worker/start", { method: "POST" }),
  stopWorker: () => req<{ stopped: true; status: any }>("/api/peers/worker/stop", { method: "POST" }),
  listModels: () => req<{
    default: string;
    effort: "auto" | "low" | "high";
    models: { name: string; family: string; paramSize?: string; sizeGB?: number; capabilities: { jsonStrict: number; reasoning: number; longForm: number; speed: number; cost: number } }[];
    recommendations: Record<string, string>;
    profiles: Record<string, Record<string, number>>;
  }>("/api/models"),
  setDefaultModel: (name: string) => req<{ default: string; previous: string; ephemeral: boolean; hint: string }>("/api/models/default", { method: "POST", body: JSON.stringify({ name }) }),
  setEffort: (mode: "auto" | "low" | "high") => req<{ effort: string; previous: string }>("/api/models/effort", { method: "POST", body: JSON.stringify({ mode }) }),
  modelCatalog: () => req<{ catalog: { name: string; size: string; blurb: string; installed: boolean }[] }>("/api/models/catalog"),
  deleteModel: (name: string) => req<{ ok: true; removed: string }>(`/api/models/installed/${encodeURIComponent(name)}`, { method: "DELETE" }),
  // Bring-your-own model providers (cloud APIs the user already uses).
  listModelProviders: () => req<{
    providers: { id: string; label: string; kind: string; baseUrl: string; model: string; active: boolean; keyPrefix: string; createdAt: string }[];
    kinds: Record<string, { label: string; baseUrl: string; modelHint: string }>;
    active: { model: string; baseUrl: string } | null;
  }>("/api/models/providers"),
  addModelProvider: (body: { kind: string; model: string; apiKey: string; label?: string; baseUrl?: string; active?: boolean }) =>
    req<{ provider: any }>("/api/models/providers", { method: "POST", body: JSON.stringify(body) }),
  activateModelProvider: (id: string) => req<{ provider: any }>(`/api/models/providers/${encodeURIComponent(id)}/activate`, { method: "POST" }),
  removeModelProvider: (id: string) => req<{ ok: true }>(`/api/models/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  // Model spend policy — free-tier models are used by default; paid models
  // stay off until explicitly approved here.
  getModelPolicy: () => req<{ policy: { allowPaidModels: boolean } }>("/api/models/policy"),
  setModelPolicy: (allowPaidModels: boolean) => req<{ policy: { allowPaidModels: boolean } }>("/api/models/policy", { method: "POST", body: JSON.stringify({ allowPaidModels }) }),
  // Model roster — offline (local) / online free / online paid, with usage stats.
  getModelRoster: () => req<{
    policy: { allowPaidModels: boolean };
    offline: RosterRow[];
    online: RosterRow[];
  }>("/api/models/roster"),
  // Open a live event stream for a running job. Returns the
  // EventSource so the caller can attach onmessage / onclose handlers
  // and close() when the consumer unmounts. Use this for streaming
  // long jobs (chat tasks, digest runs) into the UI without polling.
  jobStream: (id: string): EventSource => new EventSource(`/api/tasks/jobs/${encodeURIComponent(id)}/stream`),
  listSkills: () => req<{
    count: number;
    skills: { name: string; description: string; source: "builtin" | "user" | "remote"; applies_to: string[]; bodyChars: number }[];
    issues: { file: string; source: "builtin" | "user" | "remote"; error: string }[];
  }>("/api/skills"),
  getSkill: (name: string) => req<{
    name: string;
    description: string;
    source: "builtin" | "user" | "remote";
    applies_to: string[];
    path: string;
    body: string;
  }>(`/api/skills/${encodeURIComponent(name)}`),
  listGovernance: () => req<{ policies: GovernancePolicy[]; prefixBytes: number; prefixActive: boolean }>("/api/governance"),
  getGovernance: (name: string) => req<{ name: string; path: string; body: string }>(`/api/governance/${encodeURIComponent(name)}`),
  deleteGovernance: (name: string) => req<{ ok: true; deleted: string }>(`/api/governance/${encodeURIComponent(name)}`, { method: "DELETE" }),
  invalidateGovernance: () => req<{ ok: true }>("/api/governance/invalidate", { method: "POST" }),
  // Relative URL — the browser downloads it through the Vite proxy (same-origin).
  governanceDownloadUrl: (name: string) => `/api/governance/${encodeURIComponent(name)}/download`,
  // Constraint extraction & review.
  getConstraints: (policy?: string) => req<{ constraints: ExtractedConstraint[]; byPolicy: Record<string, ExtractedConstraint[]> }>(
    `/api/governance/constraints${policy ? `?policy=${encodeURIComponent(policy)}` : ""}`),
  extractConstraints: (name: string) => req<{ policyName: string; constraints: ExtractedConstraint[]; count: number }>(
    `/api/governance/${encodeURIComponent(name)}/extract`, { method: "POST" }),
  updateConstraint: (name: string, constraintId: string, patch: Partial<ExtractedConstraint>) =>
    req<{ constraint: ExtractedConstraint }>(`/api/governance/${encodeURIComponent(name)}/constraints/${encodeURIComponent(constraintId)}`, { method: "PUT", body: JSON.stringify(patch) }),
  checkAction: (action: string, policy?: string) => req<{ action: string; violations: any[]; constrained: boolean; summary: string }>(
    "/api/governance/check-action", { method: "POST", body: JSON.stringify({ action, policy }) }),
  // Department listing — Office.tsx reads this for room names/colors; Naxie
  // owns hiring/apply decisions, so there's no client-side apply/create/delete.
  listDepartments: () => req<{ departments: any[] }>("/api/departments"),
  listSchedules: () => req<{ schedules: Schedule[] }>("/api/schedules"),
  // Either `templateId` (run an existing template) or `task` (free text —
  // the server auto-creates a hidden one-off custom template from it, the
  // Calendar popup's "just type a task" flow) is required, not both.
  createSchedule: (body: {
    name: string;
    templateId?: string;
    task?: string;
    inputs?: Record<string, unknown>;
    cadence: Cadence;
    enabled?: boolean;
    deliver?: ScheduleDelivery;
    requireApproval?: boolean;
    chainTo?: string[];
  }) => req<{ schedule: Schedule }>("/api/schedules", { method: "POST", body: JSON.stringify(body) }),
  updateSchedule: (id: string, patch: Partial<Pick<Schedule, "name" | "templateId" | "inputs" | "cadence" | "enabled" | "deliver" | "requireApproval" | "chainTo">>) =>
    req<{ schedule: Schedule }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchedule: (id: string) => req<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // Office dashboard — manual, per-department stat lines (not computed).
  listOfficeNotes: () => req<{ notes: Record<string, string[]> }>("/api/office-notes"),
  setOfficeNotes: (departmentId: string, lines: string[]) =>
    req<{ departmentId: string; lines: string[] }>(`/api/office-notes/${encodeURIComponent(departmentId)}`, { method: "PUT", body: JSON.stringify({ lines }) }),

  integrationsCatalog: () => req<{ providers: IntegrationProvider[] }>("/api/integrations/catalog"),
  listIntegrations: () => req<{ connections: IntegrationConnection[] }>("/api/integrations"),
  addIntegration: (providerId: string, label: string, values: Record<string, string>, expiresAt?: string) =>
    req<{ connection: IntegrationConnection }>("/api/integrations", { method: "POST", body: JSON.stringify({ providerId, label, values, ...(expiresAt ? { expiresAt } : {}) }) }),
  testIntegration: (id: string) => req<{ ok: boolean; detail: string }>(`/api/integrations/${encodeURIComponent(id)}/test`, { method: "POST" }),
  testAllIntegrations: () => req<{ results: { id: string; ok: boolean; detail: string }[] }>("/api/integrations/test-all", { method: "POST" }),
  removeIntegration: (id: string) => req<{ ok: true }>(`/api/integrations/${encodeURIComponent(id)}`, { method: "DELETE" }),
  rotateIntegration: (id: string, values: Record<string, string>, expiresAt?: string) => req<{ connection: IntegrationConnection }>(`/api/integrations/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ values, ...(expiresAt ? { expiresAt } : {}) }) }),
  setIntegrationExpiry: (id: string, expiresAt: string | null) => req<{ connection: IntegrationConnection }>(`/api/integrations/${encodeURIComponent(id)}/expiry`, { method: "PATCH", body: JSON.stringify({ expiresAt }) }),
  setIntegrationRoles: (id: string, allowedRoles: string[]) => req<{ connection: IntegrationConnection }>(`/api/integrations/${encodeURIComponent(id)}/roles`, { method: "PATCH", body: JSON.stringify({ allowedRoles }) }),
  // Plan-approval: draft a plan for a task and park it for human sign-off.
  planTask: (task: string) => req<{ jobId: string; status: string }>("/api/tasks/plan", { method: "POST", body: JSON.stringify({ task }) }),
  // Employee voices — report Q&A + TTS tiers (realtime / local sidecar / browser).
  voiceStatus: () => req<{ realtime: boolean; openaiTts: boolean; localTts: boolean; realtimeModel: string; ttsUrlConfigured: boolean }>("/api/voice/status"),
  voiceAsk: (jobId: string, question: string, personaId?: string, history?: { q: string; a: string }[]) =>
    req<{ text: string; personaName: string }>("/api/voice/ask", { method: "POST", body: JSON.stringify({ jobId, question, personaId, history }) }),
  // Lightweight daemon nudge probe — pending approvals, latest briefing,
  // memory (CAG) freshness, voice/connectivity, ambient-daemon cycle time.
  naxieStatus: () => req<{
    pendingApprovals: number;
    waiting: any[];
    voice: { realtime: boolean; openaiTts: boolean; localTts: boolean };
    connectivity: { cached: boolean | null; online: boolean | null };
    cag: { built: boolean; hash?: string; ageMs: number };
    briefing: any;
    onboardingNeeded: boolean;
    daemonStatus: { cycleSeconds: number };
  }>("/api/naxie/status"),
  // Naxie's general conversation — PA master. Routes through the real
  // agent/tool loop (a Job), so this returns {jobId} immediately; the caller
  // watches it via jobStream(jobId) (falling back to polling getJob) for the
  // live step feed and the final answer. A "delegate" intent still short-
  // circuits instantly with no job at all.
  voiceConverse: (messages: { role: "user" | "assistant"; content: string }[]) =>
    req<{ jobId?: string; text?: string; delegated?: { taskId: string; role: string } }>("/api/voice/converse", { method: "POST", body: JSON.stringify({ messages }) }),
  voiceTts: async (text: string, personaId?: string): Promise<Blob> => {
    const token = getToken();
    const r = await fetch("/api/voice/tts", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify({ text, personaId }),
    });
    if (!r.ok) throw new Error(`tts ${r.status}`);
    return r.blob();
  },
  // Step 1 of streamed TTS playback — POST the text, get back a one-time GET
  // URL an <audio> element can point its `src` at directly (see
  // useNaxieAssistant.ts's speak()). The GET itself isn't fetched through
  // this client — the browser streams it natively via the audio element.
  voiceTtsToken: (text: string, personaId?: string) =>
    req<{ streamUrl: string }>("/api/voice/tts/token", { method: "POST", body: JSON.stringify({ text, personaId }) }),
  // jobId is optional — omit it for a live call with Naxie herself (no
  // report to ground in), pass it for a report-discussion call (unchanged
  // VoiceDiscussion.tsx behavior).
  voiceRealtimeSession: (jobId?: string, personaId?: string) =>
    req<{ clientSecret: string; expiresAt?: number; model: string; voice: string; personaName: string; baseUrl: string }>("/api/voice/realtime-session", { method: "POST", body: JSON.stringify({ jobId, personaId }) }),
  // Report realtime token usage (read off the call's data channel) so live-call
  // spend lands in the Cost monitor — the server can't observe WebRTC traffic.
  voiceReportUsage: (model: string, inputTokens: number, outputTokens: number) =>
    req<{ ok: boolean; recorded: boolean; costUsd?: number }>("/api/voice/usage", { method: "POST", body: JSON.stringify({ model, inputTokens, outputTokens }) }),
  terminalStatus: () => req<{ enabled: boolean; cwd: string; shell: "powershell" | "bash"; platform: string; hint?: string }>("/api/terminal/status"),
  terminalExec: (command: string, cwd?: string) => req<{
    ok: true;
    command: string;
    exitCode: number | null;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    cwd: string;
    elapsedMs: number;
  }>("/api/terminal/exec", { method: "POST", body: JSON.stringify({ command, ...(cwd ? { cwd } : {}) }) }),

  // Company-system connectors (outbound authenticated HTTP to existing systems).
  connectorsCatalog: () => req<{ authTypes: ConnectorAuthCatalog[] }>("/api/connectors/catalog"),
  connectorTemplates: () => req<{ templates: ConnectorTemplate[] }>("/api/connectors/templates"),
  listConnectors: () => req<{ connectors: Connector[] }>("/api/connectors"),
  getConnector: (id: string) => req<{ connector: Connector }>(`/api/connectors/${encodeURIComponent(id)}`),
  addConnector: (body: ConnectorInput & { keyExpiresAt?: string; allowedRoles?: string[] }) => req<{ connector: Connector }>("/api/connectors", { method: "POST", body: JSON.stringify(body) }),
  updateConnector: (id: string, body: Partial<ConnectorInput>) =>
    req<{ connector: Connector }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(body) }),
  removeConnector: (id: string) => req<{ ok: true }>(`/api/connectors/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testConnector: (id: string) => req<{ ok: boolean; detail: string }>(`/api/connectors/${encodeURIComponent(id)}/test`, { method: "POST" }),
  setConnectorExpiry: (id: string, keyExpiresAt: string | null) => req<{ connector: Connector }>(`/api/connectors/${encodeURIComponent(id)}/expiry`, { method: "PATCH", body: JSON.stringify({ keyExpiresAt }) }),
  setConnectorRoles: (id: string, allowedRoles: string[]) => req<{ connector: Connector }>(`/api/connectors/${encodeURIComponent(id)}/roles`, { method: "PATCH", body: JSON.stringify({ allowedRoles }) }),
  rotateConnector: (id: string, values: Record<string, string>, expiresAt?: string) => req<{ connector: Connector }>(`/api/connectors/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ values, ...(expiresAt ? { expiresAt } : {}) }) }),
  callConnector: (id: string, body: { method?: string; path: string; query?: Record<string, any>; body?: any; headers?: Record<string, string> }) =>
    req<{ result: ConnectorCallResult }>(`/api/connectors/${encodeURIComponent(id)}/call`, { method: "POST", body: JSON.stringify(body) }),
  startConnectorOAuth: (id: string) =>
    req<{ flowId: string; userCode: string; verificationUri: string; message: string; expiresIn: number; interval: number }>(
      `/api/connectors/${encodeURIComponent(id)}/oauth/start`, { method: "POST" }),
  pollConnectorOAuth: (id: string, flowId: string) =>
    req<{ status: "pending" | "complete" | "error" | "expired"; error?: string }>(
      `/api/connectors/${encodeURIComponent(id)}/oauth/poll`, { method: "POST", body: JSON.stringify({ flowId }) }),

  // Naxie's personal Google/Microsoft connectors (Gmail/Calendar, Outlook
  // Mail/Calendar/OneDrive read-only) — distinct from the company-system
  // connectors above. One connection slot per platform.
  naxiePlatformConnections: (platform: "google" | "microsoft") =>
    req<{ connections: PlatformConnection[] }>(`/api/connectors/${platform}`),
  naxiePlatformAuthorize: (platform: "google" | "microsoft") =>
    req<{ authorize_url: string }>(`/api/connectors/${platform}/authorize`),
  naxiePlatformDisconnect: (platform: "google" | "microsoft", id: string) =>
    req<{ status: string }>(`/api/connectors/${platform}/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // "My documents" — index a folder under the Local Files sandbox into the
  // vault/RAG knowledge base. See routes/local-folder.ts.
  localFolderStatus: () => req<{ configured: boolean; rootLabel: string | null }>("/api/local-folder/status"),
  localFolderBrowse: (subPath: string) =>
    req<{ subPath: string; entries: { name: string; isDir: boolean; size: number | null; supported: boolean }[] }>(
      `/api/local-folder/browse?subPath=${encodeURIComponent(subPath)}`,
    ),
  localFolderIngest: (body: { subPath: string; recursive?: boolean; category?: string; tags?: string[]; maxFiles?: number }) =>
    req<{ queued: number; skippedUnsupported: number; skippedOverCap: number; root: string }>(
      "/api/local-folder/ingest",
      { method: "POST", body: JSON.stringify(body) },
    ),

  // Multi-account GitHub credentials + projects (repos grouped per account,
  // watched for new commits by the github-commit-watcher engine).
  listGithubAccounts: () => req<{ accounts: GithubAccount[] }>("/api/github-accounts"),
  addGithubAccount: (label: string, token: string) => req<{ account: GithubAccount }>("/api/github-accounts", { method: "POST", body: JSON.stringify({ label, token }) }),
  updateGithubAccount: (id: string, patch: { label?: string }) => req<{ account: GithubAccount }>(`/api/github-accounts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  rotateGithubAccount: (id: string, token: string) => req<{ account: GithubAccount }>(`/api/github-accounts/${encodeURIComponent(id)}/rotate`, { method: "POST", body: JSON.stringify({ token }) }),
  removeGithubAccount: (id: string) => req<{ ok: true }>(`/api/github-accounts/${encodeURIComponent(id)}`, { method: "DELETE" }),
  listProjects: () => req<{ projects: Project[] }>("/api/projects"),
  addProject: (body: { name: string; accountId: string; repos: string[] }) => req<{ project: Project }>("/api/projects", { method: "POST", body: JSON.stringify(body) }),
  updateProject: (id: string, patch: { name?: string; accountId?: string; repos?: string[] }) => req<{ project: Project }>(`/api/projects/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeProject: (id: string) => req<{ ok: true }>(`/api/projects/${encodeURIComponent(id)}`, { method: "DELETE" }),
  githubEvents: () => req<{ events: GithubEvent[] }>("/api/projects/events"),
  schedulerStatus: () => req<{ engines: SchedulerEngine[] }>("/api/scheduler/status"),

  // Vector store (pgvector RAG) — already-running re-embed pipeline; this
  // just surfaces status and lets Supabase DB URL / OpenAI embedding key be
  // set from the UI instead of only .env.
  ragStatus: () => req<RagStatus>("/api/extensions/rag/status"),
  ragSetConfig: (patch: { supabaseDbUrl?: string; openaiEmbeddingApiKey?: string }) =>
    req<RagStatus & { ok: true }>("/api/extensions/rag/config", { method: "POST", body: JSON.stringify(patch) }),
  ragReembedNow: () => req<{ ok: boolean; error?: string; lastRun: RagStatus["lastRun"] }>("/api/extensions/rag/reembed", { method: "POST" }),

  // MCP-client servers (local child-process tool servers, e.g. from the community catalog).
  listMcpServers: () => req<{ servers: McpServer[] }>("/api/mcp-servers"),
  mcpCatalog: () => req<{ catalog: McpCatalogEntry[] }>("/api/mcp-servers/catalog"),
  addMcpServer: (body: McpServerInput) => req<{ server: McpServer }>("/api/mcp-servers", { method: "POST", body: JSON.stringify(body) }),
  removeMcpServer: (id: string) => req<{ ok: true }>(`/api/mcp-servers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  setMcpServerDisabled: (id: string, disabled: boolean) => req<{ server: McpServer }>(`/api/mcp-servers/${encodeURIComponent(id)}/disabled`, { method: "PATCH", body: JSON.stringify({ disabled }) }),
  mcpServerTools: (id: string) => req<{ tools: McpTool[] }>(`/api/mcp-servers/${encodeURIComponent(id)}/tools`),
  callMcpServer: (id: string, body: { tool: string; arguments?: Record<string, any> }) =>
    req<{ result: McpCallResult }>(`/api/mcp-servers/${encodeURIComponent(id)}/call`, { method: "POST", body: JSON.stringify(body) }),
  hermesBridgeStatus: () => req<HermesBridgeStatus>("/api/hermes-bridge/status"),
  registerHermesBridge: () => req<{ ok: boolean; alreadyRegistered: boolean; status: HermesBridgeStatus }>("/api/hermes-bridge/register", { method: "POST" }),
  whatsappStatus: () => req<WhatsAppBridgeStatus>("/api/whatsapp/status"),
  whatsappReconnect: () => req<{ ok: true }>("/api/whatsapp/reconnect", { method: "POST" }),
  getExecutor: () => req<ExecutorStatus>("/api/executor"),
  setExecutor: (body: { mode?: "clawbot" | "hermes"; hermesModel?: string | null; hermesLocal?: boolean; crosscheck?: boolean }) =>
    req<{ ok: true; mode: string; hermesModelOverride: string | null; hermesLocal: boolean; crosscheck: boolean }>("/api/executor", { method: "POST", body: JSON.stringify(body) }),
  listBrands: () => req<{ brands: Brand[] }>("/api/brands"),
  getBrand: (id: string) => req<{ brand: Brand }>(`/api/brands/${encodeURIComponent(id)}`),
  updateBrand: (id: string, patch: Partial<Omit<Brand, "id" | "createdAt" | "personaIds">>) =>
    req<{ brand: Brand }>(`/api/brands/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  addBrandChannel: (id: string, channel: BrandChannel) =>
    req<{ brand: Brand }>(`/api/brands/${encodeURIComponent(id)}/channels`, { method: "POST", body: JSON.stringify(channel) }),
  listBrandSignals: (params: { brandId?: string; status?: string } = {}) => {
    const qs = new URLSearchParams(params as Record<string, string>).toString();
    return req<{ signals: BrandSignal[] }>(`/api/brand-signals${qs ? `?${qs}` : ""}`);
  },
  validateBrandSignal: (id: string, decision: "validated" | "rejected") =>
    req<{ signal: BrandSignal }>(`/api/brand-signals/${encodeURIComponent(id)}/validate`, { method: "POST", body: JSON.stringify({ decision }) }),
  scanBrandSignals: (brandId: string) =>
    req<{ run: BrandSignalRun }>("/api/brand-signals/scan", { method: "POST", body: JSON.stringify({ brandId }) }),


  // CRM — contacts, deals/pipeline, and per-contact activity (local store, no external CRM required).
  listContacts: () => req<{ contacts: Contact[] }>("/api/crm/contacts"),
  upsertContact: (body: { email?: string; name?: string; phone?: string; company?: string; notes?: string }) =>
    req<{ contact: Contact }>("/api/crm/contacts", { method: "POST", body: JSON.stringify(body) }),
  listContactActivities: (contactId: string) => req<{ activities: CrmActivity[] }>(`/api/crm/contacts/${encodeURIComponent(contactId)}/activities`),
  addContactActivity: (contactId: string, body: { kind: CrmActivity["kind"]; body: string }) =>
    req<{ activity: CrmActivity }>(`/api/crm/contacts/${encodeURIComponent(contactId)}/activities`, { method: "POST", body: JSON.stringify(body) }),
  listPipelines: () => req<{ pipelines: Pipeline[] }>("/api/crm/pipelines"),
  listDeals: (params?: { contactId?: string; stage?: string }) =>
    req<{ deals: Deal[] }>(`/api/crm/deals${params ? `?${new URLSearchParams(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}` : ""}`),
  createDeal: (body: { contactId: string; title: string; pipelineId?: string; stage?: string; value?: number }) =>
    req<{ deal: Deal }>("/api/crm/deals", { method: "POST", body: JSON.stringify(body) }),
  moveDealStage: (dealId: string, stage: string) =>
    req<{ deal: Deal }>(`/api/crm/deals/${encodeURIComponent(dealId)}/stage`, { method: "PATCH", body: JSON.stringify({ stage }) }),

  // Personal to-do list.
  myTaskLists: () => req<{ lists: MyTaskList[] }>("/api/my-tasks/lists"),
  addMyTaskList: (name: string) => req<{ list: MyTaskList }>("/api/my-tasks/lists", { method: "POST", body: JSON.stringify({ name }) }),
  renameMyTaskList: (id: string, name: string) => req<{ list: MyTaskList }>(`/api/my-tasks/lists/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify({ name }) }),
  removeMyTaskList: (id: string) => req<{ ok: true }>(`/api/my-tasks/lists/${encodeURIComponent(id)}`, { method: "DELETE" }),
  myTaskItems: (filter?: { listId?: string; myDay?: boolean; important?: boolean; completed?: boolean }) => {
    const p = new URLSearchParams();
    if (filter?.listId) p.set("listId", filter.listId);
    if (filter?.myDay) p.set("myDay", "1");
    if (filter?.important) p.set("important", "1");
    if (filter?.completed !== undefined) p.set("completed", filter.completed ? "1" : "0");
    const qs = p.toString();
    return req<{ items: MyTaskItem[] }>(`/api/my-tasks/items${qs ? `?${qs}` : ""}`);
  },
  addMyTaskItem: (body: { listId?: string; title: string; notes?: string; dueDate?: string; reminderAt?: string; repeat?: RepeatRule | null; important?: boolean; myDay?: boolean }) =>
    req<{ item: MyTaskItem }>("/api/my-tasks/items", { method: "POST", body: JSON.stringify(body) }),
  updateMyTaskItem: (id: string, patch: Partial<{ title: string; notes: string; dueDate: string | null; reminderAt: string | null; repeat: RepeatRule | null; important: boolean; listId: string }>) =>
    req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  removeMyTaskItem: (id: string) => req<{ ok: true }>(`/api/my-tasks/items/${encodeURIComponent(id)}`, { method: "DELETE" }),
  toggleMyTaskItem: (id: string) => req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(id)}/toggle`, { method: "POST" }),
  setMyTaskItemMyDay: (id: string, on: boolean) => req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(id)}/my-day`, { method: "POST", body: JSON.stringify({ on }) }),
  addMyTaskStep: (itemId: string, title: string) => req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(itemId)}/steps`, { method: "POST", body: JSON.stringify({ title }) }),
  toggleMyTaskStep: (itemId: string, stepId: string) => req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(itemId)}/steps/${encodeURIComponent(stepId)}`, { method: "PATCH" }),
  removeMyTaskStep: (itemId: string, stepId: string) => req<{ item: MyTaskItem }>(`/api/my-tasks/items/${encodeURIComponent(itemId)}/steps/${encodeURIComponent(stepId)}`, { method: "DELETE" }),

  // Auth (identity layer) + Users directory.
  login: (email: string, password: string) =>
    req<{ ok: true; user: User; token: string }>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) })
      .then(r => { setCurrentUserId(r.user?.id ?? null); return r; }),
  logout: () => req<{ ok: true }>("/api/auth/logout", { method: "POST" })
    .then(r => { setCurrentUserId(null); return r; }),
  session: () => req<{ user: User | null }>("/api/auth/session")
    .then(r => { if (r.user?.id) setCurrentUserId(r.user.id); return r; }),
  // The caller's own chat prompts + the output each produced (My Work).
  chatHistory: (limit = 50) =>
    req<{ history: { id: string; at: string; prompt: string; response: string; kind?: string; jobId?: string; persona?: string; sessionId?: string; jobStatus?: string }[] }>(`/api/chat/history?limit=${limit}`),
  loginEvents: (limit = 50) => req<{ events: LoginEvent[] }>(`/api/auth/login-events?limit=${limit}`),
  // Omnisignal — source registry + acquire/publish.
  listOmniKinds: () => req<{ kinds: OmniSourceKindInfo[] }>("/api/omnisignal/kinds"),
  listOmniSources: () => req<{ sources: OmniSource[] }>("/api/omnisignal/sources"),
  addOmniSource: (input: Omit<OmniSource, "id" | "createdAt" | "lastAcquiredAt">) =>
    req<{ source: OmniSource }>("/api/omnisignal/sources", { method: "POST", body: JSON.stringify(input) }),
  removeOmniSource: (id: string) => req<{ ok: boolean }>(`/api/omnisignal/sources/${encodeURIComponent(id)}`, { method: "DELETE" }),
  acquireOmni: (sources: OmniSpec[]) => req<AcquireResult>("/api/omnisignal/acquire", { method: "POST", body: JSON.stringify({ sources }) }),
  publishOmniDataset: (body: { name: string; sources: OmniSpec[]; sector?: string; keyField?: string; confidenceThreshold?: number }) =>
    req<{ acquisition: AcquireResult; published?: { manifest: DatasetManifest }; note?: string }>("/api/omnisignal/publish", { method: "POST", body: JSON.stringify(body) }),
  // Published datasets (ADRS pipeline output — from Omnisignal or a direct publish).
  listDatasets: () => req<{ datasets: DatasetManifest[] }>("/api/datasets"),
  getDataset: (id: string) => req<{ dataset: DatasetManifest }>(`/api/datasets/${encodeURIComponent(id)}`),
  datasetOutputUrl: (id: string, kind: "csv" | "jsonl" | "rag" | "card") => `/api/datasets/${encodeURIComponent(id)}/output/${kind}`,
  // Quality dashboard.
  submitQualityFlag: (body: { jobId: string; rating: "up" | "down"; note?: string; category?: string; persona?: string; template?: string; score?: number }) =>
    req<{ ok: true; flag: QualityFlag }>("/api/quality/flag", { method: "POST", body: JSON.stringify(body) }),
  getQualitySummary: () => req<QualitySummary>("/api/quality/summary"),
  getQualityFlags: (since?: string) =>
    req<{ flags: QualityFlag[] }>(`/api/quality/flags${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  getLowQualityRuns: (threshold?: number, minFlags?: number) =>
    req<{ runs: { task: string; count: number; rate: number }[] }>(
      `/api/quality/low-quality?threshold=${threshold ?? 0.5}&minFlags=${minFlags ?? 3}`),
  // Feature A — learned per-axis quality signals now fed back into planning.
  getQualitySignals: () =>
    req<{ signals: { scope: "kind" | "persona"; key: string; samples: number; means: Record<string, number>; weakestAxis: string; weakestGoodness: number }[] }>(
      "/api/quality/signals"),
  // Cost monitoring.
  getCostSummary: () => req<any>("/api/cost/summary"),
  getCostRecords: (since?: string) =>
    req<{ records: any[] }>(`/api/cost/records${since ? `?since=${encodeURIComponent(since)}` : ""}`),
  // Audit log.
  queryAudit: (params?: { limit?: number; offset?: number; level?: string; actor?: string; action?: string; role?: string; since?: string; jobId?: string }) => {
    const q = new URLSearchParams();
    if (params?.limit) q.set("limit", String(params.limit));
    if (params?.offset) q.set("offset", String(params.offset));
    if (params?.level) q.set("level", params.level);
    if (params?.actor) q.set("actor", params.actor);
    if (params?.action) q.set("action", params.action);
    if (params?.role) q.set("role", params.role);
    if (params?.since) q.set("since", params.since);
    if (params?.jobId) q.set("jobId", params.jobId);
    return req<{ events: any[]; total: number }>(`/api/audit?${q.toString()}`);
  },
  // SkillForge.
  draftSkill: (intent: string, taskSample: string, failureReason?: string) =>
    req<{ skill: any; raw: string }>("/api/skill-forge/draft", { method: "POST", body: JSON.stringify({ intent, taskSample, failureReason }) }),
  saveSkill: (intent: string, raw: string) =>
    req<{ ok: boolean; path: string; skill?: any }>("/api/skill-forge/save", { method: "POST", body: JSON.stringify({ intent, raw }) }),
};

// Access layers: superadmin (money + secrets), admin (people + work), staff
// (own department's workbench). member/viewer are legacy aliases of staff.
export type UserRole = "superadmin" | "admin" | "staff" | "member" | "viewer";
export type AccessLayer = "superadmin" | "admin" | "staff";
export const layerOfRole = (role?: UserRole): AccessLayer =>
  role === "superadmin" ? "superadmin" : role === "admin" ? "admin" : "staff";
export type UserStatus = "active" | "invited" | "disabled" | "pending";
export type WorkMode = "agent" | "hybrid" | "human";
export type User = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  title?: string;
  department?: string;
  status: UserStatus;
  // Hybrid workforce: how much of this person's role the system performs.
  workMode?: WorkMode;
  // Monthly salary (ZAR) — feeds the Cost page's human-cost side. Admin-only UI.
  salaryMonthly?: number;
  // Org structure: manager's email. Drives the no-delegating-upward rule.
  reportsTo?: string;
  hasPassword: boolean;
  createdAt: string;
  lastLoginAt?: string;
  loginCount: number;
};

// A task parked in waiting_on_human — the structured ask the operator answers.
export type WaitingItem = { type: "answer" | "upload" | "approval" | "action"; prompt: string };
export type WaitingTask = {
  id: string;
  title: string;
  persona?: string;
  startedAt: string;
  waitingSince: string;
  items: WaitingItem[];
  reason?: string;
  task?: string;
};

export type TimeAnalysis = {
  days: number;
  totals: { agentMs: number; humanWaitMs: number; openWaitMs: number; humanWorkMs: number; totalMs: number; pct: { agent: number; humanWait: number; humanWork: number } };
  verdict: string;
  slowestAgentTypes: { type: string; ms: number }[];
  longestWaits: { title: string; waitMs: number; open: boolean }[];
  humanWorkHours: number;
  jobCount: number;
};

// My Work — a unit of work handed to a human (by a neuro or a colleague/boss).
export type AssignmentStatus = "open" | "in_progress" | "submitted" | "done" | "declined";
export type Assignment = {
  id: string;
  title: string;
  details?: string;
  assignedToEmail: string;
  assignedByEmail?: string;
  assignedByName: string;
  assignedByKind: "human" | "neuro";
  status: AssignmentStatus;
  dueAt?: string;
  createdAt: string;
  updatedAt: string;
  fromJobId?: string;
  attachments?: { name: string; path: string; bytes: number }[];
  submissions: { at: string; byEmail: string; text?: string; files: { name: string; path: string; bytes: number }[] }[];
};
export type AssignPerson = { name: string; email: string; title?: string; department?: string; workMode?: WorkMode; eligible: boolean; isSelf: boolean };

export type CostTrend = { days: number; series: { date: string; neuroUsd: number }[] };
export type SecurityEvent = {
  at: string; ip: string;
  kind: "scanner-probe" | "traversal" | "injection" | "auth-failure-burst" | "flood" | "blocked-request";
  path: string; severity: "low" | "medium" | "high"; detail?: string; blocked?: boolean;
};
export type SecurityStatus = { events: SecurityEvent[]; blocked: { ip: string; until: string; score: number }[]; watching: number };
export type LoginEvent = { at: string; userId?: string; email: string; name?: string; ok: boolean; reason?: string; ip?: string; userAgent?: string };

export type GithubAccount = { id: string; label: string; tokenSet: boolean; createdAt: string; lastRotatedAt?: string };
export type Project = { id: string; name: string; accountId: string; repos: string[]; lastSeenShas: Record<string, string>; createdAt: string; updatedAt: string };
export type GithubEvent = { at: string; projectId: string; projectName: string; repo: string; sha: string; message: string; author: string; url: string };
export type SchedulerEngine = { name: string; intervalSeconds: number; lastRunAt?: string; lastError?: string };

export type RagStatus = {
  pgvectorEnabled: boolean;
  openaiEmbeddingEnabled: boolean;
  connected: boolean;
  lastRun: { at: number; chunks: number; ok: boolean; error?: string } | null;
  pending: boolean;
  running: boolean;
  overrides: { supabaseDbUrlOverridden: boolean; openaiEmbeddingApiKeyOverridden: boolean };
};

export type ConnectorAuthType = "none" | "apiKey" | "bearer" | "basic" | "header" | "oauth2";
export type ConnectorAuthCatalog = { type: ConnectorAuthType; label: string; fields: { name: string; label: string; secret: boolean }[] };
export type ConnectorEndpoint = { name: string; method: string; path: string; description?: string; query?: string[]; body?: string };
export type Connector = {
  id: string;
  label: string;
  baseUrl: string;
  description?: string;
  auth: {
    type: ConnectorAuthType; in?: "header" | "query"; name?: string; username?: string; secretSet: boolean;
    tenant?: string; clientId?: string; scope?: string; expiresAt?: number;
  };
  headers?: Record<string, string>;
  endpoints?: ConnectorEndpoint[];
  writeEnabled: boolean;
  skipApprovalForReads?: boolean;
  createdAt: string;
  lastTest?: { ok: boolean; detail: string; at: string };
  keyExpiresAt?: string;
  lastRotatedAt?: string;
  allowedRoles?: string[];
  daysUntilExpiry?: number;
  expiryState?: "ok" | "soon" | "expired" | "unset";
};
export type ConnectorInput = {
  label: string;
  baseUrl: string;
  description?: string;
  auth?: {
    type: ConnectorAuthType; in?: "header" | "query"; name?: string; username?: string;
    value?: string; token?: string; password?: string;
    tenant?: string; clientId?: string; scope?: string;
  };
  headers?: Record<string, string>;
  endpoints?: ConnectorEndpoint[];
  writeEnabled?: boolean;
  skipApprovalForReads?: boolean;
};
// Personal to-do list (native, offline — distinct from the agent job queue's Tasks page).
export type TaskStep = { id: string; title: string; done: boolean };
export type RepeatRule = { freq: "daily" | "weekly" | "monthly"; interval: number };
export type MyTaskItem = {
  id: string; listId: string; title: string; notes?: string; steps: TaskStep[];
  dueDate?: string; reminderAt?: string; repeat?: RepeatRule | null;
  important: boolean; myDay?: string; completed: boolean; completedAt?: string;
  createdAt: string; order: number;
};
export type MyTaskList = { id: string; name: string; color?: string; order: number; createdAt: string };

export type ConnectorTemplate = {
  id: string; label: string; description: string;
  baseUrl: string; auth: ConnectorInput["auth"]; writeEnabled: boolean; skipApprovalForReads?: boolean; endpoints: ConnectorEndpoint[];
};
export type ConnectorCallResult = {
  ok: boolean; status: number; url: string; method: string;
  contentType?: string; body: any; truncated?: boolean; error?: string;
};

export type PlatformConnection = {
  id: string;
  platform: "google" | "microsoft";
  accountName?: string;
  connectionStatus: "connected" | "error";
  errorMessage?: string;
  scope?: string;
  hasRefreshToken: boolean;
  updatedAt: string;
};

export type BrandChannel = { provider: string; connectionLabel: string; platforms?: string[] };
export type Brand = {
  id: string;
  name: string;
  tagline: string;
  voice: string;
  audience: string;
  values: string;
  guidelinesVaultPath?: string;
  personaIds: string[];
  channels: BrandChannel[];
  calendarCadence?: string;
  color: string;
  icon: string;
  createdAt: string;
  watchTerms?: string[];
  riskTerms?: string[];
  ownDomains?: string[];
};

export type BrandSignal = {
  id: string;
  dedupeKey: string;
  brandId: string;
  kind: "mention" | "opportunity";
  text: string;
  sourceUrl?: string;
  sourceType: "web_search" | "web_page" | "vault" | "email" | "telegram";
  provenance: number;
  seenCount: number;
  status: "draft" | "validated" | "rejected";
  refusedReason?: string;
  createdAt: string;
  validatedAt?: string;
};
export type BrandSignalRun = {
  id: string; brandId: string; startedAt: string; finishedAt?: string;
  candidateCount: number; signalCount: number; refusedCount: number; error?: string;
};

export type McpServer = {
  id: string;
  label: string;
  description?: string;
  command: string;
  args: string[];
  envKeys: string[]; // names only — values never leave the server
  disabled?: boolean;
  createdAt: string;
  lastError?: string;
  lastToolCount?: number;
  lastConnectedAt?: string;
};
export type McpCatalogEntry = {
  id: string;
  label: string;
  description: string;
  command: string;
  args: string[];
  env?: { name: string; description: string; required: boolean }[];
  homepage: string;
  source: "reference" | "community";
};
export type McpServerInput = {
  label: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
};
export type McpTool = { name: string; description?: string; inputSchema?: any };
export type McpCallResult = { ok: boolean; content?: any; truncated?: boolean; error?: string };

export type ExecutorStatus = {
  mode: "clawbot" | "hermes";
  hermesModelOverride: string | null;
  hermesLocal: boolean;
  crosscheck: boolean;
  fallbackToClawbot: boolean;
  qualityGate: boolean;
  hermes: { available: boolean; binPath?: string; model: string; provider: string; localModel: string };
};

export type HermesBridgeStatus = {
  hermesInstalled: boolean;
  hermesBinPath: string | null;
  hermesConfigPath: string | null;
  hermesConfigExists: boolean;
  bridgeScriptPath: string;
  bridgeScriptExists: boolean;
  registered: boolean;
  enabled: boolean;
  toolCount: number;
  tools: { name: string; description: string; readonly: boolean }[];
};

export type WhatsAppBridgeStatus = {
  running: boolean;
  connected: boolean;
  phoneNumber?: string;
  startedAt?: string;
  lastError?: string;
  processed: number;
  qrDataUrl?: string;
  qrUpdatedAt?: string;
  pendingTriage: number;
};

export type Contact = {
  id: string; name?: string; email?: string; phone?: string; company?: string;
  source?: string; tags: string[]; notes?: string; createdAt: string; updatedAt: string;
};
export type Deal = {
  id: string; contactId: string; title: string; pipelineId: string; stage: string;
  value?: number; createdAt: string; updatedAt: string; closedAt?: string;
};
export type Pipeline = { id: string; name: string; stages: string[] };
export type CrmActivity = {
  id: string; contactId: string; kind: "note" | "email" | "call" | "stage-change"; body: string; at: string;
};

export type IntegrationProvider = {
  id: string;
  name: string;
  category: "messaging" | "social" | "productivity" | "dev";
  auth: "token" | "webhook" | "oauth";
  fields: { name: string; label: string; type: "text" | "password" | "url"; placeholder?: string; secret?: boolean; required?: boolean }[];
  docsUrl?: string;
  note?: string;
  testable: boolean;
};

export type ConnectionTest = { ok: boolean; detail: string; at: string };
export type IntegrationConnection = {
  id: string;
  providerId: string;
  providerName: string;
  category: string;
  label: string;
  config: Record<string, string>;
  secretFields: string[];
  createdAt: string;
  lastTest?: ConnectionTest;
  expiresAt?: string;
  lastRotatedAt?: string;
  allowedRoles?: string[];
  daysUntilExpiry?: number;
  expiryState?: "ok" | "soon" | "expired" | "unset";
};

export type DataSourceKind = "postgres" | "mysql" | "sqlite" | "mssql" | "mongodb";

export type DataSource = {
  id: string;
  label: string;
  kind: DataSourceKind;
  connection: string;
  notes?: string;
  department?: string;
  readonly: boolean;
  createdAt: string;
};

export type DepartmentDatum = {
  id: string;
  department: string;
  title: string;
  content: string;
  createdAt: string;
  updatedAt: string;
};

export type FileBackendId = "vault" | "localdisk" | "drive" | "supabase";

export type FileBackendInfo = {
  id: FileBackendId;
  label: string;
  kind: "filesystem" | "unavailable";
  configured: boolean;
  reachable: boolean;
  detail: string;
  badges?: { label: string; reachable: boolean; configured?: boolean }[];
};

export type FileEntry = {
  name: string;
  path: string;
  type: "dir" | "file";
  size?: number;
  mtimeMs?: number;
};

// Board Meeting (LLM council).
export type BoardOpinion = {
  personaId: string;
  name: string;
  role: string;
  label: string;
  text: string;
  startedAt?: string;
  endedAt?: string;
  elapsedMs?: number;
  error?: string;
  revisions?: { at: string; note: string; previousText: string }[];
};
export type BoardRanking = {
  personaId: string;
  name: string;
  label: string;
  rankingText: string;
  error?: string;
};
export type BoardCorrection = {
  id: string;
  targetPersonaId?: string;
  note: string;
  classification: "one-off" | "standing-rule";
  ruleText?: string;
  error?: string;
  createdAt: string;
};
export type BoardRun = {
  id: string;
  topic: string;
  roster: { personaId: string; name: string; role: string }[];
  status: "running" | "completed" | "failed";
  opinions: BoardOpinion[];
  rankings: BoardRanking[];
  chairmanSynthesis: string;
  jobId?: string;
  createdAt: string;
  updatedAt: string;
  ragBlock?: string;
  groundedIn?: { path: string; preview: string; source: string }[];
  notePath?: string;
  corrections?: BoardCorrection[];
  synthesisRevisions?: { at: string; note: string; previousText: string }[];
  scheduleId?: string;
};

// Workforce contact book.
export type WorkforceAgent = {
  kind: "agent";
  id: string;
  name: string;
  role: string;
  description: string;
  responsibilities: string[];
  department: string;
  builtin: boolean;
  workMode?: WorkMode;
  contact: { activate: string; chat: string };
};
export type WorkforcePerson = {
  kind: "human";
  id: string;
  name: string;
  email: string;
  role: string;
  title?: string;
  department: string;
  status: string;
  workMode?: WorkMode;
  // Superadmin-only (server redacts for everyone else).
  salaryMonthly?: number;
};
export type WorkforceDepartment = { department: string; agents: WorkforceAgent[]; people: WorkforcePerson[] };

export type ExtractedConstraint = {
  id: string;
  policyName: string;
  rule: string;
  severity: "hard" | "soft";
  category: string;
  details?: string;
  reviewed: boolean;
  accepted: boolean;
  createdAt: string;
};

export type GovernancePolicy = {
  path: string;
  name: string;
  bytes: number;
  lastModified: string;
  reference?: boolean;   // manual/reference doc — listed + downloadable, not a prompt guardrail
};

export type Cadence = {
  daysOfWeek: number[];
  hour: number;
  minute: number;
  // One-off override — fires exactly once on this date (YYYY-MM-DD, local),
  // ignoring daysOfWeek. Set by Calendar's "schedule for <date>" popup when
  // its REPEAT toggle is off.
  once?: string;
};

export type ScheduleDelivery = { email?: string };
export type Schedule = {
  id: string;
  name: string;
  templateId: string;
  inputs: Record<string, unknown>;
  cadence: Cadence;
  enabled: boolean;
  deliver?: ScheduleDelivery;
  createdAt: string;
  lastFiredAt?: string;
  lastJobId?: string;
  lastError?: string;
  fireCount: number;
  nextFireAt?: number | null;
  // "Needs my OK" — a fired job from this schedule is forced into
  // awaiting-approval regardless of its template's own default.
  requireApproval?: boolean;
  // Routine chaining — schedule ids fired once this one's job succeeds.
  chainTo?: string[];
};


