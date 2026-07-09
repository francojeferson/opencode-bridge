// Smoke tests for opencode.mjs that need NO running daemon: flag parsing, usage
// errors, early --model validation, stdin prompt, and dead-daemon error reporting.
// Run with: npm test
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

const script = join(dirname(fileURLToPath(import.meta.url)), "..", "opencode.mjs")
const DEAD = "http://127.0.0.1:1" // nothing listens on port 1 — refuses fast

function run(args, input) {
  const r = spawnSync(process.execPath, [script, ...args], { input, encoding: "utf8", timeout: 30000 })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

test("--help prints usage, exit 0", () => {
  const r = run(["--help"])
  assert.equal(r.code, 0)
  assert.match(r.out, /^usage: node opencode\.mjs/)
})

test("unknown flag errors with usage, exit 2", () => {
  const r = run(["--teir", "high", "x"])
  assert.equal(r.code, 2)
  const j = JSON.parse(r.out)
  assert.match(j.error, /unknown flag "--teir"/)
  assert.ok(j.usage)
})

test("value flag with missing value errors, exit 2", () => {
  const r = run(["--tier"])
  assert.equal(r.code, 2)
  assert.match(JSON.parse(r.out).error, /--tier requires a value/)
})

test("value flag followed by another flag errors, exit 2", () => {
  const r = run(["--timeout", "--tier", "fast", "x"])
  assert.equal(r.code, 2)
  assert.match(JSON.parse(r.out).error, /--timeout requires a value/)
})

test("no prompt prints usage to stderr, exit 2", () => {
  const r = run([])
  assert.equal(r.code, 2)
  assert.match(r.err, /usage:/)
})

test("flag value never leaks in as the prompt", () => {
  // "--tier high" with no prompt used to send "high" AS the prompt.
  const r = run(["--tier", "high"])
  assert.equal(r.code, 2)
  assert.match(r.err, /usage:/)
})

test("malformed --model errors before any network call, exit 2", () => {
  const r = run(["--server", DEAD, "--model", "no-slash-here", "hi"])
  assert.equal(r.code, 2)
  assert.match(JSON.parse(r.out).error, /Invalid --model/)
})

test("dead daemon: --list-models reports error, exit 1", () => {
  const r = run(["--server", DEAD, "--list-models"])
  assert.equal(r.code, 1)
  assert.ok(JSON.parse(r.out).error)
})

test("dead daemon: --debug-chain reports error, exit 1", () => {
  const r = run(["--server", DEAD, "--tier", "fast", "--debug-chain"])
  assert.equal(r.code, 1)
  assert.ok(JSON.parse(r.out).error)
})

test("prompt '-' reads stdin (network error, not usage error)", () => {
  const r = run(["--server", DEAD, "-"], "hello from stdin")
  assert.equal(r.code, 1) // reached the daemon fetch — stdin prompt was accepted
  assert.ok(JSON.parse(r.out).error)
})

test("empty stdin via '-' is a usage error, exit 2", () => {
  const r = run(["--server", DEAD, "-"], "")
  assert.equal(r.code, 2)
  assert.match(r.err, /usage:/)
})
