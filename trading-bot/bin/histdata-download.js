#!/usr/bin/env node
// Downloads HistData.com free 1-minute ASCII bars (zip per year; per month for the current
// year) into <out>/stocks/histdata/<PAIR>/, the layout lib/marketdata.js reads.
//   node bin/histdata-download.js <out> <PAIR,PAIR,...> <fromYear>
// Needs open internet (runs in a GitHub workflow); unzips with the system `unzip`.
import { mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const [out, pairs, from] = process.argv.slice(2);
const PAGE = 'https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/';
const now = new Date();

async function one(pair, year, month) {
  const dir = join(out, 'stocks/histdata', pair);
  mkdirSync(dir, { recursive: true });
  const tag = month ? `${year}${String(month).padStart(2, '0')}` : `${year}`;
  const zip = join(dir, `DAT_ASCII_${pair}_M1_${tag}.zip`);
  if (existsSync(zip)) return;
  const referer = `${PAGE}${pair.toLowerCase()}/${year}${month ? `/${month}` : ''}`;
  const page = await (await fetch(referer)).text();
  const tk = /id="tk"[^>]*value="([^"]+)"|value="([^"]+)"[^>]*id="tk"/.exec(page);
  if (!tk) { console.log(`${pair} ${tag}: no token (no data?)`); return; }
  const body = new URLSearchParams({ tk: tk[1] ?? tk[2], date: String(year), datemonth: tag, platform: 'ASCII', timeframe: 'M1', fxpair: pair });
  const res = await fetch('https://www.histdata.com/get.php', { method: 'POST', body, headers: { Referer: referer, Origin: 'https://www.histdata.com' } });
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1000) { console.log(`${pair} ${tag}: empty (${buf.length} bytes)`); return; }
  writeFileSync(zip, buf);
  execFileSync('unzip', ['-o', '-q', zip, '*.csv', '-d', dir]);
  console.log(`${pair} ${tag}: ${(buf.length / 1e6).toFixed(1)} MB`);
}

for (const pair of pairs.split(',')) {
  for (let y = +from; y < now.getUTCFullYear(); y++) await one(pair, y);
  for (let mo = 1; mo <= now.getUTCMonth() + 1; mo++) await one(pair, now.getUTCFullYear(), mo);
}
