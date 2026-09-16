// Conservative secret/risk detector. Each finding has a severity that the
// caller uses to decide whether to refuse the write (high), redact it
// (medium), or just log it (low). The patterns are intentionally specific —
// we'd rather miss a fuzzy match than false-positive on user prose.
export type SecurityFinding = {
  type: string;
  match: string;
  severity: "high" | "medium" | "low";
  reason: string;
};

export type SecurityKind = "note" | "code" | "commit-message";

export function scanForSecurityRisks(content: string, kind: SecurityKind = "note"): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const seen = new Set<string>();
  const add = (f: SecurityFinding) => {
    const key = `${f.type}:${f.match}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push(f);
  };

  // High-severity: real-looking secrets. The prefixes are the strongest signal
  // because the issuers document them. Length constraints cut false positives
  // on prose. New patterns: keep them precise — anchored prefix + length lower
  // bound — or they'll fire on README excerpts.
  const SECRET_PATTERNS: { type: string; re: RegExp; reason: string }[] = [
    { type: "github_pat", re: /\bghp_[A-Za-z0-9]{36,}\b/g, reason: "GitHub personal access token" },
    { type: "github_fine_grained", re: /\bgithub_pat_[A-Za-z0-9_]{60,}\b/g, reason: "GitHub fine-grained PAT" },
    { type: "openai_key", re: /\bsk-[A-Za-z0-9]{20,}\b/g, reason: "OpenAI API key" },
    { type: "anthropic_key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g, reason: "Anthropic API key" },
    { type: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g, reason: "AWS access key id" },
    { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g, reason: "Google API key" },
    { type: "slack_token", re: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, reason: "Slack token" },
    { type: "private_key_pem", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g, reason: "PEM private key block" },
    { type: "jwt", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g, reason: "JWT-shaped token" },
  ];
  for (const p of SECRET_PATTERNS) {
    p.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = p.re.exec(content))) {
      add({ type: p.type, match: m[0], severity: "high", reason: p.reason });
    }
  }

  // Medium: suspicious URLs (raw IPs, dodgy TLDs).
  const URL_RE = /\bhttps?:\/\/([^\s)\]"']+)/gi;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(content))) {
    const host = m[1].split("/")[0].toLowerCase();
    const isIp = /^(\d{1,3}\.){3}\d{1,3}$/.test(host);
    const tld = host.split(".").pop() ?? "";
    const dodgyTlds = new Set(["tk", "ml", "ga", "cf", "click", "zip", "mov"]);
    if (isIp) add({ type: "ip_url", match: m[0], severity: "medium", reason: "URL points at a raw IP" });
    else if (dodgyTlds.has(tld)) add({ type: "dodgy_tld", match: m[0], severity: "medium", reason: `URL TLD .${tld} is commonly abused` });
  }

  // Low: command-injection-shaped patterns when the content is code or a
  // commit message. Notes get a pass — prose often discusses these patterns.
  if (kind === "code" || kind === "commit-message") {
    const INJECT_RES = [
      { re: /\b(?:rm\s+-rf\s+\/|:\s*\(\s*\)\s*\{)/g, reason: "destructive shell pattern" },
      { re: /\b(?:curl|wget)\s+\S+\s*\|\s*(?:bash|sh|zsh)\b/g, reason: "remote-pipe-execute" },
    ];
    for (const p of INJECT_RES) {
      p.re.lastIndex = 0;
      while ((m = p.re.exec(content))) add({ type: "command_injection", match: m[0], severity: "low", reason: p.reason });
    }
  }
  return out;
}

// Run findings through a redactor — replaces high-severity matches with
// `[REDACTED:type]`. Low/medium findings are left in place so the caller can
// decide what to do with them (warn, log, refuse).
export function redactHighSeverity(content: string, findings: SecurityFinding[]): string {
  let out = content;
  for (const f of findings) {
    if (f.severity === "high" && f.match) {
      out = out.split(f.match).join(`[REDACTED:${f.type}]`);
    }
  }
  return out;
}

// ─── Field-level masking for records entering an LLM prompt/context ───
// Distinct from the content scan above: that hunts for secret-SHAPED
// substrings anywhere in free text. This looks at STRUCTURED records (a
// contact pulled from the CRM, a row a connector fetched from an external
// system) and masks by FIELD NAME — an ssn/salary/card-number column is
// sensitive no matter what its value looks like, and connectors.ts calls
// arbitrary external APIs with no fixed schema to run a value-shape scan against.
export type MaskEntityType = "contact" | "customer" | "employee" | "deal" | "generic";

// Per-type allowlist — fields that make sense to hand an LLM for that record
// shape. Unknown/omitted entityType (connectors.ts's arbitrary API responses)
// skips the allowlist — we don't know the schema, so allowlisting would strip
// legitimate data as often as sensitive data — and relies on the name scrub below.
const ENTITY_ALLOWLISTS: Record<Exclude<MaskEntityType, "generic">, string[]> = {
  contact: ["id", "name", "email", "phone", "company", "source", "tags", "notes", "createdAt", "updatedAt", "title", "role"],
  customer: ["id", "name", "email", "phone", "company", "tags", "notes", "createdAt", "updatedAt", "status", "plan"],
  employee: ["id", "name", "email", "title", "department", "role", "status", "workMode", "reportsTo", "createdAt"],
  deal: ["id", "contactId", "title", "pipelineId", "stage", "value", "createdAt", "updatedAt", "closedAt"],
};

// Fires regardless of entityType/allowlist — matched against the field NAME,
// not its value, so it also catches a sensitive field on a record shape we
// don't have (or haven't listed) an allowlist for. Substring match rather
// than \b-bounded: field names are camelCase/snake_case identifiers
// ("apiKey", "bank_account"), and \b never fires inside a camelCase join.
const SENSITIVE_FIELD_RE = /password|passwd|pwd|secret|token|api[-_]?key|access[-_]?key|private[-_]?key|bank[-_]?account|iban|account[-_]?number|acct[-_]?(?:no|num)|routing[-_]?number|card[-_]?number|cardnum|cvv|cvc|ssn|social[-_]?security|national[-_]?id|passport(?:[-_]?number)?|tax[-_]?id|salary|compensation|wage/i;

const MASKED_VALUE = "[REDACTED]";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Recurses into nested objects/arrays — a connector response nests a record
// under {data:{...}} / {results:[...]} as often as not, and a field named
// "ssn" three levels down leaks exactly as much as one at the top.
function scrubSensitiveNames(value: unknown, depth = 0): unknown {
  if (depth > 6) return value; // guard against pathological/cyclical shapes
  if (Array.isArray(value)) return value.map(v => scrubSensitiveNames(v, depth + 1));
  if (!isPlainObject(value)) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = SENSITIVE_FIELD_RE.test(k) ? MASKED_VALUE : scrubSensitiveNames(v, depth + 1);
  }
  return out;
}

// Mask a record (or array of records) before it's assembled into an LLM
// prompt/context. Pass the entityType when the shape is known (crm.ts's
// contacts/deals); omit it for arbitrary shapes (connectors.ts's API bodies).
export function maskSensitiveFields(record: any, entityType?: MaskEntityType): any {
  if (Array.isArray(record)) return record.map(r => maskSensitiveFields(r, entityType));
  if (!isPlainObject(record)) return record;
  const allowlist = entityType && entityType !== "generic" ? ENTITY_ALLOWLISTS[entityType] : undefined;
  const base = allowlist
    ? Object.fromEntries(Object.entries(record).filter(([k]) => allowlist.includes(k)))
    : record;
  return scrubSensitiveNames(base);
}
