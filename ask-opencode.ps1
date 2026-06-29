# ask-opencode.ps1 — bridge Claude Code <-> a running opencode daemon
#
# Prereq (run once, persistent daemon):
#   opencode serve --port 4096
#
# Usage:
#   ./ask-opencode.ps1 "refactor auth.ts to async"
#   ./ask-opencode.ps1 -Session ses_abc... "now add tests"     # resume
#   ./ask-opencode.ps1 -Model openrouter/google/gemma-4-31b-it:free -Json "..."
#
# Notes:
#   - Uses `opencode run --attach` = the SUPPORTED client. Raw HTTP POST
#     /api/session/{id}/prompt only ADMITS a message; opencode's own client
#     drives the turn loop, so hand-rolled curl does not execute. Use this.
#   - stderr carries an ASCII banner -> ignore it (not an error).

param(
  [Parameter(Mandatory = $true, Position = 0)]
  [string]$Prompt,
  [string]$Server  = "http://127.0.0.1:4096",
  [string]$Model   = "openrouter/google/gemma-4-31b-it:free",
  [string]$Session = "",                       # ses_... to resume; empty = new
  [string]$Agent   = "build",
  [switch]$Json,                               # raw JSON events instead of text
  [switch]$SkipPermissions                     # auto-approve (dangerous)
)

$opencode = "$env:APPDATA\npm\opencode.ps1"
$args = @("run", $Prompt, "--attach", $Server, "-m", $Model, "--agent", $Agent)
if ($Session)         { $args += @("-s", $Session) }
if ($Json)            { $args += @("--format", "json") }
if ($SkipPermissions) { $args += "--dangerously-skip-permissions" }

# stderr -> $null so the banner does not pollute captured stdout
& $opencode @args 2>$null
