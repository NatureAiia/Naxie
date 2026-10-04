import re
from typing import Tuple

class CognitiveGuardrails:
    def __init__(self):
        self.injection_patterns = [
            r"ignore\s+(all\s+)?(previous|prior)\s+instructions",
            r"disregard\s+system\s+prompt",
            r"you\s+are\s+now\s+in\s+developer\s+mode",
            r"output\s+all\s+passwords"
        ]
        self.secret_patterns = [
            r"(?i)api[_-]?key\s*[:=]\s*['\"]?[a-zA-Z0-9_\-]{20,}['\"]?",
            r"(?i)bearer\s+[a-zA-Z0-9_\-\.]{25,}"
        ]

    def sanitize_input(self, text: str) -> Tuple[bool, str]:
        for pattern in self.injection_patterns:
            if re.search(pattern, text, re.IGNORECASE):
                return False, f"Prompt injection detected matching: {pattern}"
        return True, text

    def sanitize_output(self, text: str) -> str:
        sanitized = text
        for pattern in self.secret_patterns:
            sanitized = re.sub(pattern, "[REDACTED_CREDENTIAL]", sanitized)
        return sanitized
