#!/usr/bin/env node
/**
 * Parse the mirrored pal + item pages (data/raw/) into data/dataset.json (schema v2).
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

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const RAW = join(ROOT, 'data', 'raw');
const OUT = join(ROOT, 'data', 'dataset.json');

/** Nav/header content ends before this offset on paldb pages; content starts after. */
const CONTENT_MIN = 29000;

const ELEMENTS = new Set(['Normal', 'Fire', 'Water', 'Leaf', 'Electricity', 'Ice', 'Earth', 'Dark', 'Dragon']);

function decodeHtml(s) {
  return s
    .replace(/&ndash;/g, '–')
    .replace(/&mdash;/g, '—')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
}

function text(s) {
  return decodeHtml(s.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
}

/** Split a <tr> into cells, tolerating UNCLOSED <td>/<th> tags (paldb markup style). */
function splitCells(rowHtml) {
  const cells = [];
  const re = /<t[dh][^>]*>([\s\S]*?)(?=<t[dh]|<\/tr>|<tr>|<\/table>|$)/g;
  let m;
  while ((m = re.exec(rowHtml))) cells.push(m[1]);
  return cells;
}

/** paldb writes <tr><td>..<td>..<tr> — rows are delimited by the NEXT <tr>, not </tr>. */
function rowsOf(html) {
  return [...html.matchAll(/<tr>([\s\S]*?)(?=<tr>|<\/table>)/g)].map((m) => m[1]);
}

/** Stats/Others cards use div rows: <div class="d-flex justify-content-between p-2 ..."> <div>Label</div> <div>Value</div> </div>
 *  Pal pages add a progress-bar div between label and value (plain <div> regex skips it). */
function divRowsOf(html) {
  const out = [];
  const chunks = html.split(/<div class="d-flex justify-content-between p-2 align-items-center border-bottom">/).slice(1);
  for (const c of chunks) {
    const cut = c.indexOf('<div class="d-flex justify-content-between');
    const row = cut >= 0 ? c.slice(0, cut) : c;
    const cells = [...row.matchAll(/<div>([\s\S]*?)<\/div>/g)].map((m) => text(m[1])).filter(Boolean);
    if (cells.length >= 2) out.push([cells[0], cells[cells.length - 1]]);
  }
  return out;
}

function kvOf(rows) {
  const out = {};
  for (const r of rows) {
    const c = Array.isArray(r) ? r : splitCells(r).map(text).filter(Boolean);
    if (c.length >= 2) out[c[0]] = c.slice(1).join(' ');
  }
  return out;
}

/** Map content-area h4/h5 sections: title -> section html (until the next header). */
function sectionMap(html) {
  const spans = [];
  for (const m of html.matchAll(/<h[45][^>]*>([\s\S]*?)<\/h[45]>/g)) {
    const t = text(m[1]);
    if (t) spans.push({ title: t, start: m.index + m[0].length });
  }
  const content = spans.filter((s) => s.start > CONTENT_MIN);
  const out = {};
  for (let i = 0; i < content.length; i++) {
    const s = content[i];
    const end = i + 1 < content.length ? content[i + 1].start : html.length;
    out[s.title] = html.slice(s.start, end);
  }
  return out;
}

// ---------- pal page ----------

function parseWorkSuitability(html) {
  const wa = html.match(/class="workArray"([\s\S]*?)(?=<h[45]|class="mt-4 ps-2"|$)/);
  if (!wa) return undefined;
  const out = [];
  // Rows are <div class="border-bottom py-1 px-3"> chunks.
  for (const row of wa[1].split(/<div class="border-bottom py-1 px-3">/).slice(1)) {
    const a = row.match(/<a href="[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    // Level appears either as <span class="Status_Up">6</span> or plain "Lv</span>6".
    const lv = row.match(/>(\d+)</);
    if (a && lv) out.push({ work: text(a[1]), level: parseInt(lv[1], 10) });
  }
  return out.length ? out : undefined;
}

/** Active Skills are card divs (not tables): name+level header, element + CT + Power bar, aggregate/desc. */
function parseActiveSkills(sec) {
  const out = [];
  for (const card of sec.matchAll(/<div class="card itemPopup activeSkill">([\s\S]*?)(?=<div class="card itemPopup activeSkill"|$)/g)) {
    const c = card[1];
    const lv = c.match(/Lv\.?\s*(\d+)/);
    const name = c.match(/<a [^>]*class="element_color_\d+"[^>]*>([\s\S]*?)<\/a>/);
    if (!name) continue;
    const element = c.match(/padding-left: 35px">([^<]+)</);
    const ct = c.match(/: <span[^>]*>(\d+)<\/span>/);
    const power = c.match(/Power:\s*<span[^>]*>(\d+)<\/span>/);
    out.push({
      level: lv ? parseInt(lv[1], 10) : null,
      name: text(name[1]),
      element: element ? element[1].trim() : null,
      cooldown: ct ? parseInt(ct[1], 10) : null,
      power: power ? parseInt(power[1], 10) : null,
    });
  }
  return out;
}

/** Passive Skills are card divs: rank banner with the name + a tooltip with the description. */
function parsePassiveSkills(sec) {
  const out = [];
  for (const card of sec.matchAll(/<div class="border bg-dark">([\s\S]*?)(?=<div class="border bg-dark"|$)/g)) {
    const name = card[1].match(/passive-rank\d+ ps-2 py-1">([^<]+)</);
    if (!name) continue;
    const title = card[1].match(/data-bs-title="([\s\S]*?)"/);
    out.push({ name: name[1].trim(), description: title ? text(decodeHtml(title[1])) || null : null });
  }
  return out;
}

function parseDrops(sec) {
  const out = [];
  for (const row of rowsOf(sec)) {
    const cells = splitCells(row).map(text).filter(Boolean);
    if (cells.length >= 2 && cells[0] !== 'Item' && cells[0] !== 'Pal') {
      out.push({ item: cells[0], qty: cells[1] ?? null, probability: cells[2] ?? null });
    }
  }
  return out;
}

function parseSpawns(sec) {
  const out = [];
  const flat = text(sec);
  // Rows like "55 | Anubis Dunes -134,-94" / "68–72 | desertisland_1" — level + location pairs.
  const re = /(\d+(?:–\d+)?)\s*([A-Za-z][A-Za-z0-9_ ,.\-–]*?)(?=\s*\d+(?:–\d+)?\s*[A-Za-z]|$)/g;
  let m;
  while ((m = re.exec(flat))) {
    const level = m[1];
    const loc = m[2].trim();
    if (loc && !/^Map$/.test(loc) && !/^Day$/.test(loc) && !/^Night$/.test(loc)) out.push({ level, location: loc });
  }
  return out.length ? out : undefined;
}

function parsePartnerSkill(sec) {
  const first = sec.match(/<h5 class="card-title text-info">([\s\S]*?)<\/h5>([\s\S]*?)(?=<h5|$)/);
  if (!first) return undefined;
  const title = text(first[1]);
  const body = text(first[2]);
  const descMatch = body.match(/When activated,([\s\S]*?)(?:Lv\.|$)/);
  return {
    name: title.replace(/^Partner Skill:\s*/i, ''),
    description: descMatch ? descMatch[1].trim() : body.slice(0, 300) || null,
  };
}

function parsePalPage(html) {
  const secs = sectionMap(html);
  const out = {};
  if (secs.Stats) {
    const kv = kvOf(divRowsOf(secs.Stats));
    if (kv.Size) out.size = kv.Size;
    if (kv.Rarity) out.rarity = kv.Rarity;
    if (kv.Food) out.food = parseInt(kv.Food, 10) || null;
    if (kv['Work Speed']) out.workSpeed = parseInt(kv['Work Speed'], 10) || null;
  }
  if (secs.Others) {
    const kv = kvOf(divRowsOf(secs.Others));
    if (kv.GenusCategory) out.genus = kv.GenusCategory;
  }
  const ws = parseWorkSuitability(html);
  if (ws) out.workSuitability = ws;
  const skills = parseActiveSkills(secs['Active Skills'] ?? '');
  if (skills.length) out.activeSkills = skills;
  const passives = parsePassiveSkills(secs['Passive Skills'] ?? '');
  if (passives.length) out.passiveSkills = passives;
  const drops = parseDrops(secs['Possible Drops'] ?? '');
  if (drops.length) out.drops = drops;
  const spawns = parseSpawns(secs.Spawner ?? '');
  if (spawns) out.spawns = spawns;
  if (secs.Summary) {
    const s = text(secs.Summary);
    if (s) out.summary = s;
  }
  const ps = parsePartnerSkill(secs['Partner Skill'] ?? '');
  if (ps?.name) out.partnerSkill = ps;
  return out;
}

// ---------- item page ----------

function parseItemPage(html, slug) {
  const secs = sectionMap(html);
  const stats = kvOf(divRowsOf(secs.Stats ?? ''));
  const others = kvOf(divRowsOf(secs.Others ?? ''));
  // Classification: pal pages and non-item pages (categories, NPCs) that slipped into
  // the item crawl list — skip them rather than emit garbage items.
  if (stats.Size || stats.Health || stats.Food) return null; // pal-style page
  if (!stats.Rarity && !stats.Type && !stats.Code && !stats.MaxStackCount) return null; // not an item page
  // Display name: the page's own itemname anchor ("Ancient Civilization Parts"), not the slug-form <title>.
  const selfLink = html.match(new RegExp(`class="itemname"[^>]*href="${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">([\\s\\S]*?)</a>`));
  const name = selfLink
    ? text(selfLink[1])
    : text(html.match(/<title>([^<]*)/)?.[1] ?? '').replace(/\s*-\s*Palworld Database Wiki\s*$/, '');
  const out = {
    code: stats.Code ?? null,
    name,
    rarity: stats.Rarity ?? null,
    type: stats.Type ?? null,
    rank: stats.Rank ? parseInt(stats.Rank, 10) : null,
    price: stats['Gold Coin'] ? parseInt(stats['Gold Coin'].match(/(\d+)\s*$/)?.[1] ?? '', 10) || null : null,
    weight: stats.Weight ? parseFloat(stats.Weight) : null,
    maxStackCount: stats.MaxStackCount ? parseInt(stats.MaxStackCount, 10) : null,
    typeA: others.TypeA ?? null,
    typeB: others.TypeB ?? null,
  };
  const droppedBy = parseDrops(secs['Dropped By'] ?? '');
  if (droppedBy.length) out.droppedBy = droppedBy;
  // Where to buy / find + crafting recipe tables.
  const merchant = parseShopRows(secs['Wandering Merchant'] ?? '');
  if (merchant.length) out.soldBy = merchant;
  const recipe = parseCraftingRows(secs['Crafting Materials'] ?? '');
  if (recipe.length) out.usedInCrafting = recipe;
  return out;
}

/** Wandering Merchant table: Item | Source (shop). Keep the shop names (2nd column). */
function parseShopRows(sec) {
  const shops = new Set();
  for (const row of rowsOf(sec)) {
    const cells = splitCells(row).map(text);
    if (cells.length >= 2 && /^[A-Za-z][A-Za-z0-9_]*$/.test(cells[1]) && cells[1] !== 'Source') shops.add(cells[1]);
  }
  return [...shops].sort();
}

/** Crafting Materials table: Materials | Product | Schematic — per-row material list + product. */
function parseCraftingRows(sec) {
  const out = [];
  for (const row of rowsOf(sec)) {
    const cells = splitCells(row);
    if (!cells.length) continue;
    const materials = [...cells[0].matchAll(/<a [^>]*>([\s\S]*?)<\/a>/g)].map((m) => text(m[1]));
    if (!materials.length) continue;
    const qtys = [...cells[0].matchAll(/itemQuantity">(\d+)/g)].map((m) => parseInt(m[1], 10));
    const product = cells.length > 1 ? text(cells[1]) : null;
    out.push({
      materials: materials.map((item, i) => ({ item, qty: qtys[i] ?? null })),
      product: product && product !== 'Product' ? product : null,
    });
  }
  return out;
}

// ---------- merge + gate ----------

const ds = JSON.parse(readFileSync(join(ROOT, 'data', 'dataset.json'), 'utf8'));
const errors = [];
const warnings = [];

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
ds.coverage = { pals: palFiles.length, items: itemFiles.length, at: new Date().toISOString() };
const tmp = `${OUT}.tmp`;
writeFileSync(tmp, JSON.stringify(ds, null, 1));
renameSync(tmp, OUT);
console.error(`[parse] wrote ${OUT} (${(statSync(OUT).size / 1024 / 1024).toFixed(1)} MB), schema v${ds.schemaVersion}`);
