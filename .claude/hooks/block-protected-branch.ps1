# PreToolUse hook (matcher: Bash) — blocks destructive git operations that would
# modify a protected branch. PowerShell twin of hooks/bash/block-protected-branch.sh.
#
# stdin:  Claude Code hook payload JSON ({ tool_input: { command: "..." } })
# exit 0: allow    exit 2: block (stderr is fed back to Claude)

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }
$cmd = $payload.tool_input.command
if (-not $cmd -or $cmd -notmatch 'git') { exit 0 }

$proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
$configPath = Join-Path $proj '.claude\discipline.json'
$branches = @('main', 'master', 'develop', 'release/*')
$blockAllPush = $false
if (Test-Path $configPath) {
    try {
        $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
        if ($cfg.protectedBranches) { $branches = @($cfg.protectedBranches) }
        if ($cfg.blockAllPush) { $blockAllPush = $true }
    } catch {}
}

function Test-Protected([string]$branch) {
    foreach ($pat in $branches) { if ($branch -like $pat) { return $true } }
    return $false
}

function Block([string]$reason) {
    if ((Get-DiscMode) -eq 'shadow') {
        # Shadow: record what would have been stopped, let it through. One window
        # of this proves the gate's value before it can annoy anyone.
        Write-DiscEvent -Asset 'block-protected-branch' -Event 'would-block' -Verdict 'fail' -Detail $reason
        [Console]::Error.WriteLine("[block-protected-branch] SHADOW (not enforced): $reason")
        exit 0
    }
    Write-DiscEvent -Asset 'block-protected-branch' -Event 'block' -Verdict 'fail' -Detail $reason
    [Console]::Error.WriteLine("[block-protected-branch] BLOCKED: $reason")
    [Console]::Error.WriteLine('Create or switch to a feature branch, then retry.')
    exit 2
}

$current = git -C $proj rev-parse --abbrev-ref HEAD 2>$null

# 1. History-modifying commands while ON a protected branch.
if ($current -and (Test-Protected $current)) {
    if ($cmd -match '\bgit\b[^|;&]*\b(commit|merge|rebase|cherry-pick|revert)\b' -or
        $cmd -match '\bgit\b[^|;&]*\breset\b[^|;&]*--hard') {
        Block "current branch '$current' is protected — refusing to modify it directly"
    }
}

# 2. git push targeting a protected branch (refspecs, deletes, --force).
if ($cmd -match '\bgit\b[^|;&]*\bpush\b') {
    # blockAllPush: any push is a human decision. Undoing a push on a shared
    # branch costs a force-push and other people's time — the asymmetry, not
    # the branch name, is the reason this option exists.
    if ($blockAllPush) {
        Block 'blockAllPush is set — pushing is a human action; ask the user to push'
    }
    $tokens = ($cmd -split '\s+') | Where-Object { $_ -and $_ -notmatch '^-' -and $_ -notin @('git', 'push') } | Select-Object -Skip 1
    foreach ($tok in $tokens) {
        $dst = ($tok -split ':')[-1].TrimStart('+') -replace '^refs/heads/', ''
        if ($dst -and (Test-Protected $dst)) { Block "push targets protected branch '$dst'" }
        if ($tok.StartsWith(':') -or $cmd -match '--delete') {
            $src = ($tok -split ':')[0].TrimStart(':')
            if ($src -and (Test-Protected $src)) { Block "push would delete protected branch '$src'" }
        }
    }
    if ($current -and (Test-Protected $current)) { Block "push from protected branch '$current'" }
}

# 3. Deleting a protected branch locally.
if ($cmd -match '\bgit\b[^|;&]*\bbranch\b[^|;&]*(-D|-d|--delete)') {
    $tokens = ($cmd -split '\s+') | Where-Object { $_ -and $_ -notmatch '^-' -and $_ -notin @('git', 'branch') }
    foreach ($tok in $tokens) {
        if (Test-Protected $tok) { Block "deleting protected branch '$tok'" }
    }
}

exit 0
