# FX Dashboard — 10x Roadmap

*Drafted 2026-07-02, against the codebase as of `6bf4d97` (33 days of data, 5 sources).*

## Where we are

A working personal FX monitor: daily 09:00 BKT snapshot of 5 sources (Krungthai,
Krungsri, Superrich, K-Journey, Mastercard wholesale), captured via launchd +
Playwright + a Chrome extension for the two Akamai-blocked sources, published to
GitHub Pages, with a claude.ai routine confirming each morning. ~1,000 LOC, no
framework, no database — deliberately simple, and stable for ~3 weeks.

**What "10x" means here.** The current product answers *"what are the rates
today?"* The 10x version answers *"what should I do, and can I trust the data
under my decision?"* — without adding operational burden. Value therefore comes
from four axes, in priority order:

1. **Trust** — no silent gaps, no silently-wrong data (June 23 is already missing
   because the Mac was off; bank rates are unrecoverable once missed).
2. **Actionability** — alerts and recommendations instead of a chart to stare at.
3. **Coverage** — more cards/sources, and historical depth where backfill is possible.
4. **Reach** — the data meets you where you are (phone, LINE), not only in a browser tab.

---

## Phase 0 — Trust: make every day's data exist and be right

### 0.1 Missed-day catch-up (the June-23 problem)
The launchd job fires at 09:00; if the Mac is asleep it catches up on wake, but if
it's **powered off** the day is lost forever (bank rates aren't backfillable).

- **Build:** a `RunAtLoad`/boot-time guard in `run.sh`: on any start, if today's
  (BKT) snapshot is missing and the time is past 09:00, run the full pipeline
  immediately. The extension side already self-guards per-day (`lastRun` keys);
  add the same "catch up on Chrome launch" alarm check for both captures.
- **Acceptance criteria:**
  - Power the Mac on at any time after 09:00 on a day with no snapshot → within
    5 minutes a snapshot for that day exists with ≥3 sources and is pushed.
  - Launch Chrome after such a catch-up → Mastercard + K-Journey blocks fill in
    without any manual action.
  - A deliberately skipped day (Mac off from 08:00 to 14:00) produces a 14:0x
    snapshot, flagged `late: true` in the JSON so the dashboard can annotate it.

### 0.2 Cloud fallback collector (partial beats nothing)
Two sources need no browser at all: Superrich (plain API) and any future
reference feed. A **GitHub Actions cron** (02:05 UTC = 09:05 BKT) can capture
those even when the Mac is dead, committing a partial snapshot the local
pipeline upserts into later.

- **Build:** `.github/workflows/fallback-collect.yml` + a trimmed `collect-cloud.js`
  (superrich only); merge logic already upserts, so no schema change. Test whether
  Krungthai's Incapsula tolerates GitHub's IPs — if yes, add it; if not, document it.
- **Acceptance criteria:**
  - With the Mac off all day, the day's snapshot still exists with ≥1 source by 09:15 BKT.
  - A later local run the same day *adds* the missing sources without overwriting
    the cloud-captured ones (verified by a same-day rerun test).
  - Action failures produce a visible GitHub Actions failure (email from GitHub).

### 0.3 Anomaly & schema guard before publish
A silent scraper break (layout change, TH/EN text swap) currently publishes
garbage or zeros with a green "ready" notification.

- **Build:** a `validate.js` gate in `publish.sh`: schema check (every rate
  finite, > 0), sanity check (each rate within ±10% of the 7-day median for that
  source+ccy), and source-count check. On violation: still commit to a
  `quarantine/` file, **don't** publish, and mark `status.json` unhealthy.
