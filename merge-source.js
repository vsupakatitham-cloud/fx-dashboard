#!/usr/bin/env node
/*
 * Merge a generic buy/sell source capture into today's snapshot.
 *
 * Input: data/<source>-input.json  ->  { "ts": "2026-06-19", "rates": { "USD": {"buy":null,"sell":32.9}, ... } }
 * Usage: node merge-source.js <source> [YYYY-MM-DD]
 *
 * Upserts into snap.sources[<source>] so a partial capture accumulates rather than
 * wiping already-captured currencies. Used by K-Journey (KBank debit, sell-only).
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

const source = process.argv[2];
if (!source || !/^[a-z][a-z0-9]*$/.test(source)) { console.error('usage: node merge-source.js <source> [date]'); process.exit(1); }
const date = process.argv[3] || bangkokDate();
const input = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${source}-input.json`), 'utf8'));
const snapshots = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
const snap = snapshots.find((s) => s.date === date);
if (!snap) { console.error(`No snapshot for ${date}. Run collect.js first.`); process.exit(1); }

const prev = snap.sources[source] || {};
const rates = { ...(prev.rates || {}) };
for (const [code, v] of Object.entries(input.rates || {})) {
  if (!KT_SET.has(code) || !v || typeof v !== 'object') continue;
  const buy = isFinite(+v.buy) && +v.buy > 0 ? +v.buy : null;
  const sell = isFinite(+v.sell) && +v.sell > 0 ? +v.sell : null;
  if (buy != null || sell != null) rates[code] = { buy, sell };
}
snap.sources[source] = { ts: input.ts || prev.ts || null, rates };
writeOutputs(snapshots);
console.log(`Merged ${source} into ${date}: ${Object.keys(rates).length} currencies (ts ${input.ts || 'n/a'}).`);
