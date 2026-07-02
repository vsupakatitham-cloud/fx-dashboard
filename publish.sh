#!/bin/zsh
# Commit the latest data and push so GitHub Pages rebuilds.
# No-ops cleanly if there's no remote yet or no data changes.
cd "$(dirname "$0")" || exit 1

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo"; exit 0; }
git remote get-url origin >/dev/null 2>&1 || { echo "no 'origin' remote set yet — skipping push"; exit 0; }

git add data/snapshots.json data/snapshots.js data/snapshots.csv data/status.json 2>/dev/null
if git diff --cached --quiet; then
  echo "no data changes to publish"
  node status.js merge "{\"push\":{\"ok\":true,\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"detail\":\"no changes\"}}" 2>/dev/null
  exit 0
fi
git commit -q -m "data: update FX snapshots $(date +%F)"
if git push -q origin main; then
  echo "published to GitHub Pages"
  node status.js merge "{\"push\":{\"ok\":true,\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"detail\":\"published\"}}" 2>/dev/null
else
  echo "push failed (check auth/remote)"
  # Only visible locally — a failed push never reaches Pages. Remote detection is
  # via staleness (status.date < today) in the morning routine.
  node status.js merge "{\"push\":{\"ok\":false,\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"detail\":\"push failed\"}}" 2>/dev/null
fi
