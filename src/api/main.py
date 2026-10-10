import uuid
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from src.core.router import CognitiveRouter
from src.core.models import ProcessingTier
from src.security.guardrails import CognitiveGuardrails
from src.agents.critic import CriticAgent
from src.agents.planner import build_plan
from src.agents.executor import DelegatingExecutor
from src.tools.registry import allowed_tools

app = FastAPI(
    title="NaxionAI Powered by Neuroworks",
    version="1.1.0",
    description="Cognitive Multi-Agent Neural Swarm Gateway"
)

router = CognitiveRouter(complexity_threshold=0.65)
guardrails = CognitiveGuardrails()
critic = CriticAgent(allowed_tools=allowed_tools())
executor = DelegatingExecutor(critic=critic)

class QueryRequest(BaseModel):
    session_id: str = "default_session"
    prompt: str

class QueryResponse(BaseModel):
    request_id: str
    tier: ProcessingTier
    routing_reason: str
    result: str
    success: bool = True
    suggested_subagents: list[str] = []
    steps: list[dict] = []

@app.get("/health")
def health_check():
    return {"status": "healthy", "engine": "Neuroworks Cognitive Core v1.1", "tools": allowed_tools()}

@app.post("/v1/process", response_model=QueryResponse)
async def process_task(req: QueryRequest):
    valid, sanitized_or_err = guardrails.sanitize_input(req.prompt)
    if not valid:
        raise HTTPException(status_code=400, detail=sanitized_or_err)

    decision = router.evaluate(sanitized_or_err)
    plan, suggested = build_plan(sanitized_or_err)

    only_suggestion = len(plan.steps) == 1 and plan.steps[0].get("tool") == "suggest_subagent"

    if decision.tier == ProcessingTier.SYSTEM_1_FAST and only_suggestion:
        # Small talk / no tool fits — answer directly but still delegate by suggesting owners.
        output = (
            f"Naxie: '{sanitized_or_err}' looks conversational — no tool needed. "
            f"Suggested subagent(s) if this becomes a task: {', '.join(suggested)}."
        )
        safe_output = guardrails.sanitize_output(output)
        return QueryResponse(
            request_id=str(uuid.uuid4()),
            tier=decision.tier,
            routing_reason=decision.reason,
            result=safe_output,
            success=True,
            suggested_subagents=suggested,
            steps=[],
        )

    # System-2 or a fast-path task with real tools — actually execute.
    result = await executor.execute(plan)
    if result.success:
        rendered = [f"[{s['tool']}] ok" for s in (result.data or {}).get("steps", [])]
        output = f"Executed {len(rendered)} step(s) via {', '.join(rendered)}. " if rendered else "Executed plan. "
        # Surface key data (file content, command output) inline, truncated.
        for s in (result.data or {}).get("steps", []):
            data = s.get("data")
            if isinstance(data, dict):
                if "content" in data:
                    output += f"\n--- {data.get('path', 'file')} ---\n{str(data['content'])[:4000]}"
                elif "stdout" in data:
                    output += f"\n--- bash (rc={data.get('returncode')}) ---\n{str(data.get('stdout', ''))[:4000]}"
                elif "hits" in data:
                    output += f"\n--- code_analysis: {len(data['hits'])} hits ---"
                    for h in data["hits"][:10]:
                        output += f"\n{h['file']}:{h['line']}: {h['text']}"
                elif "candidates" in data:
                    output += f"\n{data.get('message', '')}"
                elif "files" in data:
                    output += f"\n--- {data.get('directory', '.')}: {len(data['files'])} files ---"
                    output += "\n" + "\n".join(str(f) for f in data["files"][:20])
                elif "text" in data and "temperature_c" in data:
                    output += f"\n--- weather: {data.get('location')} ---\n{data['text']}"
                elif "time" in data and "date" in data:
                    output += f"\n--- {data.get('date')} ---\nIt's {data['time']} ({data.get('zone', 'local')})."
                elif "result" in data and "expression" in data:
                    output += f"\n--- calculate ---\n{data['expression']} = {data['result']}"
                elif "scheduled" in data:
                    output += f"\n--- reminder #{data.get('id')} {data['scheduled']} ---\n{data.get('title', '')}"
                elif "reminders" in data:
                    rs = data["reminders"]
                    output += f"\n--- {len(rs)} reminder(s) ---" + ("".join(f"\n#{r['id']}: {r['title']}" for r in rs[:10]) if rs else "\n(none)")
                elif "sent" in data:
                    output += f"\n--- notification {'sent' if data['sent'] else 'not sent'} ---" + (f"\n{data['note']}" if data.get("note") else "")
                elif "spoken" in data:
                    output += f"\n--- voice {'spoken' if data['spoken'] else 'unavailable'} ---" + (f" ({data['note']})" if data.get("note") else "")
                elif "action" in data:
                    output += f"\n--- {data['action']} ---\n" + ", ".join(f"{k}={v}" for k, v in data.items() if k != "action")[:1000]
                elif "opened" in data:
                    output += f"\n--- browser opened ---\n{data['opened']}"
                elif "settings" in data:
                    output += f"\n--- host settings ---\n{data['settings']}"
                else:
                    output += "\n--- result ---\n" + ", ".join(f"{k}={v}" for k, v in list(data.items())[:12])[:2000]
    else:
        output = f"Plan failed: {result.error}"

    safe_output = guardrails.sanitize_output(output)

    return QueryResponse(
        request_id=str(uuid.uuid4()),
        tier=decision.tier,
        routing_reason=decision.reason,
        result=safe_output,
        success=result.success,
        suggested_subagents=suggested,
        steps=(result.data or {}).get("steps", []),
    )
