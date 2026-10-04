// Naxie's host-level PA tools — weather, reminders/toasts, system control,
// clipboard, git status/pull, and browser-open. This is a native TypeScript
// implementation; there is no first-party Python/LangChain PA-tools runtime
// in this repository. See docs/naxie-architecture.md §2.2 for the behavior
// and security posture this module follows:
//
//   - system_control / manage_clipboard reach real OS-level access and are
//     gated behind an explicit settings toggle (§2.2 decided a plain
//     Settings > System Access switch over naxionai's env-var gate — there's
//     no meaningful dev/prod distinction on a single-user local install).
//     Both toggles default OFF.
//   - Any data an LLM could have generated (reminder text, clipboard writes)
//     is passed to PowerShell over STDIN, never interpolated into the
//     command-line string — this is the actual injection defense, not
//     decorative. Do not "simplify" this back to string interpolation.
//   - open_app only ever resolves through a fixed allowlist — never a
//     free-form path reaching the shell.
//   - git_command only ever touches one operator-configured repo path — the
//     caller (an LLM-driven plan step) never supplies a path itself.
//   - browser_open: only a string that already starts with http:// or
//     https:// is opened as-is; everything else (including anything trying
//     to look like file://, javascript:, or another URI scheme) is instead
//     wrapped into a Google search query, never opened directly.
//
// The naxionai original's `_system_control_allowed()` fails OPEN on error
// (a bug flagged, not carried over) — this port fails CLOSED: any error
// reading settings blocks the gated tools rather than allowing them.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_DIR = resolve(__dirname, "../../../.naxion");
const SETTINGS_FILE = join(STATE_DIR, "host-tools-settings.json");

// ─── Settings > System Access (docs §2.2/§8.5) ─────────────────────────────

export type HostToolsSettings = {
  allowSystemControl: boolean;
  allowClipboardAccess: boolean;
  // Desktop-toast delivery for the notification dispatcher (lib/notify.ts,
  // docs §2.3). Kept as its own toggle rather than folded into
  // allowSystemControl: a toast is display-only (no OS mutation), so it
  // doesn't carry the same risk as open_app/clipboard/screenshot — default ON.
  allowNotifications: boolean;
  // The ONLY repo git_command may ever touch — never supplied by an LLM.
  gitRepoPath: string;
};

const DEFAULT_SETTINGS: HostToolsSettings = {
  allowSystemControl: false,
  allowClipboardAccess: false,
  allowNotifications: true,
  gitRepoPath: "",
};

let cache: HostToolsSettings | null = null;

function load(): HostToolsSettings {
  if (cache) return cache;
  if (!existsSync(STATE_DIR)) mkdirSync(STATE_DIR, { recursive: true });
  if (!existsSync(SETTINGS_FILE)) {
    cache = { ...DEFAULT_SETTINGS };
    persist();
    return cache;
  }
  try {
    const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
    cache = { ...DEFAULT_SETTINGS, ...parsed };
  } catch (e) {
    console.warn(`[host-tools] failed to read ${SETTINGS_FILE}: ${(e as Error).message}. Using safe defaults (everything OFF).`);
    cache = { ...DEFAULT_SETTINGS };
  }
  // Both try and catch branches above assign cache — narrowed for readers,
  // but TS's CFA doesn't carry that across the try/catch boundary here.
  return cache!;
}

function persist(): void {
  if (!cache) return;
  try { writeFileSync(SETTINGS_FILE, JSON.stringify(cache, null, 2)); }
  catch (e) { console.warn(`[host-tools] persist failed: ${(e as Error).message}`); }
}

export function getHostToolsSettings(): HostToolsSettings {
  return { ...load() };
}

export function updateHostToolsSettings(patch: Partial<HostToolsSettings>): HostToolsSettings {
  const s = load();
  Object.assign(s, patch);
  persist();
  return { ...s };
}

// Fails CLOSED on any error — the naxionai original's fail-open bug
// (docs §2.2) is deliberately not carried over.
export function isSystemControlAllowed(): boolean {
  try { return load().allowSystemControl === true; } catch { return false; }
}
export function isClipboardAllowed(): boolean {
  try { return load().allowClipboardAccess === true; } catch { return false; }
}
// Unlike the two checks above, notifications default ON — but still fail
// closed (suppress the toast) if settings can't be read at all, rather than
// crash the caller over a display-only notification.
export function isNotificationsAllowed(): boolean {
  try { return load().allowNotifications === true; } catch { return false; }
}

