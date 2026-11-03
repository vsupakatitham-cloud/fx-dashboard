/* Runs inside the real Mastercard converter tab. Only auto-fires when the URL
 * carries the '#fxauto' marker the service worker adds for scheduled runs, so it
 * never triggers while you're just browsing the page yourself.
 *
 * FRESH-SESSION strategy (v1.8.0): Akamai appears to allow only ~6 rate requests
 * per browser session before a ban that can outlast same-morning retries. So we
 * capture a small GROUP (<= groupSize) of currencies, then RELOAD the page to earn
 * a fresh Akamai sensor cookie (a new session), and capture the next group — until
 * all are collected. Progress is POSTed to the local collector after every group
 * (the server upserts), and carried across reloads via sessionStorage, so nothing
 * is lost. All settings come from the local server's /mc-config (no extension
 * reload needed to tune them).
 *
 * RATE ENDPOINT (v1.12.0): the one the converter page itself calls (no capture via the
 * old /settlement/currencyrate/conversion-rate succeeded after 2026-10-07). It needs an
 * explicit exchange_date and answers a JSON 4xx for days not yet published. Every
 * earlier capture got fxDate = snapshot date - 1 (the newest rate out at 09:00 BKT), so
 * we ask for that day and step back only if Mastercard says it isn't published.
 */
