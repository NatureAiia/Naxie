// Deterministic token mapper for Flow Automations (Zapier-style).
//
// Template values may embed tokens:
//   {{$.trigger.body.customer_email}}   — inbound webhook payload / schedule inputs
//   {{$.trigger.headers.x-sig}}         — inbound headers
//   {{$.steps.<stepId>.body.url}}       — output of an earlier step
//
// Rules (see plan):
//   - Path segments split on "."; numeric segments index arrays. Nothing else.
//   - "__proto__", "constructor", "prototype" segments are rejected (inert).
//   - If the ENTIRE string is one token, the raw value is returned
//     (number/bool/object preserved). Otherwise values are stringified
//     (objects via JSON) and interpolated.
//   - Missing paths resolve to "" + a warnings[] entry (never throws).
//   - "\{{" escapes to a literal "{{". Unmatched "{{" is left as-is + warning.
//   - Depth limit 10, template JSON cap enforced by caller (32 KB).

export type FlowMapperContext = {
  trigger: unknown;
  steps: Record<string, unknown>;
};

export type MapResult<T = unknown> = {
  resolved: T;
  warnings: string[];
};

const TOKEN_RE = /\{\{\s*(\$\.[^}]+?)\s*\}\}/g;
const FULL_TOKEN_RE = /^\s*\{\{\s*(\$\.[^}]+?)\s*\}\}\s*$/;
const FORBIDDEN_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 10;

function splitPath(expr: string): string[] | null {
  // expr starts with "$." — strip and split.
  const raw = expr.slice(2);
  if (!raw) return null;
  const parts = raw.split(".");
  if (parts.length > MAX_DEPTH) return null;
  for (const p of parts) {
    if (!p) return null;
    if (FORBIDDEN_SEGMENTS.has(p)) return null;
  }
  return parts;
}

export function resolveTokenPath(expr: string, ctx: FlowMapperContext): { found: boolean; value: unknown } {
  const parts = splitPath(expr);
  if (!parts) return { found: false, value: undefined };
  const [root, ...rest] = parts;
  let cur: unknown;
  if (root === "trigger") cur = ctx.trigger;
  else if (root === "steps") {
    const [stepId, ...tail] = rest;
    if (!stepId) return { found: false, value: undefined };
    if (!Object.prototype.hasOwnProperty.call(ctx.steps, stepId)) return { found: false, value: undefined };
    cur = (ctx.steps as Record<string, unknown>)[stepId];
    return drill(cur, tail);
  } else {
    return { found: false, value: undefined };
  }
  return drill(cur, rest);
}

function drill(cur: unknown, parts: string[]): { found: boolean; value: unknown } {
  for (const seg of parts) {
    if (FORBIDDEN_SEGMENTS.has(seg)) return { found: false, value: undefined };
    if (Array.isArray(cur)) {
      if (!/^\d+$/.test(seg)) return { found: false, value: undefined };
      const i = Number(seg);
      if (i >= cur.length) return { found: false, value: undefined };
      cur = cur[i];
    } else if (cur !== null && typeof cur === "object") {
      if (!Object.prototype.hasOwnProperty.call(cur, seg)) return { found: false, value: undefined };
      cur = (cur as Record<string, unknown>)[seg];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: cur };
}

function stringifyTokenValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  try {
    return JSON.stringify(v) ?? "";
  } catch {
    return "";
  }
}

const ESCAPED_OPEN = "\u0000ESCAPED_OPEN\u0000";

export function renderString(template: string, ctx: FlowMapperContext, warnings: string[]): unknown {
  // Protect "\{{" escapes before matching.
  const protected_ = template.replace(/\\{{/g, ESCAPED_OPEN);
  const full = protected_.match(FULL_TOKEN_RE);
  if (full) {
    const expr = full[1];
    const r = resolveTokenPath(expr, ctx);
    if (!r.found) warnings.push(`token ${expr} did not resolve — left empty`);
    const out = r.found ? r.value : "";
    return out;
  }
  let warnedUnmatched = false;
  const out = protected_.replace(TOKEN_RE, (_m, expr: string) => {
    const r = resolveTokenPath(String(expr), ctx);
    if (!r.found) warnings.push(`token ${expr} did not resolve — left empty`);
    return stringifyTokenValue(r.found ? r.value : "");
  });
  // Detect leftover "{{" that never formed a token (and wasn't escaped).
  if (!warnedUnmatched && out.includes("{{")) {
    warnings.push("unmatched '{{' left as-is (use \\{{ to escape)");
    warnedUnmatched = true;
  }
  return out.split(ESCAPED_OPEN).join("{{");
}

export function renderTemplate<T>(template: T, ctx: FlowMapperContext, warnings: string[] = [], depth = 0): MapResult<T> {
  if (depth > MAX_DEPTH) {
    warnings.push("template exceeds max depth 10 — truncated");
    return { resolved: template, warnings };
  }
  if (typeof template === "string") {
    return { resolved: renderString(template, ctx, warnings) as T, warnings };
  }
  if (Array.isArray(template)) {
    const arr = template.map((v) => renderTemplate(v, ctx, warnings, depth + 1).resolved);
    return { resolved: arr as unknown as T, warnings };
  }
  if (template !== null && typeof template === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(template as Record<string, unknown>)) {
      if (FORBIDDEN_SEGMENTS.has(k)) {
        warnings.push(`key "${k}" dropped (forbidden)`);
        continue;
      }
      out[k] = renderTemplate(v, ctx, warnings, depth + 1).resolved;
    }
    return { resolved: out as T, warnings };
  }
  return { resolved: template, warnings };
}