// ─── PowerShell execution — data over stdin, never interpolated ───────────

function runPowerShell(script: string, stdinData?: string): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn("powershell", ["-NoProfile", "-Command", script], {
      stdio: [stdinData !== undefined ? "pipe" : "ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", d => { stdout += d.toString(); });
    proc.stderr?.on("data", d => { stderr += d.toString(); });
    proc.on("error", reject);
    proc.on("close", code => resolvePromise({ stdout, stderr, code }));
    if (stdinData !== undefined) {
      proc.stdin?.write(stdinData);
      proc.stdin?.end();
    }
  });
}

// ─── get_weather ────────────────────────────────────────────────────────

const WEATHER_DESCRIPTIONS: Record<number, string> = {
  0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
  45: "Foggy", 51: "Light drizzle", 61: "Slight rain", 63: "Moderate rain",
  71: "Slight snow", 80: "Rain showers", 95: "Thunderstorm",
};

const WEATHER_EMOJI: Record<string, string> = {
  "Clear sky": "☀️", "Mainly clear": "🌤️", "Partly cloudy": "⛅", "Overcast": "☁️",
  "Foggy": "🌫️", "Light drizzle": "🌦️", "Slight rain": "🌧️", "Moderate rain": "🌧️",
  "Slight snow": "🌨️", "Rain showers": "🌧️", "Thunderstorm": "⛈️",
};

// Provider-fallback-with-labeling (ported from KimmyDeku/sebastian's
// src/lib/server/weather.ts): try a premium provider when configured, catch
// ANY failure silently, fall back to the always-free Open-Meteo path — and
// tell the caller which one actually answered, so the markdown block never
// claims a source it didn't use. Open-Meteo alone (today's only behavior)
// is unaffected when NAXION_GOOGLE_WEATHER_API_KEY is unset.
async function getGoogleWeather(lat: number, lon: number): Promise<{ current: any; hourly: { humidity?: number }; daily: { max?: number; min?: number } } | null> {
  const key = process.env.NAXION_GOOGLE_WEATHER_API_KEY;
  if (!key) return null;
  try {
    const url = `https://weather.googleapis.com/v1/currentConditions:lookup?key=${key}&location.latitude=${lat}&location.longitude=${lon}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return null;
    const data: any = await res.json();
    const cc = data?.currentConditions ?? data;
    if (!cc) return null;
    return {
      current: {
        weathercode: undefined, // Google's condition text is used directly instead of a WMO code
        temperature: cc.temperature?.degrees,
        windspeed: cc.wind?.speed?.value,
        windgusts: cc.wind?.gust?.value,
        time: cc.currentTime,
        conditionText: cc.weatherCondition?.description?.text,
      },
      hourly: { humidity: cc.relativeHumidity },
      daily: { max: cc.currentConditionsHistory?.maxTemperature?.degrees, min: cc.currentConditionsHistory?.minTemperature?.degrees },
    };
  } catch { return null; } // any failure (network, quota, malformed key) — fall through to Open-Meteo
}

export async function getWeather(location = "auto"): Promise<string> {
  try {
    let lat = 51.5074, lon = -0.1278, locName = "London";
    if (location && location.toLowerCase() !== "auto") {
      const geoUrl = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(location)}&count=1&language=en&format=json`;
      const geoRes = await fetch(geoUrl, { headers: { "User-Agent": "Naxie/1.0" }, signal: AbortSignal.timeout(5000) });
      const geo: any = await geoRes.json();
      const first = geo?.results?.[0];
      if (first) {
        lat = first.latitude ?? lat;
        lon = first.longitude ?? lon;
        locName = `${first.name}, ${(first.country_code ?? "").toUpperCase()}`;
      }
    }
    let provider = "Open-Meteo";
    let current: any, hourly: any, daily: any, descOverride: string | undefined;
    const google = await getGoogleWeather(lat, lon);
    if (google) {
      provider = "Google Weather";
      current = google.current;
      hourly = { relativehumidity_2m: [google.hourly.humidity] };
      daily = { temperature_2m_max: [google.daily.max], temperature_2m_min: [google.daily.min] };
      descOverride = google.current.conditionText;
    } else {
      const weatherUrl = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,windspeed_10m,daily=temperature_2m_max,temperature_2m_min&timezone=auto`;
      const wRes = await fetch(weatherUrl, { headers: { "User-Agent": "Naxie/1.0" }, signal: AbortSignal.timeout(5000) });
      const wData: any = await wRes.json();
      current = wData?.current_weather ?? {};
      hourly = wData?.hourly ?? {};
      daily = wData?.daily ?? {};
    }
    const desc = descOverride ?? WEATHER_DESCRIPTIONS[current.weathercode] ?? "Clear";
    const emoji = WEATHER_EMOJI[desc] ?? "🌡️";
    const temp = current.temperature ?? "—";
    const wind = current.windspeed ?? "—";
    const windGust = current.windgusts ?? "";
    const humidity = hourly?.relativehumidity_2m?.[0] ?? "";
    const todayMax = daily?.temperature_2m_max?.[0] ?? "";
    const todayMin = daily?.temperature_2m_min?.[0] ?? "";
    const range = todayMax !== "" && todayMin !== "" ? ` · 📈 ${todayMax}° / 📉 ${todayMin}°` : "";
    const humLine = humidity !== "" ? ` · 💧 Humidity ${humidity}%` : "";
    return [
      `## ${emoji} Weather — ${locName}`,
      ``,
      `**${desc}** · **${temp}°C**${range}`,
      ``,
      `| 💨 Wind | 💧 Humidity | 🕐 Observed |`,
      `|---|---|---|`,
      `| ${wind} km/h${windGust ? ` (gusts ${windGust})` : ""} | ${humidity !== "" ? `${humidity}%` : "—"} | ${current.time ?? "now"} |`,
      ``,
      // Naxie's own reading of the forecast, not an official warning — same
      // framing discipline as the ported pattern's advisories().
      `_Source: ${provider} · ${locName} (${lat.toFixed(2)}, ${lon.toFixed(2)})_`,
    ].join("\n");
  } catch (e: any) {
    return `## ⚠️ Weather\n\n_Could not retrieve weather: ${e?.message ?? e}_`;
  }
}

