// Natural-language quick add: pulls a due date, dread level, realm and repeat out of a typed title.
//   "Buy candy tomorrow !scream #errand"      → due tomorrow, scream, broom
//   "Water the mandrakes every monday"        → weekly, due next Monday
//   "Costume fitting on halloween !!"         → due Oct 31, howl
(function (root) {
  "use strict";

  const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };
  const WD = "(sunday|sun|monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thu|friday|fri|saturday|sat)";
  const FULL_WD = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";
  const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
  const MON = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
  const TAGS = {
    crypt: "crypt", home: "crypt", house: "crypt",
    ledger: "ledger", work: "ledger", job: "ledger",
    cauldron: "cauldron", party: "cauldron", cook: "cauldron",
    coven: "coven", social: "coven", friends: "coven", family: "coven",
    broom: "errand", errand: "errand", errands: "errand", shop: "errand", shopping: "errand",
  };
  const PRIO = { s: "scream", h: "howl", w: "whisper" };

  const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

  function parseQuick(text, now = new Date()) {
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const plus = (n) => new Date(today.getFullYear(), today.getMonth(), today.getDate() + n);
    const upcoming = (name) => {
      const diff = (WEEKDAYS[name.slice(0, 3).toLowerCase()] - today.getDay() + 7) % 7;
      return plus(diff === 0 ? 7 : diff);
    };
    // A month/day with no year means the next time that date comes round.
    const monthDay = (mon, day) => {
      const m = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
      const d = Number(day);
      let date = new Date(today.getFullYear(), m, d);
      if (date.getMonth() !== m) return null; // e.g. "feb 31"
      if (date < today) date = new Date(today.getFullYear() + 1, m, d);
      return date;
    };

    const out = {};
    let s = ` ${text} `;
    // Replaces the first match with a space; the callback may return false to leave it in place.
    const take = (re, fn) => {
      s = s.replace(re, (...m) => (fn(...m) === false ? m[0] : " "));
    };
    const date = (re, fn) => {
      if (out.due) return;
      take(re, (...m) => {
        const d = fn(...m);
        if (!d) return false;
        out.due = iso(d);
      });
    };

    // dread: !scream / !s / !!! (three bangs = scream, two = howl, one = whisper)
    take(/\s!(scream|howl|whisper|s|h|w)(?=\s)/i, (_, p) => { out.priority = PRIO[p[0].toLowerCase()]; });
    if (!out.priority) take(/\s(!{1,3})(?=\s)/, (_, b) => { out.priority = ["whisper", "howl", "scream"][b.length - 1]; });

    // realm: #work, #home, #party …
    take(/\s#([a-z]+)(?=\s)/i, (_, w) => {
      const t = TAGS[w.toLowerCase()];
      if (!t) return false;
      out.tag = t;
    });

    // repeat
    take(new RegExp(`\\severy\\s+${WD}(?=\\s)`, "i"), (_, w) => { out.repeat = "weekly"; out.due = iso(upcoming(w)); });
    if (!out.repeat) take(/\s(?:every\s+(?:day|night)|daily|nightly)(?=\s)/i, () => { out.repeat = "daily"; });
    if (!out.repeat) take(/\s(?:every\s+week|weekly)(?=\s)/i, () => { out.repeat = "weekly"; });
    if (!out.repeat) take(/\s(?:every\s+month|monthly)(?=\s)/i, () => { out.repeat = "monthly"; });

    // due dates
    date(/\s(?:(?:due|by|on)\s+)?(?:today|tonight)(?=\s)/i, () => today);
    date(/\s(?:(?:due|by|on)\s+)?(?:tomorrow|tmrw|tmr)(?=\s)/i, () => plus(1));
    date(/\s(?:on|by|before|until|for)\s+halloween(?=\s)/i, () => monthDay("oct", 31));
    date(/\sin\s+(\d{1,3})\s+(days?|weeks?)(?=\s)/i, (_, n, unit) => plus(Number(n) * (unit[0].toLowerCase() === "w" ? 7 : 1)));
    date(/\snext\s+week(?=\s)/i, () => plus(7));
    date(new RegExp(`\\s(?:on|by|due|next|this)\\s+${WD}(?=\\s)`, "i"), (_, w) => upcoming(w));
    date(new RegExp(`\\s${FULL_WD}\\s*$`, "i"), (_, w) => upcoming(w)); // bare weekday only at the very end
    date(new RegExp(`\\s(?:(?:on|by|due)\\s+)?${MON}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?=\\s)`, "i"), (_, m, d) => monthDay(m, d));
    date(new RegExp(`\\s(?:(?:on|by|due)\\s+)?(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MON}(?=\\s)`, "i"), (_, d, m) => monthDay(m, d));

    const title = s.replace(/\s+/g, " ").trim();
    // If everything was "parsed away", treat the input as a literal title instead.
    if (!title) return { title: text.trim() };
    return { title, ...out };
  }

  root.parseQuick = parseQuick;
})(typeof window !== "undefined" ? window : globalThis);
