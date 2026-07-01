#!/usr/bin/env node
// opencode.mjs — structured bridge: Claude Code <-> running opencode daemon
//
// Prereq (persistent daemon):   opencode serve --port 4096
//
// Usage:
//   node opencode.mjs "refactor auth.ts to async"
//   node opencode.mjs --session ses_abc "now add tests"          # resume
//   node opencode.mjs --model openrouter/google/gemma-4-31b-it:free "hi"
//   node opencode.mjs --no-tools "just answer, run no tools"      # text-only
//
// Emits ONE JSON object to stdout: { sessionID, reply, cost, tokens, messages }
// Why SDK over raw curl: SDK hits /session/{id}/prompt_async which DRIVES the
// turn and returns the assistant message. Raw /api/session/{id}/prompt only
// admits a queued message and never executes.

import { createOpencodeClient } from "@opencode-ai/sdk"

const argv = process.argv.slice(2)
const opt = (flag, def) => {
  const i = argv.indexOf(flag)
  if (i === -1) return def
  return argv[i + 1]?.startsWith("--") || i + 1 >= argv.length ? true : argv[i + 1]
}
const baseUrl = opt("--server", "http://127.0.0.1:4096")
const modelStr = opt("--model", null)
const session = opt("--session", null)
const agent = opt("--agent", "build")
const noTools = argv.includes("--no-tools")
const text = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).join(" ")
  || argv.filter((a) => !a.startsWith("--")).at(-1)

if (!text) {
  console.error("usage: node opencode.mjs [--session id] [--model p/m] [--agent a] [--no-tools] \"prompt\"")
  process.exit(2)
}

// model string "providerID/modelID..." -> first segment is provider, rest is model id
const model = modelStr
  ? (() => { const slash = modelStr.indexOf("/"); return { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) } })()
  : undefined

const client = createOpencodeClient({ baseUrl })
const unwrap = (r) => r?.data ?? r

try {
  // resume existing session or create new
  let id = session
  if (!id) {
    const createBody = { agent }
    if (model) createBody.model = { providerID: model.providerID, id: model.modelID }
    const created = unwrap(await client.session.create({ body: createBody }))
    id = created.id
  }

  // prompt_async drives the turn and returns the assistant message
  const body = { agent, parts: [{ type: "text", text }] }
  if (model) body.model = model
  if (noTools) body.tools = { bash: false, edit: false, write: false, read: false, glob: false, grep: false }
  const res = unwrap(await client.session.prompt({ path: { id }, body }))

  const parts = res.parts ?? []
  let reply = parts.filter((p) => p.type === "text").map((p) => p.text).join("").trim()

  // fallback: pull last assistant message if prompt return lacked text
  if (!reply) {
    const msgs = unwrap(await client.session.messages({ path: { id } }))
    const last = [...msgs].reverse().find((m) => m.info?.role === "assistant")
    reply = (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim()
  }

  const info = res.info ?? {}
  console.log(JSON.stringify({ sessionID: id, reply, cost: info.cost, tokens: info.tokens }, null, 2))
} catch (e) {
  console.log(JSON.stringify({ error: e.message ?? String(e) }))
  process.exit(1)
}
