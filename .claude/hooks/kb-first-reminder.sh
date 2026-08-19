#!/usr/bin/env bash
# UserPromptSubmit hook — when the prompt looks like a research/explanation
# question about this project's domain, remind Claude to query the knowledge
# base before reading code. Soft signal: stdout is appended as context, always
# exits 0.
#
# stdin:  hook payload JSON ({ prompt: "..." })
# config: .claude/discipline.json →
#   "kb": { "toolName": "my-kb-mcp", "projectTerms": ["billing", "checkout"] }
# deps: jq

set -u
. "$(dirname "$0")/_events.sh"
payload=$(cat)
DISC_SESSION_ID=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
export DISC_SESSION_ID
prompt=$(printf '%s' "$payload" | jq -r '.prompt // empty' 2>/dev/null)
[ -z "$prompt" ] && exit 0

proj="${CLAUDE_PROJECT_DIR:-.}"
config="$proj/.claude/discipline.json"
[ -f "$config" ] || exit 0

tool=$(jq -r '.kb.toolName // empty' "$config" 2>/dev/null)
[ -z "$tool" ] && exit 0

lower=$(printf '%s' "$prompt" | tr '[:upper:]' '[:lower:]')

# Looks like a research question? Override via kb.triggerPattern when your
# prompts aren't English.
pattern=$(jq -r '.kb.triggerPattern // empty' "$config" 2>/dev/null)
[ -z "$pattern" ] && pattern='\b(how|why|what|where|when|which|explain|history|architecture|flow|behavio(u)?r)\b|\?'
printf '%s' "$lower" | grep -Eq "$pattern" || exit 0

# Mentions a project term?
hit=0
while IFS= read -r term; do
  [ -z "$term" ] && continue
  case "$lower" in *"$(printf '%s' "$term" | tr '[:upper:]' '[:lower:]')"*) hit=1; break ;; esac
done < <(jq -r '.kb.projectTerms[]?' "$config" 2>/dev/null)
[ "$hit" -eq 0 ] && exit 0

# Advisory asset: the event records that the nudge fired. Whether the nudged
# behavior followed is measured downstream, not here.
disc_log kb-first-reminder nudge fired
cat <<EOF
[kb-first-reminder] This looks like a research question about this project.
Query the '$tool' knowledge base FIRST, before opening code files. Go to code
only if the KB answer is incomplete or potentially stale.
EOF
exit 0
