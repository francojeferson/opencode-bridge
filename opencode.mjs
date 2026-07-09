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
//   type prompt.txt | node opencode.mjs --tier code -         # prompt "-" reads stdin (long prompts)
//
// Emits ONE JSON object to stdout: { sessionID, reply, model, cost, tokens, fallbacks }
//
// Model resolution: --model > --tier > daemon default.
// On empty reply: falls back through tier candidates until one responds.

import { createOpencodeClient } from "@opencode-ai/sdk"

// Tier rankings: each entry is a capability RUNG matched against model IDs across ALL
// providers. Rung order = quality (best first); within a rung, betterFirst() sorts
// quality-first (cost only breaks exact ties). These regexes are a QUALITY PRIOR, not a
// requirement — an environment whose catalog matches none of them still resolves via the
// metadata-ranked safety net (see appendSafetyNet), so the bridge stays environment- and
// provider-agnostic. A dead provider's entries are skipped at runtime and the ladder
// continues to the best working model instead of dead-ending on one provider.
const TIER_RANKS = {
  high: [
    /opus-4-8/, /opus-4-7/, /opus-4-6/,
    /gpt-5\.5/, /gpt-5\.4(?!-(mini|nano))/, /gpt-5\.2(?!-codex)/,
    /kimi-k2\.5/, /kimi-k2-thinking/, /kimi-k2\.6/,
    /nemotron-3-ultra/,                       // opencode zen (free) + openrouter 550b
    /nemotron-3-120b/, /gpt-oss-120b/,        // cloudflare big
    /glm-5\.2/,                               // cloudflare
    /deepseek-v4/, /big-pickle/,              // opencode zen (free)
  ],
  code: [
    /gpt-5\.2-codex/, /gpt-5\.4(?!-(mini|nano))/, /gpt-5\.5/,
    /opus-4-8/, /opus-4-7/,
    /north-mini-code/,                        // opencode zen (free)
    /kimi-k2\.7-code/,                        // cloudflare
    /qwen.*coder/,                            // openrouter + cloudflare qwen2.5-coder
    /deepseek-r1-distill/,                    // cloudflare
    /big-pickle/,
  ],
  mid: [
    /sonnet-5/, /sonnet-4-6/, /sonnet-4-5/, /sonnet-4/,
    /gpt-5\.4-mini/, /gpt-5-mini/, /gpt-4\.1(?!-(mini|nano))/,
    /llama-3\.3-70b/, /qwen3-30b/,            // cloudflare + openrouter
    /mimo-v2\.5/, /big-pickle/,               // opencode zen (free)
    /maverick/, /nova-pro/,
  ],
  fast: [
    /mimo-v2\.5-free/,                        // opencode zen (free), first
    /gpt-5\.4-nano/, /gpt-4\.1-nano/,
    /haiku-4-5/,
    /llama-3\.2-3b/, /llama-3\.2-1b/,         // cloudflare tiny
    /gpt-4\.1-mini/, /gpt-5\.4-mini/,
    /nova-lite/, /scout/,
  ],
}

const argv = process.argv.slice(2)

// Explicit flag tables: value flags consume the next token, boolean flags stand alone.
// Anything else starting with "--" is a hard error (catches typos like --teir), and a
// value flag with a missing value errors instead of silently misparsing (--timeout
// followed by another flag used to become Number(true)=1 — a 1ms abort budget — and
// "--tier high" with no prompt used to send "high" AS the prompt).
const VALUE_FLAGS = new Set(["--server", "--model", "--tier", "--session", "--agent", "--timeout"])
const BOOL_FLAGS = new Set(["--no-tools", "--list-models", "--debug-chain", "--help"])
const flags = {}
const positional = []
let argError = null
for (let i = 0; i < argv.length; i++) {
  const a = argv[i]
  if (VALUE_FLAGS.has(a)) {
    const v = argv[i + 1]
    if (v === undefined || v.startsWith("--")) { argError = `${a} requires a value`; break }
    flags[a] = v; i++
  } else if (BOOL_FLAGS.has(a)) {
    flags[a] = true
  } else if (a.startsWith("--")) {
    argError = `unknown flag "${a}"`; break
  } else {
    positional.push(a)
  }
}

const baseUrl = flags["--server"] ?? "http://127.0.0.1:4096"
const modelStr = flags["--model"] ?? null
const tierStr = flags["--tier"] ?? null
const session = flags["--session"] ?? null
const agent = flags["--agent"] ?? "build"
const noTools = !!flags["--no-tools"]
const listModels = !!flags["--list-models"]
const debugChain = !!flags["--debug-chain"]
const timeoutArg = Number(flags["--timeout"])
const callTimeout = timeoutArg > 0 ? timeoutArg : 60000  // per-attempt ms; abort a hung model

