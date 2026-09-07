import type { ReactNode } from "react";
import { marked } from "marked";
import { Download } from "lucide-react";
import { api } from "../../lib/api";
import { Card } from "../Card";

// Renders a vault text file's content as markdown, with a download action and
// room for the promote/imports toolbars above the rendered content (passed in
// as `children` — Library.tsx supplies <PromoteBar/>/<ImportsActions/>).
// Moved out of Knowledge.tsx's `content !== null` branch.
export function MarkdownPreviewPanel({ path, content, children }: { path: string; content: string; children?: ReactNode }) {
  return (
    <Card
      title={path.split("/").pop()}
      action={
        <a href={api.brainDownloadUrl(path)} download className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-md bg-violet-500/15 border border-violet-500/40 text-violet-300 hover:bg-violet-500/25">
          <Download size={12} /> Download
        </a>
      }
    >
      {children}
      <div className="prose-vault" dangerouslySetInnerHTML={{ __html: marked.parse(content) as string }} />
    </Card>
  );
}
