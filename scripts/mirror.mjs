#!/usr/bin/env node
/**
 * Owner-side mirror crawler: fetches pal + item pages from paldb.cc with the
 * throttle protocol (polite UA, jittered sequential requests, 200+empty-body
 * signature detection -> exponential backoff). Resume-safe: skips pages that
 * already exist in data/raw/.
 *
 * Usage:
 *   node scripts/mirror.mjs                 # pals then items (default)
 *   node scripts/mirror.mjs --only pals     # pal pages only
 *   node scripts/mirror.mjs --only items    # item pages only
 *   node scripts/mirror.mjs --limit 50      # fetch at most N pages (test mode)
 *   node scripts/mirror.mjs --delay 2000    # base delay between requests (ms)
 *   node scripts/mirror.mjs --fetch-index   # refresh the cached /Items index page
 *
 * Item universe: the UNION of the sitemap fixture (exp/recon/paldb_sitemap.xml)
 * and paldb's own /Items index page (cached at data/raw/items_index.html via
 * --fetch-index). The sitemap alone omits whole content eras (Feybreak items);
 * the /Items page is the complete item index.
 *
 * Output: data/raw/pal/<slug>.html, data/raw/item/<slug>.html,
 *         data/raw/progress.json (fetched counts, for polling).
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const FAILED_FILE = join(RAW, 'failed.json');
const ITEMS_INDEX_FILE = join(RAW, 'items_index.html');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** Load the set of slugs that permanently fail (404 etc.) — skipped on resume. */
function loadPermanentMisses() {
  try {
    const d = JSON.parse(readFileSync(FAILED_FILE, 'utf8'));
    return new Set(d.filter((f) => f.reason === 'permanent').map((f) => f.slug));
  } catch {
    return new Set();
  }
}

function recordFailure(slug, reason) {
  try {
    const cur = existsSync(FAILED_FILE) ? JSON.parse(readFileSync(FAILED_FILE, 'utf8')) : [];
    cur.push({ slug, reason, at: new Date().toISOString() });
    writeFileSync(FAILED_FILE, JSON.stringify(cur, null, 1));
  } catch {
    /* best-effort */
  }
}

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : def;
}
const ONLY = arg('--only', 'all');
const LIMIT = parseInt(arg('--limit', '0'), 10) || Infinity;
const DELAY = parseInt(arg('--delay', '1600'), 10);

