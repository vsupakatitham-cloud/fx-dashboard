/* Runs in the real KBank K-Journey debit-card rate page when opened with #fxauto.
 * Scrapes the single rate table ("Bank Selling Rate" per currency) and POSTs it to the
 * local collector. One page load = all currencies, so there are NO per-currency requests
 * and no Akamai rate-limit dance (unlike the Mastercard capture).
 *
 * The currency code is a <th> (row header) and the rate is a <td>, so we read th,td.
 * Only currencies within Krungthai's 20 are kept (the server's merge filters the rest).
 */
(async () => {
  if (!location.hash.includes('fxauto')) return;
  const ENDPOINT = 'http://localhost:8777/src';
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function scrape() {
    const rates = {};
    document.querySelectorAll('table tr').forEach((tr) => {
      const c = [...tr.querySelectorAll('th,td')].map((x) => x.innerText.trim());
      if (c.length < 2) return;
      const m = c[0].match(/\b([A-Z]{3})\b/);
      const v = parseFloat((c[1] || '').replace(/[^0-9.]/g, ''));
      if (m && isFinite(v) && v > 0) rates[m[1]] = { buy: null, sell: v };
    });
    return rates;
  }

  // Wait for the table to populate — covers Akamai's JS challenge resolving and any
  // async render. Poll up to ~30s; the real table has ~28 rows so >=5 means it's loaded.
  let rates = {};
  for (let i = 0; i < 15; i++) {
    rates = scrape();
    if (Object.keys(rates).length >= 5) break;
    await sleep(2000);
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const n = Object.keys(rates).length;
  if (n) {
    try {
      const r = await fetch(ENDPOINT, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: 'kjourney', ts: today, rates }),
      });
      console.log(`[kjourney] posted ${n} rates -> ${r.status} ${await r.text()}`);
    } catch (e) {
      console.warn('[kjourney] POST to collector failed (is server.js running?):', e);
    }
  } else {
    console.warn('[kjourney] no rates scraped (Akamai challenge or page layout changed).');
  }

  // Tell the service worker we're done (records lastRun + closes this tab).
  try {
    chrome.runtime.sendMessage({ type: 'kbankDone', date: n ? today : null, captured: n });
  } catch (e) { /* worker may be asleep; harmless */ }
})();
