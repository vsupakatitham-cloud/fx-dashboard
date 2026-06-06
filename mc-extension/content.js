/* Runs inside the real Mastercard converter tab. Only auto-fires when the URL
 * carries the '#fxauto' marker that the service worker adds for scheduled runs,
 * so it never triggers while you're just browsing the page yourself.
 *
 * Captures the network/wholesale THB-per-1-FCY rate for the major currencies the
 * dashboard tracks. Akamai allows only ~4-5 quick requests before a short lockout,
 * so we go in ROUNDS: request what's still missing (paced 4s apart), pause ~75s to
 * let the short lockout clear, then retry the rest — up to 3 rounds. Then POST the
 * combined result to the local fx-dashboard collector (server.js -> /mc).
 */
(async () => {
  if (!location.hash.includes('fxauto')) return;

  // The currencies to track for Mastercard. Kept small (fewer requests = far
  // lower Akamai lockout risk). All must be within Krungthai's 20, or the merge
  // step drops them.
  const ENDPOINT = 'http://localhost:8777/mc';
  const CONFIG_URL = 'http://localhost:8777/mc-config';

  // Tunable settings. These defaults are overridden — WITHOUT an extension reload — by the
  // local server's /mc-config (edit data/mc-config.json to change the currency list or
  // timing). If the fetch fails (server down), we fall back to these built-ins.
  //   warmupMs:   wait before the 1st request so Akamai's _abck sensor cookie is set
  //   spacingMs:  gap between EVERY request — steady & gentle, no bursts
  //   cooldownMs: QUIET period after a 403 ban so it can clear (don't poke a live ban)
  //   maxPasses:  retry passes for anything still missing
  const cfg = {
    currencies: ['USD', 'EUR', 'GBP', 'CNY', 'AUD', 'KRW', 'CHF', 'JPY', 'SGD', 'HKD'],
    warmupMs: 20000,
    spacingMs: 30000,
    cooldownMs: 300000,
    maxPasses: 6,
  };

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  try {
    const cr = await fetch(CONFIG_URL, { cache: 'no-store' });
    if (cr.ok) {
      const c = await cr.json();
      if (Array.isArray(c.currencies)) {
        const list = c.currencies.filter((x) => /^[A-Z]{3}$/.test(x));
        if (list.length) cfg.currencies = list;
      }
      for (const k of ['warmupMs', 'spacingMs', 'cooldownMs', 'maxPasses']) {
        if (Number.isFinite(c[k]) && c[k] >= 0) cfg[k] = c[k];
      }
      console.log('[mc-capture] config from server:', JSON.stringify(cfg));
    }
  } catch (e) {
    console.log('[mc-capture] config fetch failed — using built-in defaults');
  }

  const CCY = cfg.currencies;
  const WARMUP_MS = cfg.warmupMs;
  const SPACING_MS = cfg.spacingMs;
  const COOLDOWN_MS = cfg.cooldownMs;
  const MAX_PASSES = cfg.maxPasses;

  // Returns { rate, fxDate } on success, or { status } on failure (403 = active ban).
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
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fxDate, rates }),
      });
      const text = await resp.text();
      console.log(`[mc-capture] posted ${Object.keys(rates).length}/${CCY.length} -> ${resp.status} ${text}`);
    } catch (e) {
      console.warn('[mc-capture] POST to collector failed (is server.js running?):', e);
    }
  }

  // One steady pass over `list` at SPACING_MS apart. On a 403 (ban) we stop poking
  // immediately — the rest of the pass is marked blocked and the caller cools down.
  async function capturePass(list) {
    const got = {};
    const blocked = [];
    let fxDate = null;
    let banned = false;
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      if (banned) { blocked.push(c); continue; }
      try {
        const res = await fetchRate(c);
        if (res.rate != null) { got[c] = res.rate; fxDate = res.fxDate || fxDate; }
        else { blocked.push(c); if (res.status === 403) banned = true; }
      } catch (e) { blocked.push(c); }
      if (!banned && i < list.length - 1) await sleep(SPACING_MS);
    }
    return { got, blocked, fxDate, banned };
  }

  // Warm up so Akamai's JS can set the sensor cookie before the first request.
  console.log(`[mc-capture] warm-up ${WARMUP_MS / 1000}s…`);
  await sleep(WARMUP_MS);

  const rates = {};
  let fxDate = null;
  let remaining = CCY.slice();

  // Steady passes; POST after every pass (server upserts) so progress is never lost. After a
  // ban, wait a long QUIET cooldown so it clears before retrying the still-missing ones.
  for (let pass = 0; pass < MAX_PASSES && remaining.length; pass++) {
    const { got, blocked, fxDate: fd, banned } = await capturePass(remaining);
    if (fd) fxDate = fd;
    if (Object.keys(got).length) {
      Object.assign(rates, got);
      await postRates(rates, fxDate);
    }
    remaining = blocked;
    if (!remaining.length) break;
    const wait = banned ? COOLDOWN_MS : SPACING_MS;
    console.log(`[mc-capture] pass ${pass + 1}: still missing ${remaining.join(',')}${banned ? ` — banned, cooling down ${COOLDOWN_MS / 1000}s` : ''}`);
    await sleep(wait);
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const captured = Object.keys(rates).length;
  if (!captured) {
    console.warn('[mc-capture] all currencies blocked after all passes — Akamai lockout.');
  } else if (remaining.length) {
    console.warn(`[mc-capture] finished ${captured}/${CCY.length}; still missing ${remaining.join(',')}.`);
  } else {
    console.log(`[mc-capture] complete: ${captured}/${CCY.length}.`);
  }

  // Tell the service worker we're done (records lastRun + closes this tab).
  // Mark "done" (date set) only if we captured the full set, so a partial day can be
  // retried with the toolbar button without the once-a-day guard blocking it.
  try {
    chrome.runtime.sendMessage({
      type: 'mcDone',
      date: captured === CCY.length ? today : null,
      captured,
      missing: remaining,
    });
  } catch (e) { /* worker may be asleep; harmless */ }
})();
