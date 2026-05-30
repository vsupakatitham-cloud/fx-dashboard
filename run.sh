#!/bin/zsh
# Wrapper that launchd (or you) calls to capture today's FX snapshot.
# Sets the Playwright browser path and logs each run.
cd "$(dirname "$0")" || exit 1
# launchd starts with a minimal PATH that lacks node/git — set it explicitly.
export PATH="/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
export PLAYWRIGHT_BROWSERS_PATH="$(pwd)/.pw-browsers"
mkdir -p logs
echo "----- run $(date) -----" >> logs/collect.log
/usr/bin/env node collect.js >> logs/collect.log 2>&1
echo "exit: $?" >> logs/collect.log

# Publish fresh data to GitHub Pages (no-ops if no remote is configured yet)
/bin/zsh publish.sh >> logs/collect.log 2>&1
