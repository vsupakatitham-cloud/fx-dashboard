#!/usr/bin/env node
/*
 * Pipeline health status — data/status.json.
 *
 * Every pipeline step records what it did so failures are explicit instead of
 * inferred: collect.js -> {date, collector}, server.js -> {captures.<source>},
 * publish.sh -> {push}. The dashboard banner and the morning claude.ai routine
 * read this file (it is committed by publish.sh, so the published copy is as-of
 * the last successful push — push failures are only visible on the local
 * dashboard and as staleness remotely).
 *
 * Use as a module:  require('./status').merge({ collector: {...} })
 * Use as a CLI:     node status.js merge '{"push":{"ok":true}}'
 *
 * merge() is a shallow section merge (top-level keys replaced, except `captures`
 * which merges per-source). Concurrent writers (collector vs server at 09:00)
 * can race read-merge-write; sections are writer-owned so a lost update is rare
 * and self-heals on the next run — acceptable for a single-user pipeline.
 */
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data', 'status.json');

function read() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch (e) { return {}; }
}

function merge(patch) {
  const cur = read();
  const next = { ...cur, ...patch };
  if (patch.captures) next.captures = { ...(cur.captures || {}), ...patch.captures };
  next.updated = new Date().toISOString();
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2) + '\n');
  return next;
}

module.exports = { read, merge, FILE };

if (require.main === module) {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'merge' && arg) {
    let patch;
    try { patch = JSON.parse(arg); } catch (e) { console.error('bad json'); process.exit(2); }
    merge(patch);
  } else if (cmd === 'show' || !cmd) {
    console.log(JSON.stringify(read(), null, 2));
  } else {
    console.error('usage: node status.js [show | merge <json>]'); process.exit(2);
  }
}