- **Acceptance criteria:**
  - Feeding a snapshot with USD sell = 0, or = 3.2 (10x off) → publish refused,
    quarantine file written, exit non-zero.
  - Normal day passes with zero added latency (< 1s).
  - The 09:15 cloud routine reports the quarantine state ("data anomaly — not
    published") instead of "ready".

### 0.4 Health status as data (`status.json`)
The morning routine infers health from the published snapshot only. Publish an
explicit machine-readable status the routine (and dashboard banner) can read.

- **Build:** every pipeline step appends to `data/status.json` (collector result,
  per-source counts, push result, validation verdict, timestamps). Dashboard
  banner turns amber/red from it. Cloud routine reads it instead of re-deriving.
- **Acceptance criteria:**
  - Each of these failure modes yields a distinct, correct status within one run:
    collector crash, one source empty, push 403, validation quarantine, server
    agent down (heartbeat stale > 26h).
  - The dashboard shows a red banner within one refresh of any unhealthy status.

---

## Phase 1 — Actionability: from chart to decisions

### 1.1 Rate alerts (LINE first)
"Tell me when USD sell < 32.50 at any card" / "when K-Journey beats Krungthai by
> 0.1%". LINE is the natural channel in Thailand (Messaging API push is free at
this volume); claude.ai push stays as backup.

- **Build:** `data/alerts.json` (rules), evaluated at the end of each daily run;
  a small `notify-line.js` using a LINE Messaging API channel token (user
  supplies once). Rules: threshold (ccy, source|best, op, value) and cross-source
  margin. Cooldown so an alert fires once per condition-entry, not daily.
- **Acceptance criteria:**
  - A rule `USD best-sell < X` set just above the current best triggers exactly
    one LINE message on the next run where it's true, and none the following day
    if still true (until it resets above the threshold).
  - Malformed rules are rejected with a clear error at load, not at 09:00.
  - End-to-end latency from snapshot commit to LINE delivery < 60s.

