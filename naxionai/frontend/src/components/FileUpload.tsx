'use client'

import { useRef, useState, type ChangeEvent, type DragEvent } from "react";

// File Upload (adapted from the Aceternity component) — a dashed dropzone that
// accepts a click or a drag-and-drop, lifts each dropped file on a subtle
// animated card, and hands the File[] back via onChange. The Aceternity source
// uses framer-motion + react-dropzone; this app has neither, so drag state and
// the lift ride native DnD events + CSS transitions instead — same behaviour,
// no new packages.

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function FileUpload({
  onChange,
  multiple = true,
  accept,
  className = "",
}: {
  onChange?: (files: File[]) => void;
  multiple?: boolean;
  accept?: string;
  className?: string;
}) {
  const [files, setFiles] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  function handleFiles(list: FileList | null) {
    if (!list || list.length === 0) return;
    const next = multiple ? [...files, ...Array.from(list)] : Array.from(list).slice(0, 1);
    setFiles(next);
    onChange?.(next);
  }

  function onInput(e: ChangeEvent<HTMLInputElement>) {
    handleFiles(e.target.files);
    e.target.value = ""; // allow re-picking the same file
  }

  function onDrop(e: DragEvent<HTMLDivElement>) {
    e.preventDefault();
    setDragOver(false);
    handleFiles(e.dataTransfer.files);
  }

  function removeAt(i: number) {
    const next = files.filter((_, idx) => idx !== i);
    setFiles(next);
    onChange?.(next);
  }

  return (
    <div className={`w-full ${className}`}>
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); inputRef.current?.click(); } }}
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        className={`group relative flex min-h-40 w-full cursor-pointer flex-col items-center justify-center rounded-lg border border-dashed p-8 text-center transition-colors duration-200
          ${dragOver ? "border-violet-400 bg-violet-500/10" : "border-ink-700 bg-ink-900/40 hover:border-ink-600"}`}
      >
        <input ref={inputRef} type="file" multiple={multiple} accept={accept} className="hidden" onChange={onInput} aria-label="Upload files" />
        <svg viewBox="0 0 24 24" className={`mb-3 h-8 w-8 transition-transform duration-200 ${dragOver ? "-translate-y-1 text-violet-400" : "text-cream-300"}`} fill="none" stroke="currentColor" strokeWidth="1.6">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 16V4m0 0L8 8m4-4l4 4M4 16v2a2 2 0 002 2h12a2 2 0 002-2v-2" />
        </svg>
        <div className="text-sm font-medium text-cream-100">
          {dragOver ? "Drop to upload" : "Drag files here, or click to browse"}
        </div>
        <div className="mt-1 text-xs text-cream-300/70">{multiple ? "One or many files" : "A single file"}</div>
      </div>

      {files.length > 0 && (
        <ul className="mt-3 space-y-2">
          {files.map((f, i) => (
            <li
              key={`${f.name}-${i}`}
              className="nw-scale-in flex items-center justify-between gap-3 rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-sm"
            >
              <span className="min-w-0 flex-1 truncate text-cream-100" title={f.name}>{f.name}</span>
              <span className="shrink-0 tabular-nums text-xs text-cream-300/70">{fmtSize(f.size)}</span>
              <button
                type="button"
                onClick={e => { e.stopPropagation(); removeAt(i); }}
                className="shrink-0 rounded p-1 text-cream-300 hover:bg-ink-700 hover:text-cream-50"
                aria-label={`Remove ${f.name}`}
              >
                <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2"><path strokeLinecap="round" d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
