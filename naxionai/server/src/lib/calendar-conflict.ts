// Calendar Conflict Resolver & Meeting Prep/Post Engine
// Detects overlapping calendar events, proposes alternative open slots,
// and drafts proactive meeting prep briefs and post-meeting action item summaries.

import type { CalEvent } from "./calendar-ical.js";

export type ConflictReport = {
  eventA: CalEvent;
  eventB: CalEvent;
  overlapMinutes: number;
  proposedAlternatives: {
    start: string;
    end: string;
    label: string;
  }[];
};

export function detectCalendarConflicts(events: CalEvent[]): ConflictReport[] {
  const reports: ConflictReport[] = [];
  const sorted = [...events].filter(e => e.start && e.end).sort(
    (a, b) => new Date(a.start).getTime() - new Date(b.start).getTime()
  );

  for (let i = 0; i < sorted.length - 1; i++) {
    const current = sorted[i];
    const next = sorted[i + 1];

    const currentEnd = new Date(current.end!).getTime();
    const nextStart = new Date(next.start).getTime();

    if (currentEnd > nextStart) {
      const overlapMinutes = Math.round((currentEnd - nextStart) / 60000);
      
      // Propose alternatives
      const baseDate = new Date(next.start);
      const durationMs = (new Date(next.end!).getTime() - nextStart) || 3600000;

      // Slot 1: Immediately after current event + 15 min buffer
      const slot1Start = new Date(currentEnd + 15 * 60000);
      const slot1End = new Date(slot1Start.getTime() + durationMs);

      // Slot 2: Next day same time
      const slot2Start = new Date(baseDate.getTime() + 86400000);
      const slot2End = new Date(slot2Start.getTime() + durationMs);

      // Slot 3: Next day 14:00 (afternoon block)
      const slot3Start = new Date(baseDate.getTime() + 86400000);
      slot3Start.setHours(14, 0, 0, 0);
      const slot3End = new Date(slot3Start.getTime() + durationMs);

      reports.push({
        eventA: current,
        eventB: next,
        overlapMinutes,
        proposedAlternatives: [
          {
            start: slot1Start.toISOString(),
            end: slot1End.toISOString(),
            label: `Today @ ${slot1Start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
          },
          {
            start: slot2Start.toISOString(),
            end: slot2End.toISOString(),
            label: `Tomorrow @ ${slot2Start.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`,
          },
          {
            start: slot3Start.toISOString(),
            end: slot3End.toISOString(),
            label: `Tomorrow @ 2:00 PM`,
          },
        ],
      });
    }
  }

  return reports;
}

export function formatConflictTelegramAlert(conflict: ConflictReport): { text: string; keyboard: any[][] } {
  const text = `⚠️ *Calendar Conflict Detected!*\n\n` +
    `Double-booking between:\n` +
    `• **${conflict.eventA.summary}**\n` +
    `• **${conflict.eventB.summary}** (${conflict.overlapMinutes} min overlap)\n\n` +
    `💡 *Recommended alternatives for "${conflict.eventB.summary.slice(0, 20)}":*`;

  const keyboard = conflict.proposedAlternatives.map((alt, idx) => [
    {
      text: `✅ Move to ${alt.label}`,
      callback_data: `cal:reschedule:${encodeURIComponent(conflict.eventB.summary.slice(0, 15))}:${alt.start.slice(0, 16)}`,
    }
  ]);

  return { text, keyboard };
}

export function formatMeetingPrep(event: CalEvent, relatedVaultNotes: string[]): string {
  const lines = [
    `# 📋 Meeting Prep: ${event.summary}`,
    ``,
    `> **Time:** ${new Date(event.start).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}${event.end ? ` - ${new Date(event.end).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}` : ""}`,
    event.location ? `> **Location:** ${event.location}` : ``,
    ``,
    `## 🎯 Objectives & Description`,
    event.description || `_No description provided on calendar event._`,
    ``,
    `## 🧠 Relevant Second-Brain Context`,
  ];

  if (relatedVaultNotes.length) {
    for (const note of relatedVaultNotes) {
      lines.push(`- [[${note}]]`);
    }
  } else {
    lines.push(`_No direct matching notes found in vault._`);
  }

  lines.push(
    ``,
    `## 📝 Post-Meeting Action Items (Template)`,
    `- [ ] `,
    `- [ ] `,
    ``
  );

  return lines.join("\n");
}

