#!/usr/bin/env bash
# PostToolUse hook: format and lint the TypeScript file that was just edited.
# Problems are printed to stderr with exit code 2, which Claude Code feeds
# back to the agent so it fixes them right away instead of at the end.
set -uo pipefail
file=$(node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).tool_input?.file_path??""))')
case "$file" in
  *.ts) ;;
  *) exit 0 ;;
esac
cd "${CLAUDE_PROJECT_DIR:-.}"
npx --no-install prettier --write "$file" >/dev/null 2>&1
if ! out=$(npx --no-install eslint --max-warnings=0 "$file" 2>&1); then
  echo "ESLint found problems in $file:" >&2
  echo "$out" >&2
  exit 2
fi
exit 0
