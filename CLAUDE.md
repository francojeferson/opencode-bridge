# opencode-bridge

SDK bridge: drive a local opencode daemon from Claude Code.

## Daemon Lifecycle

- Start daemon before querying: `opencode serve --port 4096` (background)
- Kill daemon after the task. Manage automatically — don't ask the user.

## Usage

```bash
node opencode.mjs --list-models                      # show available models, tiers, daemon default
node opencode.mjs "prompt"                           # daemon default + auto-fallback
node opencode.mjs --tier high "complex task"         # best in tier + fallback within tier
node opencode.mjs --tier code "write a parser"       # code-specialized + fallback
node opencode.mjs --tier fast "quick question"       # fastest/cheapest + fallback
node opencode.mjs --model provider/model-id "prompt" # explicit, NO fallback
node opencode.mjs --session ses_xxx "follow-up"      # resume a session
node opencode.mjs --no-tools "text-only query"       # disable tool use
node opencode.mjs --timeout 30000 "prompt"           # per-attempt ms before a hung model is aborted (default 60000)
node opencode.mjs --tier high --debug-chain          # print resolved chain, no model calls
cat prompt.txt | node opencode.mjs --tier code -     # prompt "-" reads stdin (long prompts / embedded files)
```

Output: `{ sessionID, reply, model, cost, tokens, fallbacks? }`. Capture `sessionID`
from turn 1, pass as `--session` to continue.

### Model Resolution Order

`--model` (no fallback) > `--tier` (fallback within tier) > daemon default (fallback through high → mid → fast)

### Fallback Behavior

On empty reply OR a thrown error (network/fetch failure, SDK error, timeout), the script
tries the next model in the chain — one bad model never aborts the run:
- **Hung models are aborted.** Some provider models never respond; each attempt carries an
  `AbortSignal.timeout(--timeout)` (default 60s) so a hang is aborted and the chain moves on
  instead of blocking forever. A timeout is NOT retried (the model is hung) — it just falls
  through to the next model.
- **Transient throws ARE retried** with a brief backoff (the daemon occasionally throws a
  one-off `fetch failed` while up): `--model` retries up to 3× before erroring; chain models
  2× each.
- Chains: `--tier` falls through that tier's candidates then a cross-provider metadata tail;
  no-flag goes daemon default → high → mid → fast → metadata tail.

A provider-wide failure (402 insufficient credits, 401/403 auth) marks the whole provider
dead and skips its remaining models. Output includes `fallbacks` (models that failed),
`skipped` (skipped because their provider was dead), and `lastError` on total failure.

Failed attempts' throwaway sessions are deleted best-effort on exit — only the session
that produced the reply survives. A `--session` id you pass in is never deleted.

**Exit:** the script sets `process.exitCode` and lets the event loop drain — it never calls
`process.exit()`. Calling `process.exit()` mid-request aborts libuv on Windows/Node
(`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`); draining exits cleanly with the
right code, and aborted sockets close promptly so there's no hang.

### Tiers

| Tier | Use case | Picks (best first) |
|------|----------|-------------------|
| `high` | Complex reasoning, architecture, hard problems | opus, gpt-5.5, gpt-5.4, kimi-k2 |
| `code` | Code generation, refactoring, review | codex, gpt-5.4, opus, qwen-coder |
| `mid` | General advisory, balanced cost/quality | sonnet, gpt-5.4-mini, gpt-4.1 |
| `fast` | Quick factual, simple transforms, cheap | nano, haiku, mini, nova-lite |

Tiers resolve dynamically from available models — different environments get
different picks based on what's configured.

**Tier semantics: quality-first, provider- and environment-agnostic.**
Each `TIER_RANKS` entry is a capability *rung* (regex) matched across ALL providers, in
best-first order. Within a rung, `betterFirst()` sorts **quality-first** by a metadata
`powerScore` (context + reasoning + toolcall + output room; price a mild nudge); cost
breaks only exact ties, so a higher-quality PAID model is never demoted for costing more.
Models are pre-filtered by `isTextModel` (active, text-in/text-out, NOT a media generator
— drops `gemini-*-image`-style models that return empty text despite `output.text:true`).

The regexes are a **quality prior, not a requirement**: `appendSafetyNet` appends EVERY
remaining usable model ranked by `powerScore`, with no hardcoded provider name. So an
environment whose catalog matches none of the priors (Ollama, Bedrock, a different
opencode config) still resolves to a non-empty, quality-ordered chain — the metadata
ranking simply becomes the whole chain. Verify with `--debug-chain` (its length equals the
count of usable text models in the environment). All signals come from `/config/providers`
metadata (`cost`, `limit.{context,output}`, `capabilities`, `status`).

### Model Discovery

Run `--list-models` to see what's available. Output includes:
- `defaults` — daemon's configured default
- `tiers` — resolved picks per tier for this environment
- `all` — every available model

## Critical Notes

- **No hardcoded default.** Script fetches from `/config/providers` at startup.
- Model format: `providerID/modelID` (first `/` splits provider from model id).
- **Never** curl `/api/session/*/prompt` — admit-only, won't execute. The SDK's
  `session.prompt` hits `/prompt_async`, which drives the turn.
- Default agent `build`. Sessions need an agent to run prompts.
- Authoritative model for a session: `GET /session/{id}` → `.model`.

## Troubleshooting

- `fetch failed` → daemon not running; start it.
- `"All models returned empty"` → no model in fallback chain responded; check provider auth/connectivity.
- `402 Insufficient credits` → provider out of credits; use another provider.
- Unknown tier → available: `high`, `code`, `mid`, `fast`.
