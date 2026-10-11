// Canonical outbound Telegram layout.
//
// Every bot→operator text is markdown source (converted to rich HTML by
// sendTelegramMessage) shaped as one card:
//
//   {icon} **{title}**
//   {meta — one small line, optional}
//   {body}
//   {footer — "— Naxie", plus vault path for reports, optional}
//
// Rules the audit turned up:
// - No `##` headers (they waste a line and render no better than bold).
// - Single `**title**` style everywhere (was `**` in notify, `*` in
//   digests, `##` in schedules — all render the same, pick one source).
// - Report footers always carry the vault path; alerts carry no footer.
// - Bodies are capped by the CALLER (converter slices at 3800 chars);
//   composers here take already-capped text and never re-slice mid-word.

export type CardInput = {
  icon: string;
  title: string;
  meta?: string;
  body: string;
  footer?: string;
};

export function card(o: CardInput): string {
  const head = `${o.icon} **${o.title.trim()}**`;
  const parts = [head];
  if (o.meta?.trim()) parts.push(o.meta.trim());
  if (o.body?.trim()) parts.push(o.body.trim());
  else parts.push("(no details)");
  if (o.footer?.trim()) parts.push(o.footer.trim());
  return parts.join("\n\n");
}

// The report family (reflection / innovation / rollup / todo-brief /
// system-audit / briefings): stats strip + vault footer, one shape.
export function digestCard(o: {
  icon: string;
  title: string;
  date?: string;
  stats?: string[];
  meta?: string;
  body: string;
  vaultPath?: string;
}): string {
  const title = o.date ? `${o.title} — ${o.date}` : o.title;
  const meta = o.meta?.trim() || (o.stats ?? []).filter((s) => s?.trim()).join(" · ") || undefined;
  return card({
    icon: o.icon,
    title,
    meta,
    body: o.body,
    footer: o.vaultPath ? vaultFooter(o.vaultPath) : signNaxie(),
  });
}

export function vaultFooter(path: string): string {
  return `— Naxie · full report in vault: ${path}`;
}

export function signNaxie(): string {
  return "— Naxie";
}

// Delivery wrapper for scheduled results: success keeps the report footer,
// failures get a ⚠️ title and no footer (nothing to file).
export function deliveryCard(opts: { name: string; answer: string; lateNote?: string; failed?: boolean }): string {
  if (opts.failed) {
    return card({ icon: "⚠️", title: opts.name, body: opts.answer });
  }
  return card({
    icon: "✅",
    title: opts.name,
    body: `${opts.lateNote ?? ""}${opts.answer}`,
    footer: signNaxie(),
  });
}
