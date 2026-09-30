import { useEffect, useState } from "react";
import { Mail, FolderOpen, Plug, Loader2, ChevronRight, Folder, FileText } from "lucide-react";
import { api, type PlatformConnection } from "../lib/api";
import { Card, Button, showToast } from "./Card";

// Naxie's personal-account connectors (Google, Microsoft, local documents).
// Kept as its own section so it doesn't get visually conflated with the
// generic company-system Connectors above, even though both now run
// natively on neuroworks/server (lib/oauth-connectors.ts, routes/local-folder.ts).

function readOAuthReturn(): { connected?: string; error?: string } {
  const params = new URLSearchParams(window.location.search);
  const result = { connected: params.get("connected") ?? undefined, error: params.get("error") ?? undefined };
  if (result.connected || result.error) {
    params.delete("connected");
    params.delete("error");
    const clean = `${window.location.pathname}${params.toString() ? `?${params}` : ""}`;
    window.history.replaceState({}, "", clean);
  }
  return result;
}

export function NaxiePersonalConnectors() {
  useEffect(() => {
    const { connected, error } = readOAuthReturn();
    if (connected) showToast(`Connected ${connected === "google" ? "Google" : "Microsoft"}`, "success");
    if (error) showToast(`Connection failed: ${error}`, "error");
  }, []);

  return (
    <div className="space-y-3">
      <div>
        <h2 className="font-display text-xl text-cream-50 flex items-center gap-2"><Plug size={18} /> Personal accounts</h2>
        <p className="text-sm text-cream-300/70 mt-1">
          Give Naxie read-only access to your own accounts — used for the morning digest (unread mail, upcoming
          events) and, for documents, the knowledge base.
        </p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <OAuthConnectorCard
          label="Google" icon={<Mail size={16} />} platform="google"
          scopeHint="Gmail (read) + Calendar (read)"
        />
        <OAuthConnectorCard
          label="Microsoft" icon={<Mail size={16} />} platform="microsoft"
          scopeHint="Outlook Mail + Calendar + OneDrive (read)"
        />
        <LocalDocumentsCard />
      </div>
    </div>
  );
}

function OAuthConnectorCard({ label, icon, platform, scopeHint }: {
  label: string; icon: React.ReactNode; scopeHint: string;
  platform: "google" | "microsoft";
}) {
  const [connections, setConnections] = useState<PlatformConnection[] | null>(null);
  const [busy, setBusy] = useState(false);

  async function refresh() {
    try { setConnections((await api.naxiePlatformConnections(platform)).connections); } catch { setConnections([]); }
  }
  useEffect(() => { void refresh(); }, []);

  async function connect() {
    setBusy(true);
    try {
      const { authorize_url } = await api.naxiePlatformAuthorize(platform);
      window.location.href = authorize_url; // full navigation — Google/Microsoft redirects back here when done
    } catch (e: any) {
      showToast(e?.message ?? String(e), "error");
      setBusy(false);
    }
  }

  async function remove(id: string) {
    try { await api.naxiePlatformDisconnect(platform, id); showToast(`${label} disconnected`, "success"); refresh(); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
  }

  const connected = connections && connections.length > 0;

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 shrink-0">{icon}</div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-cream-100 flex items-center gap-2">
            {label}
            {connections === null ? (
              <Loader2 size={12} className="animate-spin text-cream-300/50" />
            ) : connected ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/15 text-leaf-400">connected</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">not connected</span>
            )}
          </div>
          <div className="text-[11px] text-cream-300/60 mt-0.5">{scopeHint}</div>
          {connected && (
            <div className="text-[11px] text-cream-300/70 mt-1 font-mono truncate">{connections![0].accountName}</div>
          )}
        </div>
      </div>
      <div className="mt-3">
        {connected ? (
          <Button variant="subtle" onClick={() => remove(connections![0].id)}>Disconnect</Button>
        ) : (
          <Button onClick={connect} disabled={busy}>
            {busy ? <Loader2 size={13} className="animate-spin" /> : <Plug size={13} />} Connect
          </Button>
        )}
      </div>
    </Card>
  );
}

