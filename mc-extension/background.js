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
async function openIfNeeded(url, key, force) {
  if (!force && (await doneToday(key))) return;
  await chrome.tabs.create({ url: url + (force ? '#fxauto&force' : '#fxauto'), active: false });
}

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'mcDaily') return;
  openIfNeeded(MASTERCARD_URL, 'lastRun', false);
  openIfNeeded(KBANK_URL, 'kbankLastRun', false);
});

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
