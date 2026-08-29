# Krungthai Travel Card — FX Rate Monitor (multi-source)

Tracks the Krungthai Travel Platinum Mastercard's exchange rates with a **daily
09:00 BKT snapshot**, compared against four other providers. All history is kept
forever (nothing is pruned); the dashboard shows a selectable 7–90 day window.
Limited to the 20 currencies Krungthai publishes.

Live dashboard: https://vsupakatitham-cloud.github.io/fx-dashboard/

## Sources (5)

| Source | What | How it's read |
|--------|------|---------------|
| **krungthai** | Travel Platinum Mastercard card rates | Playwright → `OneRates` widget (Imperva/Incapsula blocks curl) |
| **krungsri** | Krungsri Boarding card special rates (16/20 pairs) | Playwright → page table |
| **superrich** | Superrich Thailand money-changer | Plain fetch of `/th/exchange-rate` — rates embedded in the Next.js payload (`exchangeList`). The old JSON API 404s since 2026-08-28. Denomination rows are outlier-filtered (collectible notes like the SGD 1,000 carry premiums). |
| **kjourney** | KBank K-Journey debit card (sell-only) | Chrome extension scrapes the KBank rate page in your real browser (Akamai blocks headless) → `POST /src` |
| **mastercard** | Mastercard network/wholesale rate (THB per 1 FCY, 0% fee) | Chrome extension captures the converter API in your real browser (Akamai blocks headless) → `POST /mc` |

`buy` = provider buys FCY from you (lower); `sell` = provider sells FCY to you
(higher). K-Journey publishes a selling rate only (`buy: null`). Mastercard is a
single wholesale value (stored `buy == sell`), plotted as a dashed *reference*
line and excluded from "best rate" — you can't transact at it.

## Why it's built as a daily collector (important)

These sites only show the **current** rate — there is **no downloadable
history**. The series **cannot be back-filled**; it is *collected forward*, one
point per day. A missed day is permanent (which is why so much of the design
below is about never missing one).

## Architecture

```
09:00 BKT  launchd com.jack.ktbfx  → run.sh → collect.js   (krungthai, krungsri, superrich)
                                              → validate.js → publish.sh → GitHub Pages
09:00 BKT  Chrome extension alarm  → mastercard capture → POST /mc  ┐
                                   → kbank capture      → POST /src ┤→ server.js merges,
                                                                    ┘  validates, publishes
Safety nets:
  com.jack.ktbfx.catchup (launchd, boot + hourly) — runs the collector if today's
      snapshot is missing past 09:05 (Mac was off at 09:00); snapshot flagged late:true
  run.sh retries collection 3× (launchd can fire on no-network DarkWakes)
  GitHub Actions fallback-collect (daily ~09:05 BKT, often hours late) — captures
      Superrich from the cloud when the Mac is off, so the day isn't empty
  Extension catch-up — on Chrome start/wake past 09:00, runs any capture the server
      says is incomplete (GET /progress = server-truth; tabs capture only missing ccys)
  validate.js — schema + anomaly gate (±10% vs 7-day median); bad data is quarantined
      and never published (status-only commit goes out instead)
  data/status.json — every pipeline step records its result; dashboard shows a
      red/amber health banner; the 09:15 claude.ai routine reads it for the morning push
```

### The Akamai lesson (Mastercard + KBank)

