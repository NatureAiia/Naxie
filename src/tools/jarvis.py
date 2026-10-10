"""JARVIS skills for Naxie — presence, awareness, and host control.

Ports docs/naxie-architecture.md §2.2 behavior into the Python gateway:
weather, reminders/toasts, system control, clipboard, git, browser-open —
plus always-safe senses: time, calculator, system status, voice output.

Security posture (mirrors naxionai/server host-tools.ts):
- system_control / manage_clipboard / git_command are gated behind an
  explicit settings toggle (default OFF, fail CLOSED on any read error).
- Reminder/clipboard text travels over the subprocess STDIN, never
  interpolated into the PowerShell command string.
- open_app resolves only through a fixed allowlist; git touches exactly one
  operator-configured repo path; browser_open only opens http(s) as-is.
"""
from __future__ import annotations

import asyncio
import ast
import json
import math
import os
import re
import shutil
import webbrowser
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

WORKSPACE_ROOT = Path(__file__).resolve().parents[2]
STATE_DIR = WORKSPACE_ROOT / ".naxion"
SETTINGS_FILE = STATE_DIR / "host-tools-settings.json"

APP_ALLOWLIST = {
    "calc": "calc.exe", "calculator": "calc.exe",
    "notepad": "notepad.exe",
    "explorer": "explorer.exe", "files": "explorer.exe",
    "chrome": "chrome", "google chrome": "chrome",
    "edge": "msedge", "microsoft edge": "msedge",
    "firefox": "firefox",
    "word": "winword", "excel": "excel", "outlook": "outlook",
    "paint": "mspaint.exe",
    "terminal": "wt.exe", "cmd": "cmd.exe",
}

DEFAULT_SETTINGS = {
    "allow_system_control": False,
    "allow_clipboard": False,
    "allow_notifications": True,
    "git_repo_path": "",
}


def _load_settings() -> Dict[str, Any]:
    try:
        if not SETTINGS_FILE.exists():
            return dict(DEFAULT_SETTINGS)
        return {**DEFAULT_SETTINGS, **json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))}
    except Exception:
        return dict(DEFAULT_SETTINGS)  # fail closed: everything stays OFF


def _save_settings(patch: Dict[str, Any]) -> Dict[str, Any]:
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    current = _load_settings()
    current.update({k: v for k, v in patch.items() if k in DEFAULT_SETTINGS})
    SETTINGS_FILE.write_text(json.dumps(current, indent=2), encoding="utf-8")
    return current


def _system_allowed() -> bool:
    try:
        return _load_settings().get("allow_system_control") is True
    except Exception:
        return False


def _clipboard_allowed() -> bool:
    try:
        return _load_settings().get("allow_clipboard") is True
    except Exception:
        return False


def _notify_allowed() -> bool:
    try:
        return _load_settings().get("allow_notifications") is True
    except Exception:
        return False


def _git_repo() -> Path | None:
    raw = _load_settings().get("git_repo_path") or os.environ.get("GIT_REPO_PATH", "")
    if not raw:
        return None
    p = Path(raw).expanduser().resolve()
    if not (p / ".git").exists():
        return None
    return p