(async () => {
  if (!location.hash.includes('fxauto')) return;

  const RATE_PATH = '/marketingservices/public/mccom-services/currency-conversions/conversion-rates';
  const MAX_DAYS_BACK = 4;
  const SS = window.sessionStorage;

  // If this tab already finished a full/partial run, don't loop again on a stray reload.
  if (SS.getItem('mcFinished') === '1') return;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Defaults — overridden (no reload) by GET /mc-config. groupSize stays <= ~5 so each
  // fresh session stays under Akamai's per-session request cap.
  const cfg = {
    currencies: ['USD', 'EUR', 'GBP', 'CNY', 'AUD', 'KRW', 'CHF', 'JPY', 'SGD', 'HKD'],
    warmupMs: 20000,      // wait after (re)load so Akamai's _abck sensor cookie is set
    spacingMs: 10000,     // gap between requests within a group
    groupSize: 5,         // currencies per fresh session (keep <= ~5)
    groupPauseMs: 45000,  // pause before reloading for the next fresh session (clean group)
    cooldownMs: 600000,   // longer quiet wait before reloading if a group hit a 403 ban
    maxReloads: 4,        // cap on fresh sessions per day
  };
  try {
    const cr = await collector('/mc-config');
    if (!cr.status) throw new Error(cr.text);
    if (cr.status === 200) {
      const c = JSON.parse(cr.text);
      if (Array.isArray(c.currencies)) {
        const list = c.currencies.filter((x) => /^[A-Z]{3}$/.test(x));
        if (list.length) cfg.currencies = list;
      }
      for (const k of ['warmupMs', 'spacingMs', 'groupSize', 'groupPauseMs', 'cooldownMs', 'maxReloads']) {
        if (Number.isFinite(c[k]) && c[k] >= 0) cfg[k] = c[k];
      }
      console.log('[mc-capture] config from server:', JSON.stringify(cfg));
    }
  } catch (e) {
    console.log('[mc-capture] config fetch failed — using built-in defaults:', e.message);
  }

  const CCY = cfg.currencies;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  // Carried across this tab's reloads: the rate date that worked, and the last failure.
  let reqDate = SS.getItem('mcReqDate');
  let lastError = SS.getItem('mcLastError');

  function daysBefore(iso, n) {
    const d = new Date(iso + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  }

  // -> { rate, fxDate, date } or { status, apiError, error }. apiError = Mastercard itself
  // answered in JSON (e.g. "Rate is not accessible for this date"); Akamai blocks are HTML.
  async function fetchRate(c, date) {
    const qs = new URLSearchParams({
      exchange_date: date, transaction_currency: c, cardholder_billing_currency: 'THB',
      bank_fee: '0', transaction_amount: '1',
    });
    const r = await fetch(`${RATE_PATH}?${qs}`, { headers: { Accept: 'application/json' } });
    let j = null;
    try { j = JSON.parse(await r.text()); } catch (e) { /* not JSON */ }
    const d = (j && j.data) || {};
    const rate = +d.conversionRate;
    if (r.ok && !d.errorCode && rate > 0) return { rate: +rate.toFixed(6), fxDate: d.fxDate || date, date };
    const why = d.errorMessage || d.errorCode || (j && (j.errorMessage || j.message)) || (j ? '' : 'non-JSON response');
    return { status: r.status, apiError: !!j, error: `${c}@${date}: HTTP ${r.status}${why ? ' ' + why : ''}` };
  }

  async function postRates(rates, fxDate) {
    const r = await collector('/mc', { fxDate, rates });
    if (r.status) console.log(`[mc-capture] posted ${Object.keys(rates).length} -> ${r.status} ${r.text}`);
    else console.warn('[mc-capture] POST to collector failed (is server.js running?):', r.text);
  }

  async function finish(complete, missing) {
    SS.setItem('mcFinished', '1');
    for (const k of ['mcRemaining', 'mcReloads', 'mcReqDate', 'mcLastError']) SS.removeItem(k);
    if (!complete) {
      console.warn(`[mc-capture] finished partial; still missing ${missing.join(',')} — last error: ${lastError}`);
      // status.json only changes when a capture reports in; without this it would keep
      // showing the last success no matter how long captures have been failing.
      const r = await collector('/capture-failed', { source: 'mastercard', missing, error: lastError });
      if (!r.status) console.warn('[mc-capture] could not report the failure to the collector:', r.text);
    } else console.log('[mc-capture] complete: all currencies captured.');
    try {
      chrome.runtime.sendMessage({
        type: 'mcDone',
        date: complete ? today : null,
        captured: CCY.length - missing.length,
        missing,
      });
    } catch (e) { /* worker may be asleep; harmless */ }
  }

  // Resume state across reloads (sessionStorage survives a same-tab reload). For a
  // FRESH tab, ask the local server what today already has and capture only the
  // missing currencies — so a tab spawned mid-day (sleep-interrupted capture, or a
  // catch-up after a partial run) never redoes work another tab already merged.
  let remaining;
  try { remaining = JSON.parse(SS.getItem('mcRemaining')); } catch (e) { /* ignore */ }
  if (!Array.isArray(remaining) || !remaining.length) {
    let have = [];
    try {
      const pr = await collector('/progress');
      if (pr.status === 200) {
        const p = JSON.parse(pr.text);
        if (p.date === today) have = (p.sources || {}).mastercard || [];
      }
    } catch (e) { /* server down — capture the full list */ }
    remaining = CCY.filter((c) => !have.includes(c));
    if (!remaining.length) { console.log('[mc-capture] server already has all currencies for today'); await finish(true, []); return; }
    if (have.length) console.log(`[mc-capture] server already has ${have.length}; capturing only: ${remaining.join(',')}`);
  }
  let reloads = parseInt(SS.getItem('mcReloads') || '0', 10) || 0;

  console.log(`[mc-capture] session ${reloads + 1}: warm-up ${cfg.warmupMs / 1000}s, then group of ${cfg.groupSize} from [${remaining.join(',')}]`);
  await sleep(cfg.warmupMs);

  // Capture one group (<= groupSize) in this fresh session; stop poking on a 403 ban.
  const group = remaining.slice(0, cfg.groupSize);
  const got = {};
  const groupBlocked = [];
  let fxDate = null;
  let banned = false;
  let walked = false;
  for (let i = 0; i < group.length; i++) {
    const c = group[i];
    if (banned) { groupBlocked.push(c); continue; }
    let res;
    try {
      // Until a date has worked, walk back from yesterday on "not published" answers —
      // at most once per session, since every request counts against Akamai's cap.
      const walk = !reqDate && !walked;
      walked = true;
      res = await fetchRate(c, reqDate || daysBefore(today, 1));
      for (let back = 2; walk && res.apiError && back <= MAX_DAYS_BACK; back++) {
        await sleep(cfg.spacingMs);
        res = await fetchRate(c, daysBefore(today, back));
      }
    } catch (e) { res = { error: `${c}: ${e.message}` }; }
    if (res.rate != null) {
      got[c] = res.rate;
      fxDate = res.fxDate || fxDate;
      if (!reqDate) { reqDate = res.date; SS.setItem('mcReqDate', reqDate); }
    } else {
      groupBlocked.push(c);
      lastError = res.error;
      SS.setItem('mcLastError', lastError);
      if (!res.apiError && (res.status === 403 || res.status === 429)) banned = true;
    }
    if (!banned && i < group.length - 1) await sleep(cfg.spacingMs);
  }
  if (Object.keys(got).length) await postRates(got, fxDate);

  // What still needs capturing = this group's misses + everything beyond this group.
  remaining = groupBlocked.concat(remaining.slice(cfg.groupSize));

  if (!remaining.length) { await finish(true, []); return; }

  if (reloads < cfg.maxReloads) {
    SS.setItem('mcRemaining', JSON.stringify(remaining));
    SS.setItem('mcReloads', String(reloads + 1));
    const wait = banned ? cfg.cooldownMs : cfg.groupPauseMs;
    console.log(`[mc-capture] ${remaining.length} left (${remaining.join(',')})${banned ? ' — banned' : ''}; fresh session in ${wait / 1000}s`);
    await sleep(wait);
    location.reload(); // re-runs content.js with a fresh Akamai cookie; sessionStorage resumes
    return;
  }

  await finish(false, remaining);
})();
