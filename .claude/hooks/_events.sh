# Shared event logging for the pack's hooks. Not a hook itself — sourced by them.
#
# Guardrails nobody measures decay into folklore. Every hook appends one line per
# firing so adoption, intercepts and cost become queries instead of transcript
# archaeology.
#
# config: .claude/discipline.json →
#   "mode": "enforce" | "shadow",     # shadow: blocking hooks log but allow
#   "events": { "enabled": true, "path": ".claude/discipline-events.jsonl" }
# Events default to ON (a log nobody enabled is a log nobody has); mode defaults
# to enforce.
#
# Usage:
#   . "$(dirname "$0")/_events.sh"
#   disc_mode                       -> echoes "enforce" | "shadow"
#   disc_log <asset> <event> <verdict> [detail] [durationMs]

disc_config_path() { echo "${CLAUDE_PROJECT_DIR:-.}/.claude/discipline.json"; }

disc_mode() {
  local c; c=$(disc_config_path)
  local m=""
  [ -f "$c" ] && m=$(jq -r '.mode // empty' "$c" 2>/dev/null)
  case "$m" in shadow) echo shadow ;; *) echo enforce ;; esac
}

disc_json_escape() {
  # Escape for a JSON string value; keeps the log parseable when commands
  # contain quotes, backslashes or newlines.
  printf '%s' "$1" | jq -Rs '.' 2>/dev/null || printf '""'
}

disc_log() {
  local asset="$1" event="$2" verdict="$3" detail="${4:-}" duration="${5:-}"
  local c; c=$(disc_config_path)
  [ -f "$c" ] || return 0

  local enabled path
  enabled=$(jq -r 'if .events.enabled == false then "no" else "yes" end' "$c" 2>/dev/null)
  [ "$enabled" = "no" ] && return 0
  path=$(jq -r '.events.path // ".claude/discipline-events.jsonl"' "$c" 2>/dev/null)
  case "$path" in /*|?:*) ;; *) path="${CLAUDE_PROJECT_DIR:-.}/$path" ;; esac

  local ts session line
  ts=$(date -u +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)
  session="${DISC_SESSION_ID:-}"
  line="{\"ts\":\"$ts\",\"asset\":\"$asset\",\"event\":\"$event\",\"verdict\":\"$verdict\",\"mode\":\"$(disc_mode)\""
  [ -n "$session" ] && line="$line,\"sessionId\":$(disc_json_escape "$session")"
  [ -n "$detail" ] && line="$line,\"detail\":$(disc_json_escape "$detail")"
  [ -n "$duration" ] && line="$line,\"durationMs\":$duration"
  line="$line}"

  mkdir -p "$(dirname "$path")" 2>/dev/null
  printf '%s\n' "$line" >> "$path" 2>/dev/null || true
  return 0
}
