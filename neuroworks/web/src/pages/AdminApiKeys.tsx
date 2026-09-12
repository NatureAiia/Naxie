import { useEffect, useState } from "react";
import { KeyRound, Plus, Trash2, Copy } from "lucide-react";
import { Card, Button } from "../components/Card";
import { api } from "../lib/api";

export function AdminApiKeys() {
  const [keys, setKeys] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  useEffect(() => { (api as any).listDispatchKeys?.().then((r:any)=>setKeys(r.keys??r??[])).catch(()=>{}).finally(()=>setLoading(false)); }, []);
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <KeyRound size={18} className="text-violet-400" />
        <h1 className="text-lg font-semibold text-cream-50">API keys</h1>
        <span className="text-xs text-cream-300/50">for external BI / dispatch — mirrors Kuwana /admin/api-keys</span>
      </div>
      <Card className="p-4">
        {loading ? <div className="text-sm text-cream-300/50">Loading…</div> : keys.length===0 ? (
          <div className="text-sm text-cream-300/60">No keys yet. Create one below. Keys are hashed (SHA-256) at rest, last-used tracked.</div>
        ) : (
          <div className="space-y-2">
            {keys.map((k:any)=>(<div key={k.id} className="flex items-center justify-between gap-2 p-2 rounded-lg bg-ink-950 border border-ink-700 text-sm"><span className="truncate">{k.label ?? k.id}</span><span className="text-[11px] text-cream-300/40">{k.lastUsedAt ? `last ${new Date(k.lastUsedAt).toLocaleDateString()}` : "never used"}</span><button className="p-1.5 rounded hover:bg-ink-800 text-cream-300"><Copy size={13}/></button><button className="p-1.5 rounded hover:bg-flame-500/20 text-flame-400"><Trash2 size={13}/></button></div>))}
          </div>
        )}
        <div className="pt-3">
          <Button><Plus size={14}/> Create key</Button>
        </div>
      </Card>
      <p className="text-[11px] text-cream-300/40">Kuwana source: <code>ApiKey</code> model — <code>hashedKey @unique</code>, <code>scopes[]</code>, <code>revokedAt</code>. External BI pulls via <code>/api/bi/*</code> with <code>X-API-Key</code>.</p>
    </div>
  );
}
