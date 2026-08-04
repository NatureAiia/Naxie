import sys
import asyncio

if sys.platform == 'win32':
    # Explicitly set Proactor event loop policy (required by Playwright)
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())
    
    # Intercept any attempts from Uvicorn's setup_event_loop to override this with SelectorEventLoop
    _original_set_policy = asyncio.set_event_loop_policy
    def _intercept_set_policy(policy):
        if isinstance(policy, asyncio.WindowsSelectorEventLoopPolicy):
            # Block the incompatible policy!
            return
        _original_set_policy(policy)
    asyncio.set_event_loop_policy = _intercept_set_policy

import uvicorn

if __name__ == "__main__":
    # We pass the application as an import string to support reload.
    # Reload is dev-only — gate it on DEBUG so production never runs the reloader.
    from config import get_settings
    import os
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port, reload=get_settings().debug)
