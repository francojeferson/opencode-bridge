#!/usr/bin/env node
// opencode.mjs — drive a running opencode daemon from Claude Code.
//
// Prereq (persistent daemon):   opencode serve --port 4096
//
// Usage:
//   node opencode.mjs "refactor auth.ts to async"
//   node opencode.mjs --session ses_abc "now add tests"       # resume
//   node opencode.mjs --model provider/model-id "hi"          # explicit model (no fallback)
//   node opencode.mjs --tier high "complex architecture task" # pick best in tier
//   node opencode.mjs --no-tools "just answer, run no tools"  # text-only
//   node opencode.mjs --list-models                           # show available models + tiers
//
// Emits ONE JSON object to stdout: { sessionID, reply, model, cost, tokens, fallbacks }
//
// Model resolution: --model > --tier > daemon default.
// On empty reply: falls back through tier candidates until one responds.

import { createOpencodeClient } from "@opencode-ai/sdk"

// Tier rankings: patterns matched against model IDs, first match wins within tier.
// Order within each tier = preference (best first).
const TIER_RANKS = {
  high: [
    /opus-4-7/, /opus-4-6/, /opus-4-5/,
    /gpt-5\.5/, /gpt-5\.4(?!-(mini|nano))/, /gpt-5\.2(?!-codex)/,
    /kimi-k2\.5/, /kimi-k2-thinking/,
    /nemotron-super.*120b/,
  ],
  code: [
    /gpt-5\.2-codex/,
    /gpt-5\.4(?!-(mini|nano))/, /gpt-5\.5/,
    /opus-4-7/, /opus-4-6/,
    /qwen.*coder/,
  ],
  mid: [
    /sonnet-4-6/, /sonnet-4-5/, /sonnet-4/,
    /gpt-5\.4-mini/, /gpt-5-mini/,
    /gpt-4\.1(?!-(mini|nano))/,
    /maverick/, /nova-pro/,
  ],
  fast: [
    /gpt-5\.4-nano/, /gpt-4\.1-nano/,
    /haiku-4-5/,
    /gpt-4\.1-mini/, /gpt-5\.4-mini/,
    /nova-lite/, /scout/,
  ],
}

const argv = process.argv.slice(2)
const opt = (flag, def) => {
  const i = argv.indexOf(flag)
  if (i === -1) return def
  return argv[i + 1]?.startsWith("--") || i + 1 >= argv.length ? true : argv[i + 1]
}
const baseUrl = opt("--server", "http://127.0.0.1:4096")
const modelStr = opt("--model", null)
const tierStr = opt("--tier", null)
const session = opt("--session", null)
const agent = opt("--agent", "build")
const noTools = argv.includes("--no-tools")
const listModels = argv.includes("--list-models")

async function fetchProviderConfig() {
  const res = await fetch(`${baseUrl}/config/providers`)
  return res.json()
}

function getAllModelIds(config) {
  const models = []
  for (const p of config.providers ?? []) {
    for (const m of Object.keys(p.models ?? {})) {
      models.push({ providerID: p.id, modelID: m, full: `${p.id}/${m}` })
    }
  }
  return models
}

function pickAllByTier(tier, models) {
  const patterns = TIER_RANKS[tier]
  if (!patterns) throw new Error(`Unknown tier "${tier}". Available: ${Object.keys(TIER_RANKS).join(", ")}`)
  const picks = []
  const seen = new Set()
  for (const pat of patterns) {
    const match = models.find(m => pat.test(m.modelID) && !seen.has(m.full))
    if (match) { picks.push(match); seen.add(match.full) }
  }
  return picks
}

