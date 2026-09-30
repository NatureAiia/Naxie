# Wake-Word + Proactive Cadence — Spike & Spec (Tracks 2+3)

Status: **spike/spec — awaiting operator sign-off before code**. No boundary in §9 crossed yet.
Covers `docs/naxie-architecture.md` §2.1 (wake-word), §2.4/§6 (`agency_daemon.py` port gaps: chat-inactivity check-in + proactive research).

---

## 1. Wake-Word Spike (Track 2)

### 1.1 What exists today, precisely

| Surface | File | Shape |
|---|---|---|
| Python wake-word | `naxionai/backend/agent/wake_word.py:81` — `WakeWordSession(phrase, sample_rate=16000)` + `accept(pcm_bytes)->bool` | Offline Vosk `KaldiRecognizer` with grammar-constrained decode: `json.dumps(sorted(targets)+["[unk]"])` |
| Grammar trick | `wake_word.py:62` `_PHONETIC_VARIANTS = {"naxie": ["nexi","naxi","nyx","nixie","natty","nexus","annex"]}` + `_build_grammar` | Brand name "naxie" not in `vosk-model-small-en-us-0.15` dict — expansion to in-vocab near-homophones is load-bearing, not cosmetic |
| WS transport | `naxionai/backend/api/voice.py:113` `GET /ws/wake?phrase=hey naxie` — client streams 16kHz mono PCM16 binary frames, server replies `{"type":"wake"}` | One `WakeWordSession` per websocket; `Reset()` after a hit so next utterance re-arms |
| Model fetch | `wake_word.py:26` `get_vosk_model()` lazy-loads `media/vosk_model/`, returns `None` if absent/dir missing, never raises — graceful degrade | ~40MB download, not shipped in-repo, must be manual step |
| TS frontend gate | `neuroworks/web/src/lib/useNaxieAssistant.ts:60` `WAKE_PHRASE_RE = /\bhey,?\s+naxie\b/i` | Cloud `SpeechRecognition` interim→final transcript regex, finalized-chunk only (`useNaxieAssistant.ts:232` comment: never interim), `wakeArmedRef` arms one ask (`useNaxieAssistant.ts:238`) |
| Voice tiers | `neuroworks/server/src/lib/voice.ts:1` | Realtime/OpenAI-TTS/local sidecar/Web Speech — none of this changes |
| Always-on premise | `docs/naxie-architecture.md:59` §2.0 Windows Service | Research for this spike assumed §2.0 may land later; wake-word propose path must work both before and after it |

### 1.2 Node/Windows options evaluated (live npm check 2026-09-09)

* **`vosk` 0.3.39** (npm `vosk`) — FFI-NAPI wrapper, ~85MB unpacked. Native `libvosk` binary + `ffi-napi@4.0.3`/`ref-napi`. Works on Windows but **requires build toolchain** (node-gyp, Python, Visual Studio Build Tools) and ships a native `.node` per arch. This is exactly what `naxionai/backend`'s Python `vosk` wraps, so grammar-constrained `KaldiRecognizer(model, 16000, grammarJson)` ports 1:1. **Available, but heavy.**
* **`node-record-lpcm16` 1.0.1 / `mic` 2.1.2** — PCM capture helpers. `node-record-lpcm16` shells `sox`/`arecord`/`rec` — on Windows needs `sox.exe` on PATH. `mic` shells `arecord`/`sox` similarly. Neither does recognition — just mic→PCM. Pair with `vosk`.
* **`@ricky0123/vad-node` 0.0.3 / `whisper-node` 1.1.1** — VAD / Whisper wrappers; not grammar-constrained wake-word, heavier model, wrong tool.
* **Browser `webkitSpeechRecognition` (current `useSpeechRecognition.ts:18`)** — zero native deps, but cloud-routed and **requires a foreground tab** (`useNaxieAssistant.ts:422` `mic.active` lost on tab close). Satisfies docs §2.1 "manual fallback (tap-to-talk)" forever, but never "host-level listening".

**Conclusion:** no lightweight pure-JS offline wake-word library exists on npm. The only proven offline path is Vosk (Node or Python).

### 1.3 Recommended architecture — two phases, not a big-bang native install

