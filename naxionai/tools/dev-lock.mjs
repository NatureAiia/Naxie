// dev-lock.mjs - single-flight guard for `pnpm dev`.
// Refuses to start a second dev tree while :7470/:7471 are already held by
// this repo's stack (the EADDRINUSE + double-polling mess). Fail-OPEN: any
// error means "allow the start" so a bug here can never brick local dev.
import { execSync } from "node:child_process";

const PORTS = [7470, 7471];

function holders() {
  const found = [];
  try {
    const out = execSync("netstat -ano -p TCP", { stdio: ["ignore", "pipe", "ignore"] }).toString();
    for (const line of out.split("\n")) {
      const m = line.match(/TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
      if (m && PORTS.includes(Number(m[1]))) found.push({ port: m[1], pid: m[2] });
    }
  } catch { return []; }
  return found.filter((h) => {
    if (h.pid === "0") return false;
    try {
      // wmic is removed on current Windows; powershell.exe (5.1) still ships.
      const cmd = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter 'ProcessId=${h.pid}' | Select-Object -ExpandProperty CommandLine"`,
        { stdio: ["ignore", "pipe", "ignore"] }
      ).toString();
      return /naxionai/i.test(cmd);
    } catch { return false; }
  });
}

try {
  const busy = holders();
  if (busy.length > 0) {
    const detail = busy.map((h) => `:${h.port} (pid ${h.pid})`).join(", ");
    console.error(
      `\n  Dev stack already running - ${detail} held by this repo.\n` +
        `  Use the running instance instead of starting a second tree.\n` +
        `  If it is a leftover, stop it first (tools\\always-on\\stop-always-on.ps1\n` +
        `  for the watchdog, or Ctrl+C the other terminal).\n`
    );
    process.exit(1);
  }
} catch {
  // Fail open - never block dev on a guard bug.
}
