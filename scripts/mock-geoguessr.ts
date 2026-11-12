/**
 * A local stand-in for geoguessr.com, for trying the collector end to end without an account.
 * It serves the same API responses the tests use, built from the demo players.
 *
 *   npm run mock:geoguessr            (http://localhost:4174, signed in as the first demo player)
 *   npm run mock:geoguessr -- --port 5000 --days 200 --signed-out
 *
 * Open the page it prints, then run the collector there exactly as you would on GeoGuessr
 * (bookmarklet or pasted script). The app accepts data from localhost while it runs on localhost.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { Topology } from 'topojson-specification';
import { generateDemo } from '../src/data/demo';
import { buildGeo, type CoverageFile } from '../src/geo/geo';
import { createMockApi } from '../tests/helpers/mockGeoguessr';

const args = process.argv.slice(2);
const opt = (name: string, fallback: string): string => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const port = Number(opt('--port', '4174'));
const days = Number(opt('--days', '120'));

const dir = path.resolve('public/data');
const coverage = JSON.parse(fs.readFileSync(path.join(dir, 'coverage.json'), 'utf8')) as CoverageFile;
const geo = buildGeo(
  JSON.parse(fs.readFileSync(path.join(dir, 'regions.topo.json'), 'utf8')) as Topology,
  coverage,
  new Uint8Array(fs.readFileSync(path.join(dir, coverage.grid.file))),
);
const demo = generateDemo(geo, { days });
const api = createMockApi(demo, { ownerId: demo.owner.id, signedOut: args.includes('--signed-out') });

const page = `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Mock GeoGuessr</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:60ch;margin:60px auto;padding:0 20px;background:#16161f;color:#eee}code{background:#2a2a3a;padding:2px 6px;border-radius:4px}</style></head>
<body>
<h1>Mock GeoGuessr</h1>
<p>Signed in as <strong>${demo.owner.nick}</strong>, with ${api.ownerTokens.length} daily challenges and ${demo.players.length - 1} friends.</p>
<p>Run the Desafío Diario collector on this page (bookmarklet or pasted script) to try the whole flow.</p>
</body></html>`;

http.createServer((req, res) => {
  const url = req.url ?? '/';
  if (req.method !== 'GET') {
    res.writeHead(405).end();
    return;
  }
  if (url.startsWith('/api/')) {
    const result = api.handle(url);
    const headers: Record<string, string> = { 'content-type': 'application/json; charset=utf-8' };
    if (result.retryAfterMs) headers['retry-after'] = String(result.retryAfterMs / 1000);
    res.writeHead(result.status, headers);
    res.end(result.data === null ? '' : JSON.stringify(result.data));
    return;
  }
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(page);
}).listen(port, () => {
  console.log(`Mock GeoGuessr on http://localhost:${port}/  (${api.ownerTokens.length} daily challenges for ${demo.owner.nick})`);
});
