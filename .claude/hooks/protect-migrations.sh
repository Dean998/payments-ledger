#!/usr/bin/env bash
# PreToolUse hook: refuse edits to migrations that are already committed.
# Applied migrations are history; changing one makes environments diverge.
# Exit code 2 blocks the tool call and shows stderr to the agent.
set -euo pipefail
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input?.file_path??""))')
case "$file" in
  */src/db/migrations/*.sql) ;;
  *) exit 0 ;;
esac
cd "${CLAUDE_PROJECT_DIR:-.}"
rel=${file#"$PWD/"}
if git cat-file -e "HEAD:$rel" 2>/dev/null; then
  echo "Blocked: $rel is a committed migration and must not change. Create a new migration instead (see .claude/skills/new-migration)." >&2
  exit 2
fi
exit 0
