// Minimal static file server for the dashboard (no dependencies).
// Also exposes POST /mc — the Mastercard capture browser extension posts the
// daily network-rate JSON here; we persist it and run merge + publish.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 8777;
const status = require('./status');

// Record a capture's outcome in data/status.json (count parsed from the merge log,
// e.g. "Merged kjourney into 2026-07-02: 20 currencies").
function recordCapture(name, mergeLog, received, ok) {
  const m = (mergeLog || '').match(/:\s*(\d+)\s+currencies/);
  try {
    status.merge({ captures: { [name]: { ok, at: new Date().toISOString(), count: m ? +m[1] : received } } });
  } catch (e) { /* best effort */ }
}
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
  '.css':'text/css', '.csv':'text/csv', '.png':'image/png', '.svg':'image/svg+xml' };

// Captures run in real Chrome tabs on these origins and POST cross-origin to this
// localhost server, so we must answer CORS preflight + allow those origins.
const ALLOWED_ORIGINS = ['https://www.mastercard.com', 'https://www.kasikornbank.com'];
function cors(res, origin) {
  const allow = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  res.setHeader('Access-Control-Allow-Origin', allow);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
}

// Sources allowed via the generic /src endpoint (buy/sell rates -> sources.<name>).
const ALLOWED_SOURCES = ['kjourney'];

function bangkokDate() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date());
}

// Does today's (BKT) snapshot already exist? The Mastercard merge needs it.
function hasTodaySnapshot() {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'snapshots.json'), 'utf8'));
    const today = bangkokDate();
    return Array.isArray(s) && s.some((x) => x.date === today);
  } catch { return false; }
}

// Wait for the 09:00 collector to write today's snapshot before merging. Normally
// the collector finishes in seconds so this returns immediately; the polling only
// matters if Mastercard fires before a slow collector. After ~3 min with no
// snapshot (collector failed / Mac was asleep) we run collect.js ourselves.
function ensureSnapshot(cb) {
  const MAX_ATTEMPTS = 18; // 18 × 10s = 180s
  let n = 0;
  const tick = () => {
    if (hasTodaySnapshot()) return cb(null);
    if (++n >= MAX_ATTEMPTS) {
      console.log('[/mc] snapshot still missing after wait — running collect.js fallback');
      return execFile('node', ['collect.js'], { cwd: ROOT }, () => cb('fallback-collect'));
    }
    setTimeout(tick, 10000);
  };
  tick();
}

function handleMcPost(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', (c) => { body += c; if (body.length > 1e5) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) { res.writeHead(413); return res.end('payload too large'); }
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
    // Validate shape: { fxDate: string|null, rates: { CCY: number, ... } }
    const rates = payload && payload.rates;
    if (!rates || typeof rates !== 'object' || !Object.keys(rates).length) {
      res.writeHead(422); return res.end('no rates');
    }
    const clean = {};
    for (const [k, v] of Object.entries(rates)) {
      if (/^[A-Z]{3}$/.test(k) && isFinite(+v) && +v > 0) clean[k] = +v;
    }
    if (!Object.keys(clean).length) { res.writeHead(422); return res.end('no valid rates'); }
    const out = { fxDate: typeof payload.fxDate === 'string' ? payload.fxDate : null, rates: clean };
    fs.writeFileSync(path.join(ROOT, 'data', 'mc-input.json'), JSON.stringify(out, null, 2));
    // Ensure today's snapshot exists, then merge + publish. Fixed scripts only — no
    // shell-injection surface.
    ensureSnapshot((waitNote) => {
      execFile('node', ['merge-mastercard.js'], { cwd: ROOT }, (mErr, mOut, mErrOut) => {
        const mergeLog = (mOut || '') + (mErrOut || '');
        execFile('/bin/zsh', ['publish.sh'], { cwd: ROOT }, (pErr, pOut, pErrOut) => {
          const pubLog = (pOut || '') + (pErrOut || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: !mErr,
            received: Object.keys(clean).length,
            fxDate: out.fxDate,
            wait: waitNote || 'snapshot-ready',
            merge: mergeLog.trim(),
            publish: pubLog.trim(),
          }));
          console.log(`[/mc] ${new Date().toISOString()} received ${Object.keys(clean).length} rates (fxDate ${out.fxDate}). ${mergeLog.trim()} | ${pubLog.trim()}`);
          recordCapture('mastercard', mergeLog, Object.keys(clean).length, !mErr);
        });
      });
    });
  });
}

