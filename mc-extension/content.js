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
  const CCY = ['USD', 'EUR', 'GBP', 'CNY', 'AUD', 'KRW', 'CHF', 'JPY', 'SGD', 'HKD'];
  const ENDPOINT = 'http://localhost:8777/mc';
  const SPACING_MS = 4000;     // gap between requests within a batch
  const BATCH_SIZE = 5;        // ≤5 requests per burst — Akamai locks after ~5
  const BATCH_PAUSE_MS = 80000; // pause between batches so the rate window resets
  const MAX_ROUNDS = 3;        // extra passes to mop up anything still blocked

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Capture a list in batches of BATCH_SIZE, pausing BATCH_PAUSE_MS between batches
  // so no single burst exceeds Akamai's ~5-request threshold (which is what was
  // locking out the tail of a 10-request round and never recovering).
  async function captureChunked(list) {
    const got = {};
    const blocked = [];
    let fxDate = null;
    for (let i = 0; i < list.length; i += BATCH_SIZE) {
      if (i > 0) {
        console.log(`[mc-capture] batch pause ${BATCH_PAUSE_MS / 1000}s before next ${BATCH_SIZE}…`);
        await sleep(BATCH_PAUSE_MS);
      }
      for (const c of list.slice(i, i + BATCH_SIZE)) {
        try {
          const r = await fetch(
            `/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${c}&crdhldBillCurr=THB&bankFee=0&transAmt=1`,
            { headers: { Accept: 'application/json' } }
          );
          if (r.status === 200) {
            const j = await r.json();
            if (j && j.data && j.data.conversionRate) {
              got[c] = +(+j.data.conversionRate).toFixed(6);
              fxDate = j.data.fxDate || fxDate;
            } else blocked.push(c);
          } else blocked.push(c);
        } catch (e) { blocked.push(c); }
        await sleep(SPACING_MS);
      }
    }
    return { got, blocked, fxDate };
  }

  const rates = {};
  let fxDate = null;
  let remaining = CCY.slice();

  for (let round = 0; round < MAX_ROUNDS && remaining.length; round++) {
    if (round > 0) {
      console.log(`[mc-capture] round ${round + 1}: ${remaining.length} still missing, waiting ${BATCH_PAUSE_MS / 1000}s…`);
      await sleep(BATCH_PAUSE_MS);
    }
    const { got, blocked, fxDate: fd } = await captureChunked(remaining);
    Object.assign(rates, got);
    if (fd) fxDate = fd;
    remaining = blocked;
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const captured = Object.keys(rates).length;

  if (captured) {
    try {
      const resp = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ fxDate, rates }),
      });
      const text = await resp.text();
      console.log(`[mc-capture] posted ${captured}/${CCY.length} rates -> ${resp.status} ${text}`);
    } catch (e) {
      console.warn('[mc-capture] POST to collector failed (is server.js running?):', e);
    }
  } else {
    console.warn('[mc-capture] all currencies blocked after retries — Akamai lockout, will retry tomorrow.');
  }

  // Tell the service worker we're done (records lastRun + closes this tab).
  // Mark "done" only if we captured the full set, so a partial day can be retried
  // with the toolbar button without the once-a-day guard blocking it.
  try {
    chrome.runtime.sendMessage({
      type: 'mcDone',
      date: captured === CCY.length ? today : null,
      captured,
      missing: remaining,
    });
  } catch (e) { /* worker may be asleep; harmless */ }
})();
