# Shared event logging for the pack's hooks. Not a hook itself — dot-sourced by
# them. PowerShell twin of hooks/bash/_events.sh.
#
# config: .claude/discipline.json →
#   "mode": "enforce" | "shadow",
#   "events": { "enabled": true, "path": ".claude/discipline-events.jsonl" }
#
# Usage:
#   . "$PSScriptRoot\_events.ps1"
#   Get-DiscMode                       -> "enforce" | "shadow"
#   Write-DiscEvent -Asset x -Event y -Verdict z [-Detail s] [-DurationMs n]

function Get-DiscConfig {
    $proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
    $p = Join-Path $proj '.claude\discipline.json'
    if (-not (Test-Path $p)) { return $null }
    try { return Get-Content $p -Raw | ConvertFrom-Json } catch { return $null }
}

function Get-DiscMode {
    $cfg = Get-DiscConfig
    if ($cfg -and $cfg.mode -eq 'shadow') { return 'shadow' }
    return 'enforce'
}

function Write-DiscEvent {
    param(
        [Parameter(Mandatory)][string]$Asset,
        [Parameter(Mandatory)][string]$Event,
        [Parameter(Mandatory)][string]$Verdict,
        [string]$Detail,
        [int]$DurationMs = -1
    )
    $cfg = Get-DiscConfig
    if (-not $cfg) { return }
    if ($cfg.events -and $cfg.events.enabled -eq $false) { return }

    $proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
    $rel = if ($cfg.events -and $cfg.events.path) { $cfg.events.path } else { '.claude/discipline-events.jsonl' }
    $path = if ([IO.Path]::IsPathRooted($rel)) { $rel } else { Join-Path $proj $rel }

    $record = [ordered]@{
        ts      = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
        asset   = $Asset
        event   = $Event
        verdict = $Verdict
        mode    = Get-DiscMode
    }
    if ($env:DISC_SESSION_ID) { $record.sessionId = $env:DISC_SESSION_ID }
    if ($Detail) { $record.detail = $Detail }
    if ($DurationMs -ge 0) { $record.durationMs = $DurationMs }

    try {
        $dir = Split-Path $path -Parent
        if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
        Add-Content -Path $path -Value ($record | ConvertTo-Json -Compress) -Encoding utf8
    } catch { }
}
