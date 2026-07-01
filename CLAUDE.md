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
```

Output: `{ sessionID, reply, model, cost, tokens, fallbacks? }`. Capture `sessionID`
from turn 1, pass as `--session` to continue.

### Model Resolution Order

`--model` (no fallback) > `--tier` (fallback within tier) > daemon default (fallback through high → mid → fast)

### Fallback Behavior

On empty reply, script automatically tries the next model in the chain:
- `--model`: no fallback — explicit choice, use as-is
- `--tier`: falls through that tier's candidates in preference order
- No flag: daemon default → high tier → mid tier → fast tier

Output includes `fallbacks` array (models that returned empty) when fallback occurred.

### Tiers

| Tier | Use case | Picks (best first) |
|------|----------|-------------------|
| `high` | Complex reasoning, architecture, hard problems | opus, gpt-5.5, gpt-5.4, kimi-k2 |
| `code` | Code generation, refactoring, review | codex, gpt-5.4, opus, qwen-coder |
| `mid` | General advisory, balanced cost/quality | sonnet, gpt-5.4-mini, gpt-4.1 |
| `fast` | Quick factual, simple transforms, cheap | nano, haiku, mini, nova-lite |

Tiers resolve dynamically from available models — different environments get
different picks based on what's configured.

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