async function fetchProviderConfig() {
  // Own abort budget: a hung (not down) daemon would otherwise stall this fetch forever.
  const res = await fetch(`${baseUrl}/config/providers`, { signal: AbortSignal.timeout(10000) })
  if (!res.ok) throw new Error(`GET /config/providers -> ${res.status} ${res.statusText}`)
  return res.json()
}

function getAllModelIds(config) {
  const models = []
  for (const p of config.providers ?? []) {
    for (const [m, meta] of Object.entries(p.models ?? {})) {
      models.push({
        providerID: p.id,
        modelID: m,
        full: `${p.id}/${m}`,
        cost: meta?.cost ?? null,          // { input, output } in $/M tokens; 0 = free
        caps: meta?.capabilities ?? null,  // { input:{text,...}, output:{text,image,...}, reasoning, toolcall }
        status: meta?.status ?? "active",
        context: meta?.limit?.context ?? 0,
        outLimit: meta?.limit?.output ?? 0,
      })
    }
  }
  return models
}

// Keep only models usable for a text turn: active, take text in, emit text out,
// and NOT a media generator. Image/audio/video-output models (e.g. the daemon's
// gemini-*-image default) advertise output.text=true yet return empty/degraded
// text, so exclude anything that also generates media. Missing metadata => keep.
function isTextModel(m) {
  if (m.status && m.status !== "active") return false
  const c = m.caps
  if (!c) return true
  if (c.input?.text === false) return false
  if (c.output?.text === false) return false
  if (c.output?.image === true || c.output?.audio === true || c.output?.video === true) return false
  return true
}

// Provider-agnostic capability proxy derived purely from metadata (no model names,
// no provider names): larger context + reasoning + toolcall + output room = more
// capable; price is a mild positive nudge (flagships tend to cost more). Used to rank
// models when no curated tier prior matches (unknown environments), and to break ties
// WITHIN a tier rung (quality-first). Reads only fields any opencode provider exposes.
function powerScore(m) {
  let s = 0
  s += Math.log10((m.context ?? 0) + 1) * 2
  s += Math.log10((m.outLimit ?? 0) + 1)
  if (m.caps?.reasoning) s += 3
  if (m.caps?.toolcall) s += 1
  s += Math.log10((m.cost?.output ?? 0) + 1)
  return s
}

// Quality-first ordering: higher powerScore first. Cost is only the FINAL tiebreak, so
// among genuinely-equivalent models (e.g. the same model served by two providers) the
// cheaper one wins — but a better model is never demoted for being pricier.
function betterFirst(a, b) {
  const d = powerScore(b) - powerScore(a)
  if (Math.abs(d) > 1e-9) return d
  return (a.cost?.output ?? Infinity) - (b.cost?.output ?? Infinity)
}

