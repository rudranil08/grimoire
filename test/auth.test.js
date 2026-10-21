// Unit tests for server/auth.js helpers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hashPassword, verifyPassword, readCookie, rateLimiter, sessionCookie } from "../server/auth.js";

test("password hashes verify only with the right password and are salted", async () => {
  const a = await hashPassword("graveyard shift");
  const b = await hashPassword("graveyard shift");
  assert.notEqual(a, b);
  assert.ok(await verifyPassword("graveyard shift", a));
  assert.ok(!(await verifyPassword("graveyard shifT", a)));
  assert.ok(!(await verifyPassword("anything", "garbage")));
});

test("rate limiter blocks after the limit within the window", () => {
  const allow = rateLimiter(3, 60_000);
  assert.deepEqual([allow("ip"), allow("ip"), allow("ip"), allow("ip")], [true, true, true, false]);
  assert.ok(allow("other-ip"));
});

test("cookies parse and are set HttpOnly + SameSite", () => {
  assert.equal(readCookie({ headers: { cookie: "a=1; grimoire_session=abc%20def; b=2" } }), "abc def");
  assert.equal(readCookie({ headers: {} }), null);
  assert.match(sessionCookie("t", 60, true), /HttpOnly; SameSite=Lax; Path=\/; Max-Age=60; Secure/);
});
