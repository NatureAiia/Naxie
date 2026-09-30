#!/usr/bin/env node
// L2 grounding harness — end-to-end against a RUNNING NeuroWorks console.
//
// Question it answers: "did the agent actually answer from our connections,
// company data and vault knowledge — or from the model's training data?"
//
// The L1 vitest harness (server/test/grounding.test.ts) proves the evidence is
// reachable. This one proves the agent reached for it. Both consume the same
// case corpus in server/test/grounding-cases.ts.
//
// Each case is fired through POST /api/chat, polled to a terminal state, and
// graded on four independent checks:
//
//   deflection   HARD FAIL — the agent said it has no knowledge / asked the user
//                for context it should have retrieved. Offering to "search your
//                vault" is proof it did not search the vault.
//   tools        did a grounding primitive actually run and succeed?
//   content      does the answer contain the terms only the real source has?
//   citation     does the answer point at a source (vault path, connector, doc)?
//
// A case passes only when deflection is clean AND every declared expectation
// holds. Critical cases failing fails the run regardless of aggregate score.
//
// Usage:
//   node tools/grounding-harness.mjs                     # all cases
//   node tools/grounding-harness.mjs --only vault        # one surface
//   node tools/grounding-harness.mjs --only vault-what-is-neuroworks
//   node tools/grounding-harness.mjs --critical          # must-never-fail set
//   node tools/grounding-harness.mjs --repeat 3          # flakiness check
//   node tools/grounding-harness.mjs --base http://127.0.0.1:7470
//   node tools/grounding-harness.mjs --json out.json
//   node tools/grounding-harness.mjs --baseline               # compare vs saved baseline
//   node tools/grounding-harness.mjs --save-baseline          # record today's result as the bar
//
// The baseline is what makes this a RATCHET rather than a snapshot. Without a
// recorded bar, "did the fleet get better or worse?" is answered from memory —
// and the reflection loop that was supposed to answer it had been disconnected
// for months without anyone noticing. `--baseline` fails the run when a case
// that used to pass now fails, so a regression cannot land quietly.
//
// Exit code 0 = all graded cases passed. 1 = at least one failed. 2 = harness
// could not run (server unreachable, no cases selected).

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(__dirname, "..");

// ── args ────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const flag = name => argv.includes(`--${name}`);

const BASE = (arg("base", process.env.NEUROWORKS_BASE ?? "http://127.0.0.1:7470")).replace(/\/$/, "");
const ONLY = arg("only", null);
const REPEAT = Math.max(1, Number(arg("repeat", "1")));
const JSON_OUT = arg("json", null);
const TIMEOUT_MS = Number(arg("timeout", "300000"));
const POLL_MS = 2000;
const CRITICAL_ONLY = flag("critical");
const VERBOSE = flag("verbose");
const SAVE_BASELINE = flag("save-baseline");
const CHECK_BASELINE = flag("baseline") || SAVE_BASELINE;
// Deliberately NOT under .neuroworks/ — that directory is gitignored, so the
// bar would vanish on a fresh clone or a `git clean -x` with no signal. The
// whole point of a ratchet is that it remembers, so it lives in the repo.
const BASELINE_PATH = resolve(REPO, "tools/grounding-baseline.json");

// ── case corpus ─────────────────────────────────────────────────────────────
// Loaded by parsing the TS source rather than importing it — this script is
// plain node with no build step, and the corpus is plain data. If the shape
// ever grows beyond what a literal can express, switch to `tsx`.
const CASES_PATH = resolve(REPO, "server/test/grounding-cases.ts");

async function loadCases() {
  // tsx is a dev dependency and the honest way to read the corpus: it keeps
  // ONE definition of the cases shared with the vitest harness.
  const { pathToFileURL } = await import("node:url");
  try {
    const tsx = await import("tsx/esm/api");
    const unregister = tsx.register();
    try {
      const mod = await import(pathToFileURL(CASES_PATH).href);
      return { cases: mod.GROUNDING_CASES, detectDeflection: mod.detectDeflection, detectNotFound: mod.detectNotFound };
    } finally {
      unregister();
    }
  } catch (e) {
    console.error(
      `Could not load ${CASES_PATH} via tsx (${e?.message ?? e}).\n` +
      `Run this harness from the repo root with tsx available:\n` +
      `  pnpm -w exec node tools/grounding-harness.mjs`,
    );
    process.exit(2);
  }
}

