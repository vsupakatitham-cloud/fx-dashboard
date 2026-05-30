# Krungthai Travel Card — FX Rate Monitor (multi-source)

Tracks the Krungthai Travel Platinum Mastercard's exchange rates with a **daily
09:00 BKT snapshot**, and compares them against other providers on a
trailing-30-day dashboard. Limited to the 20 currencies Krungthai publishes.

## Sources

| Source | What | How it's read |
|--------|------|---------------|
| **krungthai** | Travel Platinum Mastercard card rates | Playwright → `OneRates` widget |
| **krungsri** | Krungsri Boarding card special rates (16/20 pairs) | Playwright → page table |
| **superrich** | Superrich Thailand money-changer | Public API + static Basic auth |
| **mastercard** | Mastercard network rate (FCY→THB, 0% fee) | ⚠️ **not automated** — see below |

`buy` = provider buys FCY from you (lower); `sell` = provider sells FCY to you (higher).

## Why it's built as a daily collector (important)

These sites only show the **current** rate — there is **no downloadable history**
of past daily 09:00 snapshots. So a "past 30 days" view **cannot be back-filled**;
it is *collected forward*. Each daily run adds one point; the chart fills out over
a month.

Krungthai sits behind Imperva/Incapsula and Krungsri behind a CDN, so plain
`curl` is blocked — the collector drives headless Playwright Chromium for those.
Superrich exposes a JSON API (static credentials the site itself ships).

## Mastercard — manual capture (via your own browser)

Mastercard's converter API is behind **Akamai bot protection**: an automated
(headless) browser gets `403 Access Denied` outright, and even your real browser
is rate-limited if hit too fast (~5 requests, then a multi-minute lockout). So
it can't be part of the unattended daily job — but it *can* be captured from your
own Chrome with gentle pacing.

Mastercard's number is the **network/wholesale rate** (THB per 1 FCY, 0% bank
fee) — a single value per currency, no buy/sell spread. The dashboard plots it
as a dashed *reference* line and excludes it from "best rate" highlighting (you
can't actually transact at the wholesale rate).

**Daily Mastercard step (~90s):**
1. That morning, make sure today's snapshot exists: `node collect.js`.
2. Open the [converter page](https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html).
3. Open the console (Cmd+Option+J), paste the contents of **`mastercard-capture.js`**, Enter.
4. Wait for `DONE` (it copies JSON to your clipboard). Paste into `data/mc-input.json`.
5. Run `node merge-mastercard.js`.

`collect.js` preserves any merged Mastercard block when it re-runs the same day,
so the order (collect → capture → merge) is safe. If some currencies come back
`blocked`, just re-run the snippet a few minutes later — merge only updates
what's present.

## Files

| File | Purpose |
|------|---------|
| `collect.js` | Captures the 3 automated sources, appends one snapshot per BKT day. |
| `mastercard-capture.js` | Browser-console snippet to capture Mastercard rates. |
| `merge-mastercard.js` | Merges `data/mc-input.json` into today's snapshot. |
| `dashboard.html` | The comparison dashboard (open in a browser). |
| `data/snapshots.json` | Source of truth — accumulating daily snapshots (per-source). |
| `data/snapshots.csv` | Same data, long format (date,source,currency,buy,sell). |
| `data/snapshots.js` | Auto-generated shim so the dashboard works via `file://`. |
| `run.sh` | Wrapper launchd calls (sets browser path, logs). |
| `com.jack.ktbfx.plist` | macOS launchd schedule (daily 09:05). |
| `server.js` | Tiny static server for previewing the dashboard. |

### Snapshot schema
```json
{ "date": "2026-05-30", "captured_at_bkt": "2026-05-30 09:05:00",
  "sources": {
    "krungthai": { "ts": "...", "rates": { "USD": {"buy":32.54,"sell":32.59} } },
    "krungsri":  { "ts": null,  "rates": { "USD": {"buy":32.51,"sell":32.60} } },
    "superrich": { "ts": "...", "rates": { "USD": {"buy":32.40,"sell":32.47} } }
  } }
```

## Publish to the internet (GitHub Pages)

The dashboard is fully static, so it hosts on GitHub Pages for free. The repo is
already initialised and committed locally (heavy folders are git-ignored).

**One-time setup:**
1. Create a new **public** repo at https://github.com/new (e.g. `fx-dashboard`).
   Leave it empty — no README/.gitignore.
2. Connect and push (from this folder):
   ```sh
   git remote add origin https://github.com/<your-username>/fx-dashboard.git
   git push -u origin main
   ```
   (First push asks for GitHub auth — use a Personal Access Token as the password,
   or the macOS credential helper / GitHub Desktop.)
3. In the repo: **Settings → Pages → Build and deployment → Source: Deploy from a
   branch → Branch: `main` / `/ (root)` → Save.**
4. Wait ~1 minute. Your dashboard is live at
   `https://<your-username>.github.io/fx-dashboard/`

**Keeping it fresh:** after the daily `collect.js` run, `publish.sh` commits the
new data and pushes — GitHub Pages rebuilds automatically. `run.sh` already calls
`publish.sh`, so once the remote is set the live site updates every morning. (The
Mac still needs to be on for the 09:00 capture, but the *site* stays up always.)

## Daily use

**Capture today's rate manually:**
```sh
cd ~/fx-dashboard
PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node collect.js
```
Re-running on the same day overwrites that day's entry (idempotent).

**View the dashboard** — just open `dashboard.html` in your browser, or:
```sh
node server.js     # then visit http://localhost:8777
```

## Automate the 09:00 BKT capture (macOS launchd)

Your Mac's clock is Bangkok time, so 09:05 local = 09:05 BKT. The job runs
unattended whenever the Mac is powered on (it does **not** need to be awake at
exactly 09:05 — but it does need to be on; laptops asleep at 9am will capture
when next awake only if you switch `RunAtLoad`/`StartInterval` accordingly).

**Activate:**
```sh
cp "/Users/jack/Downloads/Claude-FX Dashboard/com.jack.ktbfx.plist" ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.jack.ktbfx.plist
launchctl start com.jack.ktbfx     # optional: run once now to test
```

**Check / stop:**
```sh
launchctl list | grep ktbfx
tail -f "/Users/jack/Downloads/Claude-FX Dashboard/logs/collect.log"
launchctl unload ~/Library/LaunchAgents/com.jack.ktbfx.plist   # stop
```

## Notes
- Currencies tracked: USD EUR JPY GBP CNY AED AUD CAD CHF DKK HKD INR KRW NOK NZD QAR SAR SEK SGD TWD.
- The dashboard shows the selling rate by default; toggle to buying, switch
  currency, and change the 7/14/30-day window in the UI.
- These are the **card's** rates (tight spread), not the bank counter rates.
