// Shared Google Calendar / Microsoft Graph calendar helpers — the read
// functions here replace the fetch logic that used to be inlined directly in
// primitives.ts's google.list_upcoming_events / microsoft.list_recent_events
// handlers (same behavior, just extracted so routes/calendar.ts can call them
// too, lib-to-lib, without going through the agent/primitive pipeline for a
// plain page load). The write functions are new.
//
// Read functions keep the primitives' original swallow-to-[] posture (they
// feed best-effort digests/page loads); write functions throw on failure —
// an operator-facing "create this event" must not silently no-op.

export type ExternalEvent = { summary: string; start?: string; end?: string; account: string; source: "google" | "microsoft"; id?: string };
export type TokenEntry = { token: string; accountName?: string };

async function tokensFor(platform: "google" | "microsoft"): Promise<TokenEntry[]> {
  const { getValidAccessTokens } = await import("./oauth-connectors.js");
  return getValidAccessTokens(platform);
}

export async function listGoogleEvents(maxResults = 10): Promise<ExternalEvent[]> {
  try {
    const tokens = await tokensFor("google");
    if (!tokens.length) return [];
    const maxPerAccount = Math.min(Number(maxResults) || 10, 50);
    const all: ExternalEvent[] = [];
    for (const { token, accountName } of tokens) {
      const params = new URLSearchParams({ maxResults: String(maxPerAccount), singleEvents: "true", orderBy: "startTime", timeMin: new Date().toISOString() });
      const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) continue;
      const data: any = await r.json();
      for (const e of data.items ?? []) {
        all.push({ summary: e.summary, start: e.start?.dateTime ?? e.start?.date, end: e.end?.dateTime ?? e.end?.date, account: accountName ?? "unknown", source: "google", id: e.id });
      }
    }
    return all;
  } catch { return []; }
}

export async function listMicrosoftEvents(maxResults = 10): Promise<ExternalEvent[]> {
  try {
    const tokens = await tokensFor("microsoft");
    if (!tokens.length) return [];
    const maxPerAccount = Math.min(Number(maxResults) || 10, 50);
    const all: ExternalEvent[] = [];
    for (const { token, accountName } of tokens) {
      const r = await fetch(`https://graph.microsoft.com/v1.0/me/events?$top=${maxPerAccount}&$select=id,subject,start,end&$orderby=start/dateTime`, { headers: { authorization: `Bearer ${token}` } });
      if (!r.ok) continue;
      const data: any = await r.json();
      for (const e of data.value ?? []) {
        all.push({ summary: e.subject, start: e.start?.dateTime, end: e.end?.dateTime, account: accountName ?? "unknown", source: "microsoft", id: e.id });
      }
    }
    return all;
  } catch { return []; }
}

export type EventWriteArgs = { summary: string; start: string; end: string; description?: string; attendees?: string[] };
export type EventWriteResult = { ok: true; id: string };

export async function createGoogleEvent(token: string, args: EventWriteArgs): Promise<EventWriteResult> {
  const r = await fetch("https://www.googleapis.com/calendar/v3/calendars/primary/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      summary: args.summary,
      description: args.description,
      start: { dateTime: args.start },
      end: { dateTime: args.end },
      attendees: args.attendees?.map(email => ({ email })),
    }),
  });
  if (!r.ok) throw new Error(`Google Calendar create failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const data: any = await r.json();
  return { ok: true, id: data.id };
}

export async function updateGoogleEvent(token: string, eventId: string, args: Partial<EventWriteArgs>): Promise<EventWriteResult> {
  const body: any = {};
  if (args.summary !== undefined) body.summary = args.summary;
  if (args.description !== undefined) body.description = args.description;
  if (args.start !== undefined) body.start = { dateTime: args.start };
  if (args.end !== undefined) body.end = { dateTime: args.end };
  if (args.attendees !== undefined) body.attendees = args.attendees.map(email => ({ email }));
  const r = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Google Calendar update failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return { ok: true, id: eventId };
}

export async function createMicrosoftEvent(token: string, args: EventWriteArgs): Promise<EventWriteResult> {
  const r = await fetch("https://graph.microsoft.com/v1.0/me/events", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      subject: args.summary,
      body: args.description ? { contentType: "Text", content: args.description } : undefined,
      start: { dateTime: args.start, timeZone: "UTC" },
      end: { dateTime: args.end, timeZone: "UTC" },
      attendees: args.attendees?.map(email => ({ emailAddress: { address: email }, type: "required" })),
    }),
  });
  if (!r.ok) throw new Error(`Microsoft Calendar create failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 300)}`);
  const data: any = await r.json();
  return { ok: true, id: data.id };
}

export async function updateMicrosoftEvent(token: string, eventId: string, args: Partial<EventWriteArgs>): Promise<EventWriteResult> {
  const body: any = {};
  if (args.summary !== undefined) body.subject = args.summary;
  if (args.description !== undefined) body.body = { contentType: "Text", content: args.description };
  if (args.start !== undefined) body.start = { dateTime: args.start, timeZone: "UTC" };
  if (args.end !== undefined) body.end = { dateTime: args.end, timeZone: "UTC" };
  if (args.attendees !== undefined) body.attendees = args.attendees.map(email => ({ emailAddress: { address: email }, type: "required" }));
  const r = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, {
    method: "PATCH",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`Microsoft Calendar update failed (${r.status}): ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return { ok: true, id: eventId };
}
