---
name: zapier-automation
description: Trigger or set up Zapier "Webhooks by Zapier" Zaps from Naxie — fire an existing catch-hook Zap with a JSON payload, or guide the operator through wiring one. Every call is approval-gated.
applies_to: [plan, draft-other, summarize, integration, zapier, webhook]
---

# Skill: Zapier automation

## Goal

Let the operator automate work that spans SaaS tools (Slack, Gmail, Salesforce,
etc.) without leaving the conversation with Naxie. Zapier's "Webhooks by Zapier"
trigger turns any incoming POST into a Zap run — so Naxie exposes that as a tool
rather than a full OAuth integration.

## When to use

- The operator asks Naxie to push something to another app ("post this digest to
  #announcements", "create a task in the CRM from this email").
- The operator wants a scheduled cross-app report, or to react to a Naxie result
  by kicking off a Zapier workflow.
- There's already a Zap in the operator's Zapier account using the
  "Webhooks by Zapier" → "Catch Hook" trigger (the webhook URL + optional key
  are configured, not hardcoded here).

## Tooling

Naxie reaches Zapier through the MCP server at
`naxionai/server/mcp/zapier-mcp.mjs` (register it on the MCP Servers page;
every call is approval-gated):

- `zapier_list_webhooks` — show the configured hook names (URLs redacted).
- `zapier_trigger_webhook(name, payload, dry_run?)` — POST `payload` as JSON to
  the named hook. Use `dry_run: true` to preview the target + body first.
- `zapier_help` — wiring instructions shown to the operator.

The server only ever POSTs to URLs whose host ends in `zapier.com`, and the
`key` (if any) is sent as a query param the operator set — Naxie never sees the
raw secret in chat (it's redacted in results).

## Process

1. Ask the operator which app/action they want to reach, and confirm a Zapier
   Zap already exists for it (or offer to draft the setup steps via
   `zapier_help` so they can create one).
2. If a Zap exists, read the catch-hook URL + optional key from the configured
   webhook (do NOT prompt the operator to paste a secret into chat unless they
   insist).
3. Before firing for the first time on a given payload, propose a
   `zapier_trigger_webhook` call with `dry_run: true` and show the operator the
   exact target + JSON it would send. Surface the approval prompt.
4. On success, summarize what was sent and what Zapier received (HTTP status +
   body). Treat non-2xx or `isError` results as a failure to report back from,
   not silently retry.
5. If no Zap exists yet, return the `zapier_help` text verbatim and offer to
   draft the payload schema the operator should expect on the Zapier side.

## Caveats

- Catch hooks typically return an empty 200 body — "no body" is normal and
  means the Zap is running.
- Zapier may apply rate limits; do not fan out many triggers in a tight loop.
- This skill is a trigger client only — it does not list/manage the operator's
  Zaps in Zapier (that would require the Zapier Platform API + OAuth), which
  keeps secrets out of this server entirely.
