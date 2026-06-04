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
  const SPACING_MS = 4000;        // gap between requests within a batch
  const BATCH_SIZE = 4;           // ≤4 per burst — stays under Akamai's ~5 lockout threshold
  const BATCH_PAUSE_MS = 150000;  // 2.5 min between batches so the rate window fully resets
  const ROUND_PAUSE_MS = 180000;  // 3 min between retry rounds (80s did NOT clear the lockout)
  const MAX_ROUNDS = 6;           // keep retrying the still-missing ones until all 10 land

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  async function fetchRate(c) {
    const r = await fetch(
      `/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${c}&crdhldBillCurr=THB&bankFee=0&transAmt=1`,
      { headers: { Accept: 'application/json' } }
    );
    if (r.status !== 200) return null;
    const j = await r.json();
    return (j && j.data && j.data.conversionRate)
      ? { rate: +(+j.data.conversionRate).toFixed(6), fxDate: j.data.fxDate || null }
      : null;
  }

  // Capture a list in batches of BATCH_SIZE, pausing BATCH_PAUSE_MS between batches so
  // no single burst exceeds Akamai's ~5-request threshold and each batch is seen fresh.
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
          const res = await fetchRate(c);
          if (res) { got[c] = res.rate; fxDate = res.fxDate || fxDate; }
          else blocked.push(c);
        } catch (e) { blocked.push(c); }
        await sleep(SPACING_MS);
      }
    }
    return { got, blocked, fxDate };
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

  const rates = {};
  let fxDate = null;
  let remaining = CCY.slice();

  // Round 0 = first full pass; rounds 1..N retry only what's still missing, with a long
  // pause between rounds so the lockout clears. Progress is POSTed (and upserted) after
  // every round, so even if Chrome/the tab closes mid-way, what's captured is saved.
  for (let round = 0; round < MAX_ROUNDS && remaining.length; round++) {
    if (round > 0) {
      console.log(`[mc-capture] round ${round + 1}: ${remaining.length} still missing (${remaining.join(',')}), waiting ${ROUND_PAUSE_MS / 1000}s…`);
      await sleep(ROUND_PAUSE_MS);
    }
    const { got, blocked, fxDate: fd } = await captureChunked(remaining);
    if (fd) fxDate = fd;
    if (Object.keys(got).length) {
      Object.assign(rates, got);
      await postRates(rates, fxDate); // incremental save (server upserts)
    }
    remaining = blocked;
  }

  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const captured = Object.keys(rates).length;
  if (!captured) {
    console.warn('[mc-capture] all currencies blocked after all rounds — Akamai lockout.');
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
