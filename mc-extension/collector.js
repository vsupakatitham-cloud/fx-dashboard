/* Shared by the content scripts: talk to the local collector (server.js) through the
 * extension's service worker. A content script's own requests carry the page's origin,
 * and Chrome's Local Network Access gate blocks a public site from reaching localhost
 * unless that site holds the permission; the worker's requests are exempt.
 * Resolves { status, text }; status 0 = collector unreachable.
 */
function collector(path, body) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage({ type: 'collector', path, body }, (r) =>
        resolve(r || { status: 0, text: (chrome.runtime.lastError || {}).message || 'no response' }));
    } catch (e) { resolve({ status: 0, text: String(e) }); }
  });
}
