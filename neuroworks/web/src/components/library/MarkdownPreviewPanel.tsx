import { useState, type ReactNode } from "react";
import { marked } from "marked";
import { Download, History } from "lucide-react";
import { api } from "../../lib/api";
import { Card } from "../Card";
import { VersionHistoryPanel } from "./VersionHistoryPanel";

// Renders a vault text file's content as markdown, with a download action and
// room for the promote/imports toolbars above the rendered content (passed in
// as `children` — Library.tsx supplies <PromoteBar/>/<ImportsActions/>).
// Moved out of Knowledge.tsx's `content !== null` branch.
export function MarkdownPreviewPanel({ path, content, children }: { path: string; content: string; children?: ReactNode }) {
  const [showHistory, setShowHistory] = useState(false);
  return (
    <Card
      title={path.split("/").pop()}
      action={
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setShowHistory(v => !v)}
            className={`inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md border ${
              showHistory
                ? "bg-violet-500/25 border-violet-500/60 text-violet-200"
                : "bg-violet-500/15 border-violet-500/40 text-violet-300 hover:bg-violet-500/25"
            }`}
          >
            <History size={12} /> History
          </button>
          <a href={api.brainDownloadUrl(path)} download className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25">
            <Download size={12} /> Download
          </a>
        </div>
      }
    >
      {children}
      {showHistory && (
        <div className="mb-4">
          <VersionHistoryPanel path={path} />
        </div>
      )}
      <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(content) as string }} />
    </Card>
  );
}
