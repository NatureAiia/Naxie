import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Users2, Waypoints } from "lucide-react";
import { PageHeader } from "../components/PageHeader";
import { BoardMeeting } from "./BoardMeeting";
import { Orchestrate } from "./Orchestrate";

// Council — one page, two tabs. Board Meeting (council debate → chairman
// synthesis) and Orchestrate (objective → parallel sub-tasks → final report)
// share the decompose-then-synthesize shape, so they live together with
// cross-handoffs: Board → Orchestrate carries the decision out, and
// Orchestrate → Board sends findings back for review.
//
// Both tabs stay mounted (the inactive one hidden) so a handoff doesn't cost
// you the result you just sent: switching back shows the synthesis or the
// expanded report exactly where you left it, instead of a fresh empty page.

type Tab = "board" | "orchestrate";

export function Council() {
  const [searchParams, setSearchParams] = useSearchParams();
  const raw = searchParams.get("tab");
  const tab: Tab = raw === "orchestrate" ? "orchestrate" : "board";

  // Cross-tab handoffs: each side pre-fills the other's input and switches.
  const [boardTopic, setBoardTopic] = useState<string | undefined>(undefined);
  const [objective, setObjective] = useState<string | undefined>(undefined);

  function switchTab(next: Tab) {
    setSearchParams(next === "board" ? {} : { tab: next }, { replace: true });
  }

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Users2 size={24} />}
        title="Council"
        subtitle="Debate it with the board, or break it down with orchestration — then carry the outcome forward."
      />

      <div role="tablist" aria-label="Council views" className="flex items-center gap-1 border-b border-ink-800">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "board"}
          onClick={() => switchTab("board")}
          className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${
            tab === "board" ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
          }`}
        >
          <Users2 size={13} /> Board Meeting
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "orchestrate"}
          onClick={() => switchTab("orchestrate")}
          className={`px-4 py-2 text-xs font-medium border-b-2 -mb-px whitespace-nowrap transition-colors inline-flex items-center gap-1.5 ${
            tab === "orchestrate" ? "border-violet-500 text-cream-50" : "border-transparent text-cream-300/60 hover:text-cream-100"
          }`}
        >
          <Waypoints size={13} /> Orchestrate
        </button>
      </div>

      <div role="tabpanel" hidden={tab !== "board"}>
        <BoardMeeting
          initialTopic={boardTopic}
          onSendToOrchestrate={(obj) => { setObjective(obj); switchTab("orchestrate"); }}
        />
      </div>
      <div role="tabpanel" hidden={tab !== "orchestrate"}>
        <Orchestrate
          embedded
          initialObjective={objective}
          onSendToBoard={(topic) => { setBoardTopic(topic); switchTab("board"); }}
        />
      </div>
    </div>
  );
}
