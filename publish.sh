#!/bin/zsh
# Commit the latest data and push so GitHub Pages rebuilds.
# No-ops cleanly if there's no remote yet or no data changes.
cd "$(dirname "$0")" || exit 1

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo"; exit 0; }
git remote get-url origin >/dev/null 2>&1 || { echo "no 'origin' remote set yet — skipping push"; exit 0; }

git add data/snapshots.json data/snapshots.js data/snapshots.csv
if git diff --cached --quiet; then
  echo "no data changes to publish"
  exit 0
fi
git commit -q -m "data: update FX snapshots $(date +%F)"
if git push -q origin main; then echo "published to GitHub Pages"; else echo "push failed (check auth/remote)"; fi
