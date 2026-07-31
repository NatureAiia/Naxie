// Windows 11 Notepad reader.
//
// Modern Notepad keeps every open tab — INCLUDING unsaved ones — in an
// autosave store so tabs survive a restart. Each tab is a `.bin` file under
//   %LOCALAPPDATA%\Packages\Microsoft.WindowsNotepad_8wekyb3d8bbwe\LocalState\TabState\
// The format is an undocumented "NP" binary header + the tab text as UTF-16LE,
// and it drifts across Notepad versions. Rather than parse the header exactly,
// we run a UTF-16LE "strings" scan: pull out every run of printable
// (ascii, 0x00) pairs at any offset. That's robust to header layout changes
// and to the per-tab headers interleaved in a multi-tab file. Verified live
// 2026-07-21 against real tabs (plain notes, contact lists, bank details).
//
// This exists because "what's in my notepad" / "summarise my notepad notes"
// otherwise mis-routed to fs.find_in with the whole sentence as a FILENAME
// (zero matches — there's no file literally named "whats in my notepad").

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";

export type NotepadTab = { id: string; text: string; chars: number; updatedAt: string };

function tabStateDir(): string | null {
  const local = process.env.LOCALAPPDATA;
  if (!local) return null;
  const dir = join(local, "Packages", "Microsoft.WindowsNotepad_8wekyb3d8bbwe", "LocalState", "TabState");
  return existsSync(dir) ? dir : null;
}

// UTF-16LE "strings": every run of >= MIN_RUN printable/whitespace ASCII code
// units, joined. Alignment-free — it locks onto (printable, 0x00) pairs
// wherever they start, so headers between tab texts are simply skipped.
function extractText(buf: Buffer, minRun = 4): string {
  const runs: string[] = [];
  let cur = "";
  for (let i = 0; i + 1 < buf.length; i++) {
    const lo = buf[i], hi = buf[i + 1];
    const printable = hi === 0 && (lo === 9 || lo === 10 || lo === 13 || (lo >= 32 && lo < 127));
    if (printable) { cur += String.fromCharCode(lo); i++; } // consume the pair
    else {
      if (cur.trim().length >= minRun) runs.push(cur.replace(/[ \t]+/g, " ").trimEnd());
      cur = "";
    }
  }
  if (cur.trim().length >= minRun) runs.push(cur.replace(/[ \t]+/g, " ").trimEnd());
  return runs.join("\n").replace(/\r\n?/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

export function readNotepadTabs(limit = 20): { available: boolean; reason?: string; tabs: NotepadTab[] } {
  const dir = tabStateDir();
  if (!dir) {
    return {
      available: false,
      reason: process.platform === "win32"
        ? "The Windows Notepad autosave store wasn't found — either the modern Notepad isn't installed, or no tabs have been opened. (Classic notes saved as .txt files can be found with fs.find_in instead.)"
        : `Reading the Notepad app is Windows-only (this host is ${process.platform}). For plain-text notes, use fs.find_in on .txt / .md files.`,
      tabs: [],
    };
  }
  try {
    // Only the primary per-tab file (<uuid>.bin) — skip the .0/.1 delta
    // snapshots and .bak backups, which hold partial/older state.
    const files = readdirSync(dir)
      .filter(f => f.endsWith(".bin") && !/\.\d+\.bin$/.test(f))
      .map(f => ({ f, t: statSync(join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t)
      .slice(0, Math.max(1, Math.min(50, limit)));
    const tabs: NotepadTab[] = [];
    for (const { f, t } of files) {
      try {
        const text = extractText(readFileSync(join(dir, f)));
        if (text.length === 0) continue; // empty tab — nothing to show
        tabs.push({ id: f.replace(/\.bin$/, ""), text, chars: text.length, updatedAt: new Date(t).toISOString() });
      } catch { /* skip an unreadable tab */ }
    }
    return { available: true, tabs };
  } catch (e: any) {
    return { available: false, reason: `Couldn't read the Notepad store: ${String(e?.message ?? e).slice(0, 160)}`, tabs: [] };
  }
}
