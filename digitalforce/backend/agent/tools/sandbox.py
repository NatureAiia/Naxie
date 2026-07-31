"""
Digital Force — Sandbox Execution Tool
Provides a Local subprocess runner for all agents to execute Python/Playwright scraping code.
"""

import json
import logging
import asyncio
import os
import sys
import tempfile
from pathlib import Path

logger = logging.getLogger(__name__)


def _host_exec_allowed() -> tuple[bool, str]:
    """Guard: this "sandbox" is a plain local subprocess as the current OS user —
    no isolation. Agent-authored code is prompt-injectable, so running it on the
    host in production is arbitrary RCE. Refuse in production unless the operator
    explicitly accepted the risk via `allow_host_code_exec` (dev always allowed)."""
    try:
        from config import get_settings
        s = get_settings()
    except Exception:
        # No settings available (e.g. isolated test import) → be permissive only
        # when we can't prove we're in production.
        return True, ""
    if s.is_production and not s.allow_host_code_exec:
        return False, (
            "Code execution is disabled in production. `execute_python` runs code in a local "
            "subprocess with no isolation, which is arbitrary host RCE. Set ALLOW_HOST_CODE_EXEC=1 "
            "to explicitly accept this risk, or wire a real isolated sandbox."
        )
    return True, ""

# Generated code runs with only what it needs to start Python and hit the
# network — NOT the full parent environment, which holds every API key,
# JWT secret, and DB URL this process has. Trims a large secret-exfiltration
# surface without needing real process isolation.
_SANDBOX_ENV_ALLOWLIST = (
    "PATH", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP",
    "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "COMSPEC", "PATHEXT",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "REQUESTS_CA_BUNDLE",
)


def _sandbox_env() -> dict:
    return {k: v for k, v in os.environ.items() if k.upper() in _SANDBOX_ENV_ALLOWLIST}


def is_playwright_used(code: str) -> bool:
    """Detect if the generated script uses Playwright."""
    return "playwright" in code.lower() or "async_playwright" in code

async def run_in_e2b(code: str, function_name: str = None, test_args: dict = None) -> dict:
    """
    Execute generated code using a local subprocess.
    Maintains the 'run_in_e2b' signature for backwards compatibility but does not use E2B.
    """
    allowed, reason = _host_exec_allowed()
    if not allowed:
        logger.warning("[Sandbox] Refused host code execution: %s", reason)
        return {"success": False, "error": reason, "output": "", "sandbox": "disabled"}

    uses_playwright = is_playwright_used(code)

    if function_name:
        test_code = f"import asyncio\n{code}\n\nasync def _test():\n    return await {function_name}(**{json.dumps(test_args or {})})\n\nprint('RESULT:', asyncio.run(_test()))"
    else:
        test_code = code

    logger.info("[Sandbox] Running code in Local Subprocess Sandbox...")
    
    with tempfile.NamedTemporaryFile(mode='w', suffix='.py', delete=False, encoding='utf-8') as f:
        f.write(test_code)
        temp_path = f.name
        
    try:
        # Run local subprocess with 30 second timeout
        process = await asyncio.create_subprocess_exec(
            sys.executable, temp_path,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            env=_sandbox_env(),
        )
        try:
            stdout, stderr = await asyncio.wait_for(process.communicate(), timeout=30.0)
        except asyncio.TimeoutError:
            process.kill()
            return {"success": False, "error": "Execution timed out after 30 seconds."}

        output = stdout.decode(errors='replace').strip()
        error = stderr.decode(errors='replace').strip()
        
        sandbox_type = "local_playwright" if uses_playwright else "local_standard"
        
        # Determine success. A non-zero exit is always a failure. On exit 0, when
        # we wrapped a function call we REQUIRE the injected `RESULT:` sentinel to
        # be present — its absence means the function never returned (silent
        # failure) rather than assuming success from empty output. For raw code,
        # exit 0 with no explicit failure signal is a success.
        if process.returncode != 0:
            return {"success": False, "error": error or output, "output": output, "sandbox": sandbox_type}

        if function_name and "RESULT:" not in output:
            return {"success": False, "error": "function did not return a RESULT sentinel (silent failure)",
                    "output": output, "sandbox": sandbox_type}

        success = ("'success': false" not in output.lower())
        return {"success": success, "output": output, "error": error if error else None, "sandbox": sandbox_type}
        
    except Exception as e:
        logger.error("Local execution failed: %s", str(e), exc_info=True)
        return {"success": False, "error": str(e)}
    finally:
        try:
            Path(temp_path).unlink(missing_ok=True)
        except Exception:
            pass
