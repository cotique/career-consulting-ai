# PreToolUse (Bash|Edit|Write) + UserPromptSubmit hook — keep credentials out of
# files, commands, and the transcript.
#
# Two jobs, because the two cases have different remedies:
#
#   PreToolUse       -> BLOCK. A secret about to be written into a file or a
#                       command is preventable, so prevent it.
#   UserPromptSubmit -> WARN only. By the time a human has pasted a password
#                       into the chat it is already on disk; blocking the turn
#                       would not unsay it. The value is telling you to rotate
#                       it now rather than discovering it in a transcript later.
#
# Registering this hook is the opt-in: it runs with sane defaults even without a
# config section, because the cost of missing a leaked key is asymmetric. Tune it
# with .claude/discipline.json → "secrets": { "extraPatterns": [...],
# "ignorePatterns": [...], "enabled": false }.
#
# False positives are the real risk — a gate that fires on placeholders teaches
# people to ignore gates — so anything that looks like a placeholder or an
# environment-variable reference is ignored by design.

$ErrorActionPreference = 'Continue'
. "$PSScriptRoot\_events.ps1"

try { $payload = [Console]::In.ReadToEnd() | ConvertFrom-Json } catch { exit 0 }
if ($payload.session_id) { $env:DISC_SESSION_ID = $payload.session_id }

$cfg = Get-DiscConfig
if ($cfg -and $cfg.secrets -and $cfg.secrets.enabled -eq $false) { exit 0 }

# What to scan, and how hard to act, depends on the event.
$isPrompt = $false
$text = ''
if ($payload.prompt) { $isPrompt = $true; $text = [string]$payload.prompt }
elseif ($payload.tool_input) {
    $ti = $payload.tool_input
    $parts = @($ti.command, $ti.content, $ti.new_string, $ti.file_text) | Where-Object { $_ }
    $text = ($parts -join "`n")
}
if (-not $text) { exit 0 }

# Placeholders and indirection: never a real credential, always a false positive.
$ignore = @(
    '(?i)\b(x{3,}|y{3,}|z{3,}|\*{3,}|\.{3,})\b',
    '(?i)(changeme|example|dummy|placeholder|redacted|your[-_]|my[-_]?secret|sample|fake|test[-_]?key|<[^>]{3,}>)',
    '\$\{?[A-Za-z_][A-Za-z0-9_]*\}?',      # $VAR / ${VAR}
    '%[A-Za-z_][A-Za-z0-9_]*%',            # %VAR%
    '(?i)process\.env\.',
    '(?i)os\.environ'
)
if ($cfg -and $cfg.secrets -and $cfg.secrets.ignorePatterns) { $ignore += @($cfg.secrets.ignorePatterns) }

$patterns = [ordered]@{
    'private key block'        = '-----BEGIN [A-Z ]*PRIVATE KEY-----'
    'AWS access key id'        = 'AKIA[0-9A-Z]{16}'
    'GitHub token'             = 'gh[pousr]_[A-Za-z0-9]{30,}'
    'Slack token'              = 'xox[baprs]-[A-Za-z0-9-]{10,}'
    'Google API key'           = 'AIza[0-9A-Za-z_\-]{35}'
    'JWT'                      = 'eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}'
    'Azure storage key'        = '(?i)AccountKey\s*=\s*[A-Za-z0-9+/]{40,}={0,2}'
    'credential in a URL'      = '(?i)[a-z][a-z0-9+.\-]*://[^:/\s@]+:[^@/\s]{6,}@'
    'assigned password/token'  = '(?i)\b(password|passwd|pwd|secret|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|client[-_]?secret)\b\s*[:=]\s*["'']?[^\s"''`,;<>${}%]{8,}'
}
if ($cfg -and $cfg.secrets -and $cfg.secrets.extraPatterns) {
    $i = 0
    foreach ($p in @($cfg.secrets.extraPatterns)) { $i++; $patterns["project pattern $i"] = $p }
}

$hits = @()
foreach ($name in $patterns.Keys) {
    foreach ($m in [regex]::Matches($text, $patterns[$name])) {
        $sample = $m.Value
        $isPlaceholder = $false
        foreach ($ig in $ignore) { if ($sample -match $ig) { $isPlaceholder = $true; break } }
        if (-not $isPlaceholder) { $hits += $name }
    }
}
# Credentials pasted in prose ("the db password is hunter2") — this is how a
# human leaks one in chat, and the code-shaped patterns above all miss it. The
# value must look like a secret (contains a digit, or is long) or every "the
# token is invalid" would fire.
$narrative = '(?i)\b(password|passwd|pwd|secret|api[-_ ]?key|apikey|token|credential)\b[ \t]*(?:is|are|=|:)[ \t]*["'']?([^\s"''`,;]{8,})'
foreach ($m in [regex]::Matches($text, $narrative)) {
    $val = $m.Groups[2].Value
    if (-not ($val -match '\d' -or $val.Length -ge 16)) { continue }
    $skip = $false
    foreach ($ig in $ignore) { if ($val -match $ig) { $skip = $true; break } }
    if (-not $skip) { $hits += 'credential in prose' }
}

$hits = $hits | Select-Object -Unique
if ($hits.Count -eq 0) { exit 0 }

$what = $hits -join ', '

if ($isPrompt) {
    # Advisory: the credential is already in the transcript. Say the useful thing.
    Write-DiscEvent -Asset 'secret-guard' -Event 'warn' -Verdict 'fail' -Detail $what
    Write-Output "[secret-guard] This message appears to contain a credential ($what)."
    Write-Output "  It is now in the transcript on disk. Treat it as compromised and rotate it."
    Write-Output "  Do not echo it into a file, a command, or a commit. Refer to the secret store"
    Write-Output "  or an environment variable name instead."
    exit 0
}

if ((Get-DiscMode) -eq 'shadow') {
    Write-DiscEvent -Asset 'secret-guard' -Event 'would-block' -Verdict 'fail' -Detail $what
    [Console]::Error.WriteLine("[secret-guard] SHADOW (not enforced): credential material in tool input ($what)")
    exit 0
}
Write-DiscEvent -Asset 'secret-guard' -Event 'block' -Verdict 'fail' -Detail $what
[Console]::Error.WriteLine("[secret-guard] BLOCKED: this would write credential material ($what).")
[Console]::Error.WriteLine('Use the secret store or an environment variable reference instead of the literal value.')
[Console]::Error.WriteLine('If the value is a placeholder the pattern misread, add it to secrets.ignorePatterns.')
exit 2
