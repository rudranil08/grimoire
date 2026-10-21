// Unit tests for the natural-language quick-add parser (public/quickadd.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const ctx = {};
vm.runInNewContext(readFileSync(new URL("../public/quickadd.js", import.meta.url), "utf8"), { globalThis: ctx });
// spread into a main-realm object so deepStrictEqual compares values, not vm prototypes
const parse = (text) => ({ ...ctx.parseQuick(text, new Date(2026, 9, 20)) }); // Tue 20 Oct 2026

test("plain titles pass through untouched", () => {
  assert.deepEqual(parse("Carve the pumpkin"), { title: "Carve the pumpkin" });
  assert.deepEqual(parse("Halloween party prep"), { title: "Halloween party prep" }); // bare 'halloween' is not a date
  assert.deepEqual(parse("Fix #42 bug"), { title: "Fix #42 bug" }); // unknown hashtags stay
});

test("relative dates", () => {
  assert.equal(parse("Buy candy today").due, "2026-10-20");
  assert.equal(parse("Buy candy tomorrow").due, "2026-10-21");
  assert.equal(parse("Buy candy in 3 days").due, "2026-10-23");
  assert.equal(parse("Buy candy in 2 weeks").due, "2026-11-03");
  assert.equal(parse("Plan next week").due, "2026-10-27");
  assert.equal(parse("Call the coven tomorrow").title, "Call the coven");
});

test("weekdays and named dates", () => {
  assert.equal(parse("Séance on friday").due, "2026-10-23");
  assert.equal(parse("Séance tuesday").due, "2026-10-27"); // same weekday → next week
  assert.equal(parse("Costume fitting by halloween").due, "2026-10-31");
  assert.equal(parse("Return the book oct 15").due, "2027-10-15"); // already passed → next year
  assert.equal(parse("Party on 31st October").due, "2026-10-31");
  assert.equal(parse("Taxes feb 31").due, undefined); // impossible date is left alone
});

test("dread, realm and repeat", () => {
  const q = parse("Buy candy tomorrow !scream #errand");
  assert.deepEqual(q, { title: "Buy candy", priority: "scream", tag: "errand", due: "2026-10-21" });
  assert.equal(parse("Thing !!").priority, "howl");
  assert.equal(parse("Thing !h").priority, "howl");
  assert.equal(parse("Report #work").tag, "ledger");
  assert.equal(parse("Water mandrakes every day").repeat, "daily");
  const w = parse("Take out the bones every monday");
  assert.equal(w.repeat, "weekly");
  assert.equal(w.due, "2026-10-26");
  assert.equal(w.title, "Take out the bones");
});

test("input that is only keywords stays a literal title", () => {
  assert.deepEqual(parse("tomorrow"), { title: "tomorrow" });
});
