#!/usr/bin/env node
/**
 * Parse the mirrored pal + item pages (data/raw/) into data/dataset.json (schema v2).
 *
 * Pure page parsing lives in scripts/parse-lib.mjs (unit-tested against fixtures);
 * this script is the orchestration: read the mirror, merge into the base dataset,
 * run the validation gate, and write atomically.
 *
 * Pal pages enrich each pal record with: food, size, rarity, partner skill,
 * active/passive skills, possible drops, work suitability, spawn locations and
 * summary. Item pages become a new `items` array: code/name/rarity/type/rank/
 * sell price/weight/stack count/typeA/typeB + dropped-by rows.
 *
 * Exit non-zero if the validation gate fails. Never writes a partial dataset.
 *
 * Usage: node scripts/parse-pages.mjs [--raw-dir data/raw]
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parsePalPage, parseItemPage } from './parse-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'data', 'dataset.json');

// ---------- merge + gate ----------

const ds = JSON.parse(readFileSync(join(ROOT, 'data', 'dataset.json'), 'utf8'));
const errors = [];
const warnings = [];

// Reset v2 enrichment fields before re-parsing: a pal whose page no longer yields a
// field (removed section, empty copy) must not keep the stale value from a past run.
const ENRICH_KEYS = ['size', 'rarity', 'food', 'workSpeed', 'genus', 'summary', 'partnerSkill', 'activeSkills', 'passiveSkills', 'workSuitability', 'drops', 'spawns'];
for (const p of ds.pals) for (const k of ENRICH_KEYS) delete p[k];

const palFiles = readdirSync(join(RAW, 'pal')).filter((f) => f.endsWith('.html'));
const itemFiles = readdirSync(join(RAW, 'item')).filter((f) => f.endsWith('.html'));
console.error(`[parse] ${palFiles.length} pal pages, ${itemFiles.length} item pages`);

// Pal enrichment: match by slug (file name == slug).
const bySlug = new Map(ds.pals.map((p) => [p.slug, p]));
let enriched = 0;
let palUnknown = 0;
for (const f of palFiles) {
  const slug = f.replace(/\.html$/, '');
  const pal = bySlug.get(slug);
  const html = readFileSync(join(RAW, 'pal', f), 'utf8');
  const parsed = parsePalPage(html);
  if (!pal) {
    palUnknown++;
    if (!Object.keys(parsed).length) continue;
    warnings.push(`pal page ${slug} has no matching dataset record (new pal?): ${Object.keys(parsed).join(',')}`);
    continue;
  }
  if (Object.keys(parsed).length) {
    Object.assign(pal, parsed);
    enriched++;
  } else {
    warnings.push(`pal ${slug}: no parseable content`);
  }
}

// Items: parse all pages.
const items = [];
let itemEmpty = 0;
let nonItems = 0;
for (const f of itemFiles) {
  const html = readFileSync(join(RAW, 'item', f), 'utf8');
  const slug = f.replace(/\.html$/, '');
  const item = parseItemPage(html, slug);
  if (!item) {
    nonItems++;
    continue;
  }
  if (!item.code && !item.name) {
    itemEmpty++;
    warnings.push(`item page ${f}: no parseable content`);
    continue;
  }
  if (!item.code) item.code = slug;
  if (!item.slug) item.slug = slug;
  items.push(item);
}
items.sort((a, b) => a.name.localeCompare(b.name));

// gate
const palCount = ds.pals.length;
if (palCount !== 299) errors.push(`expected 299 pals, got ${palCount}`);
if (items.length < 700) errors.push(`expected ~800 items, got ${items.length}`);
const noCode = items.filter((i) => !i.code).length;
const noName = items.filter((i) => !i.name).length;
const noRarity = items.filter((i) => !i.rarity).length;
if (noCode || noName) errors.push(`items missing mandatory fields: code=${noCode} name=${noName}`);
if (noRarity > items.length * 0.5) errors.push(`too many items missing rarity: ${noRarity}/${items.length}`);
const enrichedCount = ds.pals.filter((p) => p.activeSkills || p.workSuitability || p.drops).length;
if (enrichedCount < 200) errors.push(`expected most pals enriched, got ${enrichedCount}`);
const noCombo = ds.pals.filter((p) => p.rankResult && !p.activeSkills).length;

for (const w of warnings.slice(0, 20)) console.error(`[parse] warn: ${w}`);
console.error(`[parse] pals enriched: ${enriched}/${palFiles.length} (${palUnknown} unknown-pal pages skipped)`);
console.error(`[parse] items parsed: ${items.length} (${itemEmpty} empty), enriched pals: ${enrichedCount}`);

if (errors.length) {
  for (const e of errors) console.error(`[parse] GATE FAIL: ${e}`);
  process.exit(1);
}

// write v2 dataset atomically
ds.schemaVersion = 2;
ds.generatedAt = new Date().toISOString();
ds.items = items;
ds.coverage = { pals: ds.pals.length, items: items.length, at: new Date().toISOString() };
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, JSON.stringify(ds, null, 1));
renameSync(tmp, OUT);
console.error(`[parse] wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB), schema v${ds.schemaVersion}`);
