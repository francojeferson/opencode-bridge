# opencode ↔ Claude Code Bridge — Setup & Runbook

Goal: let one agent (Claude Code, or any orchestrator) drive a **locally installed
opencode** agent programmatically — create a session, send prompts, resume across
turns, and read back structured replies. This document is a complete, reproducible
runbook. Follow it top to bottom.

> Validated on: Windows 11, opencode `1.17.11`, `@opencode-ai/sdk@1.17.11`,
> Node `v26`, shell = Git Bash / PowerShell. Adjust paths for other OSes.

---

## TL;DR (the working path)

1. Start a persistent daemon: `opencode serve --port 4096`
2. Install the SDK: `npm install @opencode-ai/sdk` (in a Node ESM project)
3. Drive it with the SDK method `client.session.prompt(...)`, which calls
   `POST /session/{id}/prompt_async`.
4. Read replies from the returned message or `client.session.messages(...)`.

The helper `opencode.mjs` (in this folder) wraps all of that and prints one JSON
object per call: `{ sessionID, reply, cost, tokens }`.

---

## The critical gotcha (read this first)

The opencode server exposes **two different HTTP namespaces** for prompting, and
they are NOT equivalent:

| Route | Behaviour |
|---|---|
| `POST /api/session/{id}/prompt` | **Admit-only.** Returns an ack with a `msg_…` id, but the turn **never executes** — `cost` stays `0`, no assistant message is ever produced. A dead end. |
| `POST /session/{id}/prompt_async` | **Drives the turn.** Executes the agent, returns the assistant message. This is what the SDK and `run` use. |

Body shapes also differ:

- `/api/...` route advertises `{ "prompt": { "text": "..." } }`
- `/session/.../prompt_async` (SDK) wants:
  ```json
  {
    "agent": "build",
    "model": { "providerID": "openrouter", "modelID": "google/gemma-4-31b-it:free" },
    "parts": [{ "type": "text", "text": "your prompt" }]
  }
  ```

**Do not hand-roll `curl` against `/api/session/*/prompt`.** Use the SDK (or
`opencode run --attach`). This single mismatch is the reason naive HTTP integration
silently does nothing.

Other namespace notes:
- Session **create** uses `model: { providerID, id }` (field is `id`).
- Prompt uses `model: { providerID, modelID }` (field is `modelID`). Yes, they differ.

---

## Prerequisites & verification

```bash
# opencode installed and on PATH
opencode --version            # expect 1.17.x

# a provider is authenticated
opencode auth list            # must show at least one credential

# node available (ESM, v18+)
node -v
```

> ⚠ **Provider credits.** During validation the only authed provider was OpenRouter
> with **0 credits → every paid model returns HTTP 402** ("Insufficient credits").
> Free `:free` models work but are rate-limited and often emit very low / empty
> output. For real work, add OpenRouter credit or `opencode auth login` another
> provider (e.g. Anthropic). List models with:
> ```bash
> curl -s http://127.0.0.1:4096/config/providers
> ```

### Windows stderr quirk
opencode prints an ASCII-art banner to **stderr**. In PowerShell, redirecting a
native exe's stderr wraps each line in a `NativeCommandError` and flips `$?` to
`$false` even on exit 0. When scripting, send stderr to null (`2>$null` / `2>/dev/null`)
so captured stdout stays clean JSON — the banner is not a real error.

---

## Step 1 — start the daemon

```bash
opencode serve --port 4096 --hostname 127.0.0.1
# -> "opencode server listening on http://127.0.0.1:4096"
```

Run it in the background / as a long-lived process. It is unsecured by default
(warns about `OPENCODE_SERVER_PASSWORD`); set that env var + use basic auth if the
port is exposed beyond localhost.

Sanity-check the API:
```bash
curl -s http://127.0.0.1:4096/api/agent      # lists agents: build, plan, general, ...
curl -s http://127.0.0.1:4096/api/session    # lists sessions
```

The default agent id is **`build`**. A session created with `agent: null` will NOT
run prompts — always attach an agent.

---

## Step 2 — install the SDK

```bash
cd opencode-bridge
npm init -y
npm pkg set type=module          # SDK is ESM
npm install @opencode-ai/sdk     # match the server version (1.17.11)
```

