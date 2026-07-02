#!/usr/bin/env node
/*
 * Pre-publish validation gate (roadmap 0.3).
 *
 * Validates TODAY's (Asia/Bangkok) snapshot before publish.sh is allowed to commit:
 *   1. Schema  — every rate has buy/sell that are each null or a finite number > 0,
 *                not both null; currency codes are A-Z{3}; snapshot has date/sources.
 *   2. Anomaly — each rate within ±10% of the median of that source+ccy+side over
 *                the prior 7 calendar entries (enforced only when ≥3 prior values
 *                exist, so new sources/currencies aren't false-flagged).
 *
 * On violation: writes quarantine/<date>-<ts>.json (the offending snapshot + the
 * issue list), records {validation:{ok:false,issues}} in data/status.json, and
 * exits 1 — publish.sh then reverts the data files to HEAD and publishes ONLY the
 * status file, so bad data never reaches the site but the failure is visible.
 * On pass: records {validation:{ok:true}} and exits 0.
 *
 * Testing: --file <path> validates an alternate snapshots file; --date YYYY-MM-DD
 * overrides "today"; --dry skips quarantine/status writes.
 */
const fs = require('fs');
const path = require('path');

const KT_SET = new Set(['USD','EUR','JPY','GBP','CNY','AED','AUD','CAD','CHF','DKK','HKD','INR','KRW','NOK','NZD','QAR','SAR','SEK','SGD','TWD']);
const TOLERANCE = 0.10;   // ±10% vs recent median
const MIN_HISTORY = 3;    // prior values needed before anomaly check applies

function arg(name) { const i = process.argv.indexOf(name); return i > -1 ? process.argv[i + 1] : null; }
const FILE = arg('--file') || path.join(__dirname, 'data', 'snapshots.json');
const DRY = process.argv.includes('--dry');

function bkkToday() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

const today = arg('--date') || bkkToday();
let snapshots;
try { snapshots = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) {
  console.error('validate: cannot read snapshots:', e.message); process.exit(1);
}

const snap = snapshots.find((s) => s.date === today);
if (!snap) { console.log(`validate: no snapshot for ${today} — nothing to validate`); process.exit(0); }

const issues = [];

// --- 1. schema ---
if (!snap.sources || !Object.keys(snap.sources).length) issues.push('snapshot has no sources');
for (const [src, blk] of Object.entries(snap.sources || {})) {
  if (!blk || typeof blk.rates !== 'object') { issues.push(`${src}: missing rates object`); continue; }
  if (!Object.keys(blk.rates).length) issues.push(`${src}: zero currencies`);
  for (const [ccy, r] of Object.entries(blk.rates)) {
    if (!/^[A-Z]{3}$/.test(ccy)) { issues.push(`${src}.${ccy}: bad currency code`); continue; }
    if (!KT_SET.has(ccy)) issues.push(`${src}.${ccy}: outside tracked set`);
    for (const side of ['buy', 'sell']) {
      const v = r ? r[side] : undefined;
      if (v === null || v === undefined) continue;
      if (!isFinite(v) || v <= 0) issues.push(`${src}.${ccy}.${side}: invalid value ${v}`);
    }
    if ((r?.buy == null) && (r?.sell == null)) issues.push(`${src}.${ccy}: both buy and sell null`);
  }
}

// --- 2. anomaly vs recent median ---
const prior = snapshots.filter((s) => s.date < today).slice(-7);
function median(a) { const s = [...a].sort((x, y) => x - y); return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2; }
for (const [src, blk] of Object.entries(snap.sources || {})) {
  for (const [ccy, r] of Object.entries(blk.rates || {})) {
    for (const side of ['buy', 'sell']) {
      const v = r ? r[side] : null;
      if (v == null || !isFinite(v) || v <= 0) continue; // schema handles invalids
      const hist = prior.map((s) => s.sources?.[src]?.rates?.[ccy]?.[side]).filter((x) => x != null && isFinite(x) && x > 0);
      if (hist.length < MIN_HISTORY) continue;
      const med = median(hist);
      const dev = Math.abs(v / med - 1);
      if (dev > TOLERANCE) issues.push(`${src}.${ccy}.${side}: ${v} deviates ${(dev * 100).toFixed(1)}% from 7-day median ${med}`);
    }
  }
}

if (!issues.length) {
  if (!DRY) { try { require('./status').merge({ validation: { ok: true, at: new Date().toISOString() } }); } catch (e) { /* best effort */ } }
  console.log(`validate: ${today} OK (${Object.keys(snap.sources).length} sources)`);
  process.exit(0);
}

console.error(`validate: ${today} FAILED — ${issues.length} issue(s):`);
issues.forEach((i) => console.error('  - ' + i));
if (!DRY) {
  const qdir = path.join(__dirname, 'quarantine');
  fs.mkdirSync(qdir, { recursive: true });
  const qfile = path.join(qdir, `${today}-${Date.now()}.json`);
  fs.writeFileSync(qfile, JSON.stringify({ date: today, issues, snapshot: snap }, null, 2));
  console.error('quarantined to ' + qfile);
  try { require('./status').merge({ validation: { ok: false, at: new Date().toISOString(), issues: issues.slice(0, 10) } }); } catch (e) { /* best effort */ }
}
process.exit(1);
