import { Radar } from "lucide-react";
import { Card } from "../components/Card";

// Placeholder only — no logic behind this yet. The seam for a future
// always-on watcher (calendar deltas, job-queue events, schedule ticks
// feeding into a "worth a proactive message?" judgment, reusing
// push_to_chat + the reflection loop's synthesis pattern) is left here so
// it has somewhere to land without another round of nav/route surgery.
export function AmbientWatch() {
  return (
    <div className="space-y-4">
      <div>
        <h1 className="font-display text-3xl text-cream-50 flex items-center gap-3"><Radar size={24} /> Ambient Watch</h1>
        <p className="text-sm text-cream-300/70 mt-1 max-w-2xl">
          Coming soon — a background watcher that notices things (a calendar change, a job finishing,
          a schedule firing) and decides on its own whether to bring it to you, instead of waiting to be asked.
        </p>
      </div>
      <Card>
        <div className="text-center py-10 text-cream-300/60 text-sm">
          Not built yet. When it lands, this is where you'll control what it's allowed to notice
          and how often it can interrupt you.
        </div>
      </Card>
    </div>
  );
}
