// Minimal static file server for the dashboard (no dependencies).
// Also exposes POST /mc — the Mastercard capture browser extension posts the
// daily network-rate JSON here; we persist it and run merge + publish.
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = __dirname;
const PORT = process.env.PORT || 8777;
const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json',
  '.css':'text/css', '.csv':'text/csv', '.png':'image/png', '.svg':'image/svg+xml' };

// The capture runs in a real Chrome tab on mastercard.com and POSTs cross-origin
// to this localhost server, so we must answer CORS preflight + allow that origin.
const ALLOWED_ORIGIN = 'https://www.mastercard.com';
function cors(res, origin) {
  res.setHeader('Access-Control-Allow-Origin', origin === ALLOWED_ORIGIN ? origin : ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Vary', 'Origin');
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
    // Merge into today's snapshot, then publish. Fixed scripts only — no shell-injection surface.
    execFile('node', ['merge-mastercard.js'], { cwd: ROOT }, (mErr, mOut, mErrOut) => {
      const mergeLog = (mOut || '') + (mErrOut || '');
      execFile('/bin/zsh', ['publish.sh'], { cwd: ROOT }, (pErr, pOut, pErrOut) => {
        const pubLog = (pOut || '') + (pErrOut || '');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: !mErr,
          received: Object.keys(clean).length,
          fxDate: out.fxDate,
          merge: mergeLog.trim(),
          publish: pubLog.trim(),
        }));
        console.log(`[/mc] ${new Date().toISOString()} received ${Object.keys(clean).length} rates (fxDate ${out.fxDate}). ${mergeLog.trim()} | ${pubLog.trim()}`);
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
