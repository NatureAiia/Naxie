// One-time (re-runnable) extraction of the Company-data page's uploaded
// documents into vault-indexed markdown sidecars.
//
// Problem this solves: the operator uploaded real company knowledge
// (strategic plan, governance policy, org structure, summit plans) as
// PDF/DOCX/XLSX into the vault's _company/ folder — but the vault index only
// reads markdown, so vault.search could never surface any of it and agents
// answered org/company questions as if the company had no records.
//
// For every extractable file in <vault>/_company this writes
// `<name>.extracted.md` alongside it: frontmatter naming the source file +
// the extracted text. The vault indexer picks the sidecars up like any note,
// so vault.search / brain search hit the CONTENT of the uploads.
//
// Safe to re-run: skips sidecars that are newer than their source file.
// Run: npx tsx tools/extract-company-docs.ts   (from the repo root)

import { readdirSync, statSync, writeFileSync, existsSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { extractDocText } from "../server/src/lib/doc-extractor.js";
import { config } from "../server/src/config.js";

const companyDir = resolve(config.vaultPath, "_company");
const EXTRACTABLE = new Set([".pdf", ".docx", ".xlsx", ".xls", ".xlsm", ".txt", ".csv"]);

async function main() {
  if (!existsSync(companyDir)) {
    console.error(`no _company folder at ${companyDir}`);
    process.exit(1);
  }
  const files = readdirSync(companyDir).filter(f => {
    const ext = extname(f).toLowerCase();
    return EXTRACTABLE.has(ext) && !f.endsWith(".extracted.md");
  });
  console.log(`${files.length} extractable files in ${companyDir}`);
  let written = 0, skipped = 0, failed = 0;
  for (const f of files) {
    const src = resolve(companyDir, f);
    const sidecar = resolve(companyDir, `${basename(f, extname(f))}.extracted.md`);
    if (existsSync(sidecar) && statSync(sidecar).mtimeMs >= statSync(src).mtimeMs) {
      skipped++;
      continue;
    }
    try {
      const r = await extractDocText(src);
      const text = (r.text ?? "").trim();
      if (!text) { console.warn(`  ~ ${f}: extractor returned no text`); failed++; continue; }
      const body = [
        "---",
        "type: company-doc-extract",
        `source: ${f}`,
        `extractedAt: ${new Date().toISOString()}`,
        "note: auto-generated sidecar so vault search can see inside the upload — edit the SOURCE file, not this",
        "---",
        "",
        `# ${basename(f, extname(f)).replace(/[_-]+/g, " ")}`,
        "",
        text.slice(0, 60_000),
      ].join("\n");
      writeFileSync(sidecar, body, "utf8");
      console.log(`  + ${basename(sidecar)} (${text.length} chars)`);
      written++;
    } catch (e: any) {
      console.warn(`  ! ${f}: ${e?.message ?? e}`);
      failed++;
    }
  }
  console.log(`done: ${written} written, ${skipped} up-to-date, ${failed} failed`);
}

main();
