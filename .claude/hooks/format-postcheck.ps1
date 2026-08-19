# PostToolUse hook (matcher: Edit|Write) — run a formatter/linter check on the
# changed file and feed violations back to Claude (exit 2). PowerShell twin of
# hooks/bash/format-postcheck.sh.

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }
$file = $payload.tool_input.file_path
if (-not $file) { exit 0 }

$proj = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { '.' }
$configPath = Join-Path $proj '.claude\discipline.json'
if (-not (Test-Path $configPath)) { exit 0 }
try { $cfg = Get-Content $configPath -Raw | ConvertFrom-Json } catch { exit 0 }
if (-not $cfg.format) { exit 0 }

$base = Split-Path $file -Leaf
foreach ($entry in $cfg.format.PSObject.Properties) {
    if ($base -notlike $entry.Name) { continue }
    $run = $entry.Value -replace '\{file\}', $file
    Push-Location $proj
    $out = Invoke-Expression $run 2>&1
    $failed = ($LASTEXITCODE -ne 0)
    Pop-Location
    if ($failed) {
        if ((Get-DiscMode) -eq 'shadow') {
            Write-DiscEvent -Asset 'format-postcheck' -Event 'would-block' -Verdict 'fail' -Detail $file
            [Console]::Error.WriteLine("[format-postcheck] SHADOW (not enforced): '$($entry.Name)' check failed for ${file}")
            exit 0
        }
        Write-DiscEvent -Asset 'format-postcheck' -Event 'block' -Verdict 'fail' -Detail $file
        [Console]::Error.WriteLine("[format-postcheck] '$($entry.Name)' check failed for ${file}:")
        ($out | Select-Object -Last 20) | ForEach-Object { [Console]::Error.WriteLine($_) }
        [Console]::Error.WriteLine('Fix the formatting/lint violations in the file you just edited.')
        exit 2
    }
}
exit 0