/** Slugs from the sitemap fixture (source A — historical, omits Feybreak-era content). */
function sitemapSlugs() {
  const xml = readFileSync(join(ROOT, 'exp', 'recon', 'paldb_sitemap.xml'), 'utf8');
  return [
    ...new Set([...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].replace('https://paldb.cc', '').replace(/^\//, ''))),
  ];
}

/** Slugs from paldb's /Items index page (source B — the complete item universe). */
function itemsIndexSlugs() {
  if (!existsSync(ITEMS_INDEX_FILE)) {
    throw new Error(`items index missing — run "node scripts/mirror.mjs --fetch-index" once to cache ${ITEMS_INDEX_FILE}`);
  }
  const h = readFileSync(ITEMS_INDEX_FILE, 'utf8');
  return [...new Set([...h.matchAll(/href="([A-Za-z0-9_%\-]+)"/g)].map((m) => m[1]))];
}

function buildList() {
  const ds = JSON.parse(readFileSync(join(ROOT, 'data', 'dataset.json'), 'utf8'));
  const palSlugs = new Set(ds.pals.map((p) => p.slug));
  const palNames = new Set(ds.pals.map((p) => p.name.replace(/ /g, '_')));
  const slugs = [...new Set([...sitemapSlugs(), ...itemsIndexSlugs()])];
  const pals = ds.pals.map((p) => ({ url: `https://paldb.cc/${p.slug}`, name: p.slug, kind: 'pal' }));
  const items = slugs
    .filter((s) => s && !palSlugs.has(s) && !palNames.has(s))
    .filter((s) => ![...palNames].some((n) => s.replace(/_+$/, '').endsWith('_' + n))) // title-style pal pages (incl. trailing-underscore sitemap twins)
    .filter((s) => !s.endsWith('_')) // trailing-underscore duplicates 404
    .filter((s) => !/diary/i.test(s))
    .filter((s) => !/^en_text/i.test(s)) // i18n text-dump pages, not items
    .filter((s) => !/%26|Syndicate|PIDF|Commander|Brothers_of_the|Rayne/.test(s))
    .filter((s) => !['Breed', 'privacy', 'en_text', 'en_Text_en_text', ''].includes(s))
    .map((s) => ({ url: `https://paldb.cc/${s}`, name: s, kind: 'item' }));
  return { pals, items };
}

let backoffMs = 30000;

async function fetchPage(page) {
  const dir = join(RAW, page.kind);
  const file = join(dir, `${page.name}.html`);
  if (existsSync(file) && statSync(file).size > 1000) return { cached: true };
  mkdirSync(dir, { recursive: true });
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch(page.url, {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
      });
    } catch (e) {
      console.error(`[mirror] fetch error ${page.url}: ${e.message}`);
      await sleep(backoffMs);
      continue;
    }
    const body = await res.text();
    const ctype = res.headers.get('content-type') ?? '';
    const isThrottle = res.status === 200 && (body.length === 0 || (ctype.includes('text/html') && body.length < 500));
    if (!isThrottle) {
      if (res.status !== 200) {
        // Permanent/non-throttle failure (404, 5xx): skip immediately, no backoff.
        console.error(`[mirror] status ${res.status} ${page.url} — skipping`);
        if (res.status === 404) recordFailure(page.name, 'permanent');
        return { failed: true, permanent: true };
      }
      writeFileSync(file, body);
      if (backoffMs > 30000) backoffMs = 30000;
      return { ok: true, bytes: body.length };
    }
    // Throttle signature (200 + empty/tiny body): back off and retry.
    console.error(`[mirror] throttled (${page.url}, status ${res.status}, ${body.length}B) — attempt ${attempt + 1}/4, backing off ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs);
    if (backoffMs < 300000) backoffMs *= 2;
  }
  console.error(`[mirror] giving up on ${page.url} after 4 throttle retries`);
  return { failed: true };
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Fetch paldb's /Items index page and cache it (throttle-aware, 4 attempts). */
async function fetchIndex() {
  console.error('[mirror] fetching items index from https://paldb.cc/Items ...');
  for (let attempt = 0; attempt < 4; attempt++) {
    let res;
    try {
      res = await fetch('https://paldb.cc/Items', {
        headers: { 'User-Agent': UA, Accept: 'text/html' },
        redirect: 'follow',
      });
    } catch (e) {
      console.error(`[mirror] index fetch error: ${e.message}`);
      await sleep(backoffMs);
      if (backoffMs < 300000) backoffMs *= 2;
      continue;
    }
    const body = await res.text();
    const ctype = res.headers.get('content-type') ?? '';
    const isThrottle = res.status === 200 && (body.length === 0 || (ctype.includes('text/html') && body.length < 500));
    if (res.status === 200 && !isThrottle) {
      writeFileSync(ITEMS_INDEX_FILE, body);
      console.error(`[mirror] items index cached (${body.length} bytes)`);
      return;
    }
    console.error(`[mirror] index attempt ${attempt + 1}/4 throttled (status ${res.status}, ${body.length}B) — backing off ${Math.round(backoffMs / 1000)}s`);
    await sleep(backoffMs);
    if (backoffMs < 300000) backoffMs *= 2;
  }
  throw new Error('could not fetch the items index after 4 attempts');
}

async function crawl(list, label) {
  let done = 0;
  let failed = 0;
  for (const page of list) {
    if (done >= LIMIT) break;
    const r = await fetchPage(page);
    if (r.cached) continue;
    if (r.failed) failed++;
    done++;
    if (done % 10 === 0 || r.failed) {
      console.error(`[mirror] ${label} ${done}/${list.length} (failed ${failed})`);
      writeProgress();
    }
    await sleep(DELAY + Math.random() * 600);
  }
  console.error(`[mirror] ${label} done: fetched ${done}, failed ${failed}, total ${list.length}`);
  return { fetched: done, failed };
}

function writeProgress() {
  try {
    const palDir = join(RAW, 'pal');
    const itemDir = join(RAW, 'item');
    const count = (dir) => (existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.html')).length : 0);
    writeFileSync(
      join(RAW, 'progress.json'),
      JSON.stringify({ pals: count(palDir), items: count(itemDir), at: new Date().toISOString() }, null, 1),
    );
  } catch {
    /* progress is best-effort */
  }
}

if (process.argv.includes('--fetch-index')) {
  await fetchIndex();
  console.error('[mirror] index refreshed — run again without --fetch-index to crawl');
  process.exit(0);
}

const { pals, items } = buildList();
const permanentMisses = loadPermanentMisses();
const itemFilter = (p) => !permanentMisses.has(p.name);
console.error(`[mirror] targets: ${pals.length} pals, ${items.length} items (${permanentMisses.size} known permanent misses skipped), delay ${DELAY}ms`);
writeProgress();

if (ONLY === 'all' || ONLY === 'pals') await crawl(pals, 'pals');
if (ONLY === 'all' || ONLY === 'items') await crawl(items.filter(itemFilter), 'items');
writeProgress();
console.error('[mirror] complete');
