// L1 grounding harness — offline, no LLM, no live server.
//
// Question it answers: "could the agent have grounded this answer at all?"
//
// It exercises the retrieval substrate and the routing gate that stands in
// front of it, in the same order the agent does:
//
//   1. index      — is the vault index actually built and non-empty?
//   2. retrieval  — does full-text search surface the canonical document?
//   3. triage     — does the filename probe that decides "consult the vault or
//                   answer from world knowledge?" fire for these asks?
//   4. tools      — do the grounding primitives each case expects still exist?
//
// A failure at (1)-(3) means the model never saw the evidence, so no amount of
// prompt tuning in synthesis can fix the deflection. A failure at (4) means a
// primitive was renamed out from under the planner hints in agent.ts.
//
// End-to-end answer quality is graded by the L2 harness (tools/grounding-harness.mjs).

import { beforeAll, describe, expect, it } from "vitest";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { config } from "../src/config.js";
import { searchVault, searchVaultFilenames, isAgentCapture } from "../src/lib/vault.js";
import { buildIndex, indexStats, invalidateIndex } from "../src/lib/vault-index.js";
import { extractTopic, looksLikeDirectAnswer, isTriviallyDirectAnswer } from "../src/lib/agent.js";
import { findPrimitive } from "../src/lib/primitives.js";
import { GROUNDING_CASES, CRITICAL_CASES, detectDeflection, detectNotFound } from "./grounding-cases.js";

const ALL_SURFACES = ["vault", "company", "connection", "directory", "self", "inbox", "honesty", "safety"] as const;

const VAULT = config.vaultPath;
const haveVault = !!VAULT && existsSync(VAULT);

// The vault is a real folder on the operator's machine, not a fixture. On a
// machine without it (fresh clone, CI) these assertions are meaningless, so we
// skip rather than fail red for the wrong reason — but we make the skip loud.
const describeVault = haveVault ? describe : describe.skip;

if (!haveVault) {
  console.warn(
    `[grounding] VAULT_PATH ${VAULT ? `"${VAULT}" does not exist` : "is unset"} — ` +
    `skipping vault-grounded assertions. These are the tests that catch the ` +
    `"I don't have specific knowledge of NeuroWorks" regression.`,
  );
}

/**
 * Reproduces the triage decision from agent.ts (the block that combines
 * looksLikeDirectAnswer + the vault filename probe) so we can assert on the
 * ROUTING outcome without booting the LLM. Kept deliberately close to the
 * original; if agent.ts changes shape this is the test that should be updated
 * alongside it.
 */
function triageWouldSkipVault(ask: string): { skips: boolean; topic: string; hits: string[] } {
  const topic = extractTopic(ask);
  // We cannot call the LLM here, so we take the WORST case: assume the small
  // triage model says DIRECT. That's the branch the reported failure took, and
  // a grounding guarantee that only holds when the classifier happens to say
  // TOOLS is not a guarantee.
  //
  // The one thing this worst case must NOT throw away is the deterministic
  // veto. llmTriage applies the same corpus guards looksLikeDirectAnswer does
  // (ORG_STRUCTURE_RE / COMPANY_DOCS_RE), so a task those reject cannot be
  // routed DIRECT no matter what the classifier returns. Modelling the LLM as
  // omnipotent here made the helper stricter than production and failed
  // company-brand-guidelines for a filename-probe miss that production never
  // depends on — its protection comes from the veto, not the probe.
  let direct = looksLikeDirectAnswer(ask);
  // Must mirror agent.ts exactly: same pool size, same exclusion. An earlier
  // version of this helper used a different limit and a narrower filter, so it
  // stayed green while production deflected — the probe there fetched a single
  // hit, which for any previously-researched topic was the agent's own capture,
  // and filtering captures left it with nothing.
  const hits = (topic && topic.length >= 2
    ? searchVaultFilenames(topic, 5, { excludeAgentCaptures: true })
    : []).map(h => h.path);
  if (direct && hits.length > 0 && !isTriviallyDirectAnswer(ask, false) && topic && topic.length >= 3) {
    direct = false; // vault override fires — the agent consults the vault
  }
  return { skips: direct, topic, hits: [...new Set(hits)] };
}

