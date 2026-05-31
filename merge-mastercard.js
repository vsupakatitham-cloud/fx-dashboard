#!/usr/bin/env node
/*
 * Merge a manual Mastercard capture into the daily snapshot.
 *
 * Mastercard's rate is the network/wholesale rate (THB per 1 FCY, 0% bank fee) —
 * a single number per currency, no buy/sell spread. We store it as buy==sell so
 * it slots into the same schema, and the dashboard treats it as a reference line.
 *
 * Input: data/mc-input.json  ->  { "fxDate": "2026-05-29", "rates": { "USD": 32.78, ... } }
 * Optionally pass a target date as argv[2] (defaults to today, Asia/Bangkok).
 *
 * Usage:  node merge-mastercard.js [YYYY-MM-DD]
 */
const fs = require('fs');
const path = require('path');

const KT_SET = new Set(['USD','EUR','JPY','GBP','CNY','AED','AUD','CAD','CHF','DKK','HKD','INR','KRW','NOK','NZD','QAR','SAR','SEK','SGD','TWD']);
const DATA_DIR = path.join(__dirname, 'data');
const JSON_PATH = path.join(DATA_DIR, 'snapshots.json');
const CSV_PATH = path.join(DATA_DIR, 'snapshots.csv');
const JS_PATH = path.join(DATA_DIR, 'snapshots.js');

function bangkokDate() {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return `${p.year}-${p.month}-${p.day}`;
}

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

const date = process.argv[2] || bangkokDate();
const input = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'mc-input.json'), 'utf8'));
const snapshots = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const snap = snapshots.find((s) => s.date === date);
if (!snap) { console.error(`No snapshot for ${date}. Run collect.js first.`); process.exit(1); }

// Upsert into any existing Mastercard block rather than replacing it — so a
// partial capture (some currencies blocked by Akamai) never wipes out currencies
// that an earlier capture the same day already got.
const prev = snap.sources.mastercard || {};
const rates = { ...(prev.rates || {}) };
for (const [code, v] of Object.entries(input.rates || {})) {
  const val = +v;
  if (KT_SET.has(code) && isFinite(val)) rates[code] = { buy: val, sell: val };
}
snap.sources.mastercard = { ts: input.fxDate || prev.ts || null, reference: true, rates };
writeOutputs(snapshots);
console.log(`Merged Mastercard into ${date}: ${Object.keys(rates).length} currencies (fxDate ${input.fxDate || 'n/a'}).`);
