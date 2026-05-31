/* Runs inside the real Mastercard converter tab. Only auto-fires when the URL
 * carries the '#fxauto' marker that the service worker adds for scheduled runs,
 * so it never triggers while you're just browsing the page yourself.
 *
 * Captures the network/wholesale THB-per-1-FCY rate for the major currencies the
 * dashboard tracks, paced ~4s apart to stay under Akamai's rate limit, then POSTs
 * the result to the local fx-dashboard collector (server.js -> /mc).
 */
(async () => {
  if (!location.hash.includes('fxauto')) return;

  // Majors only — fewer requests = far lower lockout risk. Matches the set the
  // dashboard has historically tracked for Mastercard.
  const CCY = ['USD', 'EUR', 'JPY', 'GBP', 'CNY', 'AED', 'AUD', 'CAD', 'DKK'];
  const ENDPOINT = 'http://localhost:8777/mc';
  const SPACING_MS = 4000;

  const rates = {};
  let fxDate = null;
  const blocked = [];

  for (const c of CCY) {
    try {
      const r = await fetch(
        `/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${c}&crdhldBillCurr=THB&bankFee=0&transAmt=1`,
        { headers: { Accept: 'application/json' } }
      );
      if (r.status === 200) {
        const j = await r.json();
        if (j && j.data && j.data.conversionRate) {
          rates[c] = +(+j.data.conversionRate).toFixed(6);
          fxDate = j.data.fxDate || fxDate;
        } else blocked.push(c);
      } else blocked.push(c);
    } catch (e) { blocked.push(c); }
    await new Promise((res) => setTimeout(res, SPACING_MS));
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());

  if (Object.keys(rates).length) {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fxDate, rates }),
      });
      const text = await resp.text();
      console.log('[mc-capture] posted', Object.keys(rates).length, 'rates ->', resp.status, text);
    } catch (e) {
      console.warn('[mc-capture] POST to collector failed (is server.js running?):', e);
    }
  } else {
    console.warn('[mc-capture] all currencies blocked — Akamai lockout, will retry tomorrow.');
  }

  // Tell the service worker we're done (records lastRun + closes this tab).
  // Only mark "done" if we actually captured something, so a fully-blocked run retries.
  try {
    chrome.runtime.sendMessage({
      type: 'mcDone',
      date: Object.keys(rates).length ? today : null,
      captured: Object.keys(rates).length,
      blocked,
    });
  } catch (e) { /* worker may be asleep; harmless */ }
})();