const matchesAny = (paths: string[], fragments: string[]) =>
  fragments.some(f => paths.some(p => p.toLowerCase().includes(f.toLowerCase())));

describe("grounding corpus", () => {
  it("every case declares a rationale and a surface", () => {
    for (const c of GROUNDING_CASES) {
      expect(c.rationale, `${c.id} missing rationale`).toBeTruthy();
      expect(ALL_SURFACES as readonly string[]).toContain(c.surface);
    }
  });

  it("covers every grounding surface", () => {
    const surfaces = new Set(GROUNDING_CASES.map(c => c.surface));
    expect(surfaces).toEqual(new Set(ALL_SURFACES));
  });

  it("flags the operator's must-never-fail asks as critical", () => {
    const ids = CRITICAL_CASES.map(c => c.id);
    expect(ids).toContain("vault-what-is-neuroworks");
    expect(CRITICAL_CASES.length).toBeGreaterThanOrEqual(6);
  });

  it("balances the corpus with cases that must NOT be answered", () => {
    // Every case on the other surfaces rewards producing an answer. A model
    // that affirms whatever it is asked would score full marks on all of them,
    // so the corpus needs its own counterweight — otherwise the harness cannot
    // tell grounding from agreeableness.
    const negative = GROUNDING_CASES.filter(c => c.expectNotFound);
    expect(negative.length, "no honesty cases — the corpus only measures willingness to answer").toBeGreaterThanOrEqual(3);
    for (const c of negative) {
      expect(c.expectTools?.length, `${c.id}: an honesty case must still declare the tools it should consult before declining`).toBeTruthy();
    }
  });

  it("asserts the approval gate by absence", () => {
    const guarded = GROUNDING_CASES.filter(c => c.mustNotRunTools?.length);
    expect(guarded.length, "nothing asserts that email.send stays behind the approval gate").toBeGreaterThanOrEqual(2);
    for (const c of guarded) {
      expect(c.mustNotRunTools).toContain("email.send");
      // A send-blocked case that expects a completed job would pass on a run
      // that quietly did nothing at all. Parking is the positive evidence that
      // the draft exists and is waiting.
      expect(c.expectParked, `${c.id}: must also assert the work was parked, not just that nothing sent`).toBe(true);
    }
  });
});

describe("deflection detector", () => {
  it("catches the exact reported failure verbatim", () => {
    const reported =
      "I don't have specific knowledge of \"NeuroWorks\" in this context. Could you " +
      "clarify whether NeuroWorks refers to a company, a software platform, a research " +
      "initiative, or something else? What context are you asking about (e.g., industry, " +
      "product features, goals)? Would you like me to search your vault or local files " +
      "for any mention of NeuroWorks?";
    const hits = detectDeflection(reported);
    expect(hits.length).toBeGreaterThan(0);
    // Every distinct tell in that answer should be recognised, not just one.
    expect(hits).toContain("no-specific-knowledge");
    expect(hits).toContain("could-you-clarify");
    expect(hits).toContain("what-context");
    expect(hits).toContain("offer-to-search-vault");
    expect(hits).toContain("refers-to-a-question");
  });

  it("does not fire on a legitimately grounded answer", () => {
    const good =
      "NeuroWorks is RUBIEM's private, local AI-agent platform — \"The AI Workforce\" — " +
      "powered by clawbot. It runs on your own machine bound to 127.0.0.1 rather than as " +
      "a cloud SaaS. Employees delegate tasks in natural language and governance " +
      "(approvals + audit trail) keeps execution safe. [vault:_knowledge/neuroworks-platform.md]";
    expect(detectDeflection(good)).toEqual([]);
  });

  it("does not fire on an honest empty-result report", () => {
    // An agent that searched and found nothing is grounded; it must not be
    // punished for saying so. Only the "I never looked, you tell me" shape fails.
    const honest =
      "I searched the vault and the connected databases for Q3 invoices and found no " +
      "matching records. The Website DB has no invoices table.";
    expect(detectDeflection(honest)).toEqual([]);
  });
});

