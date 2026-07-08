/* Service worker: schedules a daily capture and opens the rate pages so each content
 * script runs inside your real (non-automated) browser session. Akamai bot-blocks
 * headless automation; a normal tab you've earned a cookie in passes. Two sources are
 * captured this way: Mastercard (converter API, per-currency) and K-Journey (KBank,
 * one table scrape).
 */

const MASTERCARD_URL = 'https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html';
const KBANK_URL = 'https://www.kasikornbank.com/th/personal/Debit-Card/Pages/exchange-rate.aspx';
const FIRE_HOUR = 9;    // local time (your Mac/Chrome clock is BKT)
const FIRE_MIN = 0;     // 09:00 — same as the launchd collector; the /mc and /src endpoints
                        // wait for the collector's snapshot before merging, so no race.

function nextFireTs() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(FIRE_HOUR, FIRE_MIN, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t.getTime();
}

function scheduleDaily() {
  chrome.alarms.create('mcDaily', { when: nextFireTs(), periodInMinutes: 1440 });
}

chrome.runtime.onInstalled.addListener(scheduleDaily);
chrome.runtime.onStartup.addListener(scheduleDaily);
// Also (re)schedule whenever the service worker spins up — covers unpacked reloads.
scheduleDaily();

function todayBkk() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}
async function doneToday(key) {
  const o = await chrome.storage.local.get(key);
  return o[key] === todayBkk();
}
// Open a rate page (background tab) with the #fxauto marker so its content script runs.
// Each source has its own once-a-day guard key; force=true ignores it (toolbar button).
//
// In-progress guard: "done" is only recorded when a capture COMPLETES, and the
// Mastercard capture runs for many minutes — meanwhile any service-worker wake
// (e.g. the K-Journey tab's completion message) re-ran the catch-up and opened a
// SECOND tab capturing in parallel (seen 2026-07-04: every POST duplicated, double
// traffic tripping Akamai, rounds crawling at +3 ccys). So also skip if a capture
// for this source STARTED recently and may still be running.
//
// The guard must also be ATOMIC: at Chrome startup after a missed 09:00 (Mac
// asleep), the missed alarm + onStartup + worker-spin-up catch-up all fire within
// milliseconds, and a plain async read-then-write race let ALL of them pass the
// check before any wrote StartedAt (seen 2026-07-08 — duplicates despite v1.10.1).
// MV3 runs a single worker instance, so serializing through an in-memory promise
// queue makes the check-and-set effectively atomic; the persisted StartedAt still
// guards across worker restarts.
const IN_PROGRESS_MS = 45 * 60 * 1000;
let openQueue = Promise.resolve();
function openIfNeeded(url, key, force) {
  openQueue = openQueue.then(() => openIfNeededSerial(url, key, force)).catch(() => {});
  return openQueue;
}
async function openIfNeededSerial(url, key, force) {
  if (!force && (await doneToday(key))) return;
  const startKey = key + 'StartedAt';
  if (!force) {
    const o = await chrome.storage.local.get(startKey);
    if (o[startKey] && Date.now() - o[startKey] < IN_PROGRESS_MS) return;
  }
  await chrome.storage.local.set({ [startKey]: Date.now() });
  const tab = await chrome.tabs.create({ url: url + (force ? '#fxauto&force' : '#fxauto'), active: false });
  // Capture tabs idle in long ban-cooldowns between rounds, and Chrome's Memory
  // Saver discards idle background tabs (especially on battery) — which froze the
  // 2026-07-08 capture mid-run. Exempt capture tabs from discarding.
  try { await chrome.tabs.update(tab.id, { autoDiscardable: false }); } catch (e) { /* best effort */ }
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'mcDaily') return;
  openIfNeeded(MASTERCARD_URL, 'lastRun', false);
  openIfNeeded(KBANK_URL, 'kbankLastRun', false);
});

// Catch-up: if Chrome starts (or the service worker wakes) after 09:00 local and
// today's captures haven't run — e.g. the Mac was powered off at 09:00 — run them
// now. The per-day guards make this idempotent; a capture that already succeeded
// today is never repeated. (A capture that FAILED outright leaves its guard unset,
// so it also gets retried on the next worker wake — intentional.)
async function catchUpIfMissed() {
  const now = new Date();
  const nine = new Date(now);
  nine.setHours(FIRE_HOUR, FIRE_MIN, 0, 0);
  if (now < nine) return;
  openIfNeeded(MASTERCARD_URL, 'lastRun', false);
  openIfNeeded(KBANK_URL, 'kbankLastRun', false);
}
chrome.runtime.onStartup.addListener(catchUpIfMissed);
catchUpIfMissed();

// Toolbar button = manual "capture now" for both sources (ignores the once-a-day guard).
chrome.action.onClicked.addListener(() => {
  openIfNeeded(MASTERCARD_URL, 'lastRun', true);
  openIfNeeded(KBANK_URL, 'kbankLastRun', true);
});

// Content scripts ask us to close their tab when finished (and record the day's run).
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && (msg.type === 'mcDone' || msg.type === 'kbankDone')) {
    const key = msg.type === 'mcDone' ? 'lastRun' : 'kbankLastRun';
    if (msg.date) chrome.storage.local.set({ [key]: msg.date, [key + 'Result']: msg });
    if (sender.tab && sender.tab.id) chrome.tabs.remove(sender.tab.id);
    sendResponse({ ok: true });
  }
  return true;
});