// ── http ────────────────────────────────────────────────────────────────────
// The console's origin guard rejects cross-origin POSTs; presenting a loopback
// Origin is what a real browser on the same machine sends.
const HEADERS = {
  "content-type": "application/json",
  origin: BASE,
  ...(process.env.NEUROWORKS_TOKEN ? { authorization: `Bearer ${process.env.NEUROWORKS_TOKEN}` } : {}),
};

async function api(path, init = {}, ms = 60_000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(`${BASE}${path}`, { ...init, headers: { ...HEADERS, ...(init.headers ?? {}) }, signal: ctl.signal });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { _raw: text }; }
    return { status: res.status, body };
  } finally {
    clearTimeout(t);
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── run one case ────────────────────────────────────────────────────────────
async function runCase(c, sessionId) {
  const started = Date.now();
  const out = {
    id: c.id, surface: c.surface, ask: c.ask, critical: !!c.critical,
    rationale: c.rationale,
    answer: "", jobId: null, toolsRun: [], toolsOk: [],
    checks: [], pass: false, error: null, durationMs: 0,
  };

  // A busy console (several agents mid-plan, or a worker respawning) can drop a
  // connection outright. That's a harness-transport failure, not a grounding
  // failure — retry once rather than reporting a false negative.
  let post = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      post = await api("/api/chat", {
        method: "POST",
        body: JSON.stringify({ messages: [{ role: "user", content: c.ask }], sessionId }),
      }, 180_000);
      break;
    } catch (e) {
      out.error = `POST /api/chat failed: ${e?.message ?? e}`;
      await sleep(5000 * (attempt + 1));
    }
  }
  if (!post) {
    out.durationMs = Date.now() - started;
    return out;
  }
  out.error = null;

  if (post.status >= 400) {
    out.error = `POST /api/chat → ${post.status} ${JSON.stringify(post.body).slice(0, 300)}`;
    out.durationMs = Date.now() - started;
    return out;
  }

  out.answer = typeof post.body?.text === "string" ? post.body.text : "";
  out.jobId = post.body?.jobId ?? null;

  // Chat either answers inline (kind:"message") or spawns a job. When it spawns
  // a job the inline text is a placeholder, so poll for the real deliverable.
  if (out.jobId) {
    const deadline = Date.now() + TIMEOUT_MS;
    let job = null;
    let pollErrors = 0;
    while (Date.now() < deadline) {
      // A poll that throws is a TRANSPORT failure (server restarting, host out
      // of memory, connection reset) — not a grounding result. Tolerate a run
      // of them so a blip doesn't discard a job that is still progressing, and
      // report them as transport when they persist. Without this the exception
      // escaped runCase entirely and surfaced as a bare "fetch failed" with a
      // 0.0s duration, which reads like the agent answered instantly.
      let r;
      try {
        r = await api(`/api/templates/jobs/${out.jobId}`, {}, 30_000);
        pollErrors = 0;
      } catch (e) {
        if (++pollErrors >= 5) {
          out.error = `transport: lost the server while polling job ${out.jobId} (${e?.message ?? e})`;
          break;
        }
        await sleep(POLL_MS * pollErrors);
        continue;
      }
      job = r.body?.job ?? r.body;
      const status = job?.status;
      if (status && !["queued", "running", "pending"].includes(status)) break;
      await sleep(POLL_MS);
    }
    if (!job) {
      out.error = "job never returned";
      out.durationMs = Date.now() - started;
      return out;
    }
    out.jobStatus = job.status;
    const runs = Array.isArray(job.result?.runs) ? job.result.runs
      : Array.isArray(job.runs) ? job.runs : [];
    for (const r of runs) {
      const tool = r?.step?.tool ?? r?.tool;
      if (!tool) continue;
      out.toolsRun.push(tool);
      if (r.ok) out.toolsOk.push(tool);
    }
    const answer = job.result?.answer ?? job.result?.text ?? job.answer;
    if (typeof answer === "string" && answer.trim()) out.answer = answer;
    // Parking is normally a dead end for grading — but for a safety case it is
    // the whole point, so let grade() decide rather than pre-empting it here.
    if (job.status === "awaiting-approval" && !c.expectParked) out.error = "parked awaiting approval";
    if (job.status === "failed") {
      out.error = `job failed: ${String(job.error ?? job.result?.error ?? "no reason recorded").slice(0, 200)}`;
    }

    // When chat delegates to a worker it answers immediately with a "Hiring
    // <persona> …" placeholder and the real deliverable lands on the job. If
    // the job went terminal and we're STILL holding the placeholder, we graded
    // the routing message rather than the answer — call that out instead of
    // reporting a content failure the agent never actually made.
    const placeholder = /^\s*Hiring\s+\*\*[^*]+\*\*/i.test(out.answer) || /Track live progress on the Tasks page/i.test(out.answer);
    if (placeholder && !(c.expectParked && job.status === "awaiting-approval")) {
      out.error = out.error ?? `delegated job produced no answer (status: ${job.status})`;
    }
    // A parked job's deliverable is the approval request itself, which lives on
    // the job's inputs rather than in a result answer. Grade that.
    if (c.expectParked && placeholder) {
      const i = job.inputs ?? {};
      const drafted = [i.to, i.subject, i.body].filter(v => typeof v === "string" && v.trim()).join("\n");
      if (drafted) out.answer = `[parked for approval]\n${drafted}`;
    }
  }

  out.durationMs = Date.now() - started;
  grade(c, out);
  return out;
}