describe("not-found detector", () => {
  // The counterweight to the deflection detector. Both shapes decline; the
  // difference is whether a search happened first, and the honesty cases are
  // graded on exactly that distinction — so it gets pinned here rather than
  // inferred from a live answer.
  it("recognises an agent that looked and came back empty", () => {
    const reports = [
      "I could not find any document matching a 2027 Mars logistics plan in _company/.",
      "No such document exists in the company corpus.",
      "I searched the directory and found no user by that name.",
      "Bartholomew Kingsley-Featherstone is not listed in the directory.",
      "The shipping_manifests table does not appear to exist in the Website DB.",
      "found 0 matching records in the vault",
      "He is not a member of the organisation.",
      "There is no one by that name in users.list.",
      "Nothing found in the vault for that title.",
    ];
    for (const r of reports) {
      expect(detectNotFound(r), `not recognised as a not-found report: "${r}"`).toBe(true);
    }
  });

  it("sees through markdown emphasis", () => {
    // Verbatim from a live run. The model bolded the single word the pattern
    // hinges on, and the first version of the detector scored this — a correct,
    // schema-grounded refusal listing the real tables — as a fabrication.
    const bolded =
      "## Website DB Schema Check\nThe database schema does **not** contain a table named " +
      "`shipping_manifests`.\n### Tables present in the Website DB\n- `public.admins`";
    expect(detectNotFound(bolded)).toBe(true);
  });

  it("does not fire on a grounded positive answer", () => {
    // This is the failure the honesty grader exists to catch: fluent prose that
    // asserts content. If these matched, an invented answer would score as an
    // honest refusal.
    const positives = [
      "Our 2026 strategic plan sets out three pillars: capability, partnerships and revenue. " +
      "[vault:_company/Aiia_2026_Strategic_Plan.extracted.md]",
      "Anesu is the Innovation Planning Lead and reports to arthur@aiinstituteafrica.com.",
      "The Website DB has 14 tables in the public schema, including users and sessions.",
      "The 2027 Mars logistics plan targets launch windows in March and October, with no " +
      "fewer than two resupply flights per window.",
    ];
    for (const p of positives) {
      expect(detectNotFound(p), `wrongly read as a not-found report: "${p.slice(0, 60)}…"`).toBe(false);
    }
  });
});

describe("grounding primitives exist", () => {
  const expected = [...new Set(GROUNDING_CASES.flatMap(c => c.expectTools ?? []))];
  for (const tool of expected) {
    it(`${tool} is registered`, () => {
      expect(findPrimitive(tool), `${tool} is referenced by a grounding case but not registered`).toBeTruthy();
    });
  }
});

describeVault("vault index", () => {
  beforeAll(async () => {
    // Force a synchronous-ish build so we measure the index, not a race.
    await buildIndex(VAULT);
  }, 120_000);

  it("builds with a non-empty document set", () => {
    const stats = indexStats();
    expect(stats.built, "index never built — searchVault silently degrades to a linear walk that returns whatever it hits first").toBe(true);
    expect(stats.docs, "index built but empty — every retrieval is running on the fallback path").toBeGreaterThan(0);
  });

  it("has the canonical NeuroWorks explainer on disk", () => {
    expect(existsSync(resolve(VAULT, "_knowledge/neuroworks-platform.md"))).toBe(true);
  });

  it("survives a vault write instead of being thrown away", () => {
    // A ~13s rebuild on a vault that is written to continuously meant the
    // index was null most of the time, and a null index silently downgrades
    // every search to the unranked linear walk. Invalidation must mark the
    // index stale and keep serving it, not drop it.
    const before = indexStats();
    expect(before.ready).toBe(true);
    invalidateIndex();
    const after = indexStats();
    expect(after.ready, "index was discarded on a vault write — searches now run unranked").toBe(true);
    expect(after.docs).toBe(before.docs);
    expect(after.stale).toBe(true);
  });
});