function pickAllByTier(tier, models) {
  const patterns = TIER_RANKS[tier]
  if (!patterns) throw new Error(`Unknown tier "${tier}". Available: ${Object.keys(TIER_RANKS).join(", ")}`)
  const pool = models.filter(isTextModel)
  const picks = []
  const seen = new Set()
  for (const pat of patterns) {
    const matches = pool.filter(m => pat.test(m.modelID) && !seen.has(m.full)).sort(betterFirst)
    for (const m of matches) { picks.push(m); seen.add(m.full) }
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

  // Start with daemon default — but only if it's a usable text model. The daemon's
  // first default is often an image model (returns empty text); skip it and let the
  // high tier lead instead.
  if (providerID && defaultModelID) {
    const full = `${providerID}/${defaultModelID}`
    const meta = models.find(m => m.full === full)
    if (meta && isTextModel(meta)) { chain.push({ providerID, modelID: defaultModelID }); seen.add(full) }
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
  // pickAllByTier throws only on an unknown tier NAME. An empty result (valid tier, but
  // no model in this environment matches the curated prior) is fine — appendSafetyNet
  // fills the chain from the metadata ranking, keeping the bridge environment-agnostic.
  return pickAllByTier(tier, models).map(m => ({ providerID: m.providerID, modelID: m.modelID }))
}

// Provider-agnostic tail: append EVERY remaining usable text model, ranked best-first by
// metadata (powerScore). Hardcodes no provider name, so it works in any environment — and
// guarantees a working model is reachable even when the catalog matches none of the
// curated tier priors (in that case this ranking IS the whole chain). A dead provider is
// still skipped at runtime, so the ladder walks down to the best model that answers.
function appendSafetyNet(chain, config) {
  const seen = new Set(chain.map(m => `${m.providerID}/${m.modelID}`))
  const out = [...chain]
  for (const m of getAllModelIds(config).filter(isTextModel).sort(betterFirst)) {
    if (!seen.has(m.full)) { out.push({ providerID: m.providerID, modelID: m.modelID }); seen.add(m.full) }
  }
  return out
}

// Levenshtein edit distance — used to suggest near matches for a mistyped --model id
// (substring matching alone misses single-char typos like "big-pikle" vs "big-pickle").
function editDistance(a, b) {
  const m = a.length, n = b.length
  if (!m) return n
  if (!n) return m
  let prev = Array.from({ length: n + 1 }, (_, i) => i)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    prev = cur
  }
  return prev[n]
}

// A provider-wide failure (insufficient credits, auth) means every other model
// from that provider will fail the same way — skip them instead of hammering each.
function isProviderDead(error) {
  const code = error?.data?.statusCode
  if (code === 402 || code === 401 || code === 403) return true
  return /insufficient credits|unauthorized|forbidden/i.test(error?.data?.message ?? "")
}

// Both diagnostic modes exit via process.exitCode + drain, same as main() — see the
// comment above main() for why process.exit() is never called.
async function runListModels() {
  try {
    const config = await fetchProviderConfig()
    const models = getAllModelIds(config)
    const defaults = config.default ?? {}
    const tiers = {}
    for (const tier of Object.keys(TIER_RANKS)) {
      tiers[tier] = pickAllByTier(tier, models).map(m => ({ model: m.full, out: m.cost?.output ?? null, pw: +powerScore(m).toFixed(2) }))
    }
    console.log(JSON.stringify({ defaults, tiers, all: models.map(m => m.full) }, null, 2))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message ?? String(e) }))
    process.exitCode = 1
  }
}

// Print the resolved fallback chain (no model calls) for --tier / no-flag. Useful for
// verifying ordering and confirming the chain resolves in a given environment.
async function runDebugChain() {
  try {
    const config = await fetchProviderConfig()
    const chain = appendSafetyNet(tierStr ? buildTierFallbackChain(tierStr, config) : buildFallbackChain(config), config)
    console.log(JSON.stringify(chain.map(m => `${m.providerID}/${m.modelID}`), null, 2))
  } catch (e) {
    console.log(JSON.stringify({ error: e.message ?? String(e) }))
    process.exitCode = 1
  }
}

const USAGE = 'usage: node opencode.mjs [--server url] [--model p/m] [--tier high|code|mid|fast] [--session id] [--agent a] [--no-tools] [--timeout ms] [--list-models] [--debug-chain] [--help] "prompt" (or "-" to read the prompt from stdin)'

// Prompt = all non-flag tokens. A lone "-" reads the prompt from stdin instead —
// Windows command lines cap near 8K chars, so piping is the only way to hand over a
// long prompt (e.g. a file to review) without hitting the cap or shell-quoting hazards.
let text = null
async function readStdin() {
  process.stdin.setEncoding("utf8")
  let buf = ""
  for await (const chunk of process.stdin) buf += chunk
  return buf
}

const client = createOpencodeClient({ baseUrl })
const unwrap = (r) => r?.data ?? r

// Sessions created by THIS run. Failed fallback attempts would otherwise pile up orphan
// sessions in the daemon; main() deletes every created-but-unused one on the way out.
// A caller-supplied --session id is never added here, so it is never deleted.
const createdSessions = new Set()

