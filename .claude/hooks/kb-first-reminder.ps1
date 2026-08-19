# UserPromptSubmit hook — remind Claude to query the knowledge base before
# reading code when the prompt looks like a research question about this
# project's domain. Soft signal: stdout becomes extra context, always exit 0.
# PowerShell twin of hooks/bash/kb-first-reminder.sh.

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }
$prompt = $payload.prompt
if (-not $prompt) { exit 0 }

$proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
$configPath = Join-Path $proj '.claude\discipline.json'
if (-not (Test-Path $configPath)) { exit 0 }
try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch { exit 0 }
if (-not $cfg.kb -or -not $cfg.kb.toolName) { exit 0 }

$lower = $prompt.ToLowerInvariant()
# Override via kb.triggerPattern when your prompts aren't English.
$research = if ($cfg.kb.triggerPattern) { $cfg.kb.triggerPattern }
            else { '\b(how|why|what|where|when|which|explain|history|architecture|flow|behaviou?r)\b|\?' }
if ($lower -notmatch $research) { exit 0 }

$hit = $false
foreach ($term in @($cfg.kb.projectTerms)) {
    if ($term -and $lower.Contains($term.ToLowerInvariant())) { $hit = $true; break }
}
if (-not $hit) { exit 0 }

# Advisory asset: the event records that the nudge fired. Whether the nudged
# behavior followed is measured downstream, not here.
Write-DiscEvent -Asset 'kb-first-reminder' -Event 'nudge' -Verdict 'fired'
Write-Output "[kb-first-reminder] This looks like a research question about this project."
Write-Output "Query the '$($cfg.kb.toolName)' knowledge base FIRST, before opening code files."
Write-Output "Go to code only if the KB answer is incomplete or potentially stale."
exit 0
