// Smart Email Triage — classifies incoming emails into Action / Scheduled / FYI
// with a 1-liner explanation and enhanced Telegram actions (Respond, Snooze, Archive, Delegate).

export type EmailClassification = {
  category: "action" | "scheduled" | "fyi";
  badge: string;
  oneLinerReason: string;
  urgency: "high" | "medium" | "low";
};

export function classifyEmail(sender: string, subject: string, body: string): EmailClassification {
  const s = subject.toLowerCase();
  const b = body.toLowerCase();
  const from = sender.toLowerCase();

  // 1. Scheduled / Calendar invites
  const scheduledKeywords = ["invitation:", "accepted:", "declined:", "calendar", "meeting", "rescheduled:", "zoom", "google meet", "teams meeting", "webinar"];
  if (scheduledKeywords.some(k => s.includes(k) || b.includes(k))) {
    return {
      category: "scheduled",
      badge: "📅 Scheduled",
      oneLinerReason: "Calendar event, meeting invite, or appointment coordination.",
      urgency: "medium",
    };
  }

  // 2. FYI / Notifications / Newsletters
  const fyiKeywords = ["newsletter", "unsubscribe", "digest", "no-reply", "noreply", "receipt", "invoice #", "order confirmation", "weekly update", "statement ready", "terms update"];
  if (fyiKeywords.some(k => s.includes(k) || from.includes(k) || b.includes(k))) {
    return {
      category: "fyi",
      badge: "👀 FYI",
      oneLinerReason: "Informational notification, newsletter, or automated service report.",
      urgency: "low",
    };
  }

  // 3. Action / High Priority
  const actionKeywords = ["action required", "urgent", "approval", "please review", "deadline", "need your input", "can you", "feedback needed", "payment due", "sign"];
  const hasActionKeyword = actionKeywords.some(k => s.includes(k) || b.includes(k));

  return {
    category: "action",
    badge: "🔥 Action",
    oneLinerReason: hasActionKeyword 
      ? "Direct request requiring human decision, response, or review."
      : "Personal communication awaiting your reply.",
    urgency: hasActionKeyword ? "high" : "medium",
  };
}

