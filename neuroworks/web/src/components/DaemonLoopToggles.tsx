import { useEffect, useState } from "react";
import { api, ApiError, type DaemonSettings } from "../lib/api";
import { showToast } from "./Card";
import { ToggleRow } from "./ToggleRow";

// Operator kill switches for org-daemon.ts's named background loops (see
// server/src/lib/daemon-settings.ts). Mirrors CapabilityToggles.tsx's
// fetch-once / optimistic-PATCH-with-403-rollback shape, but the setting is
// an array of DISABLED loop names rather than a flat boolean record, so
// "checked" here means "enabled" (i.e. NOT in disabledLoops).

const LOOPS: { key: string; label: string }[] = [
  { key: "sweepStaleOrgApprovals", label: "Expire stale approvals" },
  { key: "reconcileOrphanedActiveTasks", label: "Reconcile orphaned tasks" },
  { key: "maybeEscalateBlockedSLA", label: "Blocked-task SLA escalation" },
  { key: "maybeNudgePendingApprovals", label: "Nudge pending approvals" },
  { key: "maybeBackupVault", label: "Vault backup" },
  { key: "maybeNudgeStaleExecutorTasks", label: "Nudge stale executor tasks" },
  { key: "maybeReportIdleActivity", label: "Idle activity report" },
  { key: "maybeRunArchitectReview", label: "Architect self-improvement review" },
  { key: "maybeGenerateBriefing", label: "Daily briefing" },
  { key: "maybeNudgeChatInactivity", label: "Chat-inactivity check-in" },
  { key: "maybeRunProactiveResearch", label: "Proactive research" },
  { key: "maybeScoreTelegramNews", label: "Telegram news scoring" },
  { key: "maybeProcessComplianceReminders", label: "Compliance reminders" },
  { key: "maybeExtractZettels", label: "Auto-extract zettels from chats" },
];

export function DaemonLoopToggles({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<DaemonSettings | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    api.daemonSettings().then(r => setSettings(r.settings)).catch(() => { /* leave null — toggles just don't render */ });
  }, []);

  if (!settings) return null;

  async function flip(key: string, next: boolean) {
    const prevDisabled = settings!.disabledLoops;
    const nextDisabled = next ? prevDisabled.filter(k => k !== key) : [...prevDisabled, key];
    setSettings(s => (s ? { ...s, disabledLoops: nextDisabled } : s));
    setPending(key);
    try {
      const r = await api.updateDaemonSettings({ disabledLoops: nextDisabled });
      setSettings(r.settings);
    } catch (e) {
      setSettings(s => (s ? { ...s, disabledLoops: prevDisabled } : s));
      if (e instanceof ApiError && e.status === 403) {
        setCanEdit(false);
        showToast("Admin access required to change daemon loop settings", "error");
      } else {
        showToast(e instanceof Error ? e.message : String(e), "error");
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-2"}`}>
      {LOOPS.map(loop => (
        <ToggleRow
          key={loop.key}
          label={loop.label}
          checked={!settings.disabledLoops.includes(loop.key)}
          onChange={next => void flip(loop.key, next)}
          disabled={!canEdit || pending === loop.key}
          compact={compact}
        />
      ))}
    </div>
  );
}
