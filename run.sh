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

# Collect with retries: launchd fires missed 09:00 runs on WAKE, including
# DarkWakes that have no network (seen 2026-07-12: all sources
# ERR_INTERNET_DISCONNECTED, run burned). Retrying with a pause rides out
# no-network wakes — if the Mac goes back to sleep mid-sleep, the retry resumes
# (with network) on the next real wake.
attempt=1
while true; do
  /usr/bin/env node collect.js >> logs/collect.log 2>&1
  rc=$?
  echo "exit: $rc" >> logs/collect.log
  [[ $rc -eq 0 ]] && break
  if (( attempt >= 3 )); then
    echo "collect failed after ${attempt} attempts — giving up (hourly catch-up will retry)" >> logs/collect.log
    break
  fi
  attempt=$((attempt+1))
  echo "collect failed — retrying (attempt ${attempt}) in 180s" >> logs/collect.log
  sleep 180
done

# Publish fresh data to GitHub Pages (no-ops if no remote is configured yet)
/bin/zsh publish.sh >> logs/collect.log 2>&1
