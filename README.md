# opencode-bridge

SDK bridge to drive a local [opencode](https://opencode.ai) daemon from Claude Code or any CLI agent. Sends prompts to other AI models with automatic fallback, tier-based routing, and session continuity.

## Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [opencode](https://opencode.ai) installed and configured with at least one provider

## Installation

```bash
git clone https://github.com/francojeferson/opencode-bridge.git
cd opencode-bridge
npm install
```

Verify:

```bash
node opencode.mjs --help
```

## First Run

### 1. Start the opencode daemon

```bash
opencode serve --port 4096
```

Keep this running in a separate terminal (or background it with `&`).

### 2. Check available models

```bash
node opencode.mjs --list-models
```

This shows your configured providers, tier rankings, and all available models.

### 3. Send a test prompt

```bash
node opencode.mjs --tier fast "Hello, what model are you?"
```

Expected output:

```json
{
  "sessionID": "ses_...",
  "reply": "I'm ...",
  "model": "provider/model-id",
  "cost": 0,
  "tokens": { "input": 0, "output": 0, "reasoning": 0 }
}
```

### 4. Stop the daemon when done

```bash
# Find and kill the process
taskkill /IM opencode.exe /F   # Windows
# or
kill $(pgrep -f "opencode serve")  # Linux/macOS
```

## Usage

```bash
node opencode.mjs [flags] "your prompt"
```

### Flags

| Flag | Description |
|------|-------------|
| `--tier high\|code\|mid\|fast` | Pick best model in tier with automatic fallback |
| `--model provider/model-id` | Exact model, no fallback |
| `--session ses_xxx` | Continue an existing session |
| `--no-tools` | Disable tool use (text-only) |
| `--timeout ms` | Per-attempt timeout in ms (default: 60000) |
| `--list-models` | Show available models and tiers |
| `--debug-chain` | Print resolved fallback chain without calling any model |

### Tiers

| Tier | Use case |
|------|----------|
| `high` | Complex reasoning, architecture, hard problems |
| `code` | Code generation, refactoring, review |
| `mid` | General advisory, balanced cost/quality |
| `fast` | Quick factual, simple transforms, cheap |

### Session Continuity

```bash
# Turn 1 - capture sessionID
RESULT=$(node opencode.mjs --tier mid "Design a caching layer")
SESSION=$(echo "$RESULT" | jq -r .sessionID)

# Turn 2 - continue conversation
node opencode.mjs --session "$SESSION" "Add Redis eviction to that design"
```

## Installing the Claude Code Skill

The skill lets Claude Code invoke opencode-bridge automatically when it needs another model's perspective.

### Global install (available in all projects)

```bash
mkdir -p ~/.claude/skills/opencode
cp .claude/skills/opencode/SKILL.md ~/.claude/skills/opencode/SKILL.md
```

On Windows (PowerShell):

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.claude\skills\opencode"
Copy-Item ".claude\skills\opencode\SKILL.md" "$env:USERPROFILE\.claude\skills\opencode\SKILL.md"
```

### Verify installation

```bash
ls ~/.claude/skills/opencode/SKILL.md
```

The skill will be available in the next Claude Code session. Invoke with `/opencode` or let it trigger automatically when context suggests delegating to another model.

### What the skill does

When triggered, Claude Code will:

1. Start the opencode daemon (if not already running)
2. Send prompts via `node opencode.mjs` with appropriate flags
3. Parse the JSON response and use the `reply` field
4. Thread `sessionID` for multi-turn conversations
5. Kill the daemon when the task is complete

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `Cannot find package '@opencode-ai/sdk'` | Run `npm install` in the bridge directory |
| `fetch failed` | Daemon not running; start with `opencode serve --port 4096` |
| `"All models returned empty"` | No model responded; check provider auth/credits |
| `402 Insufficient credits` | Provider out of credits; other providers in the fallback chain will be tried automatically |
| Empty reply from `--model` | Model ID may be wrong; run `--list-models` to check |

## License

[MIT](LICENSE) — free to use, modify, and distribute.