Both are Akamai-protected: headless automation gets 403 outright; even a real
browser is limited to ~5 quick requests per session. The Mastercard capture
therefore runs in **your real Chrome** via the extension, in **fresh-session
groups**: ≤5 currencies, then `location.reload()` for a new Akamai cookie, then
the next group (resumable via `sessionStorage`, progress POSTed incrementally,
capture tabs exempted from Chrome's Memory Saver). KBank shows all currencies in
one table, so its capture is a single page-load scrape — no rate-limit dance.

## Files

| File | Purpose |
|------|---------|
| `collect.js` | Captures the 3 automated sources; preserves extension-merged sources on same-day reruns; flags late catch-ups. |
| `collect-cloud.js` | GitHub Actions fallback — Superrich only, when the Mac is off (`.github/workflows/fallback-collect.yml`). |
| `server.js` | Static dashboard server + capture endpoints: `POST /mc`, `POST /src`, `GET /mc-config`, `GET /progress`. |
| `merge-mastercard.js` / `merge-source.js` | Upsert a capture into today's snapshot (partial captures accumulate, never wipe). |
| `validate.js` | Pre-publish gate: schema + ±10%-vs-median anomaly checks; quarantines to `quarantine/` on failure. |
| `status.js` | Reads/writes `data/status.json` (pipeline health). |
| `should-catchup.js` | Guard for catch-up runs: true only if today's snapshot is missing past 09:05 BKT. |
| `run.sh` | launchd wrapper: normal + `--catchup` modes, collection retries, publish. |
| `publish.sh` | Validation gate → commit data → push (SSH). Status-only publish on quarantine. |
| `com.jack.ktbfx.plist` | launchd: daily 09:00 collector. |
| `com.jack.ktbfx.catchup.plist` | launchd: boot + hourly missed-day catch-up. |
| `com.jack.ktbfx.server.plist` | launchd: keeps `server.js` always running (KeepAlive). |
| `mc-extension/` | Chrome extension (Mastercard + KBank captures, daily alarm + catch-up + toolbar force). |
| `data/mc-config.json` | Server-driven capture tuning (currencies, pacing) — edit takes effect next run, **no extension reload**. |
| `data/snapshots.json` | Source of truth — all daily snapshots, forever. |
| `data/snapshots.csv` / `.js` | Long-format export / dashboard shim. |
| `data/status.json` | Machine-readable pipeline health (published). |
| `dashboard.html` | The dashboard (chart with click-to-focus legend, comparison table, all-currency matrix, health banner). |
| `mastercard-capture.js` | Legacy manual console snippet (fallback only). |
| `ROADMAP.md` | Feature roadmap with acceptance criteria. |

### Snapshot schema
```json
{ "date": "2026-08-29", "captured_at_bkt": "2026-08-29 09:00:05",
  "late": true,            // only on catch-up captures after 09:30
  "fallback": true,        // only on cloud-fallback-created entries
  "sources": {
    "krungthai":  { "ts": "...", "rates": { "USD": {"buy":33.11,"sell":33.16} } },
    "krungsri":   { "ts": null,  "rates": { "USD": {"buy":33.08,"sell":33.17} } },
    "superrich":  { "ts": "...", "rates": { "USD": {"buy":33.05,"sell":33.14} } },
    "kjourney":   { "ts": "...", "rates": { "USD": {"buy":null,"sell":33.22} } },
    "mastercard": { "ts": "2026-08-28", "reference": true,
                    "rates": { "USD": {"buy":33.20,"sell":33.20} } }
  } }
```

## Publishing (GitHub Pages)

Repo `vsupakatitham-cloud/fx-dashboard`, Pages from `main`/root. `publish.sh`
pushes over **SSH using a per-repo deploy key** (`~/.ssh/fx-dashboard_ed25519`
via the `github-fxdash` host alias in `~/.ssh/config`).

> **Do not switch the push back to HTTPS + keychain.** GitHub Desktop overwrites
> the shared `github.com` keychain entry with tokens that can't push, which broke
> the daily publish every morning until the deploy key replaced it. If a push
> ever 403s, check the deploy key still has write access — don't touch the keychain.

## Daily operation (all automatic)

Nothing to do on a normal day. The Mac needs to be on (or powered on at some
point during the day — catch-up handles late starts), Chrome running for the two
browser captures. A claude.ai routine checks the result at 09:15 BKT and sends a
push notification.

**Manual checks:**
```sh
tail -f ~/fx-dashboard/logs/collect.log        # collector + publish log
tail -f ~/fx-dashboard/logs/server.log         # capture endpoint log
node ~/fx-dashboard/status.js show             # pipeline health
launchctl list | grep ktbfx                    # agents loaded?
```

**Force things manually:**
```sh
launchctl kickstart "gui/$(id -u)/com.jack.ktbfx"          # run collector now
launchctl kickstart "gui/$(id -u)/com.jack.ktbfx.catchup"  # catch-up (no-ops if today exists)
# Extension toolbar button = force both browser captures (debounced 90s)
```

> **Project must live outside `~/Downloads`/`~/Desktop`/`~/Documents`** — those
> are macOS TCC-protected and launchd agents are denied access there.

## Extension versioning

After changing extension *code*, bump `mc-extension/manifest.json` and reload the
extension at `chrome://extensions`. Capture *tuning* (currency list, pacing)
lives in `data/mc-config.json` and needs **no reload** — the extension fetches it
each run.

## Notes
- Currencies tracked: USD EUR JPY GBP CNY AED AUD CAD CHF DKK HKD INR KRW NOK NZD QAR SAR SEK SGD TWD.
- A source can miss a currency on a given day if the provider doesn't list it
  (e.g. KBank occasionally omits one) — that's the provider, not a capture bug.
- Dashboard: selling rate by default; 7/14/30/60/90-day windows; click legend
  entries to focus lines (others dim).
- Known permanent gaps: 2026-06-23 (all sources; Mac off, pre-catch-up),
  2026-08-28 (superrich only; their API died mid-transition).
