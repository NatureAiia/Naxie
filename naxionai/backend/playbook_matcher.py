"""
NAXIONAI — Playbook skill matcher (Phase 2)

Ported from neuroworks/server/src/lib/skills.ts. Playbooks are short markdown
guidance docs the agent can load when working on a relevant task — "how to
write a good email", "how to structure meeting notes" — NOT the same thing
as SkillForge's GeneratedSkill (LLM-authored, E2B-sandbox-tested Python tools
that get executed). Playbooks are never executed; they're injected into a
synth prompt to bias output style/structure. See the two-table split in
database.py: GeneratedSkill (unchanged) vs PlaybookSkill (new, this module).

Two sources, exactly like the TS original:
  - builtin: ships as backend/skills/*.md (140 curated playbooks, copied
    verbatim from neuroworks).
  - user: rows in the PlaybookSkill table (user-authored or auto-drafted
    overrides) — loaded by the API layer and passed in alongside the builtin
    list, not read from disk.

Lookup is by stable name (the `name:` frontmatter field, or the filename
without .md). suggest_skills_for_task() matches a task's text (and,
optionally, a detected intent) against `applies_to` frontmatter plus the
SKILL_KEYWORDS regex table below — ported pattern-for-pattern (extracted
programmatically from the live RegExp objects in skills.ts, not
hand-transcribed, to avoid subtle regex bugs).
"""

import re
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple

SKILLS_DIR = Path(__file__).parent / "skills"


@dataclass
class PlaybookSkillDef:
    name: str
    description: str
    applies_to: List[str]
    body: str                # full markdown body (post-frontmatter)
    source: str               # "builtin" | "user" | "auto"


def parse_frontmatter(raw_in: str) -> Tuple[dict, str]:
    """Parse a `---\\nkey: value\\n---\\nbody` block. Array values use the
    `[a, b, c]` form. Mirrors skills.ts's parseFrontmatter()."""
    raw = raw_in.replace("\r\n", "\n")
    m = re.match(r"^---\n([\s\S]*?)\n---\n?([\s\S]*)$", raw)
    if not m:
        return {}, raw
    meta_raw, body = m.group(1), m.group(2)
    meta: dict = {}
    for line in meta_raw.split("\n"):
        kv = re.match(r"^\s*([\w_-]+):\s*(.+?)\s*$", line)
        if not kv:
            continue
        key, val = kv.group(1), kv.group(2)
        if val.startswith("[") and val.endswith("]"):
            meta[key] = [s.strip().strip("\"'") for s in val[1:-1].split(",") if s.strip()]
        else:
            meta[key] = val.strip("\"'")
    return meta, body


def load_builtin_skills() -> List[PlaybookSkillDef]:
    """The 140 static playbooks bundled under backend/skills/."""
    out: List[PlaybookSkillDef] = []
    if not SKILLS_DIR.exists():
        return out
    for path in sorted(SKILLS_DIR.glob("*.md")):
        raw = path.read_text(encoding="utf-8")
        meta, body = parse_frontmatter(raw)
        applies_to = meta.get("applies_to")
        out.append(PlaybookSkillDef(
            name=str(meta.get("name", path.stem)).strip(),
            description=str(meta.get("description", "(no description)")).strip(),
            applies_to=applies_to if isinstance(applies_to, list) else [],
            body=body.strip(),
            source="builtin",
        ))
    return out