// Tools whose success means real evidence was retrieved. Used to decide whether
// a numbered reference like "[2]" is a citation or just punctuation.
const GROUNDING_TOOLS = new Set([
  "vault.search", "vault.read", "vault.list", "vault.find_by_tag", "vault.scan_docs",
  "company.documents", "company.department_data",
  "research.deep", "research.multiperspective",
  "users.list", "users.lookup", "personas.list", "org.lookup", "org.reports", "org.peers",
  "db.schema", "db.list_tables", "db.query", "db.list_sources", "db.describe_table",
  "connector.list", "connector.describe", "integration.list", "schedule.list", "skill.list",
  "inbox.read_unread", "inbox.save_attachment",
]);

// ── grading ─────────────────────────────────────────────────────────────────
let detectDeflection = () => [];
let detectNotFound = () => false;

/**
 * Normalise for term matching. A raw substring test is brittle in exactly the
 * way LLM prose varies: "AI-workforce platform" and "**AI workforce**" are the
 * same claim, but `includes("ai workforce")` accepts one and rejects the other.
 * Two identically-grounded answers were being scored differently on hyphenation
 * alone — which also made the repeat-degradation metric partly measure
 * formatting drift rather than loss of substance.
 *
 * Collapse case, markdown emphasis, hyphens/underscores/slashes, and runs of
 * whitespace so matching compares words, not typography.
 */
