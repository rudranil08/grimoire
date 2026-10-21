// iCalendar (RFC 5545) feed of unfinished, dated tasks as all-day events.
const RRULE = { daily: "FREQ=DAILY", weekly: "FREQ=WEEKLY", monthly: "FREQ=MONTHLY" };
const PRIORITY = { scream: 1, howl: 5, whisper: 9 }; // iCal: 1 = highest

// Escape TEXT values: backslash, semicolon, comma and newlines.
const esc = (s) => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");

// Fold lines longer than 75 octets (continuation lines start with a space).
function fold(line) {
  const bytes = Buffer.from(line, "utf8");
  if (bytes.length <= 75) return line;
  const parts = [];
  let start = 0;
  while (start < bytes.length) {
    let end = Math.min(start + (start === 0 ? 75 : 74), bytes.length);
    while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--; // don't split a UTF-8 sequence
    parts.push(bytes.subarray(start, end).toString("utf8"));
    start = end;
  }
  return parts.join("\r\n ");
}

const ymd = (iso) => iso.replaceAll("-", "");
const nextDay = (iso) => { const d = new Date(iso + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); };
const stamp = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");

export function toIcs(tasks, now = Date.now()) {
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Grimoire//Haunted Task Ledger//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:Grimoire 🎃", "X-PUBLISHED-TTL:PT1H",
  ];
  for (const t of tasks) {
    if (t.done || !t.due) continue;
    const desc = [t.notes, ...(t.subtasks ?? []).map((s) => `${s.done ? "☑" : "☐"} ${s.text}`)].filter(Boolean).join("\n");
    lines.push(
      "BEGIN:VEVENT",
      `UID:${t.id}@grimoire`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${ymd(t.due)}`,
      `DTEND;VALUE=DATE:${ymd(nextDay(t.due))}`,
      `SUMMARY:${esc(t.title)}`,
      `PRIORITY:${PRIORITY[t.priority] ?? 0}`,
      `CATEGORIES:${esc(t.tag)}`,
      ...(desc ? [`DESCRIPTION:${esc(desc)}`] : []),
      ...(t.repeat && RRULE[t.repeat] ? [`RRULE:${RRULE[t.repeat]}`] : []),
      "TRANSP:TRANSPARENT",
      "END:VEVENT",
    );
  }
  lines.push("END:VCALENDAR");
  return lines.map(fold).join("\r\n") + "\r\n";
}
