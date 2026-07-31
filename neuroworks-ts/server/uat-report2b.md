# NeuroWorks harness #2 report
Generated: 2026-07-27T14:35:48.384Z · Server: http://127.0.0.1:7470

Health: ok=true model=qwen2.5:3b openrouter=gpt-5.6-terra

## 1. Functionality + quality + speed

| task | grade | time | target | route | findings |
|---|---|---|---|---|---|
| direct-qa | WARN | 118s | 40s |  | 🟠slow |
| explainer | PASS | 22s | 70s |  | — |
| email-invite | PASS | 34s | 70s | vault.search,fs.find_in,quality.check,security.scan | — |
| postmortem | FAIL | - | 150s | - | 🔴exception |
| analyst | FAIL | - | 100s | - | 🔴exception |
| grounding-connector | FAIL | - | 120s | - | 🔴exception |
| grounding-org | FAIL | - | 120s | - | 🔴exception |
| email-read | WARN | 276s | 90s | inbox.read_unread,quality.check,security.scan,governance.check | 🟠slow |
| social-read | PASS | 8s | 90s | social.history | — |
| social-publish | FAIL | 8s | 90s | social.history | 🔴wrong-route 🔴no-approval-gate |
| memory | PASS | 68s | 90s | memory.note,quality.check,security.scan,governance.check | — |

## 2. Repeat — de-duplication

| task | run-1 | run-2 | identical? | verdict |
|---|---|---|---|---|
| email-invite | 642f17e0 | f55bbb0b | no | PASS |
| postmortem | be7ea4fa | 5c023550 | no | FAIL empty |

## 3. Findings (7 high, 2 medium)

- 🔴 HIGH · **postmortem** · `exception` — poll timeout for 590aae49-589d-4e6a-98b3-b0c851c34a20
- 🔴 HIGH · **analyst** · `exception` — poll timeout for c14f5876-bbc0-4bd7-bff6-2dd8130b8d85
- 🔴 HIGH · **grounding-connector** · `exception` — poll timeout for 07026cad-e935-4e02-8ca3-a6ba13687e4d
- 🔴 HIGH · **grounding-org** · `exception` — poll timeout for 779ed4d6-28ed-47de-9f12-b4255c4af142
- 🔴 HIGH · **social-publish** · `wrong-route` — expected tool social.post, plan used [social.history]
- 🔴 HIGH · **social-publish** · `no-approval-gate` — a publishing/sensitive action did NOT park for approval
- 🔴 HIGH · **repeat** · `repeat-empty` — repeat 'postmortem' had an empty run
- 🟠 MED · **direct-qa** · `slow` — 118s vs 40s (>1.5×)
- 🟠 MED · **email-read** · `slow` — 276s vs 90s (>1.5×)

## 4. Output samples

### direct-qa — WARN (118s)
```
Idempotency in a REST API ensures that identical requests have consistent results without altering the system state or producing unintended side effects. This property matters because it guarantees predictable behavior and simplifies client implementations by allowing operations like updates to be retried safely, knowing they will produce the same outcome regardless of how many times they are executed.
```

### explainer — PASS (22s)
```
## TLS 1.3 Handshake: Establishing a Secure Session

1. **ClientHello.** The client opens a TCP connection and sends supported TLS versions, cipher suites, a random value, Server Name Indication (SNI), ALPN protocols such as HTTP/2, and one or more ephemeral key shares (typically X25519).

2. **ServerHello.** The server selects TLS 1.3, a cipher suite, and a compatible key share. Both sides can now perform ephemeral Diffie–Hellman key agreement and independently derive a shared secret. The server sends its remaining handshake messages encrypted with keys derived from that secret.

3. **Server authentication.** The encrypted server flight includes its certificate chain, a CertificateVerify signature proving possession of the certificate’s private key, and a Finished message authenticating t
```

### email-invite — PASS (34s)
```
Subject: You’re invited: Analytics Dashboard webinar next Thursday

Hi,

We’re hosting a webinar next Thursday to introduce our new analytics dashboard and share how it can help you explore your data more easily.

Join us for a practical walkthrough, including key features and time for questions.

**Register now to save your spot for next Thursday’s webinar.**

Best,  
Neuro
```

### postmortem — FAIL (-)
```
poll timeout for 590aae49-589d-4e6a-98b3-b0c851c34a20
```

### analyst — FAIL (-)
```
poll timeout for c14f5876-bbc0-4bd7-bff6-2dd8130b8d85
```

### grounding-connector — FAIL (-)
```
poll timeout for 07026cad-e935-4e02-8ca3-a6ba13687e4d
```

### grounding-org — FAIL (-)
```
poll timeout for 779ed4d6-28ed-47de-9f12-b4255c4af142
```

### email-read — WARN (276s)
```
## Unread Inbox Status

The unread-inbox check failed because the mail server could not be resolved: `getaddrinfo ENOTFOUND mail.rubiem.com`. Your unread-email status and count are therefore unknown; no email summary is available. [1]
```

### social-read — PASS (8s)
```
I tried to complete this part of the task and hit an error I don't have a clean recovery for. Could you tell me a bit more about what you're trying to achieve, or try a different angle?

_Technical detail: social not configured — set AYRSHARE_API_KEY in clawbot/.env (one key covers X, LinkedIn, Facebook, Instagram, …). Get it from ayrshare.com._
```

### social-publish — FAIL (8s)
```
I tried to complete this part of the task and hit an error I don't have a clean recovery for. Could you tell me a bit more about what you're trying to achieve, or try a different angle?

_Technical detail: social not configured — set AYRSHARE_API_KEY in clawbot/.env (one key covers X, LinkedIn, Facebook, Instagram, …). Get it from ayrshare.com._
```

### memory — PASS (68s)
```
## Q1 Board Meeting Record

The Q1 board meeting is recorded as taking place on **2026-02-15**. [1]

### Information on File

The available record contains only the meeting reference and date. It does not include an agenda, attendee list, board materials, location, decisions, action items, or follow-up notes. [1]
```

---
Finished: 2026-07-27T15:17:51.369Z. Verdict: NOT READY — 7 high finding(s).