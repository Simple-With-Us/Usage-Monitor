export const BILLS_CALENDAR_PRODID = "-//Usage Monitor//Bills//EN";
export const BILLS_CALENDAR_NAME = "Bills";

export type BillsCalendarSort =
  | "subscription"
  | "prepaid"
  | "usage"
  | "dev-expense";

export interface BillsCalendarEvent {
  uid: string;
  date: string;
  summary: string;
  description: string;
}

function icsEscape(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\n|\r/g, "\\n");
}

function foldLine(line: string): string {
  const chunks: string[] = [];
  let remaining = line;
  while (remaining.length > 75) {
    chunks.push(remaining.slice(0, 75));
    remaining = ` ${remaining.slice(75)}`;
  }
  chunks.push(remaining);
  return chunks.join("\r\n");
}

export function calendarTitle(amountUsd: number, service: string, sort: BillsCalendarSort): string {
  const amount = Number.isFinite(amountUsd) ? `$${amountUsd.toFixed(2)}` : "$—";
  const name = service.replace(/\s+/g, " ").trim() || "Unknown";
  return `${amount} - ${name} - ${sort}`;
}

export function calendarSortFromExpense(
  kind: string,
  label: string,
  notes?: string,
  explicit?: string | null,
): BillsCalendarSort {
  if (
    explicit === "subscription"
    || explicit === "prepaid"
    || explicit === "usage"
    || explicit === "dev-expense"
  ) {
    return explicit;
  }
  const blob = `${kind} ${label} ${notes ?? ""}`;
  if (/dev-expense|domain|namecheap|unstoppable|developer membership/i.test(blob)) {
    return "dev-expense";
  }
  if (kind === "subscription") return "subscription";
  if (kind === "prepaid") return "prepaid";
  if (kind === "usage") return "usage";
  return "usage";
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

function compactDate(isoDate: string): string {
  return isoDate.replaceAll("-", "");
}

export function renderBillsCalendar(events: BillsCalendarEvent[], stamp = new Date()): string {
  const dtstamp = stamp.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    `PRODID:${BILLS_CALENDAR_PRODID}`,
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
    `X-WR-CALNAME:${icsEscape(BILLS_CALENDAR_NAME)}`,
    "X-WR-TIMEZONE:America/Chicago",
  ];
  for (const event of events) {
    lines.push("BEGIN:VEVENT");
    lines.push(`UID:${icsEscape(event.uid)}`);
    lines.push(`DTSTAMP:${dtstamp}`);
    lines.push(`DTSTART;VALUE=DATE:${compactDate(event.date)}`);
    lines.push(`DTEND;VALUE=DATE:${compactDate(nextDay(event.date))}`);
    lines.push(foldLine(`SUMMARY:${icsEscape(event.summary)}`));
    if (event.description) {
      lines.push(foldLine(`DESCRIPTION:${icsEscape(event.description)}`));
    }
    lines.push("END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.join("\r\n")}\r\n`;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export interface OwnerExpenseRow {
  id: string;
  provider: string;
  service: string | null;
  label: string | null;
  costUsd: number | null;
  occurredAt: Date;
  metadata: unknown;
}

export function eventsFromOwnerExpenseRows(rows: OwnerExpenseRow[]): BillsCalendarEvent[] {
  const events: BillsCalendarEvent[] = [];
  for (const row of rows) {
    const metadata = asRecord(row.metadata);
    const notes = typeof metadata?.notes === "string" ? metadata.notes : undefined;
    const dueDate = typeof metadata?.dueDate === "string" ? metadata.dueDate : null;
    const nextDueDate = typeof metadata?.nextDueDate === "string" ? metadata.nextDueDate : null;
    const sort = calendarSortFromExpense(
      String(row.service ?? ""),
      row.label ?? row.provider,
      notes,
      typeof metadata?.calendarSort === "string" ? metadata.calendarSort : null,
    );
    const amount = typeof row.costUsd === "number" ? row.costUsd : 0;
    const date = row.occurredAt.toISOString().slice(0, 10);
    const description = [
      row.label,
      dueDate ? `Due ${dueDate}.` : null,
      notes,
    ].filter(Boolean).join("  ");
    events.push({
      uid: `${row.id}@usage.jays.services`,
      date,
      summary: calendarTitle(amount, row.provider, sort),
      description,
    });
    if (nextDueDate && metadata?.cancelledNoRenew !== true) {
      events.push({
        uid: `${row.id}-next@usage.jays.services`,
        date: nextDueDate,
        summary: calendarTitle(amount, row.provider, sort),
        description: `Upcoming renewal.  Last charge ${date}.  ${description}`.trim(),
      });
    }
  }
  return events;
}