function buildFallbackChain(config) {
  const models = getAllModelIds(config)
  const defaults = config.default ?? {}
  const providerID = Object.keys(defaults)[0]
  const defaultModelID = defaults[providerID]

  const chain = []
  const seen = new Set()

  // Start with daemon default
  if (providerID && defaultModelID) {
    chain.push({ providerID, modelID: defaultModelID })
    seen.add(`${providerID}/${defaultModelID}`)
  }

  // Then tier "high" candidates as fallbacks
  for (const m of pickAllByTier("high", models)) {
    if (!seen.has(m.full)) { chain.push({ providerID: m.providerID, modelID: m.modelID }); seen.add(m.full) }
  }
  // Then "mid"
  for (const m of pickAllByTier("mid", models)) {
    if (!seen.has(m.full)) { chain.push({ providerID: m.providerID, modelID: m.modelID }); seen.add(m.full) }
  }
  // Then "fast"
  for (const m of pickAllByTier("fast", models)) {
    if (!seen.has(m.full)) { chain.push({ providerID: m.providerID, modelID: m.modelID }); seen.add(m.full) }
  }
  return chain
}

function buildTierFallbackChain(tier, config) {
  const models = getAllModelIds(config)
  const picks = pickAllByTier(tier, models)
  if (!picks.length) throw new Error(`No model matched tier "${tier}" from available models`)
  return picks.map(m => ({ providerID: m.providerID, modelID: m.modelID }))
}

if (listModels) {
  try {
    const config = await fetchProviderConfig()
    const models = getAllModelIds(config)
    const defaults = config.default ?? {}
    const tiers = {}
    for (const [tier] of Object.entries(TIER_RANKS)) {
      tiers[tier] = pickAllByTier(tier, models).map(m => m.full)
    }
    console.log(JSON.stringify({ defaults, tiers, all: models.map(m => m.full) }, null, 2))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message ?? String(e) }))
    process.exit(1)
  }
  process.exit(0)
}

const text = argv.filter((a, i) => !a.startsWith("--") && !argv[i - 1]?.startsWith("--")).join(" ")
  || argv.filter((a) => !a.startsWith("--")).at(-1)

if (!text) {
  console.error('usage: node opencode.mjs [--model p/m] [--tier high|code|mid|fast] [--session id] [--agent a] [--no-tools] [--list-models] "prompt"')
  process.exit(2)
}

const client = createOpencodeClient({ baseUrl })
const unwrap = (r) => r?.data ?? r

async function sendPrompt(model, sessionId) {
  let id = sessionId
  if (!id) {
    const created = unwrap(await client.session.create({
      body: { agent, model: { providerID: model.providerID, id: model.modelID } },
    }))
    id = created.id
  }

  const body = { agent, model, parts: [{ type: "text", text }] }
  if (noTools) body.tools = { bash: false, edit: false, write: false, read: false, glob: false, grep: false }
  const res = unwrap(await client.session.prompt({ path: { id }, body }))

  const parts = res.parts ?? []
  let reply = parts.filter((p) => p.type === "text").map((p) => p.text).join("").trim()

  if (!reply) {
    const msgs = unwrap(await client.session.messages({ path: { id } }))
    const last = [...msgs].reverse().find((m) => m.info?.role === "assistant")
    reply = (last?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim()
  }

  return { id, reply, info: res.info ?? {} }
}

try {
  // Explicit --model: no fallback, use as-is
  if (modelStr) {
    const slash = modelStr.indexOf("/")
    const model = { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) }
    const { id, reply, info } = await sendPrompt(model, session)
    console.log(JSON.stringify({ sessionID: id, reply, model: modelStr, cost: info.cost, tokens: info.tokens }, null, 2))
    process.exit(0)
  }

  // Build fallback chain
  const config = await fetchProviderConfig()
  const chain = tierStr ? buildTierFallbackChain(tierStr, config) : buildFallbackChain(config)

  const tried = []
  for (const model of chain) {
    const modelFull = `${model.providerID}/${model.modelID}`
    const { id, reply, info } = await sendPrompt(model, null)
    if (reply) {
      console.log(JSON.stringify({
        sessionID: id,
        reply,
        model: modelFull,
        cost: info.cost,
        tokens: info.tokens,
        ...(tried.length ? { fallbacks: tried } : {}),
      }, null, 2))
      process.exit(0)
    }
    tried.push(modelFull)
  }

  // All models returned empty
  console.log(JSON.stringify({ error: "All models returned empty", tried }, null, 2))
  process.exit(1)
} catch (e) {
  console.log(JSON.stringify({ error: e.message ?? String(e) }))
  process.exit(1)
}