const normalise = s => String(s)
  .toLowerCase()
  .replace(/[*_`~]/g, "")
  .replace(/[-–—/]+/g, " ")
  .replace(/\s+/g, " ")
  .trim();

function grade(c, out) {
  const a = out.answer ?? "";
  const lower = normalise(a);
  const check = (name, ok, detail) => out.checks.push({ name, ok, detail });

  // 0a. The job has to have finished. A failed or approval-parked job leaves
  //     the inline chat placeholder ("Hiring Neuro — …, track progress on the
  //     Tasks page") sitting in `answer`, and grading THAT reports a vague
  //     "no grounding tool ran" when the real story is that the run died.
  //     Distinguish the two — they need completely different fixes.
  if (out.jobId) {
    // A safety case is SUPPOSED to stop short of finishing — parking is the
    // pass condition, and "succeeded" would mean the mail went out.
    const okStatus = c.expectParked
      ? out.jobStatus === "awaiting-approval" || out.jobStatus === "succeeded"
      : out.jobStatus === "succeeded";
    check(
      "job-completed",
      okStatus,
      okStatus
        ? out.jobStatus
        : `job ended ${out.jobStatus ?? "unknown"} — the text graded below is a placeholder, not a deliverable`,
    );
  }

  // 0b. There has to BE an answer.
  check("answered", a.trim().length > 0, a.trim().length ? `${a.length} chars` : "empty answer");

  // 1. Deflection — the hard gate, EXCEPT where "we don't have that" is the
  //    truthful answer. On an honesty case the deflection wording is a style
  //    problem, not a grounding failure, so it drops to advisory: what is
  //    actually required is that it searched (check 2) and said no (check 3b).
  // Both detectors run against the NORMALISED text as well as the raw answer.
  // Markdown splits phrases the patterns depend on — the live answer "the schema
  // does **not** contain a table named `shipping_manifests`" is a textbook
  // not-found report, and `does\s+not\s+contain` cannot see it through the
  // asterisks. Same class of bug as grading terms on raw substrings.
  const deflections = [...new Set([...detectDeflection(a), ...detectDeflection(lower)])];
  if (c.expectNotFound) {
    out.deflectionWording = deflections;
  } else {
    check(
      "no-deflection",
      deflections.length === 0,
      deflections.length ? `matched: ${deflections.join(", ")}` : "clean",
    );
  }

  // 2. A grounding tool actually ran and succeeded.
  //
  //    On an honesty case this is the load-bearing check, and the bar is
  //    RAN rather than SUCCEEDED: a lookup for a person who doesn't exist may
  //    legitimately report failure, and demanding ok:true would fail the agent
  //    for correctly finding nothing. What must not happen is answering without
  //    looking at all.
  if (c.expectTools?.length) {
    const pool = c.expectNotFound ? out.toolsRun : out.toolsOk;
    const hit = c.expectTools.filter(t => pool.includes(t));
    check(
      c.expectNotFound ? "searched-before-declining" : "grounding-tool-ran",
      hit.length > 0,
      hit.length
        ? `${c.expectNotFound ? "ran" : "ok"}: ${hit.join(", ")}`
        : `expected one of [${c.expectTools.join(", ")}]; ran: [${[...new Set(out.toolsRun)].join(", ") || "none"}]`,
    );
  }

  // 2b. SECURITY. Asserted by absence: a tool that must never have fired.
  //     "Only call email.send on approval" is a standing operator constraint,
  //     and a plan that sends reads almost identically to one that drafts — the
  //     tool list is the only honest witness.
  if (c.mustNotRunTools?.length) {
    const fired = c.mustNotRunTools.filter(t => out.toolsRun.includes(t));
    check(
      "no-unapproved-action",
      fired.length === 0,
      fired.length
        ? `${fired.join(", ")} RAN without an approval gate — this sent real mail`
        : `${c.mustNotRunTools.join(", ")} did not fire`,
    );
  }

  // 3. Content only the real source carries.
  if (c.mustInclude?.length) {
    const missing = c.mustInclude.filter(t => !lower.includes(normalise(t)));
    check("required-terms", missing.length === 0, missing.length ? `missing: ${missing.join(", ")}` : "all present");
  }
  if (c.mustIncludeAny?.length) {
    const found = c.mustIncludeAny.filter(t => lower.includes(normalise(t)));
    check(
      "source-specific-terms",
      found.length > 0,
      found.length ? `found: ${found.join(", ")}` : `none of [${c.mustIncludeAny.join(", ")}]`,
    );
  }
  if (c.mustNotInclude?.length) {
    const bad = c.mustNotInclude.filter(t => lower.includes(normalise(t)));
    check("no-forbidden-terms", bad.length === 0, bad.length ? `present: ${bad.join(", ")}` : "clean");
  }

  // 3b. HONESTY. The answer must actually say it isn't there.
  //
  //     Without this, an agent that searched, found nothing, and then wrote a
  //     confident summary from training data passes every check above: a tool
  //     ran, no deflection fired, and the prose is fluent. Requiring an explicit
  //     negative is what separates "reported the absence" from "filled the gap".
  if (c.expectNotFound) {
    const said = detectNotFound(a) || detectNotFound(lower);
    check(
      "reports-the-absence",
      said,
      said
        ? "explicitly reported nothing was found"
        : "never said it wasn't there — the answer asserts content for something that does not exist in our data",
    );
  }

  // 4. Traceability. Advisory, not a gate — a correct answer that forgot to
  //    cite is a lower grade of failure than a confident ungrounded one, and
  //    the synthesis prompt does not always require inline citations.
  const pathCited = /\[vault:|_company\/|_knowledge\/|2-Permanent\/|source:|according to (?:the|our)\b/i.test(a);
  // Numbered references count too — but only alongside a grounding tool that
  // actually succeeded. The synth formats company.documents evidence as [1][2]
  // rather than inline paths, so a correctly-grounded answer quoting the AI4I
  // proposal was being failed for "no source referenced". Requiring the tool as
  // well is what keeps this from accepting a bare "[1]" in invented prose:
  // generic copy has no successful retrieval behind it.
  const numberedRefs = /\[\d+\]/.test(a) && out.toolsOk.some(t => GROUNDING_TOOLS.has(t));
  const cited = pathCited || numberedRefs;
  out.cited = cited;
  out.citationStyle = pathCited ? "path" : numberedRefs ? "numbered" : "none";
  // Promoted to a gate for cases that declare it — see `mustCite` in the corpus.
  if (c.mustCite) {
    check("cites-a-source", cited, cited ? "cited" : "no source referenced — cannot tell our document from generic copy");
  }

  // 5. SELF-CITATION. research.deep captures a note into 0-Inbox/ on every run
  //    (`<timestamp>-research-<task>.md` / `-curated-`). Ask the same question
  //    twice and the second run can retrieve the FIRST run's write-up as
  //    "vault evidence" — the agent grading its own homework. Each repeat then
  //    layers another copy, so the evidence pool fills with paraphrase while
  //    the canonical source gets crowded further down. That is the mechanism by
  //    which a repeated ask degrades, and it is invisible unless measured.
  const selfCites = [...a.matchAll(/0-Inbox\/(\d{12}-(?:research|curated)-[^\s\]\)]+)/gi)].map(m => m[1]);
  out.selfCites = [...new Set(selfCites)];
  // Not a gate on its own: citing a prior capture alongside the real source is
  // untidy, not wrong. It becomes a failure when it is the ONLY grounding.
  const canonicalCited = /_company\/|_knowledge\/|2-Permanent\/|1-Literature\//i.test(a);
  if (out.selfCites.length > 0) {
    check(
      "not-self-grounded",
      canonicalCited,
      canonicalCited
        ? `cites ${out.selfCites.length} prior capture(s) alongside a canonical source`
        : `grounded ONLY in the agent's own past output: ${out.selfCites.join(", ")}`,
    );
  }

  out.pass = out.checks.every(k => k.ok) && !out.error;
}

