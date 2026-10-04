import time
from typing import Callable
from src.core.models import ExecutionResult

class SelfHealingHarness:
    def __init__(self, max_retries: int = 3):
        self.max_retries = max_retries

    async def execute(self, tool_func: Callable, payload: dict) -> ExecutionResult:
        start_time = time.time()
        current_payload = payload.copy()
        attempts = 0

        while attempts < self.max_retries:
            try:
                result = await tool_func(**current_payload)
                elapsed = (time.time() - start_time) * 1000
                return ExecutionResult(success=True, data=result, execution_time_ms=elapsed)
            except TypeError as te:
                attempts += 1
                msg = str(te)
                if "unexpected keyword argument" in msg:
                    bad_key = msg.split("'")[1] if "'" in msg else None
                    if bad_key and bad_key in current_payload:
                        del current_payload[bad_key]
                        continue
                if attempts >= self.max_retries:
                    break
            except Exception as e:
                attempts += 1
                if attempts >= self.max_retries:
                    elapsed = (time.time() - start_time) * 1000
                    return ExecutionResult(
                        success=False,
                        error=f"{type(e).__name__}: {str(e)}",
                        retries_exhausted=True,
                        execution_time_ms=elapsed
                    )

        elapsed = (time.time() - start_time) * 1000
        return ExecutionResult(
            success=False,
            error="Exceeded maximum self-healing retries",
            retries_exhausted=True,
            execution_time_ms=elapsed
        )
