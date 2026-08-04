"""
NAXIONAI — Naxie Personal Assistant (PA) Tools
Native tools for desktop control, reminders, weather, clipboard, and browser.
"""

import os
import sys
import json
import time
import logging
import subprocess
import webbrowser
import urllib.request
import urllib.parse
from typing import Optional
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


def _system_control_allowed() -> tuple[bool, str]:
    """Guard for tools that act directly on the host (launch apps, clipboard).
    Same reasoning as sandbox.py's _host_exec_allowed: these are driven by LLM
    output that can be steered by prompt-injected content (chat, RAG, web
    results), so refuse in production unless the operator opts in."""
    try:
        from config import get_settings
        s = get_settings()
    except Exception:
        return True, ""
    if s.is_production and not s.allow_system_control:
        return False, (
            "System control is disabled in production. `system_control` / `manage_clipboard` act "
            "directly on the host (launch apps, read/write clipboard) and are driven by LLM output "
            "that can be steered by prompt-injected content. Set ALLOW_SYSTEM_CONTROL=1 to explicitly "
            "accept this risk."
        )
    return True, ""


# Only these apps can be launched via system_control('open_app', ...) — the
# target string comes from LLM output, which can be steered by injected
# content, so it must resolve through a fixed allowlist rather than being
# passed straight to a shell.
_APP_ALLOWLIST = {
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


def _win32_focus_window_by_title(substr: str) -> bool:
    """Bring the first visible top-level window whose title contains `substr`
    (case-insensitive) to the foreground. Pure ctypes — no pywin32 dependency.
    Windows refuses SetForegroundWindow from a background process unless its
    thread input is attached to the current foreground window's thread first,
    hence the AttachThreadInput dance around it."""
    if sys.platform != "win32":
        return False
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    kernel32 = ctypes.windll.kernel32
    found: list = []

    @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    def _enum_callback(hwnd, _lparam):
        if not user32.IsWindowVisible(hwnd):
            return True
        length = user32.GetWindowTextLengthW(hwnd)
        if length == 0:
            return True
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        if substr.lower() in buf.value.lower():
            found.append(hwnd)
            return False
        return True

    user32.EnumWindows(_enum_callback, 0)
    if not found:
        return False

    hwnd = found[0]
    SW_RESTORE = 9
    user32.ShowWindow(hwnd, SW_RESTORE)

    foreground_hwnd = user32.GetForegroundWindow()
    current_thread_id = kernel32.GetCurrentThreadId()
    target_thread_id = user32.GetWindowThreadProcessId(hwnd, None)
    foreground_thread_id = user32.GetWindowThreadProcessId(foreground_hwnd, None) if foreground_hwnd else current_thread_id

    user32.AttachThreadInput(foreground_thread_id, target_thread_id, True)
    try:
        user32.BringWindowToTop(hwnd)
        user32.SetForegroundWindow(hwnd)
    finally:
        user32.AttachThreadInput(foreground_thread_id, target_thread_id, False)
    return True


@tool
async def get_weather(location: str = "auto") -> str:
    """Fetch live weather conditions and forecast for a city or current location (using Open-Meteo free API).
    Example location: 'London', 'New York', 'Tokyo', or 'auto'."""
    try:
        # Default coordinates for auto (or geocode location)
        lat, lon, loc_name = 51.5074, -0.1278, "London"  # Default fallback
        
        if location and location.lower() != "auto":
            # Geocode city via Open-Meteo Geocoding API
            geo_url = f"https://geocoding-api.open-meteo.com/v1/search?name={urllib.parse.quote(location)}&count=1&language=en&format=json"
            req = urllib.request.Request(geo_url, headers={"User-Agent": "NaxionAI/1.0"})
            with urllib.request.urlopen(req, timeout=5) as resp:
                data = json.loads(resp.read().decode())
                if data.get("results"):
                    first = data["results"][0]
                    lat = first.get("latitude", lat)
                    lon = first.get("longitude", lon)
                    loc_name = f"{first.get('name')}, {first.get('country_code', '').upper()}"

        # Fetch weather data
        weather_url = f"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}&current_weather=true&hourly=temperature_2m,relativehumidity_2m,windspeed_10m"
        req = urllib.request.Request(weather_url, headers={"User-Agent": "NaxionAI/1.0"})
        with urllib.request.urlopen(req, timeout=5) as resp:
            wdata = json.loads(resp.read().decode())
            current = wdata.get("current_weather", {})
            temp_c = current.get("temperature")
            wind = current.get("windspeed")
            code = current.get("weathercode", 0)

            # Map weather codes
            weather_descriptions = {
                0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
                45: "Foggy", 51: "Light drizzle", 61: "Slight rain", 63: "Moderate rain",
                71: "Slight snow", 80: "Rain showers", 95: "Thunderstorm"
            }
            desc = weather_descriptions.get(code, "Clear")
            return f"Weather for {loc_name}: {temp_c}°C ({desc}), Wind speed: {wind} km/h."
    except Exception as e:
        logger.error(f"[PA Tools] Weather error: {e}")
        return f"Could not retrieve weather: {e}"


@tool
async def set_reminder(title: str, message: str, delay_seconds: int = 0) -> str:
    """Set a desktop notification reminder for the user.
    title: Notification header (e.g. 'Meeting in 10 mins')
    message: Body text (e.g. 'Call John on Zoom')
    delay_seconds: Seconds to wait before popping notification (0 for immediate)"""
    try:
        import asyncio

        async def _trigger():
            if delay_seconds > 0:
                await asyncio.sleep(delay_seconds)

            # title/message are LLM-controlled text. They used to be spliced
            # directly into a PowerShell double-quoted here-string, which both
            # interpolates "$(...)" subexpressions AND can be broken out of
            # with an embedded newline + '"@' — i.e. arbitrary PowerShell
            # execution from chat/RAG/web content. Send them over stdin as
            # JSON instead so they're never parsed as PowerShell source, and
            # XML-escape before dropping them into the toast markup.
            ps_cmd = """
            $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
            $titleEsc = [System.Security.SecurityElement]::Escape($data.title)
            $msgEsc = [System.Security.SecurityElement]::Escape($data.message)
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
            [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
            $xml = "<toast><visual><binding template='ToastGeneric'><text>$titleEsc</text><text>$msgEsc</text></binding></visual></toast>"
            $toastXml = [Windows.Data.Xml.Dom.XmlDocument]::new()
            $toastXml.LoadXml($xml)
            $toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NaxionAI").Show($toast)
            """
            try:
                proc = await asyncio.create_subprocess_exec(
                    "powershell", "-NoProfile", "-Command", ps_cmd,
                    stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
                )
                await proc.communicate(input=json.dumps({"title": title, "message": message}).encode())
            except Exception:
                pass

        asyncio.create_task(_trigger())
        if delay_seconds > 0:
            return f"Reminder set: '{title}' will trigger in {delay_seconds} seconds."
        return f"Reminder notification sent: '{title}'"
    except Exception as e:
        return f"Failed to set reminder: {e}"


@tool
def system_control(action: str, target: str = "") -> str:
    """Perform OS system actions on Windows.
    action: 'open_app' (target='calc'|'notepad'|'chrome'|etc), 'take_screenshot', 'volume_mute', 'volume_unmute',
    'focus_window' (target=window title or substring, e.g. 'chrome', 'cursor' — brings a matching open window to the foreground),
    'brightness_get', 'brightness_set' (target='0'-'100'), 'battery_status'."""
    allowed, reason = _system_control_allowed()
    if not allowed:
        return reason
    try:
        act = action.lower().strip()
        if act == "open_app":
            if not target:
                return "App target name required (e.g. 'notepad', 'calc', 'chrome')."
            # target is LLM-controlled; it used to go straight into a shell
            # command line ("cmd /c start <target>" with shell=True), where
            # metacharacters like '&' or '|' let injected content chain
            # arbitrary commands. Resolve through a fixed allowlist instead.
            exe = _APP_ALLOWLIST.get(target.lower().strip())
            if not exe:
                return f"App '{target}' is not in the allowed list: {', '.join(sorted(set(_APP_ALLOWLIST.values())))}."
            subprocess.Popen(["cmd.exe", "/c", "start", "", exe])
            return f"Launched application '{target}'."

        elif act == "take_screenshot":
            import tempfile
            tmp_file = os.path.join(tempfile.gettempdir(), f"naxie_screenshot_{int(time.time())}.png")
            # PowerShell screenshot snippet
            ps_cmd = f"""
            Add-Type -AssemblyName System.Windows.Forms
            $screen = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds
            $bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
            $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
            $graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
            $bitmap.Save('{tmp_file}')
            """
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], check=True)
            return f"Screenshot captured and saved to: {tmp_file}"

        elif act in ("volume_mute", "volume_unmute"):
            ps_cmd = "$wsh = New-Object -ComObject WScript.Shell; $wsh.SendKeys([char]173)"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd])
            return f"System volume toggled."

        elif act == "focus_window":
            if not target:
                return "Window title (or substring) required, e.g. 'chrome', 'notepad', 'cursor'."
            ok = _win32_focus_window_by_title(target)
            return (
                f"Brought window matching '{target}' to the foreground."
                if ok else f"No visible open window found matching '{target}'."
            )

        elif act == "brightness_get":
            try:
                import wmi
                w = wmi.WMI(namespace="wmi")
                monitors = w.WmiMonitorBrightness()
                if not monitors:
                    return "Could not read brightness: no WMI-compatible display found (common on desktop monitors)."
                return f"Current screen brightness: {monitors[0].CurrentBrightness}%."
            except ImportError:
                return "Brightness control requires the 'wmi' package. Install it with: pip install wmi"
            except Exception as e:
                return f"Failed to read brightness: {e}"

        elif act == "brightness_set":
            if not target:
                return "Brightness percentage required (0-100), e.g. target='50'."
            try:
                pct = max(0, min(100, int(target.strip().rstrip("%"))))
            except ValueError:
                return f"Invalid brightness value '{target}' — must be a number 0-100."
            try:
                import wmi
                w = wmi.WMI(namespace="wmi")
                brightness_methods = w.WmiMonitorBrightnessMethods()
                if not brightness_methods:
                    return "Could not set brightness: no WMI-compatible display found (common on desktop monitors)."
                brightness_methods[0].WmiSetBrightness(pct, 0)
                return f"Screen brightness set to {pct}%."
            except ImportError:
                return "Brightness control requires the 'wmi' package. Install it with: pip install wmi"
            except Exception as e:
                return f"Failed to set brightness: {e}"

        elif act == "battery_status":
            try:
                import psutil
                batt = psutil.sensors_battery()
                if batt is None:
                    return "No battery detected (likely a desktop PC)."
                state = "charging" if batt.power_plugged else "on battery"
                return f"Battery at {batt.percent:.0f}% ({state})."
            except Exception as e:
                return f"Failed to read battery status: {e}"

        return (
            f"Unknown action: {action}. Supported: 'open_app', 'take_screenshot', 'volume_mute', "
            "'focus_window', 'brightness_get', 'brightness_set', 'battery_status'."
        )
    except Exception as e:
        return f"System control failed: {e}"


