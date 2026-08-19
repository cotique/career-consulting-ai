#!/usr/bin/env bash
# PostToolUse hook (matcher: Edit|Write) — run a formatter/linter check on the
# file that was just changed and feed violations back to Claude (exit 2).
# The edit itself already happened; exit 2 here is feedback, not a rollback.
#
# stdin:  hook payload JSON ({ tool_input: { file_path: "..." } })
# config: .claude/discipline.json →
#   "format": { "*.cs": "dotnet format --verify-no-changes --include \"{file}\"" }
#   ({file} is replaced with the changed file's path)
# deps: jq

set -u
. "$(dirname "$0")/_events.sh"
payload=$(cat)
DISC_SESSION_ID=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
export DISC_SESSION_ID
file=$(printf '%s' "$payload" | jq -r '.tool_input.file_path // empty' 2>/dev/null)
[ -z "$file" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-.}"
config="$proj/.claude/discipline.json"
[ -f "$config" ] || exit 0

base=$(basename "$file")
while IFS=$'\t' read -r glob check_cmd; do
  [ -z "$check_cmd" ] && continue
  # shellcheck disable=SC2254
  case "$base" in
    $glob)
      run="${check_cmd//\{file\}/$file}"
      if ! out=$(cd "$proj" && eval "$run" 2>&1); then
        if [ "$(disc_mode)" = "shadow" ]; then
          disc_log format-postcheck would-block fail "$file"
          echo "[format-postcheck] SHADOW (not enforced): '$glob' check failed for $file" >&2
          exit 0
        fi
        disc_log format-postcheck block fail "$file"
        {
          echo "[format-postcheck] '$glob' check failed for $file:"
          printf '%s\n' "$out" | tail -n 20
          echo "Fix the formatting/lint violations in the file you just edited."
        } >&2
        exit 2
      fi
      ;;
  esac
done < <(jq -r '.format // {} | to_entries[] | [.key, .value] | @tsv' "$config" 2>/dev/null)

exit 0