**Phase 2a — WebSocket to Node Vosk (no native mic capture, no toolchain):**
* Add `GET /api/voice/wake` WebSocket (mirrors `naxionai/backend/api/voice.py:113` but on the TS server). Client captures mic via existing `getUserMedia` → AudioWorklet resampling to 16kHz mono PCM16 (same format `WakeWordSession.accept` expects), streams binary frames. Server runs `vosk` Node binding only — mic capture stays in the browser.
* Why this first: **zero Windows toolchain to install**, reuses the already-granted browser mic permission, and achieves "offline wake-word" (audio never leaves the machine — Vosk runs locally in Node, not in Chrome's cloud SpeechRecognition). The only thing it doesn't yet solve is "tab must be open" — but §2.0 Windows Service isn't landed yet anyway, so host-level mic has nowhere to run yet.
* Model handling: reuse `naxionai/backend/media/vosk_model/` location or `neuroworks/server/media/vosk_model/` with same `get_vosk_model()` graceful-degrade — `voiceStatus()` gains `wakeWord: { available, modelPath }` so UI can show "download model" hint instead of silent fail.

**Phase 2b — Host-level mic (true tab-less, after §2.0 service lands):**
* Add `lib/wake-word-host.ts` daemon: `node-record-lpcm16` (or `mic`) → `vosk.Model` + `KaldiRecognizer` with same grammar JSON (`_PHONETIC_VARIANTS` ported verbatim). Runs inside the Windows Service process, no browser involved. Emits `wake` event → same `notifyAttention` toast / orb state as Phase 2a, and optionally auto-starts a short capture window for the follow-up command (sent to `voice.py`-style Whisper or directly to `/api/voice/converse`).
* Native-deps gate: behind `NAXION_WAKE_WORD_HOST=1` env flag; auto-detects missing `sox`/`vosk` native and degrades to Phase 2a with a `voiceStatus` hint, same degrade posture as Python's `get_vosk_model()->None`.

**Shared contract (both phases):**
* Grammar = `JSON.stringify(sorted(expandPhrase(phrase)) + ["[unk]"])` — port `wake_word.py:67` `_build_grammar` exactly, including the `_PHONETIC_VARIANTS` dict.
* `accept(pcm: Buffer)->boolean` semantics: `AcceptWaveform` → check `Result().text` if final else `PartialResult().partial`, exact match against `targets` set, `Reset()` on hit. No `close()` needed (matches Python's lack of one).
* Audio contract: 16kHz mono 16-bit PCM LE, chunk size ~4096 bytes (any size works — Vosk is streaming).
* Security: wake-word detection itself is **always-allowed** (no governance gate) — it's just "did we hear the phrase". The *follow-up command* re-enters normal Naxie triage (`naxie-router.ts:100` `classifyChatIntent`).

### 1.4 What this spike did NOT assume

* Did not pick `node-windows`/NSSM for §2.0 — tracked as separate `○ a2` phase, boundary-flagged in `docs/naxie-architecture.md:254`.
* Did not bundle the ~40MB Vosk model into git — download remains a manual `media/vosk_model/` step (same URL already in `wake_word.py:39` comment).
* Did not propose wake-word-gated TTS interruption or continuous transcription — the daemon's `notifyAttention` toast is the only proactive surface until user engages (`docs/naxie-architecture.md:234`).

---

## 2. Proactive Cadence Spec (Track 3)

### 2.1 Why these two were unbuilt — the actual gaps

`org-daemon.ts:36` SCOPE NOTE lists them as "product decision, not scoping gap":

* **Chat-inactivity check-in** (`agency_daemon.py:408` `_check_idle_chat_nudge`): fires purely because *you* went quiet, regardless of task state. But `neuroworks` has **no persisted `lastInteractionAt`** — `useNaxieAssistant.ts:63` keeps `turns` in `sessionStorage` (per-tab, ephemeral), and `voice.ts:89` `/converse` is stateless (no write). So "hours since last chat" is uncomputable today.
* **Proactive research** (`agency_daemon.py:291` `_run_proactive_research`): every 2h, LLM drafts "2-3 trending opportunities + 2-3 content ideas + 1 competitor angle" personalized from past goals + recent chat + `brand_voice`/`industry`. But `neuroworks` has **no `industry`/`brand_voice` and no topic source** — the TS stack is single-operator, no `AgencySettings.industry`, and inventing "what Naxie should research" without an interest signal is guessing, not porting.

### 2.2 Chat-inactivity check-in — concrete spec

**Persisted state (new file: `.neuroworks/naxie-interactions.json`):**

```ts
type NaxieInteractions = {
  lastInteractionAt: string; // ISO — updated on every successful /api/voice/converse and /api/naxie/ask
  lastNudgeAt?: string;      // ISO — throttles one nudge per idle window
};
```

* Writer: `voice.ts:89` `/converse` and `naxie.ts:91` `/ask` call `touchInteraction()` after responding (fire-and-forget, never blocks the response). Also `chat.ts` if direct worker chat should count — **proposed: yes, any user turn counts**, matching `agency_daemon.py:416` which queries `ChatMessage` regardless of channel.
* Reader: `org-daemon.ts` new `maybeNudgeChatInactivity(now)` — mirrors `agency_daemon.py:408` shape exactly:

| Param | `agency_daemon.py` | Proposed TS |
|---|---|---|
| Idle threshold | `CHAT_IDLE_THRESHOLD_HRS = 2` | `NAXION_CHAT_IDLE_HRS` env, default `2` (same) |
| Throttle | `last_idle_chat_nudge` column | `lastNudgeAt` in same JSON file; check `now - lastNudge >= threshold` |
| Guard | `if not last_msg: return` | `if not lastInteractionAt: return` (never chatted → no check-in) |
| Content | `agent.llm.generate_completion` with `preferred_name` + `prefs_text` | `llmGenerate` with `getOperatorIdentity().name` + `buildMagContext()` facts (operator facts), same 1-3 sentence warm check-in prompt (`agency_daemon.py:454`) |
| Delivery | `chat_push(user_id, msg, "naxie")` | `notifyAttention("Naxie — checking in", msg, {actor:"naxie"})` + `logAudit("naxie","nudge.chat_checkin",...)` — respects `docs/naxie-architecture.md:234` silent-until-engaged (badge/toast, never unsolicited voice) |
| Env tuning | hardcoded | `NAXION_CHAT_NUDGE_ENABLED=0` to disable; threshold/throttle via env |

* Tests: pure `maybeNudgeChatInactivity(now)` with injected `lastInteractionAt`/`lastNudgeAt` — same `now` param pattern `org-daemon.ts:59` already uses for `maybeNudgePendingApprovals`.

### 2.3 Proactive research — concrete spec (no guessing)

**Topic source (ordered, first non-empty wins, additive where noted):**

1. **Explicit interests file (new, highest signal):** `vaultPath/_neuroworks/interests.md` — one topic/interest per line or freeform paragraph, maintained by operator or by Naxie via `memory.note subject="interests"`. If this file exists and is non-empty, its lines are the research topics. UI: tiny "Research interests" field on `pages/Onboarding.tsx:195` (extend `priorities` textarea) + `GET/PUT /api/naxie/interests` for direct edit.
2. **Sector context (automatic, always additive):** `sector-packs.ts:68` `SECTORS[].contextNote` for `getOnboardingState().sector` — e.g. FinTech's "EcoCash, RBZ compliance" gives a grounded vertical without the operator writing anything. Appended as "Sector context: …" in the research prompt, not a standalone query.
3. **MAG-derived topics (automatic, fallback):** `mag.ts:252` `buildMagContext` recent subjects + `memory.ts:147` `searchMemory` hits for operator — top 3 subjects by `lastTs` become candidate topics when (1) is empty. Cheap, already persisted, no new store.
4. **Vault RAG signals (optional, low weight):** `naxie-context.ts:38` `ragSearch` over recent vault notes — only if vault has recent edits (mtime <7d), to avoid re-researching stale notes.

**Why this ordering:** (1) is the only place the operator explicitly says "care about X" — without it, every other source is an inference. (2) is always true for the sector they picked during onboarding, so even a fresh install has *something* to research. (3)/(4) are fallbacks that get better as memory/vault accrue, matching `agency_daemon.py:303` "learns from training docs + recent chat + past goals" but with TS-native sources (no `Goal` table here — `OrgTask` history + vault replace it).

**Daemon behavior (`org-daemon.ts` new `maybeRunProactiveResearch(now)`):**

* Cadence: `PROACTIVE_RESEARCH_HRS = 2` → `NAXION_PROACTIVE_RESEARCH_HRS` env, default `4` (more conservative than Python's 2h — PA research every 2h was noisy in `agency_daemon.py`'s own throttle comments). Throttle timestamp `lastResearchAt` in same `.neuroworks/naxie-interactions.json` or a dedicated `.neuroworks/research-state.json` — either works, keep it one file for simplicity.
* LLM prompt: ports `agency_daemon.py:332` structure but with TS sources:

```
You are Naxie's proactive researcher.
Operator: {getOperatorIdentity().summary}
Sector: {getSectorContext(sector)}
Interests: {interests.md or "(none set — using recent memory/vault signals)"}
Recent memory: {buildMagContext(maxFacts=6)}
Today: {now.toDateString()}
Trending context note: {sector contextNote — already included above}
Task: surface 2-3 actionable opportunities + 1 angle to watch, ≤250 words, grounded in the sector/interest context, no fluff.
```

* Delivery: same `notifyAttention` (toast + in-app briefing card) as `maybeGenerateBriefing` — **not** an auto-created `OrgTask` (research is a digest, not a backlog item). Optionally `noteFact(subject="research", fact=summary)` so next turn's MAG remembers it.
* Disable: `NAXION_PROACTIVE_RESEARCH_ENABLED=0` (default **OFF** until interests or sector exist — avoids empty "researching nothing" runs on a fresh install).
* Tests: topic-source resolver is pure (`resolveResearchTopics({ interestsFile, sector, magSubjects }) -> string[]`); daemon tick respects throttle and disabled flag.

### 2.4 Relationship to existing daemon & briefing

`org-daemon.ts:289` `tick()` already sequences 8 phases in one 5m loop. New phases slot in after `maybeGenerateBriefing`:

```
tick: sweepStale → reconcile → nudgeApprovals → backup → architect → briefing → nudgeExecutor → idleReport → [NEW] nudgeChatInactivity → [NEW] proactiveResearch
```

* No new timer, same `DAEMON_CYCLE_SECONDS` (300s default) — matches `agency_daemon.py:25`.
* Briefing (`maybeGenerateBriefing`) stays daily 08:00-gated; chat nudge is 2h-since-last-talk; research is 4h-since-last-research. Independent throttles, no cross-interference.

### 2.5 What still needs operator sign-off (boundary flags)

* **Credential-free by design** — neither phase introduces a new remote push (email/remote repo) so no §9 PAT/SSH decision. If later "email the research brief" is wanted, that's a separate flag.
* **Wake-word host mic** (Phase 2b) needs `sox`/`vosk` native toolchain + Windows Service (§2.0) — both flagged in `docs/naxie-architecture.md:252`.
* **Proactive research default OFF** protects against "Naxie kept emailing me AI slop" — operator opts in by setting interests or explicitly enabling the env flag.

---

## 3. Implementation sketch (after sign-off)

1. **Wake-word 2a** (≈1-2 days): `lib/wake-word.ts` (port `_build_grammar` + `WakeWordSession`), `routes/voice.ts` WS upgrade (`/api/voice/wake`), `lib/voice.ts` `voiceStatus().wakeWord`, web `AudioWorklet` PCM streamer + `useNaxieAssistant.ts` wake gate now backed by WS `{"type":"wake"}` instead of regex only. Model dir + `.env.example` hint.
2. **Interactions persistence** (≈0.5 day): `.neuroworks/naxie-interactions.json` + `touchInteraction()` called from `voice.ts:89` + `naxie.ts:91` + `chat.ts`.
3. **Chat check-in** (≈0.5 day): `org-daemon.ts: maybeNudgeChatInactivity` + `notifyAttention`, env flags, tests.
4. **Research interests + spec** (≈1 day): `vault/_neuroworks/interests.md` + `routes/naxie.ts` interests endpoints, `Onboarding.tsx` field, `org-daemon.ts: maybeRunProactiveResearch` with ordered topic resolver, env flags, tests.
5. **Host mic 2b** (deferred until §2.0 service): `lib/wake-word-host.ts` + `NAXION_WAKE_WORD_HOST` gate.

Each lands with `vitest run` + `tsc --noEmit` per `docs/naxie-architecture.md:273` "after each phase" rule.