@tool
def manage_clipboard(action: str = "read", text: str = "") -> str:
    """Read or write text to the Windows Clipboard.
    action: 'read' (returns clipboard text) or 'write' (copies 'text' to clipboard)."""
    allowed, reason = _system_control_allowed()
    if not allowed:
        return reason
    try:
        act = action.lower().strip()
        if act == "write":
            # text is LLM-controlled; it used to be spliced into the PowerShell
            # command line inside single quotes ("Set-Clipboard -Value '...'"),
            # so an embedded quote broke out of the string and let injected
            # content run arbitrary PowerShell. Send it over stdin instead —
            # it's then just data, never parsed as script source.
            ps_cmd = "$t = [Console]::In.ReadToEnd(); Set-Clipboard -Value $t"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], input=text, text=True, check=True)
            return f"Text successfully copied to clipboard ({len(text)} chars)."
        else:
            ps_cmd = "Get-Clipboard"
            res = subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], capture_output=True, text=True)
            clip_content = res.stdout.strip()
            return f"Clipboard contents: {clip_content}" if clip_content else "Clipboard is empty."
    except Exception as e:
        return f"Clipboard operation failed: {e}"


@tool
def browser_open(url_or_search: str) -> str:
    """Open a URL or perform a web search in the user's default web browser.
    url_or_search: e.g. 'https://google.com' or 'latest AI news'."""
    try:
        target = url_or_search.strip()
        if not target.startswith("http://") and not target.startswith("https://"):
            target = f"https://www.google.com/search?q={urllib.parse.quote(target)}"
        webbrowser.open(target)
        return f"Opened web browser to: {target}"
    except Exception as e:
        return f"Failed to open browser: {e}"


def get_pa_tools():
    """Return list of all PA personal assistant tools."""
    return [get_weather, set_reminder, system_control, manage_clipboard, browser_open]
