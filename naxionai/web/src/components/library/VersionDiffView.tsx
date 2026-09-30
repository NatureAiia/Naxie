import { diffLines } from "diff";

// Pure line-by-line diff renderer — no fetching, no state. Given the raw
// "before"/"after" text of two versions of a vault note, computes chunks
// with jsdiff's diffLines and renders them as a simple two-color list:
// added lines get a leaf (green) tint, removed lines a coral (red) tint,
// unchanged lines render plain. Deliberately not a Monaco DiffEditor —
// Monaco is only used in IDE.tsx today, and this feature just needs a
// glanceable added/removed list, not a full code-diff widget.
export function VersionDiffView({ before, after }: { before: string; after: string }) {
  const chunks = diffLines(before ?? "", after ?? "");
  let hasChanges = false;
  const rows: { key: string; text: string; kind: "add" | "remove" | "same" }[] = [];
  chunks.forEach((chunk, ci) => {
    const kind = chunk.added ? "add" : chunk.removed ? "remove" : "same";
    if (kind !== "same") hasChanges = true;
    // Drop the single trailing empty line each chunk's split leaves behind
    // (diffLines chunk values end with "\n").
    const lines = chunk.value.split("\n");
    if (lines[lines.length - 1] === "") lines.pop();
    lines.forEach((line, li) => rows.push({ key: `${ci}-${li}`, text: line, kind }));
  });

  if (!hasChanges) {
    return <div className="text-sm text-cream-300/50 italic px-1">No differences between these two versions.</div>;
  }

  return (
    <div className="font-mono text-xs rounded-lg border border-ink-800 overflow-hidden">
      {rows.map(row => (
        <div
          key={row.key}
          className={
            "px-3 py-0.5 whitespace-pre-wrap break-words border-l-2 " +
            (row.kind === "add"
              ? "bg-leaf-500/15 border-leaf-500/60 text-leaf-400"
              : row.kind === "remove"
              ? "bg-coral-500/15 border-coral-500/60 text-coral-400"
              : "border-transparent text-cream-300/70")
          }
        >
          <span className="select-none opacity-60 mr-2">{row.kind === "add" ? "+" : row.kind === "remove" ? "-" : " "}</span>
          {row.text.length > 0 ? row.text : " "}
        </div>
      ))}
    </div>
  );
}
