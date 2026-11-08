#!/usr/bin/env bash
# Run Prettier in the WSL dev clone (which has node_modules) and copy every file it changed back to
# the Windows worktree, where commits are made. Run through w.sh so the clone matches the branch:
#   wsl -d Ubuntu -e bash .../infra/scripts/w.sh --branch <branch> "bash infra/scripts/format-back.sh <windows-worktree-path>"
set -euo pipefail
DEST="${1:?windows worktree path, e.g. /mnt/f/Projects/Techrida/Business-OS/bos-p0}"
pnpm exec prettier --write . --log-level warn
changed=$(git diff --name-only)
[ -z "$changed" ] && { echo "format-back: nothing to change"; exit 0; }
while IFS= read -r f; do cp "$f" "$DEST/$f"; done <<<"$changed"
echo "format-back: copied $(wc -l <<<"$changed") formatted file(s) to $DEST"
git checkout -q -- .
