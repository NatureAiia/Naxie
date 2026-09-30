// Auto-generate docs/EXTENSIONS.md from EXTENSION_CATALOG so the doc never
// drifts from the code. Run: pnpm -F neuroworks exec tsx tools/gen-extension-docs.ts
// (or: tsx tools/gen-extension-docs.ts from the naxionai/ root).

import { writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { EXTENSION_CATALOG } from "../server/src/lib/extensions.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(__dirname, "../docs/EXTENSIONS.md");

const byCategory = new Map<string, typeof EXTENSION_CATALOG>();
for (const e of EXTENSION_CATALOG) {
  if (!byCategory.has(e.category)) byCategory.set(e.category, []);
  byCategory.get(e.category)!.push(e);
}

const lines: string[] = [
  "# Extensions",
  "",
  `> Auto-generated from \`server/src/lib/extensions.ts\` (EXTENSION_CATALOG) on ${new Date().toISOString()} — do not edit by hand; run \`tsx tools/gen-extension-docs.ts\` after changing the catalog.`,
  "",
  "The Extensions page (`/extensions`) monitors everything in this catalog plus token-based integrations, BYO connectors, and model providers.",
  "",
  "## Core catalog",
  "",
];

for (const [cat, exts] of [...byCategory.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
  lines.push(`### ${cat}`);
  lines.push("");
  for (const e of exts) {
    lines.push(`#### ${e.name} (\`${e.id}\`)`);
    lines.push("");
    lines.push(`${e.description}`);
    lines.push("");
    lines.push(`- **Enable:** set \`${e.envKey}\`${e.envKeys?.length ? ` (+ ${e.envKeys.map(k => `\`${k}\``).join(", ")})` : ""}`);
    if (e.docsUrl) lines.push(`- **Docs:** ${e.docsUrl}`);
    lines.push(`- **Health test:** ${e.testable ? "yes — Test button runs a live check" : "no (passive)"}`);
    lines.push(`- **Connect:** ${e.connectHint}`);
    lines.push("");
  }
}

lines.push(
  "## Webhooks (Zapier / Make)",
  "",
  "1. Create: `POST /api/extensions/webhooks` with `{\"targetId\": \"<connector-id>\", \"targetKind\": \"connector\"}`.",
  "2. Call: `POST /api/extensions/webhook/<id>` with header `X-Webhook-Secret: <secret>`.",
  "3. Payloads carrying `task`/`text`/`objective`/`prompt` auto-create an agent job; poll `/api/tasks/jobs/:jobId`.",
  "4. High-severity secrets in payloads are rejected with HTTP 400 before storage (`webhook.blocked` audit).",
  "",
  "## Marketplace export",
  "",
  "- `POST /api/extensions/export/:id` bundles a connector/integration into a versioned skill at `server/src/skills/_user/<slug>.md` (frontmatter `version:` bumps on each re-export).",
  "- `GET /api/extensions/marketplace` lists exported skills with name/description/version.",
  "- Exported content is security-scanned; high-severity secrets block the export (`marketplace.blocked` audit).",
  "",
  "## Security scanning",
  "",
  "- Ingress: webhook payloads are scanned (`scanForSecurityRisks`); high-severity findings → HTTP 400 + `webhook.blocked`.",
  "- Egress: connector \"try it\" responses are scanned; high-severity matches are redacted to `[REDACTED:<type>]` with a warning field + `connector.call.blocked` audit.",
  "- Patterns live in `server/src/lib/security.ts`; keep them precise (anchored prefix + length floor) to avoid false positives.",
  "",
);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join("\n"), "utf8");
console.log(`wrote ${OUT} (${EXTENSION_CATALOG.length} extensions, ${byCategory.size} categories)`);
