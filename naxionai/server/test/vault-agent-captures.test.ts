import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// VAULT_PATH is read at module-load time by config.ts, so it must be set
// before vault.js is imported — a static import would be hoisted above this
// assignment, so we set the env var first and import dynamically.
const tmpVault = mkdtempSync(join(tmpdir(), "nw-vault-test-"));
process.env.VAULT_PATH = tmpVault;

mkdirSync(join(tmpVault, "0-Inbox"), { recursive: true });
mkdirSync(join(tmpVault, "_naxion", "jobs"), { recursive: true });
mkdirSync(join(tmpVault, "_naxion", "reflections"), { recursive: true });
writeFileSync(join(tmpVault, "0-Inbox", "dario-amodei-notes.md"), "# real user notes on dario amodei");
writeFileSync(join(tmpVault, "_naxion", "jobs", "dario-amodei-research.md"), "job tracker record");
writeFileSync(join(tmpVault, "_naxion", "reflections", "dario-amodei-reflection.md"), "nightly reflection mentioning dario amodei");

const { searchVaultFilenames } = await import("../src/lib/vault.js");

describe("searchVaultFilenames excludeAgentCaptures", () => {
  it("includes _naxion/* hits by default (unchanged behaviour)", () => {
    const hits = searchVaultFilenames("dario amodei", 10);
    const paths = hits.map(h => h.path);
    expect(paths).toContain("0-Inbox/dario-amodei-notes.md");
    expect(paths).toContain("_naxion/jobs/dario-amodei-research.md");
    expect(paths).toContain("_naxion/reflections/dario-amodei-reflection.md");
  });

  it("excludes every _naxion/* agent capture when excludeAgentCaptures is set, not just jobs/", () => {
    const hits = searchVaultFilenames("dario amodei", 10, { excludeAgentCaptures: true });
    const paths = hits.map(h => h.path);
    expect(paths).toEqual(["0-Inbox/dario-amodei-notes.md"]);
  });

  it("still returns [] when the topic has no real user notes, even if only agent captures match", () => {
    mkdirSync(join(tmpVault, "_naxion", "memory"), { recursive: true });
    writeFileSync(join(tmpVault, "_naxion", "memory", "only-in-agent-capture.md"), "self-citation bait");
    const hits = searchVaultFilenames("only in agent capture", 10, { excludeAgentCaptures: true });
    expect(hits).toEqual([]);
    rmSync(tmpVault, { recursive: true, force: true });
  });
});