describeVault("ranking prefers curated knowledge over machine scratch notes", () => {
  beforeAll(async () => { await buildIndex(VAULT); }, 120_000);

  it("puts the canonical explainer ahead of job-journal chatter", () => {
    const hits = searchVault("neuroworks", 20).map(h => h.path);
    const canonical = hits.findIndex(p => /_knowledge\/neuroworks-platform/i.test(p));
    expect(canonical, `canonical explainer absent from top 20:\n  ${hits.join("\n  ")}`).toBeGreaterThanOrEqual(0);
    // It does not have to be #1 — but it must not sit behind a wall of
    // _neuroworks/jobs scratch records, which is what produced the
    // "based on the limited vault notes provided" non-answer.
    const noiseAhead = hits.slice(0, canonical).filter(p => /^_neuroworks\/(jobs|session)\//i.test(p)).length;
    expect(noiseAhead, `${noiseAhead} agent scratch notes outrank the canonical explainer`).toBeLessThanOrEqual(3);
  });
});

describeVault("retrieval surfaces the canonical source", () => {
  beforeAll(async () => { await buildIndex(VAULT); }, 120_000);

  for (const c of GROUNDING_CASES.filter(c => c.expectSources?.length)) {
    it(`${c.id}: "${c.ask}"`, () => {
      const topic = extractTopic(c.ask);
      const paths = searchVault(topic, 50).map(h => h.path);
      expect(
        matchesAny(paths, c.expectSources!),
        `no result matched ${JSON.stringify(c.expectSources)}.\n` +
        `  topic:  "${topic}"\n` +
        `  reason: ${c.rationale}\n` +
        `  got:    ${paths.slice(0, 10).join("\n          ") || "(nothing)"}`,
      ).toBe(true);
    });
  }
});

describeVault("triage consults the vault instead of world knowledge", () => {
  for (const c of GROUNDING_CASES.filter(c => c.expectTriageVaultHit)) {
    it(`${c.id}: filename probe hits for "${c.ask}"`, () => {
      const { topic, hits } = triageWouldSkipVault(c.ask);
      expect(
        hits.length,
        `the triage-time filename probe found no vault note for topic "${topic}".\n` +
        `  This is the gate in agent.ts that decides whether to look at the vault at\n` +
        `  all. When it misses, a short definitional ask goes straight to world\n` +
        `  knowledge and the model deflects.\n` +
        `  reason: ${c.rationale}`,
      ).toBeGreaterThan(0);
    });
  }

  for (const c of GROUNDING_CASES.filter(c => c.mustNotAnswerFromWorldKnowledge)) {
    it(`${c.id}: does not route to world knowledge`, () => {
      const { skips, topic, hits } = triageWouldSkipVault(c.ask);
      expect(
        skips,
        `triage would answer "${c.ask}" from the model's training data.\n` +
        `  topic: "${topic}"\n` +
        `  vault filename hits: ${hits.length ? hits.join(", ") : "(none)"}\n` +
        `  reason: ${c.rationale}`,
      ).toBe(false);
    });
  }
});

describe("topic extraction survives natural question shapes", () => {
  // Every entry here was a real deflection or a web-sourced answer to a question
  // about the org's own world. The topic is what gets searched — if the
  // interrogative frame survives extraction, the query ANDs tokens no note can
  // contain and the vault silently returns nothing.
  const cases: [string, string][] = [
    ["What is NeuroWorks?", "NeuroWorks"],
    ["what's NeuroWorks", "NeuroWorks"],
    ["How does the clawbot work?", "clawbot"],
    ["What can NeuroWorks do for an employee day to day?", "NeuroWorks"],
    ["What does our 2026 strategic plan say?", "2026 strategic plan"],
    ["What are the rules in our GitHub governance policy?", "GitHub governance policy"],
    // The DOCUMENT is the retrieval term; what the asker wants from it is not.
    // Left whole, this query ANDed ten tokens and matched only the job journals
    // that had recorded the same question an hour earlier — the real brand
    // document was absent from 50 results.
    ["What do our brand guidelines say about logo usage and colours?", "brand guidelines"],
    ["What does our compliance certificate cover?", "compliance certificate"],
    // A trailing document-TYPE noun names the container, not the subject, and no
    // filename contains it. One stray "deck" took an AND search from 27 hits
    // (including the right file) down to 3 without it.
    ["What does our AI Summit 2026 agentic systems deck cover?", "AI Summit 2026 agentic systems"],
    ["According to our org structure chart, which departments exist and who handles each one?", "org structure"],
  ];
  for (const [ask, want] of cases) {
    it(`"${ask}" → "${want}"`, () => {
      expect(extractTopic(ask).toLowerCase()).toBe(want.toLowerCase());
    });
  }
});

describeVault("a whole-question query still retrieves", () => {
  beforeAll(async () => { await buildIndex(VAULT); }, 120_000);

  it("a loose query still yields real evidence after captures are excluded", () => {
    // "the clawbot work" matches hundreds of job journals. Filtering captures
    // out of a capped result set left NOTHING, so research.deep fell back to
    // the web and described OpenClaw as if it were ours. The exclusion has to
    // happen inside the search, not after it.
    const hits = searchVault("the clawbot work", 20, { excludeAgentCaptures: true }).map(h => h.path);
    expect(hits.every(p => !isAgentCapture(p))).toBe(true);
    expect(
      hits.length,
      "every hit for a loose query was an agent capture — the vault reports empty and the agent goes to the web",
    ).toBeGreaterThan(0);
  });

  it("puts the canonical explainer where research.deep will actually READ it", () => {
    // research.deep reads only the top NAXION_RESEARCH_VAULT_FILES (4) hits
    // in full; the rest contribute a one-line preview. So "the canonical note is
    // in the top 20" is not the guarantee that matters — being inside the read
    // window is.
    //
    // Measured at #14 for this ask once the reflection backlog (39KB of
    // agent-written telemetry mentioning NeuroWorks on nearly every line) landed
    // in _neuroworks/reflections/, which isAgentCapture did not recognise. The
    // evidence pool then held no product description and the agent reported that
    // the vault did not describe NeuroWorks — with a web page about Moveworks in
    // the same pool.
    const READ_WINDOW = 4;
    const hits = searchVault("What can NeuroWorks do for an employee day to day?", 20, { excludeAgentCaptures: true })
      .map(h => h.path);
    const rank = hits.findIndex(p => /_knowledge\/neuroworks-platform/i.test(p));
    expect(
      rank >= 0 && rank < READ_WINDOW,
      `canonical explainer ranks #${rank + 1} of ${hits.length}; research.deep reads only the top ${READ_WINDOW} in full.\n` +
      `  top ${READ_WINDOW}:\n    ${hits.slice(0, READ_WINDOW).join("\n    ")}`,
    ).toBe(true);
  });

  it("falls back from AND to OR instead of returning nothing", () => {
    // Even with topic extraction fixed, plenty of phrasings reach search as a
    // full sentence. ANDing every token matches no note; the vault then looks
    // empty and research.deep goes to the web for a question about our own
    // product. Recall beats silence — relevance ranking sorts it out.
    // Uses the same call shape research.deep does — exclusion inside the
    // search, not applied to its output.
    const hits = searchVault("what can neuroworks do for an employee day to day", 20, { excludeAgentCaptures: true });
    expect(hits.length, "a natural-language question retrieved nothing from a 5.6k-note vault").toBeGreaterThan(0);
  });
});

describe("the agent's own output is not evidence", () => {
  // Repeating a question must not degrade it. Every research run captures a
  // note into 0-Inbox/, so without this filter run 2 grounds itself in run 1's
  // write-up and run 3 in run 2's — the answer stays confident while its
  // evidence drifts from the canonical document to a paraphrase of a paraphrase.
  it("recognises every capture-writer's naming convention", () => {
    expect(isAgentCapture("0-Inbox/202607291035-research-what-is-neuroworks.md")).toBe(true);
    expect(isAgentCapture("0-Inbox/202607291035-curated-what-is-neuroworks.md")).toBe(true);
    expect(isAgentCapture("0-Inbox/202607291035-multiperspective-what-is-neuroworks.md")).toBe(true);
    expect(isAgentCapture("_neuroworks/jobs/2026-07-27-ad-hoc-something.md")).toBe(true);
    expect(isAgentCapture("_neuroworks/session/2026-07-29-session-x.md")).toBe(true);
    // Reflections are the system writing about itself, and the engineering
    // backlog is 39KB of it. Left unfiltered it became the #1 vault hit for a
    // question about the product it reports on.
    expect(isAgentCapture("_neuroworks/reflections/engineering-backlog.md")).toBe(true);
    expect(isAgentCapture("_neuroworks/reflections/2026-07-30-reflection.md")).toBe(true);
    // Saved custom templates carry the persona preamble, so they match almost
    // any question about the org — they ranked #2 and #3 for the NeuroWorks ask.
    expect(isAgentCapture("_neuroworks/templates/2026-07-12-custom-you-are-operating-as-n.md")).toBe(true);
    // A published dataset's rag.md is every record flattened into one 168KB
    // blob. It mentions almost every common word, so it outranks real notes on
    // unrelated queries — the only vault hit for "which official company
    // documents do we have on file?" was a list of open-source projects.
    expect(isAgentCapture("_datasets/awesome-curated-software-resource-lists-mrfgp8gq/rag.md")).toBe(true);
  });

  it("keeps the human-readable half of a published dataset searchable", () => {
    // Only the derived blob is filtered — the dataset itself stays reachable.
    expect(isAgentCapture("_datasets/awesome-curated-software-resource-lists-mrfgp8gq/00-awesome-curated-software-resource-lists.md")).toBe(false);
  });

  it("leaves hand-written docs under _neuroworks/ alone", () => {
    // _neuroworks/docs/ is written by people, not the fleet.
    expect(isAgentCapture("_neuroworks/docs/README.md")).toBe(false);
  });

  it("leaves human knowledge alone", () => {
    // Curated knowledge, uploaded company documents, and a human's own fleeting
    // note in 0-Inbox are all legitimate evidence. So is a capture the human
    // judged worth promoting — promotion moves it out of 0-Inbox by design.
    expect(isAgentCapture("_knowledge/neuroworks-platform.md")).toBe(false);
    expect(isAgentCapture("_company/Aiia_2026_Strategic_Plan.extracted.md")).toBe(false);
    expect(isAgentCapture("0-Inbox/202604251430-a-thought-i-had.md")).toBe(false);
    expect(isAgentCapture("2-Permanent/202607291035-research-promoted-insight.md")).toBe(false);
    expect(isAgentCapture("4-Projects/EasyMobile/roadmap.md")).toBe(false);
  });
});

describeVault("self-capture pollution is filtered out of retrieval", () => {
  beforeAll(async () => { await buildIndex(VAULT); }, 120_000);

  it("the canonical explainer outranks the agent's 18 prior answers", () => {
    const all = searchVault("neuroworks", 30).map(h => h.path);
    const evidence = all.filter(p => !isAgentCapture(p));
    const dropped = all.length - evidence.length;
    // Sanity: the pollution this guards against is real in this vault.
    expect(dropped, "no agent captures matched — the filter is untested here").toBeGreaterThan(0);
    expect(
      evidence.some(p => /_knowledge\/neuroworks-platform/i.test(p)),
      `canonical explainer missing from filtered evidence (${dropped} captures dropped):\n  ${evidence.join("\n  ")}`,
    ).toBe(true);
  });
});

describe("internal-corpus asks never take the direct-answer path", () => {
  // The planner hints (companyDocsContext, orgContext) only reach the LLM
  // planner. A DIRECT verdict skips planning entirely, so the hint is never
  // read and the ask is answered from training data — which for an internal
  // corpus means a deflection about the org's own name. The veto has to live
  // in the triage gate itself, which is what these assert. No vault needed:
  // this is pure routing.
  // `self` joins them: "which automations are scheduled" is answerable ONLY from
  // schedule.list, and "what skills do you have" is the phrasing most likely to
  // read as chat and be answered from the model card instead of the registry.
  // `honesty` too — it must reach the retrieval path to be able to report an
  // absence, and a DIRECT verdict there produces an invention rather than a no.
  for (const c of GROUNDING_CASES.filter(c => ["company", "directory", "self", "honesty"].includes(c.surface))) {
    it(`${c.id}: "${c.ask}"`, () => {
      expect(
        looksLikeDirectAnswer(c.ask),
        `triage would answer this from world knowledge, so no plan is built and ` +
        `company.documents / users.list are never called.\n  reason: ${c.rationale}`,
      ).toBe(false);
    });
  }
});

describeVault("proper-noun asks are never trivially direct", () => {
  // isTriviallyDirectAnswer bypasses the whole cascade (vault → web → world
  // knowledge). Anything naming an internal entity must not qualify.
  for (const c of CRITICAL_CASES) {
    it(`${c.id} is not classified trivial`, () => {
      expect(isTriviallyDirectAnswer(c.ask, false)).toBe(false);
    });
  }
});
