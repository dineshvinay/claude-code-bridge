import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("server.mjs is valid, loopback-only, and token-gated", () => {
  const src = readFileSync(join(root, "server.mjs"), "utf8");
  // Never bind to anything but loopback.
  assert.ok(/const HOST = "127\.0\.0\.1"/.test(src), "must bind 127.0.0.1 only");
  assert.ok(!/0\.0\.0\.0/.test(src), "must not bind 0.0.0.0");
  // Must gate on a token + origin allowlist.
  assert.ok(/token !== TOKEN/.test(src), "must reject bad tokens");
  assert.ok(/ALLOWED_ORIGINS/.test(src), "must check an origin allowlist");
  // The three capabilities are present.
  for (const cap of ['case "start"', 'case "ask"', 'case "ask-image"']) {
    assert.ok(src.includes(cap), `missing handler: ${cap}`);
  }
});

test("package.json exposes start + token scripts", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.name, "claude-code-bridge");
  assert.ok(pkg.scripts.start && pkg.scripts.token, "start + token scripts required");
});