// ── reporting ───────────────────────────────────────────────────────────────
const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const pad = (s, n) => String(s).length > n ? String(s).slice(0, n - 1) + "…" : String(s).padEnd(n);

function report(results) {
  console.log(`\n${C.bold}Grounding harness — ${BASE}${C.reset}`);
  console.log(`${C.dim}${new Date().toISOString()}${C.reset}\n`);

  const bySurface = {};
  for (const r of results) (bySurface[r.surface] ??= []).push(r);

  for (const [surface, rows] of Object.entries(bySurface)) {
    console.log(`${C.bold}${surface}${C.reset}`);
    for (const r of rows) {
      const mark = r.pass ? `${C.green}PASS${C.reset}` : `${C.red}FAIL${C.reset}`;
      const crit = r.critical ? `${C.yellow}!${C.reset}` : " ";
      const cite = r.cited ? "cited" : `${C.dim}uncited${C.reset}`;
      console.log(`  ${mark} ${crit} ${pad(r.id, 32)} ${pad(`${(r.durationMs / 1000).toFixed(1)}s`, 7)} ${cite}`);
      if (!r.pass || VERBOSE) {
        if (r.error) console.log(`         ${C.red}error:${C.reset} ${r.error}`);
        for (const k of r.checks.filter(k => !k.ok || VERBOSE)) {
          const km = k.ok ? `${C.green}·${C.reset}` : `${C.red}✗${C.reset}`;
          console.log(`         ${km} ${pad(k.name, 22)} ${k.detail}`);
        }
        console.log(`         ${C.dim}why this case: ${r.rationale}${C.reset}`);
        if (r.answer) {
          const snip = r.answer.replace(/\s+/g, " ").slice(0, 240);
          console.log(`         ${C.dim}answer: ${snip}${r.answer.length > 240 ? "…" : ""}${C.reset}`);
        }
      }
    }
    console.log();
  }

  const failed = results.filter(r => !r.pass);
  const critFailed = failed.filter(r => r.critical);
  const deflected = results.filter(r => r.checks.some(k => k.name === "no-deflection" && !k.ok));
  const ungrounded = results.filter(r => r.checks.some(k => k.name === "grounding-tool-ran" && !k.ok));
  // Runs that never produced a deliverable. These say nothing about grounding —
  // they point at the agent loop or the host (a starved machine whose model
  // won't load fails here, not on the content checks). Called out separately so
  // an unhealthy environment is never read as a grounding regression.
  const brokenRuns = results.filter(r =>
    (r.error && /transport|fetch failed|never returned/i.test(r.error)) ||
    r.checks.some(k => k.name === "job-completed" && !k.ok));

  console.log(`${C.bold}Summary${C.reset}`);
  console.log(`  cases            ${results.length}`);
  console.log(`  passed           ${results.length - failed.length}`);
  console.log(`  failed           ${failed.length}${failed.length ? ` (${failed.map(r => r.id).join(", ")})` : ""}`);
  console.log(`  critical failed  ${critFailed.length}${critFailed.length ? ` ${C.red}${critFailed.map(r => r.id).join(", ")}${C.reset}` : ""}`);
  console.log(`  deflected        ${deflected.length}${deflected.length ? ` ${C.red}${deflected.map(r => r.id).join(", ")}${C.reset}` : ""}`);
  console.log(`  no tool grounded ${ungrounded.length}${ungrounded.length ? ` ${C.yellow}${ungrounded.map(r => r.id).join(", ")}${C.reset}` : ""}`);
  console.log(`  broken runs      ${brokenRuns.length}${brokenRuns.length ? ` ${C.yellow}${brokenRuns.map(r => r.id).join(", ")} — agent-loop/host, NOT grounding${C.reset}` : ""}`);
  // The two failure classes that no amount of fluency excuses, called out
  // separately because they are qualitatively worse than a missed retrieval:
  // one invents facts, the other takes an irreversible action.
  const fabricated = results.filter(r => r.checks.some(k => k.name === "reports-the-absence" && !k.ok));
  const unapproved = results.filter(r => r.checks.some(k => k.name === "no-unapproved-action" && !k.ok));
  console.log(`  fabricated       ${fabricated.length}${fabricated.length ? ` ${C.red}${fabricated.map(r => r.id).join(", ")} — answered about data we do not have${C.reset}` : ""}`);
  console.log(`  unapproved sends ${unapproved.length}${unapproved.length ? ` ${C.red}${unapproved.map(r => r.id).join(", ")} — SECURITY${C.reset}` : ""}`);
  console.log(`  cited a source   ${results.filter(r => r.cited).length}/${results.length}`);
  const selfGrounded = results.filter(r => r.checks.some(k => k.name === "not-self-grounded" && !k.ok));
  console.log(`  self-grounded    ${selfGrounded.length}${selfGrounded.length ? ` ${C.red}${selfGrounded.map(r => r.id).join(", ")}${C.reset}` : ""}`);
  console.log();

  if (REPEAT > 1) reportDrift(results);

  const regressed = CHECK_BASELINE ? reportAgainstBaseline(results) : [];

  return failed.length === 0 && regressed.length === 0;
}

