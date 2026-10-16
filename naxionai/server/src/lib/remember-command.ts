// Explicit "remember this" command parser.
// Extracts facts from common phrasing patterns used by the operator
// to explicitly store a durable fact in the "operator" memory subject.
//
// Patterns:
// - "Remember this: I prefer a minimalist style"
// - "Please remember that I use VS Code"
// - "Don't forget I work in London"
// - "Remember: I love dark mode"

export function parseRememberCommand(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // Patterns to match:
  // 1. Literal "Remember: <fact>"
  // 2. "Remember this: <fact>" / "Remember that: <fact>"
  // 3. "Please remember [that/this/it] <fact>"
  // 4. "Don't forget [that/this/it] <fact>"
  const patterns = [
    /^remember:\s*(.+)$/i,
    /^(?:please\s+)?(?:remember|don't forget|do not forget)\s+(?:this|that|it)?\s*[:,\-—]?\s*(.+)$/is,
  ];

  for (const regex of patterns) {
    const match = trimmed.match(regex);
    if (match && match[1]) {
      const fact = match[1].trim();
      if (fact.length < 5 || fact.length > 500) return null;
      // Strip wrapping quotes if present
      return fact.replace(/^["']|["']$/g, "").trim();
    }
  }

  return null;
}
