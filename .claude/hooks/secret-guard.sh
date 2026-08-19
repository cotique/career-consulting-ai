#!/usr/bin/env bash
# PreToolUse (Bash|Edit|Write) + UserPromptSubmit hook — keep credentials out of
# files, commands, and the transcript. Bash twin of secret-guard.ps1.
#
# Two jobs, because the two cases have different remedies:
#
#   PreToolUse       -> BLOCK. A secret about to be written into a file or a
#                       command is preventable, so prevent it.
#   UserPromptSubmit -> WARN only. Once a human has pasted a password into the
#                       chat it is already on disk; blocking the turn would not
#                       unsay it. The value is telling you to rotate it now.
#
# Registering this hook is the opt-in: it runs with sane defaults even without a
# config section, because the cost of missing a leaked key is asymmetric. Tune
# via .claude/discipline.json → "secrets": { "extraPatterns": [...],
# "ignorePatterns": [...], "enabled": false }.
#
# False positives are the real risk — a gate that fires on placeholders teaches
# people to ignore gates — so placeholders and env-var references are ignored.
# deps: jq

set -u
. "$(dirname "$0")/_events.sh"
payload=$(cat)
DISC_SESSION_ID=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
export DISC_SESSION_ID

config=$(disc_config_path)
if [ -f "$config" ] && [ "$(jq -r '.secrets.enabled // "true"' "$config" 2>/dev/null)" = "false" ]; then
  exit 0
fi

prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
if [ -n "$prompt" ]; then
  is_prompt=1
  text="$prompt"
else
  is_prompt=0
  text=$(printf '%s' "$payload" | jq -r '[.tool_input.command, .tool_input.content, .tool_input.new_string, .tool_input.file_text] | map(select(. != null)) | join("\n")' 2>/dev/null)
fi
[ -z "$text" ] && exit 0

ignore_file=$(mktemp); trap 'rm -f "$ignore_file"' EXIT
cat > "$ignore_file" <<'IGN'
(x{3,}|y{3,}|z{3,}|\*{3,}|\.{3,})
(changeme|example|dummy|placeholder|redacted|your[-_]|sample|fake|test[-_]?key|<[^>]{3,}>)
\$\{?[A-Za-z_][A-Za-z0-9_]*\}?
%[A-Za-z_][A-Za-z0-9_]*%
process\.env\.
os\.environ
IGN
if [ -f "$config" ]; then
  jq -r '.secrets.ignorePatterns[]?' "$config" 2>/dev/null >> "$ignore_file"
fi

is_placeholder() {  # $1 = matched sample
  while IFS= read -r ig; do
    [ -z "$ig" ] && continue
    printf '%s' "$1" | grep -Eqi "$ig" && return 0
  done < "$ignore_file"
  return 1
}

hits=""
check() {  # $1 = label, $2 = pattern
  while IFS= read -r sample; do
    [ -z "$sample" ] && continue
    is_placeholder "$sample" || { case "$hits" in *"$1"*) ;; *) hits="${hits}${1}, ";; esac; return 0; }
  done < <(printf '%s' "$text" | grep -Eoi "$2" 2>/dev/null)
}

check 'private key block'       '-----BEGIN [A-Z ]*PRIVATE KEY-----'
check 'AWS access key id'       'AKIA[0-9A-Z]{16}'
check 'GitHub token'            'gh[pousr]_[A-Za-z0-9]{30,}'
check 'Slack token'             'xox[baprs]-[A-Za-z0-9-]{10,}'
check 'Google API key'          'AIza[0-9A-Za-z_-]{35}'
check 'JWT'                     'eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}'
check 'Azure storage key'       'AccountKey[[:space:]]*=[[:space:]]*[A-Za-z0-9+/]{40,}={0,2}'
check 'credential in a URL'     '[a-z][a-z0-9+.-]*://[^:/[:space:]@]+:[^@/[:space:]]{6,}@'
check 'assigned password/token' '(password|passwd|pwd|secret|api[-_]?key|apikey|access[-_]?token|auth[-_]?token|client[-_]?secret)[[:space:]]*[:=][[:space:]]*"?[^[:space:]"'"'"'`,;<>${}%]{8,}'

# Credentials pasted in prose ("the db password is hunter2") — this is how a human
# leaks one in chat, and every code-shaped pattern above misses it. The value must
# look like a secret (contains a digit, or is long) or "the token is invalid" fires.
narrative='(password|passwd|pwd|secret|api[-_ ]?key|apikey|token|credential)[[:space:]]*(is|are|=|:)[[:space:]]*"?[^[:space:]"'"'"'`,;]{8,}'
while IFS= read -r sample; do
  [ -z "$sample" ] && continue
  val=$(printf '%s' "$sample" | sed -E 's/.*(is|are|=|:)[[:space:]]*"?//')
  [ -z "$val" ] && continue
  if ! printf '%s' "$val" | grep -q '[0-9]' && [ ${#val} -lt 16 ]; then continue; fi
  is_placeholder "$val" || { case "$hits" in *'credential in prose'*) ;; *) hits="${hits}credential in prose, ";; esac; }
done < <(printf '%s' "$text" | grep -Eoi "$narrative" 2>/dev/null)

if [ -f "$config" ]; then
  n=0
  while IFS= read -r p; do
    [ -z "$p" ] && continue
    n=$((n + 1))
    check "project pattern $n" "$p"
  done < <(jq -r '.secrets.extraPatterns[]?' "$config" 2>/dev/null)
fi

[ -z "$hits" ] && exit 0
what=${hits%, }

if [ "$is_prompt" -eq 1 ]; then
  disc_log secret-guard warn fail "$what"
  echo "[secret-guard] This message appears to contain a credential ($what)."
  echo "  It is now in the transcript on disk. Treat it as compromised and rotate it."
  echo "  Do not echo it into a file, a command, or a commit. Refer to the secret store"
  echo "  or an environment variable name instead."
  exit 0
fi

if [ "$(disc_mode)" = "shadow" ]; then
  disc_log secret-guard would-block fail "$what"
  echo "[secret-guard] SHADOW (not enforced): credential material in tool input ($what)" >&2
  exit 0
fi
disc_log secret-guard block fail "$what"
{
  echo "[secret-guard] BLOCKED: this would write credential material ($what)."
  echo "Use the secret store or an environment variable reference instead of the literal value."
  echo "If the value is a placeholder the pattern misread, add it to secrets.ignorePatterns."
} >&2
exit 2
