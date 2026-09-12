import { Boxes, Lock, RefreshCw } from "lucide-react";
import { Card, Button } from "../components/Card";

export function AdminExternalApis() {
  return (
    <div className="space-y-4 max-w-3xl">
      <div className="flex items-center gap-2">
        <Boxes size={18} className="text-violet-400" />
        <h1 className="text-lg font-semibold text-cream-50">External APIs</h1>
        <span className="text-xs text-cream-300/50">credentials you call INTO — Kuwana ExternalIntegration</span>
      </div>
      <Card className="p-4 space-y-3">
        <p className="text-sm text-cream-300/70">Register a third-party secret (maps API, SMS gateway, future LLM provider) without a deploy. Stored as <code>AES-256-GCM</code> <code>encryptedValue</code> — plaintext never logged, looked up by <code>name</code> via <code>src/lib/externalIntegrations.ts</code>.</p>
        <div className="grid gap-2">
          {[
            { name: "maps_api", label: "Maps API" },
            { name: "sms_gateway", label: "SMS gateway" },
          ].map(r=>(
            <div key={r.name} className="flex items-center justify-between p-3 rounded-lg bg-ink-950 border border-ink-700">
              <div><div className="text-sm text-cream-100 flex items-center gap-1.5"><Lock size={12} className="text-cream-300/50"/>{r.label}</div><div className="text-[11px] text-cream-300/40 font-mono">{r.name}</div></div>
              <Button variant="subtle">Rotate</Button>
            </div>
          ))}
        </div>
        <Button><RefreshCw size={14}/> Add integration</Button>
      </Card>
    </div>
  );
}
