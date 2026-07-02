#!/usr/bin/env node
/*
 * Cloud fallback collector (roadmap 0.2) — runs in GitHub Actions, not on the Mac.
 *
 * Purpose: when the Mac is powered off at 09:00 BKT, the browser-based sources are
 * unavoidably lost for the day, but Superrich is a plain HTTPS API — capture at
 * least that, so the day has SOME data. A partial snapshot beats an empty day,
 * and the local catch-up (run.sh --catchup + extension) fills in the rest when
 * the Mac powers on.
 *
 * Behaviour:
 *   - If today's (BKT) snapshot already exists AND has superrich -> exit 0, no-op
 *     (the local pipeline already ran; never fight it).
 *   - Otherwise fetch Superrich, upsert ONLY sources.superrich into today's entry
 *     (creating the entry with fallback:true if it doesn't exist), rewrite the
 *     three data files, and record status. The workflow then commits + pushes.
 *
 * Testing: TEST_DATE=YYYY-MM-DD fakes "today"; DRY_RUN=1 skips all writes.
 * No dependencies — plain Node 18+ (global fetch).
 */
const fs = require('fs');
const path = require('path');

const KT_SET = new Set(['USD','EUR','JPY','GBP','CNY','AED','AUD','CAD','CHF','DKK','HKD','INR','KRW','NOK','NZD','QAR','SAR','SEK','SGD','TWD']);
const SUPERRICH_URL = 'https://www.superrichthailand.com/web/api/v1/rates';
const SUPERRICH_AUTH = 'Basic c3VwZXJyaWNoVGg6aFRoY2lycmVwdXM='; // static creds the site ships
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const DATA_DIR = path.join(__dirname, 'data');
const JSON_PATH = path.join(DATA_DIR, 'snapshots.json');
const JS_PATH = path.join(DATA_DIR, 'snapshots.js');
const CSV_PATH = path.join(DATA_DIR, 'snapshots.csv');
const DRY = !!process.env.DRY_RUN;

function bkkNow() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// Same output writer as collect.js / merge-source.js (kept dependency-free here).
function writeOutputs(snapshots) {
  fs.writeFileSync(JSON_PATH, JSON.stringify(snapshots, null, 2));
  fs.writeFileSync(JS_PATH, 'window.FX_SNAPSHOTS = ' + JSON.stringify(snapshots) + ';\n');
  const lines = ['date,captured_at_bkt,source,source_ts,currency,buy,sell'];
  for (const s of snapshots) for (const src of Object.keys(s.sources)) {
    const blk = s.sources[src];
    for (const code of Object.keys(blk.rates || {})) {
      const r = blk.rates[code];
      lines.push([s.date, s.captured_at_bkt, src, blk.ts || '', code, r.buy ?? '', r.sell ?? ''].join(','));
    }
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

(async () => {
  const now = bkkNow();
  const today = process.env.TEST_DATE || now.date;

  let snapshots = [];
  try { snapshots = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch (e) { /* fresh start */ }
  const existing = snapshots.find((s) => s.date === today);

  if (existing && existing.sources && existing.sources.superrich) {
    console.log(`fallback: ${today} already has superrich (local pipeline ran) — nothing to do`);
    return;
  }

  console.log(`fallback: ${today} ${existing ? 'exists but lacks superrich' : 'has NO snapshot'} — fetching Superrich…`);
  const res = await fetch(SUPERRICH_URL, { headers: { Authorization: SUPERRICH_AUTH, Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error('superrich HTTP ' + res.status);
  const json = await res.json();
  const rates = {};
  let ts = null;
  for (const row of (json.data?.exchangeRate || [])) {
    const code = (row.cUnit || '').trim();
    const r0 = (row.rate || [])[0];
    if (!r0) continue;
    const buy = r0.cBuying ?? r0.cBuy1, sell = r0.cSelling ?? r0.cSell1;
    if (KT_SET.has(code) && isFinite(buy) && isFinite(sell)) rates[code] = { buy: +buy, sell: +sell };
    if (!ts && r0.dateTime) ts = r0.dateTime;
  }
  if (!Object.keys(rates).length) throw new Error('superrich returned no usable rates');
  console.log(`fallback: superrich ${Object.keys(rates).length} pairs (ts ${ts})`);

  if (DRY) { console.log('fallback: DRY_RUN — would', existing ? 'add superrich to existing entry' : 'create new fallback entry', `for ${today}; no writes`); return; }

  if (existing) {
    existing.sources.superrich = { ts, rates };
  } else {
    snapshots.push({ date: today, captured_at_bkt: `${today} ${now.time}`, fallback: true, sources: { superrich: { ts, rates } } });
    snapshots.sort((a, b) => a.date.localeCompare(b.date));
  }
  writeOutputs(snapshots);
  try {
    require('./status').merge({ cloud_fallback: { at: new Date().toISOString(), date: today, count: Object.keys(rates).length } });
  } catch (e) { /* best effort */ }
  console.log(`fallback: wrote ${today} snapshot (superrich only, fallback:true=${!existing ? 'yes' : 'no'})`);
})().catch((e) => { console.error('fallback collector failed:', e.message); process.exit(1); });