// ─── set_reminder (desktop toast) ───────────────────────────────────────
// Reminder scheduling here is process-lifetime only (a setTimeout) — durable
// scheduling across restarts is the daemon's job (docs §2.4/§6), not this
// module's. This function is the "fire one toast" primitive the daemon and
// direct chat requests both call.

const TOAST_SCRIPT = `
$data = [Console]::In.ReadToEnd() | ConvertFrom-Json
$titleEsc = [System.Security.SecurityElement]::Escape($data.title)
$msgEsc = [System.Security.SecurityElement]::Escape($data.message)
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$xml = "<toast><visual><binding template='ToastGeneric'><text>$titleEsc</text><text>$msgEsc</text></binding></visual></toast>"
$toastXml = [Windows.Data.Xml.Dom.XmlDocument]::new()
$toastXml.LoadXml($xml)
$toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("Naxie").Show($toast)
`;

// title/message are potentially LLM-generated text — sent over stdin as
// JSON, never spliced into the PowerShell source, then XML-escaped again
// inside the script before it reaches the toast markup.
export async function notifyToast(title: string, message: string): Promise<void> {
  await runPowerShell(TOAST_SCRIPT, JSON.stringify({ title, message }));
}

export async function setReminder(title: string, message: string, delaySeconds = 0): Promise<string> {
  const fire = () => { void notifyToast(title, message).catch(() => { /* best-effort */ }); };
  if (delaySeconds > 0) {
    setTimeout(fire, delaySeconds * 1000);
    return `Reminder set: '${title}' will trigger in ${delaySeconds} seconds.`;
  }
  fire();
  return `Reminder notification sent: '${title}'`;
}

// ─── system_control ─────────────────────────────────────────────────────

