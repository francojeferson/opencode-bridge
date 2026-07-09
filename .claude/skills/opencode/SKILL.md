---
name: opencode
description: >
  Send prompts to a local opencode daemon via the opencode-bridge SDK client.
  Use whenever you need to delegate a task to another AI model (advisory, second opinion,
  code generation, quick lookup), query opencode for information, or the user says
  "ask opencode", "send to opencode", "opencode", "/opencode", "use opencode-bridge",
  "delegate to opencode", or references multi-model orchestration through the bridge.
  Also use proactively when a task would benefit from a second model's perspective
  or when you need a model with different capabilities (e.g., code-specialized, fast/cheap).
---

# opencode-bridge Skill

Drive a local opencode daemon from Claude Code to send prompts to other AI models.

## Lifecycle

The daemon MUST be running before any bridge call. Manage it automatically:

```bash
# Start (background, idempotent — check if already running first)
opencode serve --port 4096 &>/dev/null &
OPENCODE_PID=$!
sleep 3

# Verify
curl -s http://127.0.0.1:4096 > /dev/null && echo "ready"
```

Kill the daemon when the opencode-related task is complete:
```bash
kill $OPENCODE_PID 2>/dev/null
```

If the daemon is already running (port 4096 responds), skip starting a new one. Track whether YOU started it — only kill what you started.

## Sending Prompts

Run from the opencode-bridge repo root:

```bash
node opencode.mjs [flags] "prompt text"
node opencode.mjs [flags] -              # prompt "-" reads stdin (long prompts)
```

Use the stdin form whenever the prompt embeds file contents — Windows command lines
cap near 8K chars and quoting breaks on special chars.

### Flags

| Flag | Purpose | Example |
|------|---------|---------|
| `--tier high\|code\|mid\|fast` | Pick best model in tier with fallback | `--tier code` |
| `--model provider/id` | Exact model, no fallback | `--model cai/gpt-5.4` |
| `--session ses_xxx` | Continue existing session | `--session ses_abc123` |
| `--no-tools` | Text-only, no tool use | for pure Q&A |
| `--timeout ms` | Per-attempt abort (default 60000) | `--timeout 30000` |
| `--list-models` | Show available models | diagnostic |
| `--debug-chain` | Show fallback chain | diagnostic |

### Tier Selection Guide

| Tier | When to use |
|------|-------------|
| `high` | Complex reasoning, architecture, hard problems |
| `code` | Code generation, refactoring, review |
| `mid` | General advisory, balanced cost/quality |
| `fast` | Quick factual, simple transforms, cheap checks |

Default (no tier/model flag): uses daemon default + full fallback chain (high → mid → fast).

## Output Format

Always JSON to stdout:
```json
{
  "sessionID": "ses_xxx",
  "reply": "model's response text",
  "model": "cai/gpt-5.4-nano",
  "cost": 0,
  "tokens": { "input": 0, "output": 0, "reasoning": 0 },
  "fallbacks": ["cai/model-that-failed"]
}
```

Parse the `reply` field for the model's answer. Save `sessionID` to continue the conversation.

## Session Continuity

For multi-turn conversations with opencode:
1. First call: capture `sessionID` from response
2. Subsequent calls: pass `--session <sessionID>`

This maintains context across turns within the same opencode session.

## Error Handling

- `"error": "All models returned empty"` — no model responded; check daemon connectivity
- `fetch failed` — daemon not running; start it
- `402` errors — provider out of credits; fallback chain handles automatically
- Exit code 1 = error, exit code 2 = usage/validation error

## Example Flows

### Quick advisory
```bash
node opencode.mjs --tier fast "What's the time complexity of Dijkstra's with a fibonacci heap?"
```

### Code review delegation
```bash
{ echo "Review this function for bugs:"; cat path/to/file.ts; } | node opencode.mjs --tier code -
```

### Multi-turn session
```bash
# Turn 1
RESULT=$(node opencode.mjs --tier mid "Design a caching strategy for our API")
SESSION=$(echo "$RESULT" | jq -r .sessionID)

# Turn 2
node opencode.mjs --session "$SESSION" "Now add Redis eviction policies to that design"
```

### Second opinion
```bash
node opencode.mjs --tier high "I think X is the right approach because Y. Do you agree or see problems?"
```