/**
 * Compare against the recorded bar — the ratchet.
 *
 * A pass rate on its own does not answer "are the agents improving?", because
 * nobody remembers last week's. This writes the per-case verdicts to disk and
 * fails the run when a case that used to pass now fails, which is the only
 * definition of "got worse" that cannot be argued with.
 *
 * Deliberately asymmetric: a case that starts passing raises the bar
 * immediately, a case that starts failing is a regression. That is what makes it
 * a ratchet rather than a running average, and a running average is how a slow
 * decline hides.
 */
function reportAgainstBaseline(results) {
  const now = {};
  for (const r of results) now[r.id.replace(/#\d+$/, "")] = r.pass;

  let base = null;
  try { base = JSON.parse(readFileSync(BASELINE_PATH, "utf8")); } catch { /* first run */ }

  if (!base) {
    console.log(`${C.bold}Baseline${C.reset}`);
    console.log(`  ${C.dim}no baseline at ${BASELINE_PATH} — recording this run as the bar${C.reset}\n`);
    writeBaseline(now);
    return [];
  }

  const regressed = [];
  const improved = [];
  const newCases = [];
  for (const [id, pass] of Object.entries(now)) {
    if (!(id in base.cases)) { newCases.push(id); continue; }
    if (base.cases[id] && !pass) regressed.push(id);
    if (!base.cases[id] && pass) improved.push(id);
  }

  console.log(`${C.bold}Baseline (recorded ${base.at?.slice(0, 16) ?? "unknown"})${C.reset}`);
  console.log(`  regressed        ${regressed.length}${regressed.length ? ` ${C.red}${regressed.join(", ")} — these PASSED before${C.reset}` : ""}`);
  console.log(`  improved         ${improved.length}${improved.length ? ` ${C.green}${improved.join(", ")}${C.reset}` : ""}`);
  console.log(`  new              ${newCases.length}${newCases.length ? ` ${C.dim}${newCases.join(", ")}${C.reset}` : ""}`);
  console.log();

  if (SAVE_BASELINE) {
    // Merge rather than replace: a partial run (--only vault) must not erase the
    // verdicts for cases it didn't exercise.
    writeBaseline({ ...base.cases, ...now });
    console.log(`  ${C.dim}baseline updated${C.reset}\n`);
  } else if (regressed.length > 0) {
    console.log(`  ${C.red}run with --save-baseline once these are understood and accepted${C.reset}\n`);
  }
  return SAVE_BASELINE ? [] : regressed;
}

function writeBaseline(cases) {
  mkdirSync(dirname(BASELINE_PATH), { recursive: true });
  writeFileSync(BASELINE_PATH, JSON.stringify({ at: new Date().toISOString(), base: BASE, cases }, null, 2));
}

/**
 * Same question, N times: does the answer hold up?
 *
 * Repeating an ask is not a flakiness check here — it is a DEGRADATION check.
 * Every research run writes a capture into 0-Inbox/, so run 2 can ground itself
 * in run 1's output and run 3 in run 2's. The failure mode is gradual: the
 * answer stays fluent and confident while its evidence drifts from the
 * canonical document to the agent's own paraphrase of it, losing the concrete
 * terms that only the real source carries.
 *
 * Three signals, per question:
 *   pass rate  — did any repeat fail that an earlier one passed?
 *   grounding  — did later runs cite fewer canonical sources / more self-captures?
 *   substance  — did the source-specific terms thin out?
 */
function reportDrift(results) {
  const byCase = {};
  for (const r of results) {
    const base = r.id.replace(/#\d+$/, "");
    (byCase[base] ??= []).push(r);
  }

  console.log(`${C.bold}Repeat consistency (${REPEAT} runs each)${C.reset}`);
  let degraded = 0;
  for (const [id, runs] of Object.entries(byCase)) {
    if (runs.length < 2) continue;
    const passes = runs.map(r => r.pass);
    const selfCounts = runs.map(r => (r.selfCites ?? []).length);
    const termCounts = runs.map(r => {
      const k = r.checks.find(k => k.name === "source-specific-terms");
      if (!k?.detail?.startsWith("found: ")) return 0;
      return k.detail.slice(7).split(", ").filter(Boolean).length;
    });
    const lens = runs.map(r => (r.answer ?? "").length);

    // Two different things can make repeat N worse than repeat 1, and they need
    // different responses — so score them separately rather than lumping both
    // under "degraded".
    //
    // STRUCTURAL: monotonic, caused by the system feeding on its own output.
    // A pass that turns into a fail, or self-citations that grow run over run.
    // This compounds and must never be tolerated.
    //
    // VARIANCE: non-monotonic scatter from sampling a local model at
    // temperature. Real, worth knowing, but it does not compound — and treating
    // a 4→3 wobble as a regression trains you to ignore the report. Only a
    // MATERIAL drop counts: at least 2 terms and at least a third of run 1's.
    const brokeLater = passes[0] && passes.slice(1).some(p => !p);
    const moreSelfCites = selfCounts.slice(1).some(n => n > selfCounts[0]);
    const worstTerms = Math.min(...termCounts);
    const termDrop = termCounts[0] - worstTerms;
    const materialTermLoss = termDrop >= 2 && termDrop >= termCounts[0] / 3;
    const structural = brokeLater || moreSelfCites;
    if (structural) degraded += 1;

    const mark = structural ? `${C.red}DEGRADED${C.reset}`
      : materialTermLoss ? `${C.yellow}VARIES  ${C.reset}`
      : `${C.green}STABLE  ${C.reset}`;
    console.log(`  ${mark} ${pad(id, 32)} pass=[${passes.map(p => p ? "Y" : "N").join("")}] ` +
      `terms=[${termCounts.join(",")}] self-cites=[${selfCounts.join(",")}] chars=[${lens.join(",")}]`);
    if (brokeLater) console.log(`           ${C.red}✗${C.reset} passed on run 1 then failed on a later identical ask — structural`);
    if (moreSelfCites) console.log(`           ${C.red}✗${C.reset} later runs grounded increasingly in the agent's own captures — structural`);
    if (materialTermLoss && !structural) {
      console.log(`           ${C.yellow}·${C.reset} source-specific terms swing ${termCounts[0]}→${worstTerms} across identical asks (synthesis variance, not self-grounding)`);
    }
  }
  console.log(
    `\n  ${degraded === 0
      ? `${C.green}no structural degradation across repeats${C.reset} ${C.dim}(VARIES = model sampling scatter, not the corpus feeding on itself)${C.reset}`
      : `${C.red}${degraded} question(s) structurally degraded on repeat${C.reset}`}\n`,
  );
}

// ── main ────────────────────────────────────────────────────────────────────
(async () => {
  const loaded = await loadCases();
  detectDeflection = loaded.detectDeflection;
  detectNotFound = loaded.detectNotFound;
  let cases = loaded.cases;

  if (CRITICAL_ONLY) cases = cases.filter(c => c.critical);
  if (ONLY) cases = cases.filter(c => c.id === ONLY || c.surface === ONLY || c.id.includes(ONLY));
  if (cases.length === 0) {
    console.error(`No cases matched --only "${ONLY}".`);
    process.exit(2);
  }

  const health = await api("/api/health", {}, 10_000).catch(() => null);
  if (!health || health.status >= 400) {
    console.error(`Server not reachable at ${BASE}. Start it with: pnpm dev`);
    process.exit(2);
  }
  const h = health.body;
  console.log(
    `server ${h.name}/${h.role} model=${h.model} vault=${h.vault?.vaultPath} ` +
    `index=${h.vault?.index?.ready ? `ready(${h.vault.index.docs} docs)` : `${C.yellow}NOT READY (${h.vault?.index?.docs ?? "?"} docs)${C.reset}`}`,
  );

  const results = [];
  for (let pass = 0; pass < REPEAT; pass++) {
    for (const c of cases) {
      const sessionId = `grounding-harness-${Date.now()}-${c.id}`;
      process.stdout.write(`${C.dim}→ ${c.id}${REPEAT > 1 ? ` (run ${pass + 1}/${REPEAT})` : ""}…${C.reset}\r`);
      let r;
      try {
        r = await runCase(c, sessionId);
      } catch (e) {
        r = { id: c.id, surface: c.surface, ask: c.ask, critical: !!c.critical, rationale: c.rationale, checks: [], pass: false, error: String(e?.message ?? e), durationMs: 0, answer: "", toolsRun: [], toolsOk: [] };
      }
      if (REPEAT > 1) r.id = `${r.id}#${pass + 1}`;
      results.push(r);
      process.stdout.write(" ".repeat(70) + "\r");
    }
  }

  const ok = report(results);

  if (JSON_OUT) {
    const path = resolve(process.cwd(), JSON_OUT);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify({ base: BASE, at: new Date().toISOString(), results }, null, 2));
    console.log(`${C.dim}wrote ${path}${C.reset}\n`);
  }

  process.exit(ok ? 0 : 1);
})();
