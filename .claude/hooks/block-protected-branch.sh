#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash) — blocks destructive git operations that would
# modify a protected branch.
#
# stdin:  Claude Code hook payload JSON ({ tool_input: { command: "..." } })
# exit 0: allow    exit 2: block (stderr is fed back to Claude)
# deps:   jq, git
#
# Protected branch patterns come from .claude/discipline.json (protectedBranches),
# falling back to: main, master, develop, release/*

set -u
. "$(dirname "$0")/_events.sh"
payload=$(cat)
DISC_SESSION_ID=$(printf '%s' "$payload" | jq -r '.session_id // empty' 2>/dev/null)
export DISC_SESSION_ID
cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // empty' 2>/dev/null)
[ -z "$cmd" ] && exit 0
case "$cmd" in *git*) ;; *) exit 0 ;; esac

proj="${CLAUDE_PROJECT_DIR:-.}"
config="$proj/.claude/discipline.json"
branches=""
block_all_push=""
if [ -f "$config" ]; then
  branches=$(jq -r '.protectedBranches[]?' "$config" 2>/dev/null)
  block_all_push=$(jq -r 'if .blockAllPush then "1" else "" end' "$config" 2>/dev/null)
fi
[ -z "$branches" ] && branches=$'main\nmaster\ndevelop\nrelease/*'

is_protected() {
  local b="$1" pat
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    # shellcheck disable=SC2254
    case "$b" in $pat) return 0 ;; esac
  done <<< "$branches"
  return 1
}

block() {
  if [ "$(disc_mode)" = "shadow" ]; then
    # Shadow: record what would have been stopped, let it through. One window of
    # this proves the gate's value before it can annoy anyone.
    disc_log block-protected-branch would-block fail "$1"
    echo "[block-protected-branch] SHADOW (not enforced): $1" >&2
    exit 0
  fi
  disc_log block-protected-branch block fail "$1"
  echo "[block-protected-branch] BLOCKED: $1" >&2
  echo "Create or switch to a feature branch, then retry." >&2
  exit 2
}

current=$(git -C "$proj" rev-parse --abbrev-ref HEAD 2>/dev/null || true)

# 1. History-modifying commands while ON a protected branch.
if [ -n "$current" ] && is_protected "$current"; then
  if printf '%s' "$cmd" | grep -Eq '\bgit\b[^|;&]*\b(commit|merge|rebase|cherry-pick|revert)\b|\bgit\b[^|;&]*\breset\b[^|;&]*--hard'; then
    block "current branch '$current' is protected — refusing to modify it directly"
  fi
fi

# 2. git push targeting a protected branch (refspecs, deletes, --force).
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^|;&]*\bpush\b'; then
  # blockAllPush: any push is a human decision. Undoing a push on a shared
  # branch costs a force-push and other people's time — the asymmetry, not the
  # branch name, is the reason this option exists.
  [ -n "$block_all_push" ] && block 'blockAllPush is set — pushing is a human action; ask the user to push'

  # Candidate destination refs: bare args and the dst side of src:dst refspecs.
  while IFS= read -r tok; do
    [ -z "$tok" ] && continue
    dst="${tok##*:}"                      # refspec dst (or the token itself)
    dst="${dst#+}"
    dst="${dst#refs/heads/}"
    if [ -n "$dst" ] && is_protected "$dst"; then
      block "push targets protected branch '$dst'"
    fi
    # 'git push origin :branch' / '--delete branch' — dst is empty, src is the victim
    if [ "${tok#:}" != "$tok" ] || printf '%s' "$cmd" | grep -q -- '--delete'; then
      src="${tok%%:*}"; src="${src#:}"
      [ -n "$src" ] && is_protected "$src" && block "push would delete protected branch '$src'"
    fi
  done < <(printf '%s' "$cmd" | tr ' ' '\n' | grep -vE '^-|^$|^git$|^push$' | tail -n +2)

  # Bare 'git push [--force]' pushes the current branch.
  if [ -n "$current" ] && is_protected "$current"; then
    block "push from protected branch '$current'"
  fi
fi

# 3. Deleting a protected branch locally.
if printf '%s' "$cmd" | grep -Eq '\bgit\b[^|;&]*\bbranch\b[^|;&]*(-D|-d|--delete)'; then
  while IFS= read -r tok; do
    [ -z "$tok" ] && continue
    is_protected "$tok" && block "deleting protected branch '$tok'"
  done < <(printf '%s' "$cmd" | tr ' ' '\n' | grep -vE '^-|^$|^git$|^branch$')
fi

exit 0