### 1.2 "Exchange today?" percentile indicator
For the selected currency: where does today's best sell rate sit vs the trailing
window (30/60/90d)? A simple percentile chip ("today is better than 82% of the
last 60 days") turns the chart into a decision.

- **Build:** dashboard-only computation over the existing series; chip + sparkline
  next to the comparison table; grey-out when < 14 days of history for the pair.
- **Acceptance criteria:**
  - Chip shows percentile and direction arrow for every ccy with ≥14 days of data.
  - Hand-computed percentile for 3 spot-checked ccys matches the chip exactly.
  - Renders with no console errors and < 50ms added render time (measured).

### 1.3 Savings calculator + source win-rate analytics
"Spending ฿30,000 in Japan next week — which card, and how much does the choice
matter?" Plus a standing answer to "who usually wins?"

- **Build:** a panel: amount input × selected ccy → per-source cost, spread vs
  best, and vs Mastercard wholesale as the fee-free baseline. A win-rate table
  (last 30/60/90d): % of days each source was best per ccy, average margin vs
  the wholesale reference.
- **Acceptance criteria:**
  - For a given amount/ccy the panel's arithmetic matches a manual calc to 4dp.
  - Win-rate table totals 100% per ccy/window (ties split), Mastercard excluded
    from "best" (it isn't transactable) but shown as baseline.
  - Both features work on mobile viewport (375px) without horizontal scroll.

---

## Phase 2 — Coverage: more sources, deeper history

### 2.1 New card sources (the generic pipeline earns its keep)
The `/src` endpoint + `merge-source.js` + collect.js preservation fix mean a new
browser-captured source is ~1 content script + 1 SRC_META line. Candidates, in
rough order of value to a Thai travel-card user:
- **SCB Planet** (the other major Thai travel card)
- **TTB All Free / Bangkok Bank Be1st** (debit FX)
- **Wise / YouTrip / Revolut** (SGD/regional multi-currency cards — natural
  benchmark set; Wise has a public API which needs no browser at all)

- **Acceptance criteria (per source):**
  - Appears in SRC_META/SRC_ORDER with a distinct colour; renders in chart,
    comparison, matrix; buy/sell or sell-only handled correctly (`—` for absent).
  - Captured automatically at 09:00 with its own once-a-day guard; a fully-missed
    day self-reports in `status.json` rather than silently showing stale data.
  - Terms check documented in README (as done for Reuters/KBank) before enabling.

### 2.2 Mastercard historical backfill
Unique opportunity: Mastercard's API accepts an explicit `fxDate` — the **one
source whose history is fetchable**. Backfill the wholesale reference line to
well before 2026-05-30 to give every percentile/trend feature real depth.

- **Build:** an extension "backfill mode" (config-driven date range) reusing the
  fresh-session capture: N dates × majors, heavily paced, resumable, POSTing to a
  `/backfill` endpoint that writes into historical snapshot entries (creating
  date-only entries where no local snapshot exists, flagged `partial: true`).
- **Acceptance criteria:**
  - 90 days of USD/EUR/JPY wholesale history present and charted (dashed line
    extends left of 2026-05-30; other sources simply absent there).
  - Backfill run never disturbs current-day capture (guards + separate endpoint),
    and is resumable after an Akamai ban with no duplicate entries.
  - Spot-check 5 random backfilled dates against the Mastercard site manually.

### 2.3 Bank of Thailand official reference line
The authoritative THB fix, free API (one-time key registration by user). Gives
the dashboard an "official" anchor alongside the wholesale line.

- **Acceptance criteria:** daily BOT mid rate for all covered ccys it publishes,
  rendered as a second dashed reference; documented key-renewal procedure;
  pipeline unaffected when the API is down (source simply absent + status noted).

---

## Phase 3 — Reach: the data comes to you

### 3.1 Mobile PWA + per-currency deep links
- **Build:** manifest + service worker (cache-first shell, network-first data),
  `?ccy=JPY&win=60` URL state, add-to-home-screen.
- **Acceptance criteria:** Lighthouse PWA installable; opening `?ccy=JPY` lands
  on JPY directly; works offline showing last-cached data with a "stale" banner.

### 3.2 Weekly LINE/email digest
- **Build:** extend the cloud routine (or a second one, Sundays): week's range
  per followed ccy, best source of the week, notable moves (> 1%), gap days.
- **Acceptance criteria:** one message per week, correct week boundaries (BKT),
  numbers reproducible from snapshots.json; silent weeks (no data) alert instead.

### 3.3 Formal data access
- **Build:** document `snapshots.json`/`.csv` as a stable public schema
  (versioned), add `data/schema.json`, and a tiny `/api/latest` convenience
  route on the Pages site (static JSON regenerated each publish).
- **Acceptance criteria:** README data dictionary; schema version bumps on any
  breaking change; external `curl` of the Pages JSON returns today's data.

---

## Sequencing & effort

| Order | Item | Effort | Depends on |
|---|---|---|---|
| 1 | 0.1 Missed-day catch-up | S | — |
| 2 | 0.4 status.json | S | — |
| 3 | 0.3 Anomaly guard | M | 0.4 |
| 4 | 0.2 Cloud fallback | M | 0.4 |
| 5 | 1.1 LINE alerts | M | 0.4 (uses status), user LINE token |
| 6 | 1.2 Percentile chip | S | — |
| 7 | 1.3 Calculator + win-rate | M | — |
| 8 | 2.2 Mastercard backfill | M | — (big data payoff for 1.2/1.3) |
| 9 | 2.1 New sources (1–2 first: SCB Planet, Wise) | M each | — |
| 10 | 2.3 BOT reference | S | user API key |
| 11 | 3.1 PWA | M | — |
| 12 | 3.2 Weekly digest | S | 1.1 channel |
| 13 | 3.3 Data API/schema | S | — |

*S ≈ an hour or two of focused work; M ≈ an afternoon. Nothing here needs a
framework, database, or hosting change — the flat-file + Pages architecture
holds up through all of it.*

## Honest constraints carried forward

- Bank sources remain **non-backfillable**; only Mastercard (2.2) and BOT have
  history. Every missed day of the card sources is permanent — which is why
  Phase 0 outranks every shiny feature.
- Mastercard/K-Journey (and likely SCB Planet) captures stay tied to the user's
  real Chrome on a running Mac; the cloud fallback (0.2) mitigates but cannot
  replace them.
- LINE alerts and BOT need one-time credentials from the user.
- Reuters remains out: bot-blocked, terms-prohibited, paid feed.
