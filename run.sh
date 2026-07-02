#!/bin/zsh
# Wrapper that launchd (or you) calls to capture today's FX snapshot.
# Sets the Playwright browser path and logs each run.
#
# Modes:
#   run.sh            normal daily run (launchd 09:00 calendar trigger)
#   run.sh --catchup  only runs if today's snapshot is missing AND it's past
#                     09:05 BKT (fired by launchd at load + hourly, so a Mac
#                     that was powered off at 09:00 still gets its snapshot)
cd "$(dirname "$0")" || exit 1
# launchd starts with a minimal PATH that lacks node/git — set it explicitly.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.pw-browsers"
mkdir -p logs

if [[ "$1" == "--catchup" ]]; then
  # Guard: exit quietly unless a catch-up is actually needed (see should-catchup.js).
  /usr/bin/env node should-catchup.js >> logs/collect.log 2>&1 || exit 0
  echo "----- CATCH-UP run $(date) -----" >> logs/collect.log
else
  echo "----- run $(date) -----" >> logs/collect.log
fi

/usr/bin/env node collect.js >> logs/collect.log 2>&1
echo "exit: $?" >> logs/collect.log

# Publish fresh data to GitHub Pages (no-ops if no remote is configured yet)
/bin/zsh publish.sh >> logs/collect.log 2>&1