---

## Step 3 — the bridge helper

`opencode.mjs` (already in this folder) is the integration surface. Core logic:

```js
import { createOpencodeClient } from "@opencode-ai/sdk"
const client = createOpencodeClient({ baseUrl: "http://127.0.0.1:4096" })

// create (model field is `id` here)
const { data: s } = await client.session.create({
  body: { agent: "build", model: { providerID: "openrouter", id: "google/gemma-4-31b-it:free" } },
})

// prompt — DRIVES the turn, returns assistant message (model field is `modelID` here)
const { data: res } = await client.session.prompt({
  path: { id: s.id },
  body: { agent: "build",
          model: { providerID: "openrouter", modelID: "google/gemma-4-31b-it:free" },
          parts: [{ type: "text", text: "Reply with: OK" }] },
})

// read reply
const reply = (res.parts ?? []).filter(p => p.type === "text").map(p => p.text).join("").trim()
```

CLI usage:
```bash
node opencode.mjs "refactor auth.ts to async"
node opencode.mjs --session ses_abc "now add tests"             # resume by id
node opencode.mjs --model openrouter/google/gemma-4-31b-it:free "hi"
node opencode.mjs --no-tools "answer only, run no tools"
```

Output is one JSON object: `{ sessionID, reply, cost, tokens }`. Capture `sessionID`
from turn 1 and pass it as `--session` to continue the conversation.

---

## Step 4 — verify (acceptance test)

```bash
# turn 1
OUT=$(node opencode.mjs --model openrouter/nvidia/nemotron-nano-9b-v2:free \
        "Remember the number 42. Reply with just: stored.")
echo "$OUT"
SID=$(echo "$OUT" | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).sessionID))")

# turn 2 (resume — proves cross-turn memory)
node opencode.mjs --session "$SID" --model openrouter/nvidia/nemotron-nano-9b-v2:free \
  "What number did I tell you to remember? Reply with only the number."
```

**Expected:** turn 1 reply `stored`; turn 2 reply `42`. Achieved during validation.

---

## Alternative integration paths (and why the SDK wins)

| Path | How | Use when |
|---|---|---|
| **SDK** (recommended) | `@opencode-ai/sdk` against `serve` daemon | Structured JSON, programmatic control, persistent shared sessions. |
| `opencode run --attach` | `opencode run "msg" --attach http://127.0.0.1:4096 -m prov/model --format json` | Supported CLI client; also drives the daemon. Good for shell-only contexts. Parse with `--format json`; reply text may need scraping. |
| `opencode run` (no attach) | spins an embedded server per call | Quick one-shots; isolated, slower, no shared session pool. |
| **ACP** (`opencode acp`) | JSON-RPC 2.0 over stdio, protocol v1 | Editor ↔ agent (Zed/Neovim). Needs a long-lived stdio pipe — poor fit for stateless tool-call orchestrators. |
| raw `curl /api/.../prompt` | — | ❌ Does not work (admit-only). Avoid. |

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Prompt returns ack but `cost: 0`, no reply, `messages` empty | Hit `/api/session/*/prompt` (admit-only) **or** session has `agent: null` | Use SDK `session.prompt` (→ `/prompt_async`); always set `agent: "build"`. |
| `APIError ... statusCode: 402 Insufficient credits` | OpenRouter out of credits | Add credit, or auth another provider. |
| Free model replies empty / only `reasoning` tokens, `output: 0` | `:free` tier rate-limit / flaky | Retry, pick another free model (`nvidia/nemotron-nano-9b-v2:free`, `google/gemma-4-31b-it:free` worked), or use a paid model. |
| PowerShell reports `NativeCommandError` on exit 0 | banner on stderr | redirect stderr to null; ignore banner. |
| `client.session.prompt is not a function` | wrong SDK version / not ESM | `npm pkg set type=module`; install SDK matching server version. |

---

## File map (this folder)

```
opencode.mjs       # SDK bridge helper — structured JSON. USE THIS.
test-sdk.mjs       # minimal proof script (create → prompt → read)
ask-opencode.ps1   # PowerShell fallback wrapping `opencode run --attach`
SETUP.md           # this runbook
package.json
node_modules/@opencode-ai/sdk
```
