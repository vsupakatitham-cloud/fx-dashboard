#!/usr/bin/env node
/*
 * Catch-up guard: exit 0 if a catch-up collection run is needed, 1 otherwise.
 *
 * Needed when BOTH:
 *   - there is no snapshot for today (Asia/Bangkok), and
 *   - it is past 09:05 BKT (before that, the normal 09:00 launchd run handles it).
 *
 * Used by `run.sh --catchup`, which launchd fires at load (boot/login) and hourly.
 * The guard is what makes those firings safe: a day that already has its 09:00
 * snapshot must NOT be re-collected (a rerun would overwrite the 09:00 card rates
 * with whatever the rates are now).
 *
 * Testing: pass a fake clock as --now YYYY-MM-DDTHH:MM (interpreted as BKT).
 */
const fs = require('fs');
const path = require('path');

function bkkNow() {
  const i = process.argv.indexOf('--now');
  if (i > -1 && process.argv[i + 1]) {
    const m = process.argv[i + 1].match(/^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/);
    if (!m) { console.error('bad --now, want YYYY-MM-DDTHH:MM'); process.exit(2); }
    return { date: m[1], minutes: +m[2] * 60 + +m[3] };
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minutes: +parts.hour * 60 + +parts.minute };
}

const now = bkkNow();
const CUTOFF = 9 * 60 + 5; // 09:05 BKT

let snapshots = [];
try { snapshots = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'snapshots.json'), 'utf8')); } catch (e) { /* no data yet -> catch up */ }

if (snapshots.some((s) => s.date === now.date)) {
  console.log(`catchup: snapshot for ${now.date} already exists — not needed`);
  process.exit(1);
}
if (now.minutes < CUTOFF) {
  console.log(`catchup: before 09:05 BKT — the normal 09:00 run will handle ${now.date}`);
  process.exit(1);
}
console.log(`catchup: NEEDED — no snapshot for ${now.date} and it is past 09:05 BKT`);
process.exit(0);
