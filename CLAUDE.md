# opencode-bridge

SDK bridge: lets Claude Code (or any orchestrator) drive a local opencode daemon programmatically.

## Daemon Lifecycle

- **Always start daemon** (`opencode serve --port 4096`) in background before sending queries
- **Always kill daemon** after finishing opencode-related task
- Don't ask user to start/stop — manage automatically

## Usage

```bash
node opencode.mjs "prompt"                              # uses daemon default model
node opencode.mjs --model cai/gpt-5.4 "prompt"         # explicit model override
node opencode.mjs --session ses_xxx "follow-up"        # resume session
node opencode.mjs --no-tools "text-only query"         # disable tool use
```

## Critical Notes

- `--model` is optional. Omit to use daemon's configured default model.
- Model format: `providerID/modelID` (e.g. `cai/gpt-5.4`, `openrouter/google/gemma-4-31b-it:free`)
- Session create uses `model.id`, prompt uses `model.modelID` — SDK handles this difference
- **Never** use raw `curl` against `/api/session/*/prompt` — it's admit-only and won't execute. Use SDK's `session.prompt` (hits `/prompt_async`)
- Default agent: `build`. Sessions without an agent won't run prompts.
- Output: single JSON object `{ sessionID, reply, cost, tokens }`
- Capture `sessionID` from turn 1, pass as `--session` to continue conversation

## Troubleshooting

- `fetch failed` → daemon not running, start it first
- `402 Insufficient credits` → provider out of credits, add credit or auth another provider
- Empty reply → free tier rate-limit, retry or use paid model
- PowerShell stderr errors → banner noise, redirect stderr to null
