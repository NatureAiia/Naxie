// Send mail through the operator's own connected Google/Microsoft account
// (lib/oauth-connectors.ts), as a second, separate send path alongside
// lib/email.ts's SMTP/Mailjet mailbox. Deliberately NOT merged with
// lib/email.ts's sendOutbound(): that path is Naxie's own system-notification
// mailbox (schedules, reflections, etc.); this one sends AS the operator
// through an account they explicitly connected and granted gmail.send /
// Mail.Send to. Keeping them separate means neither can regress the other.
//
// Plain-text only for v1 — no HTML/multipart. The existing read primitives
// next to these (google.list_recent_emails etc.) swallow errors to `[]`
// because they feed best-effort digests; a send must NOT swallow errors —
// the operator needs to know if their email didn't go out, so every failure
// here throws instead.

export type SendMailArgs = { to: string; subject: string; body: string };
export type SendMailResult = { ok: true; id?: string };

function encodeSubjectHeader(subject: string): string {
  // RFC 2047 encoded-word for any non-ASCII subject; plain ASCII passes
  // through unchanged (the common case for operator-dictated subjects).
  // eslint-disable-next-line no-control-regex
  if (/^[\x00-\x7F]*$/.test(subject)) return subject;
  return `=?UTF-8?B?${Buffer.from(subject, "utf8").toString("base64")}?=`;
}

function splitRecipients(to: string): string[] {
  return to.split(",").map(s => s.trim()).filter(Boolean);
}

export async function sendGmailMessage(token: string, { to, subject, body }: SendMailArgs): Promise<SendMailResult> {
  const recipients = splitRecipients(to);
  if (!recipients.length) throw new Error("sendGmailMessage: no recipient");
  const raw = [
    `To: ${recipients.join(", ")}`,
    `Subject: ${encodeSubjectHeader(subject)}`,
    `Content-Type: text/plain; charset="UTF-8"`,
    `MIME-Version: 1.0`,
    "",
    body,
  ].join("\r\n");
  const encoded = Buffer.from(raw, "utf8").toString("base64url");
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/messages/send", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ raw: encoded }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Gmail send failed (${r.status}): ${text.slice(0, 300)}`);
  }
  const data: any = await r.json().catch(() => ({}));
  return { ok: true, id: data?.id };
}

export async function sendOutlookMessage(token: string, { to, subject, body }: SendMailArgs): Promise<SendMailResult> {
  const recipients = splitRecipients(to);
  if (!recipients.length) throw new Error("sendOutlookMessage: no recipient");
  const r = await fetch("https://graph.microsoft.com/v1.0/me/sendMail", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({
      message: {
        subject,
        body: { contentType: "Text", content: body },
        toRecipients: recipients.map(address => ({ emailAddress: { address } })),
      },
      saveToSentItems: true,
    }),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`Outlook send failed (${r.status}): ${text.slice(0, 300)}`);
  }
  // Graph's sendMail returns 202 Accepted with an empty body — no message id.
  return { ok: true };
}
