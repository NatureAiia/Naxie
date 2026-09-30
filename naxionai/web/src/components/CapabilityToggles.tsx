import { useEffect, useState } from "react";
import { api, ApiError, type HostToolsSettings } from "../lib/api";
import { showToast } from "./Card";
import { ToggleRow } from "./ToggleRow";

// Surfaces Naxie's real host-level capabilities (Settings > System Access,
// server/src/lib/host-tools.ts) as visible switches instead of a buried
// settings page — the "plugin toggles" ask, scoped to the 3 booleans that
// actually gate something today (system control, clipboard, notifications).
// PATCH is admin/superadmin-only server-side; a 403 here just means the
// toggle reverts and the caller is told why.

const ROWS: { key: keyof Pick<HostToolsSettings, "allowSystemControl" | "allowClipboardAccess" | "allowNotifications">; label: string }[] = [
  { key: "allowSystemControl", label: "System control" },
  { key: "allowClipboardAccess", label: "Clipboard access" },
  { key: "allowNotifications", label: "Desktop notifications" },
];

export function CapabilityToggles({ compact = false }: { compact?: boolean }) {
  const [settings, setSettings] = useState<HostToolsSettings | null>(null);
  const [canEdit, setCanEdit] = useState(true);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    api.hostToolsSettings().then(r => setSettings(r.settings)).catch(() => { /* leave null — toggles just don't render */ });
  }, []);

  if (!settings) return null;

  async function flip(key: typeof ROWS[number]["key"], next: boolean) {
    const prev = settings![key];
    setSettings(s => (s ? { ...s, [key]: next } : s));
    setPending(key);
    try {
      const r = await api.updateHostToolsSettings({ [key]: next });
      setSettings(r.settings);
    } catch (e) {
      setSettings(s => (s ? { ...s, [key]: prev } : s));
      if (e instanceof ApiError && e.status === 403) {
        setCanEdit(false);
        showToast("Admin access required to change System Access settings", "error");
      } else {
        showToast(e instanceof Error ? e.message : String(e), "error");
      }
    } finally {
      setPending(null);
    }
  }

  return (
    <div className={`flex flex-col ${compact ? "gap-1.5" : "gap-2"}`}>
      {ROWS.map(row => (
        <ToggleRow
          key={row.key}
          label={row.label}
          checked={settings[row.key]}
          onChange={next => void flip(row.key, next)}
          disabled={!canEdit || pending === row.key}
          compact={compact}
        />
      ))}
    </div>
  );
}
