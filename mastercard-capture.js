/* ============================================================================
 * Mastercard daily capture — paste into your browser console.
 *
 * Mastercard's converter API is behind Akamai bot protection: an automated
 * (headless) browser is blocked outright, and even your real browser is rate-
 * limited if hit too fast. This snippet paces requests gently (~4s apart) to
 * stay under the limit, and prints JSON ready for the merge step.
 *
 * HOW TO USE (once a day, takes ~90s):
 *   1. Open: https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html
 *   2. Open DevTools console (Cmd+Option+J) and paste this whole file, press Enter.
 *   3. Wait for "DONE". It copies the result to your clipboard automatically.
 *   4. Paste into  data/mc-input.json  (overwrite it), then run:
 *          node merge-mastercard.js
 *      (run collect.js first that morning so today's snapshot exists).
 *
 * If some currencies show as blocked, just run it again a few minutes later —
 * merge-mastercard.js only updates what's present.
 * ========================================================================== */
(async () => {
  const CCY = ['USD','EUR','JPY','GBP','CNY','AED','AUD','CAD','CHF','DKK','HKD','INR','KRW','NOK','NZD','QAR','SAR','SEK','SGD','TWD'];
  const rates = {}; let fxDate = null; const blocked = [];
  for (const c of CCY) {
    try {
      const r = await fetch(`/settlement/currencyrate/conversion-rate?fxDate=0000-00-00&transCurr=${c}&crdhldBillCurr=THB&bankFee=0&transAmt=1`, { headers: { Accept: 'application/json' } });
      if (r.status === 200) {
        const j = await r.json();
        if (j?.data?.conversionRate) { rates[c] = +(+j.data.conversionRate).toFixed(6); fxDate = j.data.fxDate || fxDate; }
      } else { blocked.push(c); }
    } catch (e) { blocked.push(c); }
    console.log(`${c}: ${rates[c] ?? 'blocked'}  (${Object.keys(rates).length}/${CCY.length})`);
    await new Promise(res => setTimeout(res, 4000));
  }
  const out = JSON.stringify({ fxDate, rates }, null, 2);
  try { await navigator.clipboard.writeText(out); console.log('Copied to clipboard ✔'); } catch {}
  console.log('DONE.', Object.keys(rates).length, 'captured;', blocked.length, 'blocked:', blocked.join(',') || 'none');
  console.log(out);
})();
