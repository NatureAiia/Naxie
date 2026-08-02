"""
Digital Force — Naxie Personal Assistant (PA) Tools
Native tools for desktop control, reminders, weather, clipboard, and browser.
"""

import os
import sys
import json
import logging
import subprocess
import webbrowser
import urllib.request
from typing import Optional
from langchain_core.tools import tool

logger = logging.getLogger(__name__)


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
            
            # Windows Toast via PowerShell (built-in, no external library required)
            ps_cmd = f"""
            [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
            [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
            $xml = @"
            <toast>
                <visual>
                    <binding template="ToastGeneric">
                        <text>{title}</text>
                        <text>{message}</text>
                    </binding>
                </visual>
            </toast>
            "@
            $toastXml = [Windows.Data.Xml.Dom.XmlDocument]::new()
            $toastXml.LoadXml($xml)
            $toast = [Windows.UI.Notifications.ToastNotification]::new($toastXml)
            [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("NaxionAI").Show($toast)
            """
            try:
                subprocess.Popen(["powershell", "-NoProfile", "-Command", ps_cmd], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
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
    action: 'open_app' (target='calc'|'notepad'|'chrome'|etc), 'take_screenshot', 'volume_mute', 'volume_unmute'."""
    try:
        act = action.lower().strip()
        if act == "open_app":
            if not target:
                return "App target name required (e.g. 'notepad', 'calc', 'chrome')."
            subprocess.Popen(["cmd.exe", "/c", "start", target], shell=True)
            return f"Launched application '{target}'."

        elif act == "take_screenshot":
            import tempfile
            tmp_file = os.path.join(tempfile.gettempdir(), f"naxie_screenshot_{int(subprocess.time.time())}.png")
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

        return f"Unknown action: {action}. Supported: 'open_app', 'take_screenshot', 'volume_mute'."
    except Exception as e:
        return f"System control failed: {e}"


@tool
def manage_clipboard(action: str = "read", text: str = "") -> str:
    """Read or write text to the Windows Clipboard.
    action: 'read' (returns clipboard text) or 'write' (copies 'text' to clipboard)."""
    try:
        act = action.lower().strip()
        if act == "write":
            ps_cmd = f"Set-Clipboard -Value '{text}'"
            subprocess.run(["powershell", "-NoProfile", "-Command", ps_cmd], check=True)
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
