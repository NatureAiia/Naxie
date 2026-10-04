import uuid
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel

from src.core.router import CognitiveRouter
from src.core.models import ProcessingTier, CognitivePlan
from src.security.guardrails import CognitiveGuardrails
from src.agents.critic import CriticAgent

app = FastAPI(
    title="NaxionAI Powered by Neuroworks",
    version="1.0.0",
    description="Cognitive Multi-Agent Neural Swarm Gateway"
)

router = CognitiveRouter(complexity_threshold=0.65)
guardrails = CognitiveGuardrails()
critic = CriticAgent(allowed_tools=["database_query", "code_analysis", "web_retrieval"])

class QueryRequest(BaseModel):
    session_id: str = "default_session"
    prompt: str

class QueryResponse(BaseModel):
    request_id: str
    tier: ProcessingTier
    routing_reason: str
    result: str

@app.get("/health")
def health_check():
    return {"status": "healthy", "engine": "Neuroworks Cognitive Core v1.0"}

@app.post("/v1/process", response_model=QueryResponse)
async def process_task(req: QueryRequest):
    valid, sanitized_or_err = guardrails.sanitize_input(req.prompt)
    if not valid:
        raise HTTPException(status_code=400, detail=sanitized_or_err)

    decision = router.evaluate(sanitized_or_err)

    if decision.tier == ProcessingTier.SYSTEM_1_FAST:
        output = f"Fast-Path Reflexive Output for: '{sanitized_or_err}'"
    else:
        plan = CognitivePlan(
            plan_id=str(uuid.uuid4()),
            intent=sanitized_or_err,
            steps=[{"tool": "code_analysis", "payload": {"target": "system"}}]
        )
        approved, notes = critic.review_plan(plan)
        if not approved:
            raise HTTPException(status_code=422, detail=f"Critic rejected plan: {notes}")
        output = f"Deliberative Reasoning Plan executed with consensus approval. Notes: {notes}"

    safe_output = guardrails.sanitize_output(output)

    return QueryResponse(
        request_id=str(uuid.uuid4()),
        tier=decision.tier,
        routing_reason=decision.reason,
        result=safe_output
    )
