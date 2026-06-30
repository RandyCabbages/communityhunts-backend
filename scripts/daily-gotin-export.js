#!/usr/bin/env node
// Daily Got-In workbook downloader (runs on the operator's PC via Task Scheduler).
// Pulls the multi-tab .xlsx from the deployed backend and drops it into a local folder.
// Auth is the GOTIN_EXPORT_KEY shared secret (the backend's /api/admin/gotin-log.xlsx accepts it),
// so this needs no Discord login. All config comes from env vars — set them in the wrapper .bat.
//
//   GOTIN_EXPORT_KEY  (required)  shared secret, must match the backend env var
//   GOTIN_API_BASE    default https://api.communityhunts.gg
//   GOTIN_TZ          default America/Chicago   day-boundary timezone (also names the file)
//   GOTIN_OUT_DIR     default <home>\Documents\CommunityHunts
//   GOTIN_SLUG        default bean              tenant slug
//
// Requires Node 18+ (global fetch). Writes got-in-YYYY-MM-DD.xlsx + got-in-latest.xlsx, and
// appends a line to gotin-export.log in the output folder. Non-zero exit on failure.

const fs = require('fs');
const path = require('path');
const os = require('os');

const KEY  = process.env.GOTIN_EXPORT_KEY || '';
const API  = (process.env.GOTIN_API_BASE || 'https://api.communityhunts.gg').replace(/\/+$/, '');
const TZ   = process.env.GOTIN_TZ || 'America/Chicago';
const SLUG = process.env.GOTIN_SLUG || 'bean';
const OUT  = process.env.GOTIN_OUT_DIR || path.join(os.homedir(), 'Documents', 'CommunityHunts');

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  try { fs.mkdirSync(OUT, { recursive: true }); fs.appendFileSync(path.join(OUT, 'gotin-export.log'), line); } catch (e) {}
  process.stdout.write(line);
}
function ymd() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}

async function main() {
  if (!KEY) throw new Error('GOTIN_EXPORT_KEY is not set');
  fs.mkdirSync(OUT, { recursive: true });
  const url = `${API}/api/admin/gotin-log.xlsx?tz=${encodeURIComponent(TZ)}&_tenant=${encodeURIComponent(SLUG)}`;
  const res = await fetch(url, { headers: { 'X-Export-Key': KEY, 'X-Tenant-Slug': SLUG } });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const dated = path.join(OUT, `got-in-${ymd()}.xlsx`);
  fs.writeFileSync(dated, buf);
  fs.writeFileSync(path.join(OUT, 'got-in-latest.xlsx'), buf);
  log(`OK ${buf.length} bytes -> ${dated}`);
}

main().catch(e => { log(`ERROR ${e.message || e}`); process.exitCode = 1; });
