import re
from src.core.models import ProcessingTier, RoutingDecision

class CognitiveRouter:
    """
    Dual-process cognitive dispatcher separating fast reflexive tasks (System 1)
    from deep multi-hop reasoning tasks (System 2).
    """
    def __init__(self, complexity_threshold: float = 0.65):
        self.threshold = complexity_threshold
        self.complex_triggers = {
            "synthesize", "analyze", "compare", "root cause",
            "architect", "evaluate", "plan", "debug", "audit"
        }

    def evaluate(self, prompt: str, context_len: int = 0) -> RoutingDecision:
        words = prompt.lower().split()
        score = 0.15

        if len(words) > 30:
            score += 0.25
        elif len(words) > 60:
            score += 0.40

        found_triggers = [t for t in self.complex_triggers if t in prompt.lower()]
        if found_triggers:
            score += min(0.45, len(found_triggers) * 0.20)

        if context_len > 3000:
            score += 0.20

        score = min(score, 1.0)

        if score >= self.threshold:
            return RoutingDecision(
                tier=ProcessingTier.SYSTEM_2_DEEP,
                confidence=round(score, 2),
                reason=f"High cognitive load detected (triggers: {found_triggers})",
                estimated_tokens=context_len + len(words) * 3
            )
        
        return RoutingDecision(
            tier=ProcessingTier.SYSTEM_1_FAST,
            confidence=round(1.0 - score, 2),
            reason="Reflexive / pattern match operation",
            estimated_tokens=context_len + len(words)
        )
