from enum import Enum
from typing import Dict, Any, List, Optional
from pydantic import BaseModel, Field

class ProcessingTier(str, Enum):
    SYSTEM_1_FAST = "system_1_fast"
    SYSTEM_2_DEEP = "system_2_deep"

class RoutingDecision(BaseModel):
    tier: ProcessingTier
    confidence: float
    reason: str
    estimated_tokens: int

class MemoryContext(BaseModel):
    session_id: str
    working_memory: List[Dict[str, str]] = Field(default_factory=list)
    episodic_facts: List[str] = Field(default_factory=list)
    procedural_skills: List[Dict[str, Any]] = Field(default_factory=list)

class CognitivePlan(BaseModel):
    plan_id: str
    intent: str
    steps: List[Dict[str, Any]]
    requires_approval: bool = False
    validation_status: str = "pending"
    critic_notes: Optional[str] = None

class ExecutionResult(BaseModel):
    success: bool
    data: Optional[Any] = None
    error: Optional[str] = None
    retries_exhausted: bool = False
    execution_time_ms: float = 0.0