async function sendPrompt(model, sessionId) {
  // Per-attempt timeout budget. The SDK honors `signal`, so a hung upstream (some provider
  // models never respond) is truly ABORTED — the socket closes and the chain moves on,
  // instead of blocking forever. Budget spans create+prompt+messages for this attempt.
  const signal = AbortSignal.timeout(callTimeout)
  let id = sessionId
  if (!id) {
    // Create body takes only {parentID, title} — agent/model bind per-prompt below.
    const created = unwrap(await client.session.create({ signal }))
    id = created.id
    createdSessions.add(id)
  }

  const body = { agent, model, parts: [{ type: "text", text }] }
  // Disable every built-in tool; "*" additionally covers the rest where the daemon
  // supports wildcard keys (unknown keys are ignored, so it is safe either way).
  if (noTools) body.tools = { "*": false, bash: false, edit: false, write: false, read: false, glob: false, grep: false, list: false, patch: false, todowrite: false, todoread: false, webfetch: false, task: false }
  const res = unwrap(await client.session.prompt({ path: { id }, body, signal }))

  const parts = res.parts ?? []
  let reply = parts.filter((p) => p.type === "text").map((p) => p.text).join("").trim()

  if (!reply) {
    // Recover parts by THIS turn's assistant message id. Taking the last assistant
    // message instead would resurface a PREVIOUS turn's reply on a resumed session,
    // faking a success for a model that answered nothing.
    const msgs = unwrap(await client.session.messages({ path: { id }, signal }))
    const mine = msgs.find((m) => m.info?.id && m.info.id === res.info?.id)
    reply = (mine?.parts ?? []).filter((p) => p.type === "text").map((p) => p.text).join("").trim()
  }

  return { id, reply, info: res.info ?? {}, error: res.info?.error ?? null }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// A RESUMED session can't be thrown away like a fresh one: a failed attempt leaves its
// user message (and any partial turn) behind, so the next chain model would see a
// duplicate unanswered question. Best-effort undo: abort anything still running server-
// side (a client-side timeout doesn't stop the turn), then revert the session to the
// message that was its tip before the attempt. Failures here are swallowed — hygiene
// must never mask the real outcome.
async function revertToTip(sessionId, tipId) {
  if (!tipId) return
  try {
    await client.session.abort({ path: { id: sessionId }, signal: AbortSignal.timeout(5000) }).catch(() => {})
    const msgs = unwrap(await client.session.messages({ path: { id: sessionId }, signal: AbortSignal.timeout(5000) }))
    const idx = msgs.findIndex((m) => m.info?.id === tipId)
    const firstNew = idx >= 0 ? msgs[idx + 1]?.info?.id : null
    if (firstNew) await client.session.revert({ path: { id: sessionId }, body: { messageID: firstNew }, signal: AbortSignal.timeout(5000) })
  } catch { /* best-effort */ }
}

// Tip of a resumed session before any attempt runs; null for fresh sessions (they are
// deleted outright on failure) or when the lookup fails (revert becomes a no-op).
async function resumeTip(sessionId) {
  if (!sessionId) return null
  try {
    const msgs = unwrap(await client.session.messages({ path: { id: sessionId }, signal: AbortSignal.timeout(callTimeout) }))
    return msgs.at(-1)?.info?.id ?? null
  } catch { return null }
}

// Retry ONLY transient thrown errors (network/fetch blips, SDK errors) with a brief
// backoff. Does NOT retry a 402/empty reply (deterministic — the fallback chain handles
// those) nor a timeout/abort (the model is hung; retrying just wastes another timeout —
// abandon it and let the chain move to the next model).
function isTimeout(e) {
  return e?.name === "TimeoutError" || e?.name === "AbortError" || /abort|timed?\s*out/i.test(e?.message ?? "")
}
async function attemptPrompt(model, sessionId, attempts = 2) {
  let lastErr
  for (let i = 0; i < attempts; i++) {
    try {
      return await sendPrompt(model, sessionId)
    } catch (e) {
      lastErr = e
      if (isTimeout(e)) break
      if (i < attempts - 1) await sleep(300 * (i + 1))
    }
  }
  throw lastErr
}

// Exit via process.exitCode + natural event-loop drain, never process.exit(): calling
// process.exit() while the SDK's undici sockets are mid-close aborts libuv on Windows
// ("Assertion failed: !(handle->flags & UV_HANDLE_CLOSING) ... win/async.c"). Draining the
// loop exits cleanly with the right code (localhost sockets close promptly — no hang).
async function main() {
  let keepId = null
  try {
    text = positional.join(" ")
    if (text === "-") text = (await readStdin()).trim()
    if (!text) {
      console.error(USAGE)
      process.exitCode = 2
      return
    }

    // Explicit --model: no fallback, but retry transient throws (no other model to fall to).
    if (modelStr) {
      const slash = modelStr.indexOf("/")
      if (slash < 1 || slash === modelStr.length - 1) {
        console.log(JSON.stringify({ error: `Invalid --model "${modelStr}": expected providerID/modelID` }, null, 2))
        process.exitCode = 2; return
      }
      const model = { providerID: modelStr.slice(0, slash), modelID: modelStr.slice(slash + 1) }

      // Validate up front against the environment's catalog. session.create does NOT
      // validate the id — a typo yields an empty reply, not an error — so catch it here
      // before spending a call, and suggest near matches. Match on the full "provider/id"
      // string (robust even when modelID itself contains slashes, e.g. @cf/openai/...).
      const allModels = getAllModelIds(await fetchProviderConfig())
      if (!allModels.some(m => m.full === modelStr)) {
        const needle = model.modelID.toLowerCase()
        const thresh = Math.max(3, Math.ceil(needle.length * 0.4))
        const near = allModels
          .map(m => {
            const id = m.modelID.toLowerCase()
            const sub = id.includes(needle) || needle.includes(id)
            return { full: m.full, d: sub ? 0 : editDistance(needle, id) }
          })
          .filter(s => s.d <= thresh)
          .sort((a, b) => a.d - b.d)
          .slice(0, 6)
          .map(s => s.full)
        console.log(JSON.stringify({ error: `Unknown model "${modelStr}"`, ...(near.length ? { didYouMean: near } : { hint: "run --list-models to see available models" }) }, null, 2))
        process.exitCode = 2; return
      }

      const tip = await resumeTip(session)
      let id, reply, info, error
      try {
        ({ id, reply, info, error } = await attemptPrompt(model, session, 3))
      } catch (e) {
        await revertToTip(session, tip)
        console.log(JSON.stringify({ error: e.message ?? String(e), model: modelStr }, null, 2))
        process.exitCode = 1; return
      }
      if (!reply && error) {
        await revertToTip(session, tip)
        console.log(JSON.stringify({ error: error.data?.message ?? error.name ?? "empty reply", model: modelStr, statusCode: error.data?.statusCode }, null, 2))
        process.exitCode = 1; return
      }
      keepId = id
      console.log(JSON.stringify({ sessionID: id, reply, model: modelStr, cost: info.cost, tokens: info.tokens }, null, 2))
      return
    }

    // Build fallback chain, then guarantee a cross-provider tail (see appendSafetyNet).
    const config = await fetchProviderConfig()
    const chain = appendSafetyNet(
      tierStr ? buildTierFallbackChain(tierStr, config) : buildFallbackChain(config),
      config,
    )

    const tried = []
    const skipped = []
    const deadProviders = new Set()
    let lastError = null
    const tip = await resumeTip(session)
    for (const model of chain) {
      const modelFull = `${model.providerID}/${model.modelID}`
      if (deadProviders.has(model.providerID)) { skipped.push(modelFull); continue }
      let id, reply, info, error
      try {
        ({ id, reply, info, error } = await attemptPrompt(model, session, 2))
      } catch (e) {
        // A THROWN error (network/fetch failure, SDK error, timeout) that survives retries
        // must not abort the whole chain — treat it like a failed model and fall through.
        await revertToTip(session, tip)
        lastError = { model: modelFull, message: e.message ?? String(e) }
        tried.push(modelFull)
        continue
      }
      if (reply) {
        keepId = id
        console.log(JSON.stringify({
          sessionID: id,
          reply,
          model: modelFull,
          cost: info.cost,
          tokens: info.tokens,
          ...(tried.length ? { fallbacks: tried } : {}),
          ...(skipped.length ? { skipped } : {}),
        }, null, 2))
        return
      }
      if (error) {
        lastError = { model: modelFull, statusCode: error.data?.statusCode, message: error.data?.message ?? error.name }
        if (isProviderDead(error)) deadProviders.add(model.providerID)
      }
      await revertToTip(session, tip)
      tried.push(modelFull)
    }

    // Nothing in the chain produced a reply
    console.log(JSON.stringify({ error: "All models returned empty", tried, ...(skipped.length ? { skipped } : {}), lastError }, null, 2))
    process.exitCode = 1
  } catch (e) {
    console.log(JSON.stringify({ error: e.message ?? String(e) }))
    process.exitCode = 1
  } finally {
    // Best-effort orphan cleanup: delete every session this run created except the one
    // that produced the returned reply. Failures here never mask the real outcome.
    createdSessions.delete(keepId)
    if (createdSessions.size) {
      await Promise.allSettled([...createdSessions].map((sid) =>
        client.session.delete({ path: { id: sid }, signal: AbortSignal.timeout(5000) })))
    }
  }
}

if (argError) {
  console.log(JSON.stringify({ error: argError, usage: USAGE }))
  process.exitCode = 2
} else if (flags["--help"]) {
  console.log(USAGE)
} else if (listModels) {
  await runListModels()
} else if (debugChain) {
  await runDebugChain()
} else {
  await main()
}