SKILL_KEYWORDS: List[Tuple[str, List[re.Pattern]]] = [
    ("email-writing", [
        re.compile("^(?!.*\\battach).*\\bemail\\b", re.IGNORECASE | re.DOTALL),
        re.compile("\\breply\\s+to\\b", re.IGNORECASE),
        re.compile("\\bsend\\s+(?:\\w+\\s+){0,3}(?:a\\s+|an\\s+|the\\s+)?(?:report|update|summary|recap|status)\\b", re.IGNORECASE),
    ]),
    ("memo-writing", [
        re.compile("\\bmemo\\b", re.IGNORECASE),
    ]),
    ("report-writing", [
        re.compile("\\b(?:full|quarterly|annual)\\s+report\\b", re.IGNORECASE),
        re.compile("\\banalysis\\s+report\\b", re.IGNORECASE),
    ]),
    ("brief-writing", [
        re.compile("(?<!negotiation[\\s-])(?<!campaign[\\s-])\\b(?:executive\\s+)?brief\\b", re.IGNORECASE),
        re.compile("\\bone[-\\s]?pager\\b", re.IGNORECASE),
    ]),
    ("proposal-writing", [
        re.compile("\\bproposal\\b", re.IGNORECASE),
        re.compile("\\bpitch\\s+(?:doc|deck)\\b", re.IGNORECASE),
        re.compile("\\brfp\\s+response\\b", re.IGNORECASE),
    ]),
    ("product-spec", [
        re.compile("\\bprd\\b", re.IGNORECASE),
        re.compile("\\bproduct\\s+(?:spec|requirements)\\b", re.IGNORECASE),
        re.compile("\\bproduct\\s+brief\\b", re.IGNORECASE),
    ]),
    ("design-doc", [
        re.compile("\\bdesign\\s+doc(?:ument)?\\b", re.IGNORECASE),
        re.compile("\\brfc\\b", re.IGNORECASE),
        re.compile("\\btechnical\\s+design\\b", re.IGNORECASE),
    ]),
    ("decision-doc", [
        re.compile("\\badr\\b", re.IGNORECASE),
        re.compile("\\brfd\\b", re.IGNORECASE),
        re.compile("\\barchitecture\\s+decision\\b", re.IGNORECASE),
        re.compile("\\bdecision\\s+record\\b", re.IGNORECASE),
    ]),
    ("incident-post-mortem", [
        re.compile("\\bpost[\\s-]?mortem\\b", re.IGNORECASE),
        re.compile("\\bincident\\s+(?:report|review)\\b", re.IGNORECASE),
        re.compile("\\bretro\\s+for\\s+(?:the\\s+)?(?:incident|outage)\\b", re.IGNORECASE),
    ]),
    ("root-cause-analysis", [
        re.compile("\\broot\\s+cause\\b", re.IGNORECASE),
        re.compile("\\brca\\b", re.IGNORECASE),
        re.compile("\\b5\\s+whys?\\b", re.IGNORECASE),
        re.compile("\\bfive\\s+whys?\\b", re.IGNORECASE),
    ]),
    ("competitive-analysis", [
        re.compile("\\bcompetitor\\b", re.IGNORECASE),
        re.compile("\\bcompetitive\\s+(?:analysis|landscape)\\b", re.IGNORECASE),
        re.compile("\\bmarket\\s+landscape\\b", re.IGNORECASE),
    ]),
    ("okr-writing", [
        re.compile("\\bokrs?\\b", re.IGNORECASE),
        re.compile("\\bobjectives?\\s+and\\s+key\\s+results\\b", re.IGNORECASE),
    ]),
    ("one-on-one-prep", [
        re.compile("\\b1[\\s:.-]?1\\b", re.IGNORECASE),
        re.compile("\\bone[\\s-]on[\\s-]one\\b", re.IGNORECASE),
    ]),
    ("performance-review", [
        re.compile("\\b(?:perf|performance)\\s+review\\b", re.IGNORECASE),
        re.compile("\\bself[\\s-]?review\\b", re.IGNORECASE),
    ]),
    ("status-update", [
        re.compile("\\bstatus\\s+update\\b", re.IGNORECASE),
        re.compile("\\bweekly\\s+update\\b", re.IGNORECASE),
        re.compile("\\bstandup\\s+(?:update|note)\\b", re.IGNORECASE),
    ]),
    ("weekly-review", [
        re.compile("\\bweekly\\s+review\\b", re.IGNORECASE),
        re.compile("\\bweek\\s+in\\s+review\\b", re.IGNORECASE),
    ]),
    ("meeting-agenda", [
        re.compile("\\b(?:meeting\\s+)?agenda\\b", re.IGNORECASE),
    ]),
    ("meeting-notes", [
        re.compile("\\bmeeting\\s+notes\\b", re.IGNORECASE),
        re.compile("\\bminutes\\s+of\\s+the\\s+meeting\\b", re.IGNORECASE),
    ]),
    ("announcement-writing", [
        re.compile("\\bannouncement\\b", re.IGNORECASE),
        re.compile("\\bannounce\\b", re.IGNORECASE),
    ]),
    ("image-prompting", [
        re.compile("\\b(?:generate|make|create|design|render|produce)\\s+(?:an?\\s+|me\\s+an?\\s+)?(?:image|logo|poster|banner|hero\\s+image|illustration|artwork|graphic|mockup|visual|picture)\\b", re.IGNORECASE),
        re.compile("\\btext[\\s-]to[\\s-]image\\b", re.IGNORECASE),
        re.compile("\\bimage\\s+of\\b", re.IGNORECASE),
    ]),
    ("feedback-giving", [
        re.compile("\\b(?:give|deliver|share)\\s+(?:some\\s+)?feedback\\b", re.IGNORECASE),
        re.compile("\\bfeedback\\s+for\\b", re.IGNORECASE),
    ]),
    ("risk-assessment", [
        re.compile("\\brisk\\s+(?:assessment|analysis|register)\\b", re.IGNORECASE),
        re.compile("\\bidentify\\s+risks?\\b", re.IGNORECASE),
    ]),
    ("fact-check", [
        re.compile("\\bfact[\\s-]?check\\b", re.IGNORECASE),
        re.compile("\\bverify\\s+(?:a\\s+|the\\s+|this\\s+)?claim\\b", re.IGNORECASE),
        re.compile("\\bis\\s+it\\s+true\\s+that\\b", re.IGNORECASE),
    ]),
    ("comparison", [
        re.compile("\\bcompare\\s+\\S+\\s+(?:to|with|vs\\.?|and|versus)\\s+\\S", re.IGNORECASE),
        re.compile("\\bside[\\s-]by[\\s-]side\\b", re.IGNORECASE),
    ]),
    ("contract-summary", [
        re.compile("\\bcontract\\b", re.IGNORECASE),
        re.compile("\\bagreement\\b", re.IGNORECASE),
        re.compile("\\bterms\\s+of\\s+service\\b", re.IGNORECASE),
        re.compile("\\btos\\b", re.IGNORECASE),
        re.compile("\\bnda\\b", re.IGNORECASE),
    ]),
    ("local-doc-summary", [
        re.compile("\\b(?:what(?:'?s|\\s+is|\\s+does)\\s+in\\s+this\\b|summari[sz]e\\s+this\\s+(?:doc|file|pdf))", re.IGNORECASE),
    ]),
    ("pc-doc-handling", [
        re.compile("\\b(?:move|copy|import|save|file|add|put|drop|stash|archive)\\b.{0,40}\\b(?:to|into|in)\\s+(?:my\\s+|the\\s+)?(?:vault|second\\s+brain|knowledge|neuroworks|obsidian|brain|inbox)\\b", re.IGNORECASE),
    ]),
    ("pr-description-writing", [
        re.compile("\\bpull\\s+request\\b", re.IGNORECASE),
        re.compile("\\bpr\\s+description\\b", re.IGNORECASE),
        re.compile("\\bpr\\s+body\\b", re.IGNORECASE),
    ]),
    ("commit-message-writing", [
        re.compile("\\bcommit\\s+message\\b", re.IGNORECASE),
        re.compile("\\bgit\\s+commit\\s+msg\\b", re.IGNORECASE),
    ]),
    ("testing-strategy", [
        re.compile("\\btest(?:ing)?\\s+(?:strategy|plan)\\b", re.IGNORECASE),
        re.compile("\\bqa\\s+plan\\b", re.IGNORECASE),
    ]),
    ("api-design", [
        re.compile("\\bapi\\s+design\\b", re.IGNORECASE),
        re.compile("\\brest\\s+api\\b", re.IGNORECASE),
        re.compile("\\bendpoint\\s+design\\b", re.IGNORECASE),
    ]),
    ("debugging-help", [
        re.compile("\\bdebug\\b", re.IGNORECASE),
        re.compile("\\berror\\b", re.IGNORECASE),
        re.compile("\\bcrashe?s?\\b", re.IGNORECASE),
        re.compile("\\bstack\\s+trace\\b", re.IGNORECASE),
        re.compile("\\bnot\\s+working\\b", re.IGNORECASE),
    ]),
    ("code-review", [
        re.compile("\\bcode\\s+review\\b", re.IGNORECASE),
        re.compile("\\breview\\s+(?:this\\s+|the\\s+|my\\s+)?code\\b", re.IGNORECASE),
    ]),
    ("edit-pass", [
        re.compile("\\bedit\\s+(?:this|my)\\b", re.IGNORECASE),
        re.compile("\\bcopy[\\s-]?edit\\b", re.IGNORECASE),
        re.compile("\\bpolish\\b", re.IGNORECASE),
        re.compile("\\bclean\\s+up\\s+the\\s+writing\\b", re.IGNORECASE),
    ]),
    ("summarization", [
        re.compile("\\btl;?dr\\b", re.IGNORECASE),
    ]),
    ("research-deep", [
        re.compile("\\bresearch\\b", re.IGNORECASE),
        re.compile("\\bdig\\s+into\\b", re.IGNORECASE),
        re.compile("\\bdeep\\s+dive\\b", re.IGNORECASE),
    ]),
    ("vault-organization", [
        re.compile("\\b(?:organi[sz]e|clean(?:[\\s-]?up)?|tidy(?:\\s+up)?|sweep|consolidate|restructure|reorgani[sz]e|file|place|structure|index)\\w*\\b[\\s\\S]{0,30}\\b(?:vault|second[\\s-]?brain|obsidian|knowledge\\s*base|zettelkasten)\\b", re.IGNORECASE),
        re.compile("\\bsecond[\\s-]?brain\\b", re.IGNORECASE),
        re.compile("\\bobsidian\\b", re.IGNORECASE),
    ]),
    ("list-making", [
        re.compile("\\b(?:make|give|write)\\s+(?:me\\s+)?(?:a\\s+)?(?:bulleted?\\s+|numbered\\s+|checklist|to[\\s-]?do)\\b", re.IGNORECASE),
    ]),
    ("table-making", [
        re.compile("\\b(?:make|build|create|give)\\s+(?:me\\s+)?(?:a\\s+)?(?:comparison\\s+)?table\\b", re.IGNORECASE),
        re.compile("\\b(?:as|in)\\s+a\\s+table\\b", re.IGNORECASE),
    ]),
    ("runbook-writing", [
        re.compile("\\brunbook\\b", re.IGNORECASE),
        re.compile("\\bincident\\s+(?:response|triage|playbook)\\b", re.IGNORECASE),
        re.compile("\\bon[- ]?call\\s+(?:procedure|playbook)\\b", re.IGNORECASE),
    ]),
    ("meddic-qualification", [
        re.compile("\\bMEDDIC\\b", re.IGNORECASE),
        re.compile("\\bdiscovery\\s+(?:call|notes?|questions?)\\b", re.IGNORECASE),
        re.compile("\\bdeal\\s+(?:qualification|review|forecast)\\b", re.IGNORECASE),
        re.compile("\\benterprise\\s+(?:sales|deal)\\b", re.IGNORECASE),
        re.compile("\\bsales\\s+(?:position|qualification|pipeline)\\b", re.IGNORECASE),
    ]),
    ("jd-writing", [
        re.compile("\\bjob\\s+description\\b", re.IGNORECASE),
        re.compile("\\bJD\\b(?!\\s+for\\s+sale)", re.IGNORECASE),
        re.compile("\\bwrite\\s+(?:a\\s+|the\\s+)?(?:job\\s+post|JD|role\\s+description)\\b", re.IGNORECASE),
    ]),
    ("launch-positioning", [
        re.compile("\\blaunch\\s+(?:blurb|copy|positioning|brief)\\b", re.IGNORECASE),
        re.compile("\\bchangelog\\s+(?:entry|copy|blurb)\\b", re.IGNORECASE),
        re.compile("\\b(?:product|feature)\\s+positioning\\b", re.IGNORECASE),
    ]),
    ("ux-critique", [
        re.compile("\\bUX\\s+(?:critique|review|audit|flow)\\b", re.IGNORECASE),
        re.compile("\\b(?:design|user\\s+experience)\\s+critique\\b", re.IGNORECASE),
        re.compile("\\bcritique\\s+(?:this|the|our)\\s+(?:UX|flow|design|UI)\\b", re.IGNORECASE),
    ]),
    ("trade-off-memo", [
        re.compile("\\btrade[- ]?off\\s+(?:memo|doc|analysis|review)\\b", re.IGNORECASE),
        re.compile("\\boption\\s+comparison\\s+memo\\b", re.IGNORECASE),
        re.compile("\\bA\\s+vs\\s+B\\s+(?:memo|comparison)\\b", re.IGNORECASE),
    ]),
    ("unit-economics", [
        re.compile("\\bunit\\s+economics?\\b", re.IGNORECASE),
        re.compile("\\bLTV\\s*(?:\\/|to|vs|over)\\s*CAC\\b", re.IGNORECASE),
        re.compile("\\bCAC\\s+payback\\b", re.IGNORECASE),
        re.compile("\\bSaaS\\s+benchmark\\b", re.IGNORECASE),
        re.compile("\\bnet\\s+dollar\\s+retention\\b", re.IGNORECASE),
        re.compile("\\bNDR\\b"),
    ]),
    ("ab-test-read", [
        re.compile("\\bA\\/?B\\s+test\\b", re.IGNORECASE),
        re.compile("\\bsplit\\s+test\\b", re.IGNORECASE),
        re.compile("\\bexperiment\\s+result\\b", re.IGNORECASE),
        re.compile("\\bvariant\\s+vs\\s+control\\b", re.IGNORECASE),
    ]),
    ("retry-different-approach", [
        re.compile("\\b(?:try (?:again |a |another )(?:approach|angle|take|way|differently|different)|different (?:approach|angle|take))\\b", re.IGNORECASE),
        re.compile("\\b(?:that('?| i)s not (?:quite |what )?(?:it|right|what i wanted)|missed (?:the )?(?:point|mark)|wrong (?:approach|angle|tack))\\b", re.IGNORECASE),
        re.compile("\\b(?:redo (?:this|it|that)|do (?:it |this )?(?:again|over) (?:but )?differently|rethink (?:this|it)|another (?:take|go|attempt))\\b", re.IGNORECASE),
    ]),
    ("benchmark-lookup", [
        re.compile("\\b(?:benchmark|industry[- ]?(?:standard|typical|average|median)|best[- ]in[- ]class|where\\s+should\\s+(?:our|my|we)\\s+\\S+\\s+sit|what\\s+(?:do|does)\\s+(?:typical|standard|best)\\s+companies)\\b", re.IGNORECASE),
        re.compile("\\b(?:what(?:'?s|\\s+is)\\s+(?:a\\s+)?(?:typical|standard|industry|good|healthy)\\s+(?:range|number|value|figure)\\s+for)\\b", re.IGNORECASE),
        re.compile("\\b(?:NDR|GRR|CAC\\s+payback|LTV[\\/: ]?CAC|gross\\s+margin|net\\s+revenue\\s+retention)\\s+benchmark", re.IGNORECASE),
    ]),
    ("source-triangulation", [
        re.compile("\\b(?:triangulat|cross[- ]?(?:check|verify|reference)|verify\\s+across|multiple\\s+sources|three\\s+sources|independent\\s+sources)\\b", re.IGNORECASE),
        re.compile("\\b(?:confirm(?:ed)?\\s+(?:by|with|across)|corroborat)\\b", re.IGNORECASE),
    ]),
    ("primary-source-check", [
        re.compile("\\b(?:primary\\s+source|official\\s+(?:source|page|filing|docs?|documentation)|go\\s+to\\s+the\\s+(?:source|filing|docs?|primary)|filing|10[- ]K|SEC\\s+filing|press\\s+release)\\b", re.IGNORECASE),
        re.compile("\\b(?:from\\s+(?:their|the\\s+company['']?s?)\\s+(?:own\\s+)?(?:site|page|docs?|documentation|pricing))\\b", re.IGNORECASE),
    ]),
    ("landscape-scan", [
        re.compile("\\b(?:landscape|market\\s+(?:landscape|map|overview|scan)|who(?:'?s|\\s+is)\\s+(?:playing|in)\\s+(?:this|the)\\s+(?:market|category|space)|map\\s+(?:the\\s+|out\\s+the\\s+)?market|category\\s+overview|state\\s+of\\s+the\\s+(?:market|category|industry))\\b", re.IGNORECASE),
    ]),
    ("meeting-actions", [
        re.compile("\\b(?:meeting\\s+transcript|action\\s+items?|turn\\s+(?:this|the)\\s+(?:meeting|transcript)|extract\\s+action\\s+items?|from\\s+this\\s+transcript)\\b", re.IGNORECASE),
    ]),
    ("crm-update", [
        re.compile("\\bupdate\\s+(?:our\\s+|the\\s+)?(?:CRM|HubSpot|Salesforce|Pipedrive)\\b", re.IGNORECASE),
        re.compile("\\b(?:CRM[-\\s]ready|CRM\\s+(?:fields?|update|record)|structured\\s+(?:CRM|sales)\\s+(?:fields?|updates?))\\b", re.IGNORECASE),
    ]),
    ("jd-to-tasks", [
        re.compile("\\b(?:from\\s+this\\s+job\\s+description|task\\s+list\\s+from\\s+(?:this\\s+)?(?:JD|job\\s+description)|role[-\\s]based\\s+(?:workflow|task)|JD\\s+(?:to|→)\\s+tasks?)\\b", re.IGNORECASE),
    ]),
    ("cv-screening", [
        re.compile("\\b(?:screen\\s+(?:these\\s+|the\\s+)?(?:CVs?|resumes?|candidates?)|rank(?:ed)?\\s+shortlist|CV\\s+(?:screening|review)|candidate\\s+(?:shortlist|screening|review))\\b", re.IGNORECASE),
    ]),
    ("vendor-comparison", [
        re.compile("\\b(?:compare\\s+(?:vendor|supplier)\\s+(?:quotes?|proposals?)|vendor\\s+(?:comparison|quotes?|matrix)|TCO\\s+(?:comparison|breakdown))\\b", re.IGNORECASE),
    ]),
    ("compliance-check", [
        re.compile("\\b(?:compliance\\s+(?:check|review|issues?|audit)|check\\s+(?:this|the)\\s+document\\s+for\\s+compliance|legal\\s+(?:risk|review)\\s+(?:check|of)|items?\\s+needing\\s+(?:legal|manager)\\s+approval)\\b", re.IGNORECASE),
    ]),
    ("travel-itinerary", [
        re.compile("\\b(?:travel\\s+itinerary|itinerary\\s+from\\s+(?:these|the)\\s+bookings?|trip\\s+(?:itinerary|plan)|full\\s+itinerary)\\b", re.IGNORECASE),
    ]),
    ("support-themes", [
        re.compile("\\b(?:support\\s+tickets?\\s+by\\s+theme|cluster\\s+(?:these\\s+)?(?:tickets?|complaints?|feedback)|ticket\\s+(?:themes?|clusters?|trends?)|issue\\s+(?:clusters?|themes?)|summari[sz]e\\s+(?:customer\\s+)?(?:support\\s+)?tickets?)\\b", re.IGNORECASE),
    ]),
    ("support-escalation", [
        re.compile("\\b(?:escalat\\w*\\s+(?:any\\s+)?(?:support\\s+)?tickets?|escalation\\s+(?:list|triage)|tickets?\\s+that\\s+(?:look|need)\\s+(?:serious|escalation)|escalation\\s+with\\s+reason)\\b", re.IGNORECASE),
    ]),
    ("kb-article", [
        re.compile("\\b(?:knowledge[-\\s]?base\\s+article|KB\\s+article|help[-\\s]?center\\s+article|from\\s+(?:this\\s+)?solved\\s+ticket|help[-\\s]?center[-\\s]?ready)\\b", re.IGNORECASE),
    ]),
    ("feedback-trends", [
        re.compile("\\b(?:customer\\s+feedback\\s+(?:trends?|analysis|themes?)|analy[sz]e\\s+(?:customer\\s+)?feedback|sentiment\\s+(?:analysis|trends?)|recurring\\s+themes?\\s+in\\s+feedback|NPS\\s+(?:analysis|trends?))\\b", re.IGNORECASE),
    ]),
    ("slide-outline", [
        re.compile("\\bslide\\s+(?:outline|structure|deck\\s+outline)|slide[-\\s]?by[-\\s]?slide\\s+(?:structure|outline)|presentation\\s+(?:outline|structure)|deck\\s+(?:outline|structure)\\b", re.IGNORECASE),
    ]),
    ("competitor-summary", [
        re.compile("\\bcompetitor\\s+(?:summary|comparison\\s+table)|summari[sz]e\\s+(?:our\\s+)?competitors?\\b|research\\s+competitors?\\s+and\\s+summari[sz]e", re.IGNORECASE),
    ]),
    ("lead-qualification", [
        re.compile("\\blead\\s+(?:qualification|scor(?:ing|e)|qualif\\w+)|qualify\\s+(?:this|the)\\s+lead|lead\\s+fit\\s+(?:assessment|analysis)|inbound\\s+lead\\s+(?:scor|review)", re.IGNORECASE),
    ]),
    ("translation", [
        re.compile("\\btranslate\\s+(?:this|the)\\s+(?:customer\\s+)?(?:message|email|reply|response)|translation\\s+(?:plus|and)\\s+(?:response|reply)|translate\\s+to\\s+\\w+\\s+and\\s+draft", re.IGNORECASE),
    ]),
    ("sop-writing", [
        re.compile("\\b(?:standard\\s+operating\\s+procedure|SOP\\s+(?:for|writing|creation)|turn\\s+(?:this|the)\\s+process\\s+into\\s+(?:an\\s+)?SOP|process\\s+to\\s+SOP|write\\s+(?:an?\\s+)?SOP)\\b", re.IGNORECASE),
    ]),
    ("procurement-request", [
        re.compile("\\bprocurement\\s+request|purchase\\s+request|generate\\s+(?:a\\s+)?(?:procurement|purchase)\\s+request|structured\\s+purchase\\s+(?:order|request)\\b", re.IGNORECASE),
    ]),
    ("training-quiz", [
        re.compile("\\btraining\\s+quiz|generate\\s+(?:a\\s+)?quiz\\s+from|quiz\\s+from\\s+(?:this\\s+)?(?:policy|training|doc)|quiz\\s+(?:questions?|with\\s+answer\\s+key)", re.IGNORECASE),
    ]),
    ("tomorrow-plan", [
        re.compile("\\btomorrow(?:'s|\\s+work)?\\s+plan|plan\\s+(?:for\\s+)?tomorrow|tomorrow'?s?\\s+(?:schedule|priorities|tasks?)|prioriti[sz]ed\\s+schedule\\s+(?:for\\s+)?tomorrow|unfinished\\s+tasks?\\s+(?:for|to)\\s+tomorrow", re.IGNORECASE),
    ]),
    ("channel-notify", [
        re.compile("\\b(?:notify|ping|alert|message|post|send|drop)\\b.{0,30}\\b(?:slack|teams|telegram|discord|google\\s*chat|webhook|channel|the\\s+team)\\b", re.IGNORECASE),
        re.compile("\\b(?:post|send)\\s+(?:this|it|that|a\\s+message)\\s+to\\b", re.IGNORECASE),
        re.compile("\\blet\\s+(?:the\\s+team|everyone|\\w+)\\s+know\\s+(?:on|in|via)\\b", re.IGNORECASE),
    ]),
    ("database-lookup", [
        re.compile("\\b(?:query|look\\s*up|pull|fetch|count|how\\s+many)\\b.{0,30}\\b(?:database|db|table|collection|records?|rows?|mongo(?:db)?|postgres|mysql|sql\\s*server)\\b", re.IGNORECASE),
        re.compile("\\bfrom\\s+(?:our|the|my)\\s+(?:database|db|crm|warehouse)\\b", re.IGNORECASE),
    ]),
    ("voiceover-script", [
        re.compile("\\b(?:voice[\\s-]?over|voiceover)\\b", re.IGNORECASE),
        re.compile("\\b(?:narrat(?:e|ion)|read (?:this|it|aloud))\\b", re.IGNORECASE),
        re.compile("\\btext[\\s-]?to[\\s-]?speech\\b", re.IGNORECASE),
        re.compile("\\bTTS\\b"),
        re.compile("\\b(?:audio|spoken)\\s+(?:version|briefing|summary|clip)\\b", re.IGNORECASE),
        re.compile("\\bIVR\\b"),
        re.compile("\\bphone\\s+(?:prompt|menu|greeting)\\b", re.IGNORECASE),
    ]),
    ("video-prompt", [
        re.compile("\\b(?:make|create|generate|produce|render)\\s+(?:a\\s+|an\\s+|the\\s+)?(?:short\\s+)?(?:video|clip|reel|teaser|ad)\\b", re.IGNORECASE),
        re.compile("\\b(?:video|reel|tiktok|shorts)\\s+(?:clip|ad|teaser|prompt)\\b", re.IGNORECASE),
        re.compile("\\bimage[\\s-]?to[\\s-]?video\\b", re.IGNORECASE),
        re.compile("\\bstoryboard\\b", re.IGNORECASE),
        re.compile("\\bproduct\\s+teaser\\b", re.IGNORECASE),
    ]),
    ("music-brief", [
        re.compile("\\b(?:compose|generate|produce|write|make)\\s+(?:a\\s+|an\\s+|some\\s+)?(?:jingle|music|track|theme|soundtrack|beat|tune)\\b", re.IGNORECASE),
        re.compile("\\b(?:background|hold)\\s+music\\b", re.IGNORECASE),
        re.compile("\\bjingle\\b", re.IGNORECASE),
        re.compile("\\bsoundtrack\\b", re.IGNORECASE),
        re.compile("\\b(?:theme|backing)\\s+(?:song|track|music)\\b", re.IGNORECASE),
    ]),
    ("multimedia-package", [
        re.compile("\\b(?:content|media|video|ad)\\s+package\\b", re.IGNORECASE),
        re.compile("\\b(?:script|storyboard)\\s+(?:\\+|and)\\s+(?:voice(?:over)?|video|music|audio)\\b", re.IGNORECASE),
        re.compile("\\bexplainer\\s+(?:video|with\\s+(?:voice|narration|music))\\b", re.IGNORECASE),
        re.compile("\\b(?:social|video|content)\\s+ad\\b.{0,30}\\b(?:voice(?:over)?|narration|music|audio)\\b", re.IGNORECASE),
        re.compile("\\b(?:voice(?:over)?|narration)\\s+(?:\\+|and)\\s+(?:video|music)\\b", re.IGNORECASE),
        re.compile("\\b(?:video|music)\\s+(?:\\+|and)\\s+(?:voice(?:over)?|narration|music)\\b", re.IGNORECASE),
    ]),
    ("aiia-finance-readout", [
        re.compile("\\bAiia\\b.{0,40}\\b(?:financ|revenue|expenses?|dashboard|figures?|numbers?|position|readout|P&L|balance|cash\\s*flow|report)\\b", re.IGNORECASE),
        re.compile("\\b(?:financ|revenue|expenses?|dashboard|figures?|numbers?|position|readout|P&L|balance|cash\\s*flow)\\b.{0,40}\\bAiia\\b", re.IGNORECASE),
        re.compile("\\bfinancial dashboard\\b", re.IGNORECASE),
        re.compile("\\b(?:finance|financial|revenue|expense)\\s+(?:dashboard|overview|figures?|numbers?|position)\\b", re.IGNORECASE),
        re.compile("\\b(?:pull|fetch|read|show me|get)\\s+(?:the\\s+|our\\s+|my\\s+)?(?:live\\s+)?(?:financials?|finance|dashboard)\\b", re.IGNORECASE),
        re.compile("\\bdashboard\\s+for\\s+(?:year\\s+)?\\d{4}\\b", re.IGNORECASE),
    ]),
    ("brd-writing", [
        re.compile("\\bBR[DS]\\b", re.IGNORECASE),
        re.compile("\\bbusiness requirements?\\b", re.IGNORECASE),
        re.compile("\\bbusiness requirements?\\s+(?:doc|document|spec|specification)\\b", re.IGNORECASE),
        re.compile("\\brequirements?\\s+(?:doc|document|specification)\\b", re.IGNORECASE),
    ]),
    ("user-stories", [
        re.compile("\\buser stor(?:y|ies)\\b", re.IGNORECASE),
        re.compile("\\bacceptance criteria\\b", re.IGNORECASE),
        re.compile("\\bgiven\\b.{0,12}\\bwhen\\b.{0,12}\\bthen\\b", re.IGNORECASE),
        re.compile("\\bepic\\b.{0,20}\\bstor(?:y|ies)\\b", re.IGNORECASE),
    ]),
    ("process-mapping", [
        re.compile("\\bas[\\s-]?is\\b[\\s\\S]{0,24}\\bto[\\s-]?be\\b", re.IGNORECASE),
        re.compile("\\bprocess\\s+(?:map|mapping|flow)\\b", re.IGNORECASE),
        re.compile("\\bcurrent state\\b[\\s\\S]{0,24}\\bfuture state\\b", re.IGNORECASE),
        re.compile("\\bworkflow\\s+(?:map|diagram|mapping)\\b", re.IGNORECASE),
    ]),
    ("press-release", [
        re.compile("\\bpress release\\b", re.IGNORECASE),
        re.compile("\\bfor immediate release\\b", re.IGNORECASE),
        re.compile("\\bmedia (?:release|statement|advisory)\\b", re.IGNORECASE),
    ]),
    ("crisis-comms", [
        re.compile("\\bcrisis\\s+(?:comm|statement|response|management|plan)", re.IGNORECASE),
        re.compile("\\bholding statement\\b", re.IGNORECASE),
        re.compile("\\b(?:incident|crisis)\\s+(?:statement|Q&?A|response)\\b", re.IGNORECASE),
        re.compile("\\bdamage control\\b", re.IGNORECASE),
    ]),
    ("reconciliation", [
        re.compile("\\brecon(?:cile|ciliation)\\b", re.IGNORECASE),
        re.compile("\\b(?:bank|account|ledger|statement|invoice)\\s+recon", re.IGNORECASE),
        re.compile("\\btie[\\s-]?out\\b", re.IGNORECASE),
    ]),
    ("invoice-statement", [
        re.compile("\\b(?:create|draft|generate|prepare|issue|raise)\\s+(?:an?\\s+)?invoice\\b", re.IGNORECASE),
        re.compile("\\binvoice\\b", re.IGNORECASE),
        re.compile("\\bstatement of account\\b", re.IGNORECASE),
        re.compile("\\bbilling statement\\b", re.IGNORECASE),
    ]),
    ("financial-statement-summary", [
        re.compile("\\bfinancial statements?\\b", re.IGNORECASE),
        re.compile("\\b(?:income statement|balance sheet|cash[\\s-]?flow statement)\\b", re.IGNORECASE),
        re.compile("\\bsummar(?:y|ise|ize)\\b[\\s\\S]{0,24}\\b(?:financials?|P&?L|accounts)\\b", re.IGNORECASE),
    ]),
    ("hr-policy", [
        re.compile("\\bHR policy\\b", re.IGNORECASE),
        re.compile("\\b(?:draft|write|create)\\s+(?:an?\\s+|a new\\s+|company\\s+)?policy\\b", re.IGNORECASE),
        re.compile("\\b(?:leave|remote[\\s-]?work|code of conduct|disciplinary|expense|attendance|grievance)\\s+policy\\b", re.IGNORECASE),
    ]),
    ("access-provisioning", [
        re.compile("\\baccess\\s+(?:provision|request|grant|review|plan|matrix)", re.IGNORECASE),
        re.compile("\\b(?:provision|deprovision|de[\\s-]?provision|onboard|offboard)\\s+(?:access|accounts?|a user|the user)\\b", re.IGNORECASE),
        re.compile("\\bleast privilege\\b", re.IGNORECASE),
        re.compile("\\bIAM\\b", re.IGNORECASE),
        re.compile("\\bpermissions?\\s+(?:plan|matrix|setup)\\b", re.IGNORECASE),
    ]),
    ("device-setup-checklist", [
        re.compile("\\b(?:device|laptop|machine|workstation|pc)\\s+(?:setup|provision|imaging|onboarding|build)\\b", re.IGNORECASE),
        re.compile("\\b(?:new\\s+)?(?:laptop|device|machine)\\s+checklist\\b", re.IGNORECASE),
        re.compile("\\bIT\\s+(?:setup|provisioning|onboarding)\\b", re.IGNORECASE),
    ]),
    ("rfp-writing", [
        re.compile("\\bRF[PQ]\\b", re.IGNORECASE),
        re.compile("\\b(?:request for (?:proposal|quotation|quote)|invitation to tender|tender)\\b", re.IGNORECASE),
        re.compile("\\bbid\\s+(?:document|invitation|request|pack)\\b", re.IGNORECASE),
    ]),
    ("negotiation-brief", [
        re.compile("\\bnegotiat(?:e|ion|ing)\\b", re.IGNORECASE),
        re.compile("\\bBATNA\\b", re.IGNORECASE),
        re.compile("\\bnegotiation\\s+(?:brief|strategy|plan|prep)\\b", re.IGNORECASE),
        re.compile("\\b(?:counter|deal)\\s*(?:position|offer)\\b", re.IGNORECASE),
    ]),
    ("cold-outreach", [
        re.compile("\\bcold\\s+(?:outreach|email|call)\\b", re.IGNORECASE),
        re.compile("\\b(?:outreach|prospect(?:ing)?|email)\\s+(?:sequence|cadence)\\b", re.IGNORECASE),
        re.compile("\\b(?:sales|sdr)\\s+(?:sequence|cadence)\\b", re.IGNORECASE),
    ]),
    ("prospect-research", [
        re.compile("\\bprospect(?:ing)?\\s+(?:research|brief)\\b", re.IGNORECASE),
        re.compile("\\b(?:research|profile)\\s+(?:a\\s+|this\\s+)?(?:prospect|lead|account|company)\\b[\\s\\S]{0,30}\\b(?:before|outreach|opener|reach out)", re.IGNORECASE),
        re.compile("\\baccount\\s+research\\b", re.IGNORECASE),
        re.compile("\\bbuying committee\\b", re.IGNORECASE),
    ]),
    ("audit-prep", [
        re.compile("\\baudit\\s+(?:prep|readiness|preparation|checklist)\\b", re.IGNORECASE),
        re.compile("\\b(?:prepare|ready|get ready)\\s+for\\s+(?:an?\\s+|the\\s+)?audit\\b", re.IGNORECASE),
        re.compile("\\b(?:SOC ?2|ISO ?27001|compliance|internal)\\s+audit\\b", re.IGNORECASE),
    ]),
    ("event-runsheet", [
        re.compile("\\brun[\\s-]?(?:sheet|of[\\s-]?show)\\b", re.IGNORECASE),
        re.compile("\\b(?:event|conference|launch|show)\\s+(?:run[\\s-]?sheet|logistics|plan|schedule)\\b", re.IGNORECASE),
    ]),
    ("training-curriculum", [
        re.compile("\\b(?:training|learning)\\s+(?:curriculum|program(?:me)?|path|plan)\\b", re.IGNORECASE),
        re.compile("\\bcurriculum\\b", re.IGNORECASE),
        re.compile("\\bcourse\\s+(?:outline|design|syllabus|plan)\\b", re.IGNORECASE),
        re.compile("\\bsyllabus\\b", re.IGNORECASE),
    ]),
    ("facilitator-guide", [
        re.compile("\\bfacilitat(?:or|ion)\\s+(?:guide|notes|plan)\\b", re.IGNORECASE),
        re.compile("\\bworkshop\\s+(?:guide|plan|facilitat|design)\\b", re.IGNORECASE),
        re.compile("\\b(?:run|design|facilitate)\\s+a\\s+workshop\\b", re.IGNORECASE),
    ]),
    ("project-plan", [
        re.compile("\\bproject\\s+plan\\b", re.IGNORECASE),
        re.compile("\\bproject\\s+(?:roadmap|timeline|schedule|milestones?)\\b", re.IGNORECASE),
        re.compile("\\bwork\\s+breakdown\\b", re.IGNORECASE),
        re.compile("\\bWBS\\b", re.IGNORECASE),
    ]),
    ("raid-log", [
        re.compile("\\bRAID\\s+(?:log|register)\\b", re.IGNORECASE),
        re.compile("\\brisks?,?\\s+assumptions?,?\\s+issues?,?\\s+(?:and\\s+)?dependencies\\b", re.IGNORECASE),
    ]),
    ("fulfillment-plan", [
        re.compile("\\b(?:fulfil?lment|shipment|shipping|delivery|consignment)\\s+(?:plan|schedule)\\b", re.IGNORECASE),
        re.compile("\\b(?:ship|fulfil?l)\\s+(?:an?\\s+|the\\s+)?order\\b", re.IGNORECASE),
        re.compile("\\bfreight\\s+(?:plan|booking)\\b", re.IGNORECASE),
        re.compile("\\bincoterm", re.IGNORECASE),
    ]),
    ("inventory-analysis", [
        re.compile("\\binventory\\s+(?:analysis|review|report|level|management|count)\\b", re.IGNORECASE),
        re.compile("\\b(?:re[\\s-]?order|restock|stock)\\s+(?:point|analysis|level|recommendation|report)\\b", re.IGNORECASE),
        re.compile("\\bsafety stock\\b", re.IGNORECASE),
        re.compile("\\bstock[\\s-]?out\\b", re.IGNORECASE),
        re.compile("\\bEOQ\\b", re.IGNORECASE),
        re.compile("\\bdays of (?:cover|stock)\\b", re.IGNORECASE),
    ]),
    ("logistics-exception", [
        re.compile("\\b(?:logistics?|shipment|delivery|order)\\s+(?:exception|issue|problem|delay|incident)\\b", re.IGNORECASE),
        re.compile("\\b(?:lost|damaged|delayed|stuck|held|missing)\\s+(?:shipment|order|consignment|package|delivery)\\b", re.IGNORECASE),
        re.compile("\\bcustoms\\s+hold\\b", re.IGNORECASE),
    ]),
    ("action-item-extraction", [
        re.compile("\\baction items?\\b", re.IGNORECASE),
        re.compile("\\b(?:extract|pull|list)\\s+(?:the\\s+)?(?:action items?|to[\\s-]?dos?|takeaways)\\b", re.IGNORECASE),
    ]),
    ("churn-risk-flag", [
        re.compile("\\bchurn\\s+(?:risk|flag|signal|score)\\b", re.IGNORECASE),
        re.compile("\\b(?:at[\\s-]?risk|flight[\\s-]?risk)\\s+(?:account|customer|client)\\b", re.IGNORECASE),
    ]),
    ("code-writing", [
        re.compile("\\b(?:write|implement|code)\\s+(?:me\\s+)?(?:a\\s+|an\\s+|the\\s+|some\\s+)?(?:code|function|method|class|script|module|component|endpoint)\\b", re.IGNORECASE),
        re.compile("\\bwrite\\s+(?:a\\s+)?(?:python|javascript|typescript|java|go|rust|sql)\\b", re.IGNORECASE),
    ]),
    ("company-knowledge-lookup", [
        re.compile("\\b(?:look up|find|search|check)\\b[\\s\\S]{0,30}\\b(?:company|internal|our)\\s+(?:knowledge|docs?|wiki|policy|handbook)\\b", re.IGNORECASE),
        re.compile("\\bwhat does (?:our|the company)\\b", re.IGNORECASE),
    ]),
    ("company-onboarding", [
        re.compile("\\b(?:company|employee|new[\\s-]?hire|staff)\\s+onboarding\\b", re.IGNORECASE),
        re.compile("\\bonboard(?:ing)?\\s+(?:plan|pack|checklist|guide)\\b", re.IGNORECASE),
    ]),
    ("css-animation-snippet", [
        re.compile("\\bcss\\s+animation\\b", re.IGNORECASE),
        re.compile("\\b(?:keyframes?|@keyframes|css\\s+transition)\\b", re.IGNORECASE),
    ]),
    ("customer-360", [
        re.compile("\\bcustomer\\s*[\\s-]?360\\b", re.IGNORECASE),
        re.compile("\\b360[\\s-]?(?:degree\\s+)?(?:view|profile)\\s+of\\b", re.IGNORECASE),
        re.compile("\\baccount\\s+360\\b", re.IGNORECASE),
    ]),
    ("daily-briefing", [
        re.compile("\\bdaily\\s+(?:briefing|brief|digest|rundown)\\b", re.IGNORECASE),
        re.compile("\\bmorning\\s+(?:briefing|brief)\\b", re.IGNORECASE),
    ]),
    ("decline-politely", [
        re.compile("\\b(?:politely\\s+)?decline\\b", re.IGNORECASE),
        re.compile("\\b(?:say no to|turn down|reject)\\s+(?:the\\s+|this\\s+|a\\s+)?(?:request|invite|invitation|offer|meeting|proposal)\\b", re.IGNORECASE),
    ]),
    ("difficult-conversation-script", [
        re.compile("\\bdifficult conversation\\b", re.IGNORECASE),
        re.compile("\\b(?:tough|hard|crucial|awkward)\\s+(?:conversation|chat|talk)\\b", re.IGNORECASE),
    ]),
    ("discovery-call-prep", [
        re.compile("\\bdiscovery call\\b", re.IGNORECASE),
        re.compile("\\b(?:prep|prepare)\\s+(?:for\\s+)?(?:a\\s+|the\\s+)?(?:discovery|sales|intro)\\s+call\\b", re.IGNORECASE),
    ]),
    ("email-triage", [
        re.compile("\\b(?:triage|sort|prioriti[sz]e|process)\\s+(?:my\\s+|the\\s+)?(?:inbox|emails?)\\b", re.IGNORECASE),
        re.compile("\\binbox\\s+(?:triage|zero)\\b", re.IGNORECASE),
    ]),
    ("eod-handoff", [
        re.compile("\\b(?:end[\\s-]?of[\\s-]?day|EOD)\\s+(?:handoff|hand[\\s-]?over|summary|update|report)\\b", re.IGNORECASE),
    ]),
    ("expense-report", [
        re.compile("\\bexpense report\\b", re.IGNORECASE),
        re.compile("\\b(?:file|submit|create|do)\\s+(?:an?\\s+|my\\s+)?expenses?\\b", re.IGNORECASE),
    ]),
    ("follow-up-cadence", [
        re.compile("\\bfollow[\\s-]?up\\s+(?:cadence|sequence|plan|schedule|cadences)\\b", re.IGNORECASE),
        re.compile("\\b(?:nurture|drip)\\s+(?:cadence|sequence|campaign)\\b", re.IGNORECASE),
    ]),
    ("intro-email", [
        re.compile("\\b(?:intro|introduction|introductory|warm)\\s+(?:email|intro)\\b", re.IGNORECASE),
        re.compile("\\bintroduce\\s+\\w+\\s+to\\s+\\w+", re.IGNORECASE),
    ]),
    ("investor-update", [
        re.compile("\\binvestor\\s+(?:update|letter|memo|report)\\b", re.IGNORECASE),
        re.compile("\\b(?:monthly|quarterly)\\s+investor\\b", re.IGNORECASE),
    ]),
    ("loading-state-design", [
        re.compile("\\bloading\\s+(?:state|spinner|skeleton|indicator|screen)\\b", re.IGNORECASE),
        re.compile("\\bskeleton\\s+(?:screen|loader|ui)\\b", re.IGNORECASE),
    ]),
    ("meeting-prep-pack", [
        re.compile("\\bmeeting\\s+(?:prep|preparation)\\s+(?:pack|doc|pack)\\b", re.IGNORECASE),
        re.compile("\\bprep(?:are)?\\s+(?:a\\s+)?(?:pack|brief)\\s+(?:for\\s+)?(?:the\\s+|a\\s+)?meeting\\b", re.IGNORECASE),
    ]),
    ("microinteraction-spec", [
        re.compile("\\bmicro[\\s-]?interaction", re.IGNORECASE),
    ]),
    ("motion-design-pass", [
        re.compile("\\bmotion\\s+design\\b", re.IGNORECASE),
        re.compile("\\b(?:animation|motion)\\s+(?:pass|spec|review|polish)\\b", re.IGNORECASE),
    ]),
    ("objection-handling-script", [
        re.compile("\\bobjection\\s+(?:handling|response|script)\\b", re.IGNORECASE),
        re.compile("\\bhandle\\s+(?:the\\s+|sales\\s+)?objection", re.IGNORECASE),
    ]),
    ("p-and-l-summary", [
        re.compile("\\bP\\s*&\\s*L\\b", re.IGNORECASE),
        re.compile("\\bprofit (?:and|&) loss\\b", re.IGNORECASE),
        re.compile("\\bincome statement\\s+(?:summary|review)\\b", re.IGNORECASE),
    ]),
    ("pipeline-review", [
        re.compile("\\b(?:sales\\s+)?pipeline\\s+(?:review|health|analysis|inspection)\\b", re.IGNORECASE),
        re.compile("\\bdeal\\s+(?:pipeline|review)\\b", re.IGNORECASE),
    ]),
    ("planning-doc", [
        re.compile("\\bplanning doc(?:ument)?\\b", re.IGNORECASE),
        re.compile("\\b(?:sprint|quarterly|strategic)\\s+planning\\s+doc", re.IGNORECASE),
    ]),
    ("pre-read", [
        re.compile("\\bpre[\\s-]?read\\b", re.IGNORECASE),
        re.compile("\\b(?:background|briefing)\\s+(?:doc|memo)\\s+(?:before|ahead of)\\b", re.IGNORECASE),
    ]),
    ("precedent-finder", [
        re.compile("\\b(?:find|search for|look for)\\s+(?:legal\\s+|relevant\\s+)?precedent", re.IGNORECASE),
        re.compile("\\bprecedent(?:s)?\\s+(?:for|on|search)\\b", re.IGNORECASE),
    ]),
    ("pricing-proposal", [
        re.compile("\\bpricing proposal\\b", re.IGNORECASE),
        re.compile("\\b(?:price|pricing)\\s+(?:quote|proposal|tiers?)\\b", re.IGNORECASE),
    ]),
    ("project-status-rollup", [
        re.compile("\\b(?:status|project)\\s+roll[\\s-]?up\\b", re.IGNORECASE),
        re.compile("\\bproject status\\s+(?:rollup|roll[\\s-]?up|summary|report)\\b", re.IGNORECASE),
        re.compile("\\bprogram\\s+status\\b", re.IGNORECASE),
    ]),
    ("release-notes-from-commits", [
        re.compile("\\brelease notes\\b", re.IGNORECASE),
        re.compile("\\bchangelog\\b", re.IGNORECASE),
        re.compile("\\brelease notes\\s+from\\s+(?:the\\s+)?commits?\\b", re.IGNORECASE),
    ]),
    ("renewal-conversation", [
        re.compile("\\brenewal\\s+(?:conversation|discussion|call|email|prep)\\b", re.IGNORECASE),
        re.compile("\\b(?:contract|subscription|account)\\s+renewal\\b", re.IGNORECASE),
    ]),
    ("risk-register", [
        re.compile("\\brisk register\\b", re.IGNORECASE),
    ]),
    ("standup-summary", [
        re.compile("\\bstand[\\s-]?up\\s+(?:summary|notes|update|recap)\\b", re.IGNORECASE),
        re.compile("\\bdaily stand[\\s-]?up\\b", re.IGNORECASE),
    ]),
    ("timesheet-fill", [
        re.compile("\\btimesheet\\b", re.IGNORECASE),
        re.compile("\\b(?:fill in|complete|log)\\s+(?:my\\s+|the\\s+)?(?:hours|time|timesheet)\\b", re.IGNORECASE),
    ]),
    ("send-attachment", [
        re.compile("\\battach(?:ment|ed|ing)?\\b", re.IGNORECASE),
        re.compile("\\bsend\\s+(?:me\\s+|him\\s+|her\\s+|them\\s+)?(?:the\\s+|that\\s+|this\\s+)?(?:file|document|doc|spreadsheet|pdf|report)\\b.{0,20}\\b(?:email|attached|attachment)\\b", re.IGNORECASE),
        re.compile("\\bemail\\b.{0,25}\\b(?:the\\s+|that\\s+|this\\s+)?(?:file|document|doc|spreadsheet|pdf)\\b", re.IGNORECASE),
    ]),
    ("human-handoff", [
        re.compile("\\bhuman[\\s-]?(?:request|handoff|hand[\\s-]?off|in[\\s-]?the[\\s-]?loop)\\b", re.IGNORECASE),
        re.compile("\\bask\\s+(?:a\\s+|the\\s+)?human\\b", re.IGNORECASE),
        re.compile("\\bwaiting\\s+on\\s+(?:a\\s+)?human\\b", re.IGNORECASE),
        re.compile("\\bneeds?\\s+(?:human|manual)\\s+(?:input|approval|review)\\b", re.IGNORECASE),
    ]),
    ("dataset-publish", [
        re.compile("\\bpublish\\s+(?:this\\s+|the\\s+)?(?:data|dataset)\\b", re.IGNORECASE),
        re.compile("\\bintellinexus\\b", re.IGNORECASE),
        re.compile("\\badd\\s+(?:this\\s+|to\\s+)?(?:the\\s+)?data\\s+pipeline\\b", re.IGNORECASE),
        re.compile("\\bturn\\s+this\\s+into\\s+a\\s+dataset\\b", re.IGNORECASE),
        re.compile("\\bmake\\s+(?:this\\s+)?(?:data\\s+)?(?:available\\s+to|queryable\\s+by)\\s+(?:the\\s+)?(?:other\\s+)?agents\\b", re.IGNORECASE),
    ]),
    ("caveman-mode", [
        re.compile("\\bcaveman\\s+mode\\b", re.IGNORECASE),
        re.compile("\\btalk\\s+like\\s+(?:a\\s+)?caveman\\b", re.IGNORECASE),
        re.compile("\\/caveman\\b", re.IGNORECASE),
        re.compile("\\b(?:be|reply|answer)\\s+(?:more\\s+)?(?:brief|terse|concise)\\b.{0,20}\\b(?:tokens?|words?)\\b", re.IGNORECASE),
        re.compile("\\bfewer\\s+(?:tokens|words)\\b", re.IGNORECASE),
        re.compile("\\bless\\s+tokens\\b", re.IGNORECASE),
    ]),
]


