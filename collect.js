#!/usr/bin/env node
/*
 * Multi-source FX rate collector for the Krungthai Travel card dashboard.
 *
 * Captures one daily snapshot (Asia/Bangkok) comparing the card's rates against
 * other providers, limited to the currencies Krungthai publishes:
 *
 *   - krungthai : Travel Platinum Mastercard rates  (OneRates widget, Playwright)
 *   - krungsri  : Boarding card special rates        (page table, Playwright)
 *   - superrich : Superrich Thailand money-changer   (public API + static auth)
 *   - mastercard: Mastercard network rate            (Akamai-blocked to bots;
 *                 only populated if a manual capture is merged in — see README)
 *
 * Stored buy/sell follow the bank convention:
 *   buy  = provider buys FCY from you  (lower number)
 *   sell = provider sells FCY to you   (higher number)
 *
 * Usage:  PLAYWRIGHT_BROWSERS_PATH=./.pw-browsers node collect.js
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const KT_CCY = ['USD','EUR','JPY','GBP','CNY','AED','AUD','CAD','CHF','DKK','HKD','INR','KRW','NOK','NZD','QAR','SAR','SEK','SGD','TWD'];
const KT_SET = new Set(KT_CCY);

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36';

const KRUNGTHAI_WIDGET =
  'https://krungthai.com/th/widget/OneRates?theme=ktb&output=embed&social=false&logo=false&loan=false&deposit=false&exchange=false&curr=' + KT_CCY.join(',');
const KRUNGSRI_URL = 'https://www.krungsri.com/th/personal/card/krungsri-boarding-card';
const SUPERRICH_URL = 'https://www.superrichthailand.com/web/api/v1/rates';
const SUPERRICH_AUTH = 'Basic c3VwZXJyaWNoVGg6aFRoY2lycmVwdXM='; // static creds the site ships

const DATA_DIR = path.join(__dirname, 'data');
const JSON_PATH = path.join(DATA_DIR, 'snapshots.json');
const CSV_PATH = path.join(DATA_DIR, 'snapshots.csv');
const JS_PATH = path.join(DATA_DIR, 'snapshots.js');

function bangkokNow() {
  const p = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((o, x) => (o[x.type] = x.value, o), {});
  return { date: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}:${p.second}` };
}

// ---------- Krungthai (Playwright) ----------
async function getKrungthai(page) {
  await page.goto(KRUNGTHAI_WIDGET, { waitUntil: 'networkidle', timeout: 90000 });
  await page.waitForFunction(() => {
    const t = document.querySelector('table');
    return t && t.querySelectorAll('tr').length > 3;
  }, { timeout: 30000 });
  await page.waitForFunction(
    () => /\d{2}\/\d{2}\/\d{4}\s+\d{2}:\d{2}:\d{2}|\d{8}\s+\d{2}:\d{2}:\d{2}/.test(document.body.innerText),
    { timeout: 8000 }
  ).catch(() => {});
  return page.evaluate(() => {
    const rates = {};
    document.querySelectorAll('table tr').forEach((tr) => {
      const c = Array.from(tr.querySelectorAll('td')).map((x) => x.innerText.trim());
      if (c.length >= 3) {
        const code = c[0].replace(/[^A-Z]/g, '');
        const buy = parseFloat(c[1].replace(/,/g, '')), sell = parseFloat(c[2].replace(/,/g, ''));
        if (/^[A-Z]{3}$/.test(code) && isFinite(buy) && isFinite(sell)) rates[code] = { buy, sell };
      }
    });
    const txt = document.body.innerText;
    let ts = null, m;
    if ((m = txt.match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}:\d{2}:\d{2})/))) ts = `${m[3]}-${m[2]}-${m[1]} ${m[4]}`;
    else if ((m = txt.match(/(\d{8})\s+(\d{2}:\d{2}:\d{2})/))) ts = `${m[1].slice(0,4)}-${m[1].slice(4,6)}-${m[1].slice(6,8)} ${m[2]}`;
    return { ts, rates };
  });
}

// ---------- Krungsri Boarding card (Playwright) ----------
async function getKrungsri(page) {
  await page.goto(KRUNGSRI_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForFunction(() => {
    return Array.from(document.querySelectorAll('table')).some((t) => /USD|EUR|JPY/.test(t.innerText));
  }, { timeout: 30000 });
  return page.evaluate(() => {
    // Columns: สกุลเงิน | แลกซื้อ (bank SELLS fcy, higher) | ขายคืน (bank BUYS fcy, lower)
    const table = Array.from(document.querySelectorAll('table')).find((t) => /USD|EUR|JPY/.test(t.innerText));
    const rates = {};
    if (table) {
      table.querySelectorAll('tr').forEach((tr) => {
        const c = Array.from(tr.querySelectorAll('td')).map((x) => x.innerText.trim());
        const idx = c.findIndex((v) => /^[A-Z]{3}$/.test(v));
        if (idx >= 0 && c[idx + 1] && c[idx + 2]) {
          const code = c[idx];
          const sell = parseFloat(c[idx + 1].replace(/,/g, '')); // แลกซื้อ
          const buy = parseFloat(c[idx + 2].replace(/,/g, ''));  // ขายคืน
          if (isFinite(buy) && isFinite(sell)) rates[code] = { buy, sell };
        }
      });
    }
    return { ts: null, rates };
  });
}

// ---------- Superrich Thailand (HTTP API) ----------
async function getSuperrich() {
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
    if (code && isFinite(buy) && isFinite(sell)) rates[code] = { buy: +buy, sell: +sell };
    if (!ts && r0.dateTime) ts = r0.dateTime;
  }
  return { ts, rates };
}

function filterToKT(rates) {
  const out = {};
  for (const k of Object.keys(rates || {})) if (KT_SET.has(k)) out[k] = rates[k];
  return out;
}

// ---------- storage ----------
function loadSnapshots() {
  let arr;
  try { arr = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8')); } catch { return []; }
  // migrate any old single-source entries -> sources.krungthai
  return arr.map((s) => {
    if (s.sources) return s;
    return { date: s.date, captured_at_bkt: s.captured_at_bkt,
      sources: { krungthai: { ts: s.source_timestamp || null, rates: s.rates || {} } } };
  });
}

function writeOutputs(snapshots) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(JSON_PATH, JSON.stringify(snapshots, null, 2));
  fs.writeFileSync(JS_PATH, 'window.FX_SNAPSHOTS = ' + JSON.stringify(snapshots) + ';\n');
  const lines = ['date,captured_at_bkt,source,source_ts,currency,buy,sell'];
  for (const s of snapshots) {
    for (const src of Object.keys(s.sources)) {
      const blk = s.sources[src];
      for (const code of Object.keys(blk.rates || {})) {
        const r = blk.rates[code];
        lines.push([s.date, s.captured_at_bkt, src, blk.ts || '', code, r.buy ?? '', r.sell ?? ''].join(','));
      }
    }
  }
  fs.writeFileSync(CSV_PATH, lines.join('\n') + '\n');
}

(async () => {
  const now = bangkokNow();
  const browser = await chromium.launch({ headless: true, args: ['--disable-blink-features=AutomationControlled'] });
  const sources = {};
  try {
    const ctx = await browser.newContext({ userAgent: UA, locale: 'th-TH', timezoneId: 'Asia/Bangkok', viewport: { width: 1366, height: 900 } });

    // Krungthai
    try {
      const p = await ctx.newPage();
      const kt = await getKrungthai(p);
      kt.rates = filterToKT(kt.rates);
      if (Object.keys(kt.rates).length) sources.krungthai = kt;
      await p.close();
      console.log(`  krungthai: ${Object.keys(kt.rates).length} pairs (ts ${kt.ts})`);
    } catch (e) { console.log('  krungthai FAILED:', e.message); }

    // Krungsri
    try {
      const p = await ctx.newPage();
      const ks = await getKrungsri(p);
      ks.rates = filterToKT(ks.rates);
      if (Object.keys(ks.rates).length) sources.krungsri = ks;
      await p.close();
      console.log(`  krungsri: ${Object.keys(ks.rates).length} pairs`);
    } catch (e) { console.log('  krungsri FAILED:', e.message); }
  } finally {
    await browser.close();
  }

  // Superrich (no browser)
  try {
    const sr = await getSuperrich();
    sr.rates = filterToKT(sr.rates);
    if (Object.keys(sr.rates).length) sources.superrich = sr;
    console.log(`  superrich: ${Object.keys(sr.rates).length} pairs (ts ${sr.ts})`);
  } catch (e) { console.log('  superrich FAILED:', e.message); }

  if (!Object.keys(sources).length) throw new Error('All sources failed.');

  // Preserve any externally-merged sources for today (mastercard, kjourney, ...). collect.js
  // only produces krungthai/krungsri/superrich, so on a same-day rerun it must NOT clobber
  // the others that the browser-extension captures POST in separately.
  const OWN = new Set(['krungthai', 'krungsri', 'superrich']);
  const snapshots = loadSnapshots();
  const existing = snapshots.find((s) => s.date === now.date);
  if (existing?.sources) for (const [k, v] of Object.entries(existing.sources)) {
    if (!OWN.has(k)) sources[k] = v;
  }

  const snapshot = { date: now.date, captured_at_bkt: `${now.date} ${now.time}`, sources };
  const idx = snapshots.findIndex((s) => s.date === now.date);
  if (idx >= 0) snapshots[idx] = snapshot; else snapshots.push(snapshot);
  snapshots.sort((a, b) => a.date.localeCompare(b.date));

  writeOutputs(snapshots);
  console.log(`[${snapshot.captured_at_bkt}] sources: ${Object.keys(sources).join(', ')}. Total days: ${snapshots.length}`);
})().catch((e) => { console.error('Collector failed:', e.message); process.exit(1); });
