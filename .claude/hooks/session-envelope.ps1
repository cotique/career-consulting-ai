# SessionStart + PreCompact hook — keep the operating state across compaction.
#
# Compaction preserves conclusions and drops the operating state: branch, base,
# worktree, repo scope, "don't touch X". Two events, one asset:
#
#   PreCompact   -> persist the envelope to .claude/session-state.json and count
#                   the compaction. Prints nothing.
#   SessionStart -> print the envelope as session context, including how many
#                   compactions this session has already been through.
#
# Compaction itself stays automatic and cannot be cancelled — that is fine. The
# harm was never the timing, it was the asymmetric loss: the summary keeps the
# conclusions and drops the state. Persisted state makes the timing irrelevant.
#
# What this does NOT restore: the provenance of claims. "X was [INFERRED], not
# [OBSERVED]" lives in the conversation text, and a summary flattens it into an
# apparent fact. That half is handled by tagging claims inline — a tag attached
# to the claim survives summarising; a disclaimer in a neighbouring paragraph
# does not.

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { $payload = $null }
if ($payload -and $payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }
$eventName = if ($payload) { $payload.hook_event_name } else { $null }
$source    = if ($payload) { $payload.source } else { $null }

$proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
$configPath = Join-Path $proj '.claude\discipline.json'
$statePath  = Join-Path $proj '.claude\session-state.json'

$repos = @('.')
$notes = @()
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($cfg.envelope.repos) { $repos = @($cfg.envelope.repos) }
        if ($cfg.envelope.notes) { $notes = @($cfg.envelope.notes) }
    } catch {}
}

function Get-Envelope {
    $lines = @()
    foreach ($rel in $repos) {
        $dir = if ($rel -eq '.') { $proj } else { Join-Path $proj $rel }
        git -C $dir rev-parse --is-inside-work-tree 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) { $lines += "  ${rel}: not a git worktree (or missing)"; continue }
        $branch = git -C $dir rev-parse --abbrev-ref HEAD 2>$null
        $head = git -C $dir rev-parse --short HEAD 2>$null
        $dirty = @(git -C $dir status --porcelain 2>$null).Count
        $wt = @(git -C $dir worktree list 2>$null).Count
        $line = "  ${rel}: branch=$branch head=$head uncommitted=$dirty"
        if ($wt -gt 1) { $line += " worktrees=$wt (confirm which one you are in)" }
        $lines += $line
    }
    if ($notes.Count -gt 0) {
        $lines += '  standing constraints:'
        foreach ($n in $notes) { if ($n) { $lines += "    - $n" } }
    }
    return $lines
}

function Read-State {
    if (-not (Test-Path $statePath)) { return $null }
    try { return Get-Content $statePath -Raw | ConvertFrom-Json } catch { return $null }
}

$state = Read-State
# A new session id starts the count over; a long-running session accumulates.
$sameSession = $state -and $env:DISC_SESSION_ID -and $state.sessionId -eq $env:DISC_SESSION_ID
$compactions = if ($sameSession -and $state.compactions) { [int]$state.compactions } else { 0 }

if ($eventName -eq 'PreCompact') {
    $compactions++
    $out = [ordered]@{
        sessionId   = $env:DISC_SESSION_ID
        compactions = $compactions
        savedAt     = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        envelope    = @(Get-Envelope)
        notes       = $notes
    }
    try {
        $dir = Split-Path $statePath -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Set-Content -Path $statePath -Value ($out | ConvertTo-Json -Depth 6) -Encoding utf8
    } catch {}
    Write-DiscEvent -Asset 'session-envelope' -Event 'persist' -Verdict 'fired' -Detail "compaction $compactions"
    exit 0
}

# SessionStart (or anything else that reaches here): re-ground.
Write-DiscEvent -Asset 'session-envelope' -Event 'ground' -Verdict 'fired' -Detail $source

Write-Output '[operational envelope - re-read this instead of recalling it]'
Get-Envelope | ForEach-Object { Write-Output $_ }

if ($compactions -gt 0) {
    Write-Output "  compactions so far in this session: $compactions"
    if ($compactions -ge 3) {
        Write-Output '  Retractions and dropped instructions cluster right after a compaction.'
        Write-Output '  A clean boundary (change verified and committed) is a cheap place to start fresh.'
    }
}
Write-Output '  Treat the above as current state, not as history: re-run these checks'
Write-Output '  before any mutation if the conversation has been compacted since.'
exit 0