async def _powershell(script: str, stdin_data: str | None = None, timeout_s: int = 20) -> Dict[str, Any]:
    try:
        proc = await asyncio.create_subprocess_exec(
            "powershell", "-NoProfile", "-Command", script,
            stdin=asyncio.subprocess.PIPE if stdin_data is not None else asyncio.subprocess.DEVNULL,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
    except FileNotFoundError:
        raise RuntimeError("PowerShell unavailable on this host")
    try:
        out, err = await asyncio.wait_for(
            proc.communicate(stdin_data.encode() if stdin_data is not None else None),
            timeout=timeout_s,
        )
    except asyncio.TimeoutError:
        proc.kill()
        raise TimeoutError("PowerShell call timed out")
    return {"code": proc.returncode,
            "stdout": out.decode(errors="replace")[:4000],
            "stderr": err.decode(errors="replace")[:1000]}


# ---- always-safe senses ----

async def get_time(timezone_name: str = "local") -> Dict[str, Any]:
    now_utc = datetime.now(timezone.utc)
    if timezone_name and timezone_name.lower() != "local":
        try:
            from zoneinfo import ZoneInfo
            local = now_utc.astimezone(ZoneInfo(timezone_name))
            label = timezone_name
        except Exception:
            local = now_utc.astimezone()
            label = "local (unknown zone, fell back)"
    else:
        local = now_utc.astimezone()
        label = "local"
    return {"zone": label, "time": local.strftime("%H:%M:%S"),
            "date": local.strftime("%Y-%m-%d (%A)"), "iso": local.isoformat()}


async def calculate(expression: str) -> Dict[str, Any]:
    allowed_funcs = {"sqrt": math.sqrt, "sin": math.sin, "cos": math.cos,
                     "tan": math.tan, "log": math.log, "exp": math.exp,
                     "floor": math.floor, "ceil": math.ceil, "abs": abs, "round": round}
    allowed_nodes = (ast.Expression, ast.BinOp, ast.UnaryOp, ast.Constant,
                     ast.Add, ast.Sub, ast.Mult, ast.Div, ast.FloorDiv,
                     ast.Mod, ast.Pow, ast.USub, ast.UAdd, ast.Call,
                     ast.Load, ast.Name, ast.Tuple)
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as e:
        raise ValueError(f"Bad expression: {e}")
    for node in ast.walk(tree):
        if not isinstance(node, allowed_nodes):
            raise ValueError(f"Blocked in expression: {type(node).__name__}")
        if isinstance(node, ast.Name) and node.id not in allowed_funcs | {"pi", "e"}:
            raise ValueError(f"Unknown name: {node.id}")
        if isinstance(node, ast.Call) and not (isinstance(node.func, ast.Name) and node.func.id in allowed_funcs):
            raise ValueError("Only math functions allowed")
    env = {"pi": math.pi, "e": math.e, **allowed_funcs, "__builtins__": {}}
    try:
        value = eval(compile(tree, "<calc>", "eval"), env)  # noqa: S307 — AST-gated above
    except Exception as e:
        raise ValueError(f"Could not evaluate: {e}")
    if isinstance(value, float) and (math.isinf(value) or math.isnan(value)):
        raise ValueError("Result is not a finite number")
    return {"expression": expression, "result": value}


async def system_status() -> Dict[str, Any]:
    info: Dict[str, Any] = {"cpu_count": os.cpu_count()}
    try:
        import psutil  # optional
        info.update({
            "cpu_percent": psutil.cpu_percent(interval=0.2),
            "memory_percent": psutil.virtual_memory().percent,
            "disk_percent": psutil.disk_usage(str(WORKSPACE_ROOT)).percent,
        })
        try:
            b = psutil.sensors_battery()
            info["battery"] = {"percent": b.percent, "plugged": b.power_plugged} if b else None
        except Exception:
            info["battery"] = None
        info["source"] = "psutil"
    except ImportError:
        total, used, _free = shutil.disk_usage(str(WORKSPACE_ROOT))
        info.update({"disk_percent": round(used / total * 100, 1), "source": "fallback (psutil not installed)"})
    return info


async def get_weather(location: str = "auto", timeout_s: int = 8) -> Dict[str, Any]:
    import httpx

    lat, lon, name = 51.5074, -0.1278, "London"
    loc = (location or "auto").strip()
    try:
        async with httpx.AsyncClient(timeout=timeout_s, headers={"User-Agent": "Naxie/1.0"}) as c:
            if loc.lower() != "auto":
                geo = await c.get("https://geocoding-api.open-meteo.com/v1/search",
                                  params={"name": loc, "count": 1, "language": "en", "format": "json"})
                first = (geo.json().get("results") or [None])[0]
                if first:
                    lat = first.get("latitude", lat)
                    lon = first.get("longitude", lon)
                    name = f"{first.get('name', loc)}, {(first.get('country_code') or '').upper()}"
            w = await c.get("https://api.open-meteo.com/v1/forecast",
                            params={"latitude": lat, "longitude": lon, "current_weather": True, "timezone": "auto"})
            cur = w.json().get("current_weather", {}) or {}
    except Exception as e:
        return {"location": loc, "error": f"Could not retrieve weather: {e}"}
    desc = {0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
            45: "Foggy", 51: "Light drizzle", 61: "Slight rain",
            63: "Moderate rain", 71: "Slight snow", 80: "Rain showers", 95: "Thunderstorm"}.get(
        cur.get("weathercode"), "Clear")
    text = f"{desc}, {cur.get('temperature', '-')}C, wind {cur.get('windspeed', '-')} km/h — {name}"
    return {"location": name, "description": desc, "temperature_c": cur.get("temperature"),
            "wind_kmh": cur.get("windspeed"), "observed": cur.get("time"), "text": text}


# ---- notifications / reminders ----

TOAST_SCRIPT = """
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
"""

REMINDERS: List[Dict[str, Any]] = []
_reminder_seq = 0


async def notify_toast(title: str, message: str) -> Dict[str, Any]:
    if not _notify_allowed():
        raise PermissionError("Notifications are OFF — enable Settings > System Access > allowNotifications")
    try:
        await _powershell(TOAST_SCRIPT, stdin_data=json.dumps({"title": title[:100], "message": message[:300]}))
    except Exception as e:
        return {"sent": False, "note": f"Toast failed (best-effort): {e}"}
    return {"sent": True, "title": title}


async def set_reminder(title: str, message: str = "", delay_seconds: int = 0) -> Dict[str, Any]:
    global _reminder_seq
    _reminder_seq += 1
    rid = _reminder_seq
    entry = {"id": rid, "title": title[:100], "message": message[:300],
             "delay_seconds": max(0, delay_seconds), "fired": False}
    REMINDERS.append(entry)

    async def _fire():
        if entry["delay_seconds"]:
            await asyncio.sleep(entry["delay_seconds"])
        try:
            await notify_toast(entry["title"], entry["message"] or entry["title"])
        except Exception:
            pass  # best-effort delivery
        entry["fired"] = True

    asyncio.ensure_future(_fire())
    when = "now" if not entry["delay_seconds"] else f"in {entry['delay_seconds']}s"
    return {"id": rid, "scheduled": when, "title": entry["title"]}


async def list_reminders() -> Dict[str, Any]:
    return {"reminders": [dict(r) for r in REMINDERS[-20:]]}


# ---- gated host control ----

def _need_system() -> None:
    if not _system_allowed():
        raise PermissionError("System control is OFF — enable allow_system_control in .naxion/host-tools-settings.json")


async def system_control(action: str, target: str = "") -> Dict[str, Any]:
    _need_system()
    a = action.strip().lower()
    if a == "open_app":
        exe = APP_ALLOWLIST.get(target.lower().strip())
        if not exe:
            raise ValueError(f"App '{target}' not allowed. Allowed: {sorted(set(APP_ALLOWLIST))}")
        if os.name == "nt":
            await asyncio.create_subprocess_exec("cmd.exe", "/c", "start", "", exe,
                                                 stdout=asyncio.subprocess.DEVNULL,
                                                 stderr=asyncio.subprocess.DEVNULL)
        else:
            raise RuntimeError("open_app is Windows-only on this host")
        return {"action": a, "launched": target}
    if a in ("volume_mute", "volume_unmute"):
        await _powershell("$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]173)")
        return {"action": a, "done": True}
    if a == "battery_status":
        st = await system_status()
        return {"action": a, "battery": st.get("battery")}
    if a == "take_screenshot":
        tmp = str(Path(os.environ.get("TEMP", ".")) / f"naxie_shot_{int(datetime.now().timestamp())}.png")
        await _powershell(
            "Add-Type -AssemblyName System.Windows.Forms\n"
            "$s=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds\n"
            "$b=New-Object System.Drawing.Bitmap $s.Width,$s.Height\n"
            "[System.Drawing.Graphics]::FromImage($b).CopyFromScreen($s.Location,[System.Drawing.Point]::Empty,$s.Size)\n"
            f"$b.Save('{tmp.replace(chr(39), chr(39)*2)}')")
        return {"action": a, "path": tmp}
    if a == "focus_window":
        if not target:
            raise ValueError("focus_window needs a window title substring")
        script = ("$substr=[Console]::In.ReadToEnd()\n"
                  "$s=Get-Process | Where-Object {$_.MainWindowTitle -like \"*$substr*\"} | Select-Object -First 1\n"
                  "if($s){Write-Output 'FOUND'} else {Write-Output 'NOTFOUND'}")
        out = await _powershell(script, stdin_data=target)
        found = "FOUND" in out["stdout"]
        return {"action": a, "target": target, "focused": found}
    if a == "brightness_get":
        out = await _powershell(
            "try{$m=Get-CimInstance -Namespace root/wmi -ClassName WmiMonitorBrightness -ErrorAction Stop | Select-Object -First 1\n"
            "if($m){Write-Output $m.CurrentBrightness}else{Write-Output 'NODISPLAY'}}catch{Write-Output 'NODISPLAY'}")
        return {"action": a, "brightness": out["stdout"].strip()}
    raise ValueError(f"Unknown system_control action '{action}'")


async def manage_clipboard(action: str = "read", text: str = "") -> Dict[str, Any]:
    if not _clipboard_allowed():
        raise PermissionError("Clipboard access is OFF — enable allow_clipboard in .naxion/host-tools-settings.json")
    if action == "write":
        await _powershell("$t=[Console]::In.ReadToEnd()\nSet-Clipboard -Value $t", stdin_data=text)
        return {"action": "write", "chars": len(text)}
    out = await _powershell("[Console]::Out.Write((Get-Clipboard -Raw))")
    return {"action": "read", "content": out["stdout"][:4000]}


async def git_command(action: str) -> Dict[str, Any]:
    _need_system()  # git mutates the repo — same gate as system_control
    repo = _git_repo()
    if repo is None:
        raise RuntimeError("No git repo configured — set git_repo_path in .naxion/host-tools-settings.json")
    a = action.strip().lower()
    if a == "status":
        args = ["status", "--short", "--branch"]
    elif a == "pull":
        args = ["pull", "--ff-only"]
    else:
        raise ValueError(f"git_command allows status|pull, not '{action}'")
    proc = await asyncio.create_subprocess_exec(
        "git", "-C", str(repo), *args,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    out, err = await asyncio.wait_for(proc.communicate(), timeout=60)
    return {"action": a, "repo": str(repo), "returncode": proc.returncode,
            "stdout": out.decode(errors="replace")[:4000],
            "stderr": err.decode(errors="replace")[:1000]}


async def browser_open(url_or_search: str) -> Dict[str, Any]:
    q = (url_or_search or "").strip()
    if re.match(r"https?://", q, re.I):
        url = q  # opened as-is; only http(s) ever opens directly
    else:
        from urllib.parse import quote_plus
        url = f"https://www.google.com/search?q={quote_plus(q[:300])}"
    try:
        webbrowser.open(url)
    except Exception as e:
        return {"opened": url, "note": f"Browser launch failed: {e}"}
    return {"opened": url}


async def speak(text: str) -> Dict[str, Any]:
    """Voice output (JARVIS speaks). Gated like notifications; best-effort."""
    if not _notify_allowed():
        raise PermissionError("Voice output follows the notifications toggle, which is OFF")
    script = ("$t=[Console]::In.ReadToEnd()\n"
              "Add-Type -AssemblyName System.Speech\n"
              "$s=New-Object System.Speech.Synthesis.SpeechSynthesizer\n"
              "$s.Speak($t)")
    try:
        await _powershell(script, stdin_data=text[:1000])
    except Exception as e:
        return {"spoken": False, "note": f"TTS unavailable: {e}"}
    return {"spoken": True, "chars": len(text)}


async def host_settings(action: str = "show", key: str = "", value: str = "") -> Dict[str, Any]:
    """Inspect (or flip) Naxie's own System Access toggles."""
    if action == "show":
        s = _load_settings()
        return {"settings": {k: (v if k != "git_repo_path" or not v else v) for k, v in s.items()}}
    if action == "set":
        if key not in DEFAULT_SETTINGS:
            raise ValueError(f"Unknown setting '{key}'. Keys: {sorted(DEFAULT_SETTINGS)}")
        parsed: Any = value
        if isinstance(DEFAULT_SETTINGS[key], bool):
            parsed = value.strip().lower() in ("1", "true", "on", "yes")
        return {"settings": _save_settings({key: parsed})}
    raise ValueError("host_settings allows show|set")