// target is LLM-controlled; it only ever resolves through this fixed
// allowlist — never passed straight to a shell.
const APP_ALLOWLIST: Record<string, string> = {
  calc: "calc.exe", calculator: "calc.exe",
  notepad: "notepad.exe",
  explorer: "explorer.exe", files: "explorer.exe",
  chrome: "chrome", "google chrome": "chrome",
  edge: "msedge", "microsoft edge": "msedge",
  firefox: "firefox",
  word: "winword", excel: "excel", outlook: "outlook",
  paint: "mspaint.exe",
  terminal: "wt.exe", cmd: "cmd.exe",
};

export type SystemControlAction =
  | "open_app" | "take_screenshot" | "volume_mute" | "volume_unmute"
  | "focus_window" | "brightness_get" | "brightness_set" | "battery_status";

// Pure decision logic, factored out for disk/process-free testing — matches
// this repo's own convention (see governance.ts/governance.test.ts) of only
// unit-testing the parts that don't touch disk or spawn a process.

// target is LLM-controlled; only ever resolves through APP_ALLOWLIST above —
// returns null rather than ever falling back to the raw string.
export function resolveAppExecutable(target: string): string | null {
  return APP_ALLOWLIST[target.toLowerCase().trim()] ?? null;
}

export function knownAppNames(): string[] {
  return [...new Set(Object.values(APP_ALLOWLIST))].sort();
}

// Returns null for anything that isn't a clean 0-100 integer (including
// trailing garbage like "50abc", which Number.parseInt would silently accept
// up to the first non-digit — this is intentionally stricter).
export function clampBrightnessPercent(target: string): number | null {
  const trimmed = target.trim().replace(/%$/, "");
  if (!/^\d+$/.test(trimmed)) return null;
  const n = Number.parseInt(trimmed, 10);
  return Math.max(0, Math.min(100, n));
}

