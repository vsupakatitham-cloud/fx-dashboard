#!/bin/zsh
# Commit the latest data and push so GitHub Pages rebuilds.
# No-ops cleanly if there's no remote yet or no data changes.
cd "$(dirname "$0")" || exit 1

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "not a git repo"; exit 0; }
git remote get-url origin >/dev/null 2>&1 || { echo "no 'origin' remote set yet — skipping push"; exit 0; }

# Validation gate (roadmap 0.3): refuse to publish a broken/anomalous snapshot.
# validate.js writes the quarantine file + status.json entry itself; we revert the
# data files to the last published state and push ONLY the status file, so the
# failure is visible remotely but bad data never reaches the site.
if ! node validate.js; then
  echo "validation FAILED — reverting data files, publishing status only"
  git checkout -- data/snapshots.json data/snapshots.js data/snapshots.csv 2>/dev/null
  git add data/status.json 2>/dev/null
  if ! git diff --cached --quiet; then
    git commit -q -m "status: data anomaly — snapshot quarantined, not published"
    git push -q origin main || echo "status push failed"
  fi
  exit 1
fi

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
