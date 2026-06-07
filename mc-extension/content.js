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
 */
(async () => {
  if (!location.hash.includes('fxauto')) return;

  const ENDPOINT = 'http://localhost:8777/mc';
  const CONFIG_URL = 'http://localhost:8777/mc-config';
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
    const cr = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (cr.ok) {
      const c = await cr.json();
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
    console.log('[mc-capture] config fetch failed — using built-in defaults');
  }

  const CCY = cfg.currencies;
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

  async function fetchRate(c) {
    const r = await fetch(
      `/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${c}&crdhldBillCurr=THB&bankFee=0&transAmt=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (r.status !== 200) return { status: r.status };
    const j = await r.json();
    return (j && j.data && j.data.conversionRate)
      ? { rate: +(+j.data.conversionRate).toFixed(6), fxDate: j.data.fxDate || null }
      : { status: 'empty' };
  }

  async function postRates(rates, fxDate) {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fxDate, rates }),
      });
      console.log(`[mc-capture] posted ${Object.keys(rates).length} -> ${resp.status} ${await resp.text()}`);
    } catch (e) {
      console.warn('[mc-capture] POST to collector failed (is server.js running?):', e);
    }
  }

  function finish(complete, missing) {
    SS.setItem('mcFinished', '1');
    SS.removeItem('mcRemaining');
    SS.removeItem('mcReloads');
    if (!complete) console.warn(`[mc-capture] finished partial; still missing ${missing.join(',')}`);
    else console.log('[mc-capture] complete: all currencies captured.');
    try {
      chrome.runtime.sendMessage({
        type: 'mcDone',
        date: complete ? today : null,
        captured: CCY.length - missing.length,
        missing,
      });
    } catch (e) { /* worker may be asleep; harmless */ }
  }

  // Resume state across reloads (sessionStorage survives a same-tab reload).
  let remaining;
  try { remaining = JSON.parse(SS.getItem('mcRemaining')); } catch (e) { /* ignore */ }
  if (!Array.isArray(remaining) || !remaining.length) remaining = CCY.slice();
  let reloads = parseInt(SS.getItem('mcReloads') || '0', 10) || 0;

  console.log(`[mc-capture] session ${reloads + 1}: warm-up ${cfg.warmupMs / 1000}s, then group of ${cfg.groupSize} from [${remaining.join(',')}]`);
  await sleep(cfg.warmupMs);

  // Capture one group (<= groupSize) in this fresh session; stop poking on a 403 ban.
  const group = remaining.slice(0, cfg.groupSize);
  const got = {};
  const groupBlocked = [];
  let fxDate = null;
  let banned = false;
  for (let i = 0; i < group.length; i++) {
    const c = group[i];
    if (banned) { groupBlocked.push(c); continue; }
    try {
      const res = await fetchRate(c);
      if (res.rate != null) { got[c] = res.rate; fxDate = res.fxDate || fxDate; }
      else { groupBlocked.push(c); if (res.status === 403) banned = true; }
    } catch (e) { groupBlocked.push(c); }
    if (!banned && i < group.length - 1) await sleep(cfg.spacingMs);
  }
  if (Object.keys(got).length) await postRates(got, fxDate);

  // What still needs capturing = this group's misses + everything beyond this group.
  remaining = groupBlocked.concat(remaining.slice(cfg.groupSize));

  if (!remaining.length) { finish(true, []); return; }

  if (reloads < cfg.maxReloads) {
    SS.setItem('mcRemaining', JSON.stringify(remaining));
    SS.setItem('mcReloads', String(reloads + 1));
    const wait = banned ? cfg.cooldownMs : cfg.groupPauseMs;
    console.log(`[mc-capture] ${remaining.length} left (${remaining.join(',')})${banned ? ' — banned' : ''}; fresh session in ${wait / 1000}s`);
    await sleep(wait);
    location.reload(); // re-runs content.js with a fresh Akamai cookie; sessionStorage resumes
    return;
  }

  finish(false, remaining);
})();