# Doc-type keyword → skill name, used as a SECONDARY signal after intent
# matching: if the user literally says "draft a PRD" or "ADR for X", load the
# matching skill even when the intent classifier missed. Ported verbatim
# (source + flags extracted from the live RegExp objects in skills.ts).
_KEYWORD_MAP = {name: patterns for name, patterns in SKILL_KEYWORDS}

# Some skills fire real, user-facing behaviour (parking a task for a human,
# drafting/sending an email) — a weak single-keyword match (score 15) must
# NOT trigger them, so require 25 (intent agreement + a keyword, or 3+
# distinct keyword hits). Everything else keeps the default floor of 1.
SKILL_MIN_SCORE = {
    "human-handoff": 25,
    "email-writing": 25,
}


def _meets_skill_floor(skill: str, score: int) -> bool:
    return score >= SKILL_MIN_SCORE.get(skill, 1)


def _score(skills: List[PlaybookSkillDef], task: str, intent: Optional[str]) -> List[Tuple[int, PlaybookSkillDef]]:
    intent_target = (intent or "").strip().lower()
    task_text = (task or "")[:2000]  # cap the regex window, same as the TS original
    scored: List[Tuple[int, PlaybookSkillDef]] = []
    for s in skills:
        score = 0
        if intent_target and s.applies_to and intent_target in [t.lower() for t in s.applies_to]:
            specificity = 10 - min(9, len(s.applies_to))
            score += 20 + specificity
        if task_text:
            patterns = _KEYWORD_MAP.get(s.name)
            if patterns:
                hits = 0
                for pat in patterns:
                    if pat.search(task_text):
                        hits += 1
                        if hits >= 4:
                            break
                if hits > 0:
                    score += 15 + (hits - 1) * 6
        if score > 0 and _meets_skill_floor(s.name, score):
            scored.append((score, s))
    scored.sort(key=lambda x: -x[0])
    return scored


def suggest_skills_for_task(
    skills: List[PlaybookSkillDef], task: str, intent: Optional[str] = None, limit: int = 2
) -> List[PlaybookSkillDef]:
    """Pick the best skill(s) for a task, scored by intent match + keyword
    hits. `skills` should be load_builtin_skills() plus any user-authored
    PlaybookSkill rows the caller has loaded from the DB."""
    return [s for _, s in _score(skills, task, intent)[:limit]]


def top_skill_score_for_task(
    skills: List[PlaybookSkillDef], task: str, intent: Optional[str] = None
) -> Optional[Tuple[int, PlaybookSkillDef]]:
    """The single best-scoring skill, or None if nothing matched. Used to
    decide whether an existing skill is strong enough to skip drafting a new
    one (mirrors topSkillScoreForTask's role in the auto-draft trigger)."""
    scored = _score(skills, task, intent)
    return scored[0] if scored else None


def skills_catalog(skills: List[PlaybookSkillDef]) -> str:
    """Compact one-line-per-skill render for a planner's prompt catalog."""
    if not skills:
        return "No skills installed."
    return "\n".join(f"- {s.name}: {s.description}" for s in skills)
