/* Service worker: schedules a daily capture and opens the converter page so the
 * content script can run inside your real (non-automated) Mastercard session.
 *
 * Why a real tab? Mastercard's rate API is behind Akamai Bot Manager — headless
 * automation is 403'd. A normal tab you've "earned" a session cookie in passes,
 * as long as requests are paced gently. So we just open the real page daily.
 */

const CONVERTER_URL = 'https://www.mastercard.com/global/en/personal/get-support/currency-exchange-rate-converter.html';
const FIRE_HOUR = 9;    // local time (your Mac/Chrome clock is BKT)
const FIRE_MIN = 0;     // 09:00 — same as the launchd collector. The collector finishes
                        // in ~seconds, and the /mc endpoint waits for its snapshot before
                        // merging, so there's no race even firing at the same minute.

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

async function alreadyDoneToday() {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
  const { lastRun } = await chrome.storage.local.get('lastRun');
  return lastRun === today;
}

async function openCaptureTab() {
  if (await alreadyDoneToday()) return;
  // '#fxauto' tells the content script this is the scheduled run (vs. you just browsing).
  await chrome.tabs.create({ url: CONVERTER_URL + '#fxauto', active: false });
}

chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'mcDaily') openCaptureTab(); });

// Toolbar button = manual "capture now" (ignores the once-a-day guard).
chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: CONVERTER_URL + '#fxauto&force', active: false });
});

// Content script asks us to close its tab when it's finished.
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.type === 'mcDone') {
    if (msg.date) chrome.storage.local.set({ lastRun: msg.date, lastResult: msg });
    if (sender.tab && sender.tab.id) chrome.tabs.remove(sender.tab.id);
    sendResponse({ ok: true });
  }
  return true;
});
