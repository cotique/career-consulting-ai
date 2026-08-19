# Stop hook — "definition of done" gate. PowerShell twin of hooks/bash/dod-gate.sh.
#
# When the session leaves uncommitted changes matching dod.fileGlobs, run the
# configured checks. Any failure blocks the stop (exit 2).

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { $payload = $null }
if ($payload -and $payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }
if ($payload -and $payload.stop_hook_active) { exit 0 }   # no infinite stop-loops

$proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
$configPath = Join-Path $proj '.claude\discipline.json'
if (-not (Test-Path $configPath)) { exit 0 }
try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch { exit 0 }
if (-not $cfg.dod -or -not $cfg.dod.checks) { exit 0 }

git -C $proj rev-parse --is-inside-work-tree 2>$null | Out-Null
if ($LASTEXITCODE -ne 0) { exit 0 }

$globs = if ($cfg.dod.fileGlobs) { @($cfg.dod.fileGlobs) } else { @('*') }
$changed = git -C $proj status --porcelain 2>$null |
    ForEach-Object { ($_.Substring(3) -split ' -> ')[-1] }

$touched = $false
foreach ($f in $changed) {
    $base = Split-Path $f -Leaf
    foreach ($g in $globs) { if ($base -like $g) { $touched = $true; break } }
    if ($touched) { break }
}
if (-not $touched) { exit 0 }

$sw = [Diagnostics.Stopwatch]::StartNew()

# Preconditions run before any check, and their failure is reported as its own
# thing rather than as a verdict on the changes. Without this the gate says
# "definition-of-done checks failed" when the real cause is a stopped Docker
# daemon, and the reader goes hunting through diffs for a fault that is not
# there. A wrong reason costs more than a wrong verdict: it sends the search in
# the wrong direction, and gates that do that get switched off. It still blocks —
# unverified work is unverified — but it blocks saying what to start rather than
# what to fix.
foreach ($pre in @($cfg.dod.preconditions)) {
    if (-not $pre) { continue }
    Push-Location $proj
    # Both failure shapes have to count. A command that runs and exits non-zero
    # sets $LASTEXITCODE; a command that is not installed at all throws instead
    # and leaves $LASTEXITCODE holding whatever the previous command left there —
    # which is 0, so testing the exit code alone reports a missing tool as
    # present. That is the precondition failing exactly when it matters.
    $global:LASTEXITCODE = 0
    $missing = $false
    try {
        Invoke-Expression $pre.command *> $null
        if ($LASTEXITCODE -ne 0) { $missing = $true }
    } catch { $missing = $true }
    Pop-Location
    if ($missing) {
        $ms = [int]$sw.ElapsedMilliseconds
        $detail = "precondition '$($pre.name)' unavailable"
        if ((Get-DiscMode) -eq 'shadow') {
            Write-DiscEvent -Asset 'dod-gate' -Event 'would-block' -Verdict 'precondition' -DurationMs $ms -Detail $detail
            [Console]::Error.WriteLine("[dod-gate] SHADOW: cannot run the checks - $detail")
            exit 0
        }
        Write-DiscEvent -Asset 'dod-gate' -Event 'precondition-failed' -Verdict 'precondition' -DurationMs $ms -Detail $detail
        [Console]::Error.WriteLine("[dod-gate] Cannot run the checks: $detail.")
        [Console]::Error.WriteLine('This is not a verdict on your changes - the checks did not run.')
        if ($pre.remedy) { [Console]::Error.WriteLine($pre.remedy) }
        exit 2
    }
}
$failures = @()
foreach ($check in $cfg.dod.checks) {
    Push-Location $proj
    $out = Invoke-Expression $check.command 2>&1
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) {
        $tail = ($out | Select-Object -Last 30) -join "`n"
        $failures += "--- $($check.name) FAILED ---`n$tail"
    }
}
$sw.Stop()
# durationMs is the gate's price: what it costs at every session end. Weigh it
# against intercepts when deciding whether the gate keeps its place.
$ms = [int]$sw.ElapsedMilliseconds

if ($failures.Count -gt 0) {
    if ((Get-DiscMode) -eq 'shadow') {
        Write-DiscEvent -Asset 'dod-gate' -Event 'would-block' -Verdict 'fail' -DurationMs $ms `
            -Detail (($failures -join "`n") -split "`n" | Select-Object -First 3 | Join-String -Separator '; ')
        [Console]::Error.WriteLine('[dod-gate] SHADOW (not enforced): definition-of-done checks failed:')
        $failures | ForEach-Object { [Console]::Error.WriteLine($_) }
        exit 0
    }
    Write-DiscEvent -Asset 'dod-gate' -Event 'block' -Verdict 'fail' -DurationMs $ms
    [Console]::Error.WriteLine('[dod-gate] Definition-of-done checks failed for uncommitted changes:')
    $failures | ForEach-Object { [Console]::Error.WriteLine($_) }
    [Console]::Error.WriteLine('Fix the failures (or revert the changes) before ending the session.')
    exit 2
}
Write-DiscEvent -Asset 'dod-gate' -Event 'pass' -Verdict 'pass' -DurationMs $ms
exit 0