function LocalDocumentsCard() {
  const [status, setStatus] = useState<{ configured: boolean; rootLabel: string | null } | null>(null);
  const [browsing, setBrowsing] = useState(false);
  const [subPath, setSubPath] = useState("");
  const [entries, setEntries] = useState<{ name: string; isDir: boolean; supported: boolean }[] | null>(null);
  const [ingesting, setIngesting] = useState(false);

  useEffect(() => { void api.localFolderStatus().then(setStatus).catch(() => setStatus({ configured: false, rootLabel: null })); }, []);

  async function browse(path: string) {
    setBrowsing(true);
    try { const r = await api.localFolderBrowse(path); setSubPath(r.subPath); setEntries(r.entries); }
    catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setBrowsing(false); }
  }

  async function ingest() {
    setIngesting(true);
    try {
      const r = await api.localFolderIngest({ subPath, recursive: true });
      showToast(`Queued ${r.queued} file(s) for indexing${r.skippedUnsupported ? ` (${r.skippedUnsupported} unsupported skipped)` : ""}`, "success");
    } catch (e: any) { showToast(e?.message ?? String(e), "error"); }
    finally { setIngesting(false); }
  }

  return (
    <Card>
      <div className="flex items-start gap-3">
        <div className="w-9 h-9 rounded-lg bg-violet-500/15 grid place-items-center text-violet-300 shrink-0"><FolderOpen size={16} /></div>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-cream-100 flex items-center gap-2">
            My documents
            {status === null ? (
              <Loader2 size={12} className="animate-spin text-cream-300/50" />
            ) : status.configured ? (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-leaf-500/15 text-leaf-400">enabled</span>
            ) : (
              <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-ink-800 text-cream-300/60">not configured</span>
            )}
          </div>
          <div className="text-[11px] text-cream-300/60 mt-0.5">Index a folder under Local Files into Naxie's knowledge base</div>
        </div>
      </div>

      {status?.configured ? (
        <div className="mt-3 space-y-2">
          <div className="flex gap-2">
            <input
              value={subPath} onChange={e => setSubPath(e.target.value)} placeholder="sub-folder (blank = root)"
              className="flex-1 bg-ink-950 border border-ink-800 text-[12px] text-cream-100 rounded-lg px-2.5 py-1.5 font-mono placeholder:text-cream-300/30"
            />
            <Button variant="subtle" onClick={() => browse(subPath)} disabled={browsing}>
              {browsing ? <Loader2 size={13} className="animate-spin" /> : <ChevronRight size={13} />} Browse
            </Button>
          </div>
          {entries && (
            <div className="max-h-32 overflow-auto rounded-lg border border-ink-800 bg-ink-950/40 divide-y divide-ink-800/60">
              {entries.length === 0 && <div className="px-2.5 py-2 text-[11px] text-cream-300/50">Empty folder</div>}
              {entries.map(e => (
                <button key={e.name} type="button"
                  onClick={() => e.isDir && browse(`${subPath}${subPath ? "/" : ""}${e.name}`)}
                  className="w-full flex items-center gap-2 px-2.5 py-1.5 text-[11px] text-left hover:bg-ink-900/60 disabled:cursor-default"
                  disabled={!e.isDir}
                >
                  {e.isDir ? <Folder size={12} className="text-cream-300/60" /> : <FileText size={12} className={e.supported ? "text-leaf-400/80" : "text-cream-300/30"} />}
                  <span className={e.isDir ? "text-cream-100" : e.supported ? "text-cream-200" : "text-cream-300/40"}>{e.name}</span>
                </button>
              ))}
            </div>
          )}
          <Button onClick={ingest} disabled={ingesting}>
            {ingesting ? <Loader2 size={13} className="animate-spin" /> : <FolderOpen size={13} />} Index this folder
          </Button>
        </div>
      ) : (
        <div className="mt-3 text-[11px] text-cream-300/60">
          Couldn't reach the server to check Local Files status — try again shortly.
        </div>
      )}
    </Card>
  );
}