// Generic source endpoint: { source, ts, rates: { CCY: {buy, sell} } } -> sources.<source>.
// Used by the K-Journey (KBank debit) capture; mastercard keeps its own /mc.
function handleSrcPost(req, res) {
  let body = '';
  let tooBig = false;
  req.on('data', (c) => { body += c; if (body.length > 1e5) { tooBig = true; req.destroy(); } });
  req.on('end', () => {
    if (tooBig) { res.writeHead(413); return res.end('payload too large'); }
    let payload;
    try { payload = JSON.parse(body); } catch { res.writeHead(400); return res.end('bad json'); }
    const source = payload && payload.source;
    if (!ALLOWED_SOURCES.includes(source)) { res.writeHead(422); return res.end('unknown source'); }
    const rates = payload && payload.rates;
    if (!rates || typeof rates !== 'object' || !Object.keys(rates).length) {
      res.writeHead(422); return res.end('no rates');
    }
    const clean = {};
    for (const [k, v] of Object.entries(rates)) {
      if (!/^[A-Z]{3}$/.test(k) || !v || typeof v !== 'object') continue;
      const buy = isFinite(+v.buy) && +v.buy > 0 ? +v.buy : null;
      const sell = isFinite(+v.sell) && +v.sell > 0 ? +v.sell : null;
      if (buy != null || sell != null) clean[k] = { buy, sell };
    }
    if (!Object.keys(clean).length) { res.writeHead(422); return res.end('no valid rates'); }
    const out = { ts: typeof payload.ts === 'string' ? payload.ts : null, rates: clean };
    fs.writeFileSync(path.join(ROOT, 'data', `${source}-input.json`), JSON.stringify(out, null, 2));
    ensureSnapshot((waitNote) => {
      execFile('node', ['merge-source.js', source], { cwd: ROOT }, (mErr, mOut, mErrOut) => {
        const mergeLog = (mOut || '') + (mErrOut || '');
        execFile('/bin/zsh', ['publish.sh'], { cwd: ROOT }, (pErr, pOut, pErrOut) => {
          const pubLog = (pOut || '') + (pErrOut || '');
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            ok: !mErr, source, received: Object.keys(clean).length,
            wait: waitNote || 'snapshot-ready', merge: mergeLog.trim(), publish: pubLog.trim(),
          }));
          console.log(`[/src ${source}] ${new Date().toISOString()} received ${Object.keys(clean).length} rates. ${mergeLog.trim()} | ${pubLog.trim()}`);
          recordCapture(source, mergeLog, Object.keys(clean).length, !mErr);
        });
      });
    });
  });
}

http.createServer((req, res) => {
  const origin = req.headers.origin || '';
  const urlPath = req.url.split('?')[0];

  if (urlPath === '/mc') {
    if (req.method === 'OPTIONS') { cors(res, origin); res.writeHead(204); return res.end(); }
    if (req.method === 'POST') { cors(res, origin); return handleMcPost(req, res); }
    res.writeHead(405); return res.end('method not allowed');
  }

  if (urlPath === '/src') {
    if (req.method === 'OPTIONS') { cors(res, origin); res.writeHead(204); return res.end(); }
    if (req.method === 'POST') { cors(res, origin); return handleSrcPost(req, res); }
    res.writeHead(405); return res.end('method not allowed');
  }

  // Tunable capture settings the browser extension reads each run — lets us change the
  // currency list / timing WITHOUT reloading the extension. Served fresh from disk so
  // edits to data/mc-config.json take effect on the next daily run (no server restart).
  if (urlPath === '/mc-config') {
    cors(res, origin);
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    if (req.method !== 'GET') { res.writeHead(405); return res.end('method not allowed'); }
    return fs.readFile(path.join(ROOT, 'data', 'mc-config.json'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(buf);
    });
  }

  // Static file serving (GET).
  let p = decodeURIComponent(urlPath);
  if (p === '/') p = '/dashboard.html';
  const file = path.join(ROOT, p);
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  });
}).listen(PORT, '127.0.0.1', () => console.log('Dashboard server on http://localhost:' + PORT + ' (POST /mc enabled)'));