export async function systemControl(action: SystemControlAction, target = ""): Promise<string> {
  if (!isSystemControlAllowed()) {
    return "System control is turned off. Enable it in Settings > System Access to let Naxie open apps, take screenshots, or control the machine directly.";
  }
  try {
    switch (action) {
      case "open_app": {
        if (!target) return "App target name required (e.g. 'notepad', 'calc', 'chrome').";
        const exe = resolveAppExecutable(target);
        if (!exe) return `App '${target}' is not in the allowed list: ${knownAppNames().join(", ")}.`;
        spawn("cmd.exe", ["/c", "start", "", exe], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
        return `Launched application '${target}'.`;
      }
      case "take_screenshot": {
        const tmpFile = join(process.env.TEMP ?? process.env.TMP ?? ".", `naxie_screenshot_${Date.now()}.png`);
        const script = `
          Add-Type -AssemblyName System.Windows.Forms
          $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
          $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
          $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
          $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
          $bitmap.Save('${tmpFile.replace(/'/g, "''")}')
        `;
        await runPowerShell(script);
        return `Screenshot captured and saved to: ${tmpFile}`;
      }
      case "volume_mute":
      case "volume_unmute": {
        await runPowerShell(`$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]173)`);
        return "System volume toggled.";
      }
      case "focus_window": {
        if (!target) return "Window title (or substring) required, e.g. 'chrome', 'notepad', 'cursor'.";
        const script = `
          $substr = [Console]::In.ReadToEnd()
          Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
using System.Text;
public class NaxieWin32 {
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowTextLength(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
}
"@
          $found = $null
          $callback = {
            param($hwnd, $lparam)
            if ([NaxieWin32]::IsWindowVisible($hwnd)) {
              $len = [NaxieWin32]::GetWindowTextLength($hwnd)
              if ($len -gt 0) {
                $sb = New-Object System.Text.StringBuilder ($len + 1)
                [NaxieWin32]::GetWindowText($hwnd, $sb, $sb.Capacity) | Out-Null
                if ($sb.ToString().ToLower().Contains($substr.ToLower())) { $script:found = $hwnd; return $false }
              }
            }
            return $true
          }
          [NaxieWin32]::EnumWindows($callback, [IntPtr]::Zero) | Out-Null
          if ($found) {
            [NaxieWin32]::ShowWindow($found, 9) | Out-Null
            [NaxieWin32]::SetForegroundWindow($found) | Out-Null
            Write-Output "FOUND"
          } else {
            Write-Output "NOTFOUND"
          }
        `;
        const { stdout } = await runPowerShell(script, target);
        return stdout.includes("FOUND")
          ? `Brought window matching '${target}' to the foreground.`
          : `No visible open window found matching '${target}'.`;
      }
      case "brightness_get": {
        const script = `
          try {
            $m = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1
            if ($m) { Write-Output $m.CurrentBrightness } else { Write-Output "NODISPLAY" }
          } catch { Write-Output "NODISPLAY" }
        `;
        const { stdout } = await runPowerShell(script);
        const val = stdout.trim();
        return val === "NODISPLAY" || !val
          ? "Could not read brightness: no WMI-compatible display found (common on desktop monitors)."
          : `Current screen brightness: ${val}%.`;
      }
      case "brightness_set": {
        if (!target) return "Brightness percentage required (0-100), e.g. target='50'.";
        const pct = clampBrightnessPercent(target);
        if (pct === null) return `Invalid brightness value '${target}' — must be a number 0-100.`;
        const script = `
          try {
            $methods = Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightnessMethods -ErrorAction Stop | Select-Object -First 1
            if ($methods) { Invoke-CimMethod -InputObject $methods -MethodName WmiSetBrightness -Arguments @{ Brightness = ${pct}; Timeout = 0 } | Out-Null; Write-Output "OK" }
            else { Write-Output "NODISPLAY" }
          } catch { Write-Output "NODISPLAY" }
        `;
        const { stdout } = await runPowerShell(script);
        return stdout.includes("OK")
          ? `Screen brightness set to ${pct}%.`
          : "Could not set brightness: no WMI-compatible display found (common on desktop monitors).";
      }
      case "battery_status": {
        const script = `
          $b = Get-CimInstance -ClassName Win32_Battery -ErrorAction SilentlyContinue | Select-Object -First 1
          if ($b) { Write-Output "$($b.EstimatedChargeRemaining)|$($b.BatteryStatus)" } else { Write-Output "NOBATTERY" }
        `;
        const { stdout } = await runPowerShell(script);
        const val = stdout.trim();
        if (val === "NOBATTERY" || !val) return "No battery detected (likely a desktop PC).";
        const [pctStr, statusCode] = val.split("|");
        // Win32_Battery.BatteryStatus: 2 = AC/charging, others = on battery.
        const state = statusCode === "2" ? "charging" : "on battery";
        return `Battery at ${pctStr}% (${state}).`;
      }
      default:
        return `Unknown action: ${action}. Supported: 'open_app', 'take_screenshot', 'volume_mute', 'volume_unmute', 'focus_window', 'brightness_get', 'brightness_set', 'battery_status'.`;
    }
  } catch (e: any) {
    return `System control failed: ${e?.message ?? e}`;
  }
}

// ─── manage_clipboard ────────────────────────────────────────────────────

export async function manageClipboard(action: "read" | "write" = "read", text = ""): Promise<string> {
  if (!isClipboardAllowed()) {
    return "Clipboard access is turned off. Enable it in Settings > System Access to let Naxie read or write your clipboard.";
  }
  try {
    if (action === "write") {
      // text is LLM-controlled; sent over stdin, never spliced into the
      // PowerShell command string.
      await runPowerShell(`$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t`, text);
      return `Text successfully copied to clipboard (${text.length} chars).`;
    }
    const { stdout } = await runPowerShell("Get-Clipboard");
    const content = stdout.trim();
    return content ? `Clipboard contents: ${content}` : "Clipboard is empty.";
  } catch (e: any) {
    return `Clipboard operation failed: ${e?.message ?? e}`;
  }
}

// ─── git_command ─────────────────────────────────────────────────────────
// The ONLY allowed target is the operator-configured gitRepoPath — never a
// path supplied by the LLM. Uses simple-git (already a dependency here)
// rather than shelling raw git commands.

export async function gitCommand(action: "status" | "pull"): Promise<string> {
  // Naxionai's original gates git_command behind the SAME
  // _system_control_allowed() check as system_control/manage_clipboard —
  // this was missed on first port; fixing it now rather than shipping a
  // tool that's less restricted than its own source.
  if (!isSystemControlAllowed()) {
    return "System control is turned off. Enable it in Settings > System Access to let Naxie check or pull the configured git repo.";
  }
  const repoPath = getHostToolsSettings().gitRepoPath.trim();
  if (!repoPath) return "No git repo configured. Set a repo path in Settings > System Access for Naxie to check.";
  if (!existsSync(join(repoPath, ".git"))) return `Configured repo path '${repoPath}' doesn't look like a git repository (no .git directory).`;
  try {
    const { simpleGit } = await import("simple-git");
    const git = simpleGit(repoPath);
    if (action === "status") {
      const branch = (await git.status()).current ?? "(detached HEAD)";
      const status = await git.status();
      const changes = status.files.map(f => `${f.working_dir}${f.index} ${f.path}`).join("\n");
      return `Branch: ${branch}\n` + (changes ? `Changes:\n${changes}` : "Working tree clean.");
    }
    if (action === "pull") {
      // --ff-only equivalent: never auto-merge or auto-resolve a conflict.
      try {
        const result = await git.pull(undefined, undefined, { "--ff-only": null });
        return result.summary.changes || result.summary.insertions || result.summary.deletions
          ? `git pull complete: ${JSON.stringify(result.summary)}`
          : "Already up to date.";
      } catch (e: any) {
        return `git pull failed:\n${e?.message ?? e}`;
      }
    }
    return `Unknown action: ${action}. Supported: 'status', 'pull'.`;
  } catch (e: any) {
    return `git ${action} failed: ${e?.message ?? e}`;
  }
}

// ─── browser_open ────────────────────────────────────────────────────────
// Only a string already prefixed http:// or https:// is opened as-is;
// everything else — including anything trying to look like file://,
// javascript:, or another URI scheme — is wrapped into a search query
// instead, so it's never opened directly. Uses rundll32's FileProtocolHandler
// rather than "cmd.exe /c start", because cmd.exe re-tokenizes its /c
// command line and can reinterpret shell metacharacters (&, |, etc.) even
// when passed as a discrete argv element — rundll32 takes the URL as a
// literal argument with no such re-parsing.
// Pure — only a string already prefixed http:// or https:// passes through
// unmodified; everything else (including anything shaped like file://,
// javascript:, or another URI scheme) is wrapped into a search query instead,
// so it's never opened directly.
export function resolveBrowserTarget(urlOrSearch: string): string {
  const target = urlOrSearch.trim();
  return target.startsWith("http://") || target.startsWith("https://")
    ? target
    : `https://www.google.com/search?q=${encodeURIComponent(target)}`;
}

export async function browserOpen(urlOrSearch: string): Promise<string> {
  try {
    const finalUrl = resolveBrowserTarget(urlOrSearch);
    spawn("rundll32", ["url.dll,FileProtocolHandler", finalUrl], { windowsHide: true, detached: true, stdio: "ignore" }).unref();
    return `Opened web browser to: ${finalUrl}`;
  } catch (e: any) {
    return `Failed to open browser: ${e?.message ?? e}`;
  }
}

// ─── hermes_agent ────────────────────────────────────────────────────────
// Opens the user's locally-installed Hermes agent (Nous Research's
// open-source agent harness, run via its CLI) in its own terminal window.
// Same gate and allowlist posture as system_control's "terminal" open_app
// target above — the command run inside is a fixed literal ("hermes"),
// never user- or LLM-supplied, so there's no free-form string reaching the
// shell. This is a UI-launcher action, not something the agent's planner
// calls itself (Hermes is a peer agent Naxie talks to over HTTP, not a tool
// Naxie invokes) — see routes/host-tools.ts's /hermes/launch.
export async function launchHermesAgent(): Promise<string> {
  if (!isSystemControlAllowed()) {
    return "System control is turned off. Enable it in Settings > System Access to let Naxie open the Hermes agent.";
  }
  try {
    spawn("cmd.exe", ["/c", "start", "Hermes Agent", "cmd.exe", "/k", "hermes"], { windowsHide: false, detached: true, stdio: "ignore" }).unref();
    return "Launched Hermes agent in a new terminal window.";
  } catch (e: any) {
    return `Failed to launch Hermes agent: ${e?.message ?? e}`;
  }
}
