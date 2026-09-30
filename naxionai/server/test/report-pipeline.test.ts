import { describe, expect, it } from "vitest";
import {
  extractCitations, isPlaceholderCitation, unsupportedUrls, cleanSectionText,
  renderReportForReader, buildEvidenceProvenance, schemaFromHeadings, GENERIC_REPORT,
  runReportPipeline, type InternalDoc, type ExternalDoc, type ReportSchema,
} from "../src/lib/report-pipeline.js";

describe("extractCitations / isPlaceholderCitation", () => {
  it("extracts vault and numbered citations", () => {
    expect(extractCitations("See [vault:notes/a.md] and [2] for details [vault:notes/a.md]")).toEqual(["vault:notes/a.md", "2"]);
  });
  it("ignores placeholder citations", () => {
    expect(extractCitations("As noted [vault:path] and [vault:N]")).toEqual([]);
  });
  it("isPlaceholderCitation recognizes common placeholders", () => {
    for (const p of ["path", "N", "source", "vault:path", "", "doc"]) {
      expect(isPlaceholderCitation(p)).toBe(true);
    }
    expect(isPlaceholderCitation("notes/real-file.md")).toBe(false);
  });
});

describe("unsupportedUrls", () => {
  it("flags a URL not in the allowed set", () => {
    const allowed = new Set(["example.com/real"]);
    expect(unsupportedUrls("See https://fake-repo.example/nothing for details.", allowed)).toEqual(["https://fake-repo.example/nothing"]);
  });
  it("allows a URL in the set and a deeper path under it", () => {
    const allowed = new Set(["example.com/real"]);
    expect(unsupportedUrls("https://example.com/real and https://example.com/real/sub", allowed)).toEqual([]);
  });
});

describe("cleanSectionText", () => {
  it("replaces a literal placeholder citation with an honest note", () => {
    expect(cleanSectionText("Claim here [vault:path].")).toBe("Claim here (source not in evidence).");
  });
  it("strips a duplicated heading", () => {
    const out = cleanSectionText("## Summary\nBody text here.", "Summary");
    expect(out).not.toMatch(/^##/m);
    expect(out).toContain("Body text here.");
  });
  it("removes a bare citation marker alone on its own line", () => {
    expect(cleanSectionText("Text.\n[2]\nMore text.")).not.toMatch(/^\[2\]$/m);
  });
});

describe("schemaFromHeadings", () => {
  it("builds sections from headings, exempting Summary from citations", () => {
    const schema = schemaFromHeadings(["Summary", "Risks"], "a test report");
    expect(schema.sections.map(s => s.id)).toEqual(["summary", "risks"]);
    expect(schema.sections[0].needsCitations).toBe(false);
    expect(schema.sections[1].needsCitations).toBe(true);
  });
  it("falls back to GENERIC_REPORT on an empty heading list", () => {
    expect(schemaFromHeadings([], "x")).toBe(GENERIC_REPORT);
  });
});

describe("buildEvidenceProvenance / renderReportForReader", () => {
  const internal: InternalDoc[] = [{ path: "notes/a.md", text: "x", curated: true, modified: "2026-01-01" }];
  const external: ExternalDoc[] = [{ n: 1, url: "https://example.com", title: "Example", text: "y" }];

  it("lists internal and external evidence", () => {
    const out = buildEvidenceProvenance(internal, external, 2);
    expect(out).toContain("notes/a.md");
    expect(out).toContain("Example");
    expect(out).toContain("2 dropped by the validator");
  });

  it("renders vault citations as numbered markers continuing after external sources", () => {
    const out = renderReportForReader("Claim [vault:notes/a.md] here.", internal, external);
    expect(out).toContain("Claim [2] here."); // external has n=1, so internal starts at 2
    expect(out).toContain("## Evidence used");
  });

  it("marks an unresolvable vault citation honestly", () => {
    const out = renderReportForReader("Claim [vault:nowhere.md] here.", internal, external);
    expect(out).toContain("(source not in evidence)");
  });
});

describe("runReportPipeline (generate injected)", () => {
  const internal: InternalDoc[] = [{ path: "notes/a.md", text: "Some internal fact.", curated: true }];
  const external: ExternalDoc[] = [{ n: 1, url: "https://example.com/real", title: "Real source", text: "Some external fact." }];

  function schema(): ReportSchema {
    return {
      id: "test",
      purpose: "a test report",
      sections: [
        { id: "summary", heading: "Summary", brief: "summarize", evidence: "both", needsCitations: false },
        { id: "body", heading: "Body", brief: "cite something", evidence: "both" },
      ],
    };
  }

  it("assembles a report from successful, cited sections", async () => {
    const result = await runReportPipeline({
      schema: schema(),
      topic: "test topic",
      internal, external,
      generate: async (_p, _s, _o) => "This has a citation [1] in it.",
    });
    expect(result.gaps).toEqual([]);
    expect(result.stats.sectionsWritten).toBe(2);
    expect(result.markdown).toContain("This has a citation");
  });

  it("withholds a claim-bearing section with no citation", async () => {
    const result = await runReportPipeline({
      schema: schema(),
      topic: "test topic",
      internal, external,
      generate: async (_p, _s, _o) => "An uncited claim with no markers at all.",
    });
    const bodyGap = result.gaps.find(g => g.id === "body");
    expect(bodyGap?.reason).toMatch(/no citation/);
    expect(result.markdown).toMatch(/Withheld/);
  });

  it("records a gap for a section whose generate call throws, without losing the rest", async () => {
    const result = await runReportPipeline({
      schema: schema(),
      topic: "test topic",
      internal, external,
      sectionTimeoutMs: 200,
      totalTimeoutMs: 5000,
      generate: async (_p, _s, _o) => { throw new Error("model unavailable"); },
    });
    expect(result.stats.sectionsFailed).toBe(2);
    expect(result.gaps.length).toBe(2);
    expect(result.markdown).toContain("Not written");
  });

  it("withholds a section naming a URL the run never fetched", async () => {
    const result = await runReportPipeline({
      schema: schema(),
      topic: "test topic",
      internal, external,
      generate: async (_p, _s, _o) => "Cited [1] but also see https://totally-invented.example/repo for more.",
    });
    const bodyGap = result.gaps.find(g => g.id === "body");
    expect(bodyGap?.reason).toMatch(/never fetched/);
  });

  it("applies the summaryGuard: withholds an exempt summary when its siblings are all unavailable", async () => {
    const guarded: ReportSchema = {
      id: "guarded",
      purpose: "a test report",
      sections: [
        { id: "summary", heading: "Summary", brief: "summarize", evidence: "both", needsCitations: false },
        { id: "opportunities", heading: "Opportunities", brief: "cite", evidence: "both" },
      ],
      summaryGuard: { summaryId: "summary", requiredIds: ["opportunities"] },
    };
    const result = await runReportPipeline({
      schema: guarded,
      topic: "test topic",
      internal, external,
      generate: async (_p, _s, o) => o.maxTokens === 400 ? "A confident claim with no support." : "Uncited body with no markers.",
    });
    const summaryGap = result.gaps.find(g => g.id === "summary");
    expect(summaryGap).toBeDefined();
  });
});
