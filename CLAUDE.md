# opencode-bridge

SDK bridge: drive a local opencode daemon from Claude Code.

## Daemon Lifecycle

- Start daemon before querying: `opencode serve --port 4096` (background)
- Kill daemon after the task. Manage automatically — don't ask the user.

## Usage

```bash
node opencode.mjs "prompt"                          # default model, drives a turn
node opencode.mjs --model openrouter/openai/gpt-5 "prompt"   # override model
node opencode.mjs --session ses_xxx "follow-up"     # resume a session
node opencode.mjs --no-tools "text-only query"      # disable tool use
```

Output: one JSON object `{ sessionID, reply, cost, tokens }`. Capture `sessionID`
from turn 1, pass as `--session` to continue.

## Critical Notes

- **Default model `opencode/big-pickle`** — reliable. The daemon's own default
  provider (`cloudflare-workers-ai`, e.g. `glm-5.2`) returns EMPTY replies
  (0 output tokens) while still charging cost. Don't rely on the daemon default.
- Model format: `providerID/modelID` (first `/` splits provider from model id;
  e.g. `opencode/big-pickle`, `openrouter/openai/gpt-5`).
- **Never** curl `/api/session/*/prompt` — admit-only, won't execute. The SDK's
  `session.prompt` hits `/prompt_async`, which drives the turn.
- Default agent `build`. Sessions need an agent to run prompts.
- Authoritative model for a session: `GET /session/{id}` → `.model`.

## Troubleshooting

- `fetch failed` → daemon not running; start it.
- Empty reply → switch off cloudflare-workers-ai; use `opencode/*` or `openrouter/*`.
- `402 Insufficient credits` → provider out of credits; use another provider.
