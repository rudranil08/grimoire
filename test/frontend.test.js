// Static checks for the browser code: every element id the scripts look up exists in the HTML,
// and every script parses. Catches "null.addEventListener" style breakage without a browser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const pub = new URL("../public/", import.meta.url);
const read = (f) => readFileSync(new URL(f, pub), "utf8");

test("every #id used by app.js exists in app.html", () => {
  const html = read("app.html");
  const js = read("app.js");
  const ids = new Set();
  for (const m of js.matchAll(/\$\(\s*["'`]#([\w-]+)["'`]\s*\)/g)) ids.add(m[1]);
  for (const m of js.matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g)) ids.add(m[1]);
  const missing = [...ids].filter((id) => !new RegExp(`id="${id}"`).test(html));
  assert.deepEqual(missing, [], `ids referenced in app.js but missing from index.html: ${missing.join(", ")}`);
});

test("every #id used by share.js exists in share.html", () => {
  const html = read("share.html");
  const ids = [...read("share.js").matchAll(/getElementById\(\s*["'`]([\w-]+)["'`]\s*\)/g)].map((m) => m[1]);
  assert.deepEqual(ids.filter((id) => !html.includes(`id="${id}"`)), []);
});

test("all browser scripts parse", () => {
  for (const f of readdirSync(pub).filter((f) => f.endsWith(".js"))) {
    execFileSync(process.execPath, ["--check", fileURLToPath(new URL(f, pub))]); // throws on a syntax error
  }
});

test("html pages only load same-origin scripts (CSP: script-src 'self')", () => {
  for (const page of ["index.html", "app.html", "auth.html", "share.html", "privacy.html"]) {
    const srcs = [...read(page).matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
    assert.ok(srcs.length > 0);
    for (const src of srcs) assert.ok(!/^https?:/.test(src), `${page} loads external script ${src}`);
    assert.ok(!/<script(?![^>]*\ssrc=)[^>]*>\s*\S/.test(read(page)), `${page} has an inline script`);
  }
});

test("every #id used by auth.js exists in auth.html", () => {
  const html = read("auth.html");
  const ids = [...read("auth.js").matchAll(/\$\(\s*["'`]([\w-]+)["'`]\s*\)/g)].map((m) => m[1]);
  assert.ok(ids.length > 5);
  assert.deepEqual(ids.filter((id) => !html.includes(`id="${id}"`)), []);
});
