#!/usr/bin/env node
/**
 * Builds data/dataset.json for palworld-mcp from three sources:
 *   1. paldb.cc  /json/iv_en.json            — per-pal stats (HP/ATK/DEF, capture rate, boss block)
 *   2. paldb.cc  /Breeding_Farm              — CombiRank table + unique-combo table (cross-check)
 *   3. palcalc-tools/palworld-1.0-calculator — ranks, rankResult eligibility, unique combos,
 *                                              paldex numbers, gender ratios, elements (MIT)
 *
 * Usage:
 *   node scripts/build-dataset.mjs                 # read local raw files (./raw by default)
 *   node scripts/build-dataset.mjs --raw-dir <dir> # raw files in <dir>
 *   node scripts/build-dataset.mjs --fetch         # download from paldb.cc + GitHub
 *
 * The structural validation gate must pass before data/dataset.json is written (atomically).
 * A failed run never touches the existing dataset — the shipped file is never left partial.
 *
 * Throttle handling (paldb.cc): single requests, browser-like headers, and retry with
 * backoff when the site answers 200 with an empty body (its rate-limit signature).
 * GitHub raw is not throttled.
 */
import { createRequire } from 'node:module';
import { writeFileSync, renameSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'data', 'dataset.json');
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const args = process.argv.slice(2);
const fetchMode = args.includes('--fetch');
const rawDir = (() => {
  const i = args.indexOf('--raw-dir');
  return i >= 0 ? resolve(process.cwd(), args[i + 1]) : join(ROOT, 'raw');
})();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Fetch with throttle detection: 200 + empty body => backoff + retry. */
async function fetchWithRetry(url, { retries = 3, baseDelayMs = 2000 } = {}) {
  let last = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://paldb.cc/' } });
    const body = await res.text();
    if (res.ok && body.length > 0) return body;
    if (res.ok && body.length === 0 && url.includes('paldb.cc')) {
      console.warn(`[throttle] empty 200 from ${url} (attempt ${attempt + 1}/${retries + 1})`);
    } else if (!res.ok) {
      console.warn(`[http ${res.status}] ${url} (attempt ${attempt + 1}/${retries + 1})`);
    }
    last = { status: res.status, len: body.length };
    await sleep(baseDelayMs * 2 ** attempt);
  }
  throw new Error(`fetch failed after ${retries + 1} attempts: ${url} (last: ${last.status}, ${last.len}B)`);
}

async function readRaw(name, url) {
  if (fetchMode) return fetchWithRetry(url);
  const p = join(rawDir, name);
  if (!existsSync(p)) throw new Error(`raw file missing: ${p} — run with --fetch or --raw-dir`);
  return readFileSync(p, 'utf8');
}

// ---------- parsers ----------

function parseIvJson(raw) {
  const arr = JSON.parse(raw);
  const byCode = new Map();
  for (const it of arr) {
    if (!it.Code) continue;
    const boss = it.Boss && Object.keys(it.Boss).length ? it.Boss : null;
    byCode.set(it.Code, {
      name: it.NameEn || it.Name,
      stats: {
        hp: it.Hp,
        attack: it.ShotAttack,
        defense: it.Defense,
      },
      friendship: {
        hp: it.Friendship_Hp,
        attack: it.Friendship_ShotAttack,
        defense: it.Friendship_Defense,
      },
      captureRate: it.CaptureRate,
      ignoreCombi: Boolean(it.IgnoreCombi),
      boss: boss
        ? {
            hp: boss.Hp,
            attack: boss.ShotAttack,
            defense: boss.Defense,
            captureRate: boss.CaptureRate,
          }
        : null,
    });
  }
  return byCode;
}

/** Pull one embedded JS object literal: /const NAME = ({...});/ */
function extractJsObject(raw, name) {
  const m = raw.match(new RegExp(`const ${name} = (\\{[\\s\\S]*?\\});\\n`));
  if (!m) throw new Error(`could not locate "const ${name} =" in source`);
  return JSON.parse(m[1]);
}

function parsePalcalc(raw) {
  const data = extractJsObject(raw, 'DATA');
  const combat = extractJsObject(raw, 'COMBAT');
  const pals = new Map();
  for (const [code, p] of Object.entries(data.pals)) {
    const el = combat[code] ? combat[code].slice(3, 5).filter(Boolean) : [];
    pals.set(code, {
      name: p.name,
      slug: p.slug,
      deck: p.deck ?? '',
      rank: p.rank,
      maleRatio: p.male ?? 50,
      rankResult: Boolean(p.rankResult),
      element: el,
    });
  }
  // Drop tower-boss self-rows ("X_Tower + X_Tower = X_Tower"): paldb calculator artifacts,
  // not real breeding — tower bosses are not among the 299 breedable forms.
  // Also drop identity rows (X + X = X): covered by the engine's identity rule, and the
  // farm page's combo table omits them (keeps the dataset minimal and parity-checkable).
  const unique = data.unique.filter(
    ([a, b, c]) => !a.endsWith('_Tower') && !b.endsWith('_Tower') && !c.endsWith('_Tower') && a !== b,
  );
  return { pals, unique };
}

function extractTable(html, nthDataTable, label) {
  const starts = [...html.matchAll(/<table[^>]*class='[^']*DataTable[^']*'/g)];
  const s = starts[nthDataTable];
  if (!s) throw new Error(`table #${nthDataTable + 1} (${label}) not found`);
  const end = html.indexOf('</table>', s.index);
  return html.slice(s.index, end);
}

function parseFarmRanks(html) {
  const tbl = extractTable(html, 0, 'CombiRank');
  const ranks = new Map();
  for (const row of tbl.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const tds = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]);
    if (tds.length < 2) continue;
    const name = tds[0].match(/<a[^>]*>(?:<[^>]+>)*([^<]+)<\/a>/s);
    const rank = tds[1].match(/(\d+)/);
    if (name && rank) ranks.set(name[1].trim(), Number(rank[1]));
  }
  return ranks;
}

function parseFarmCombos(html) {
  const tbl = extractTable(html, 1, 'unique combos');
  const combos = new Set();
  for (const row of tbl.matchAll(/<tr>(.*?)<\/tr>/gs)) {
    const tds = [...row[1].matchAll(/<td[^>]*>(.*?)<\/td>/gs)].map((m) => m[1]);
    if (tds.length < 2) continue;
    const names = (cell) => {
      const text = cell.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return [...text.matchAll(/([^()]+?)\s*\(\d+\)/g)].map((m) => m[1].trim());
    };
    const parents = names(tds[0]);
    const child = names(tds[1]);
    if (parents.length !== 2 || child.length !== 1) continue;
    if (child[0].includes('&')) continue; // tower-boss rows, not real breeding
    combos.add([parents[0], parents[1]].sort().join('|') + '=' + child[0]);
  }
  return combos;
}

// ---------- merge + gate ----------

function buildDataset(iv, palcalc, farm) {
  const pals = [];
  const noStats = [];
  for (const [code, p] of palcalc.pals) {
    const s = iv.get(code);
    if (!s) {
      noStats.push(code);
      pals.push({ code, ...p, stats: null, friendship: null, captureRate: null, ignoreCombi: false, boss: null });
      continue;
    }
    pals.push({ code, ...p, ...s });
  }

  const errors = [];
  // Directional unique combos: an unordered parent pair with more than one child.
  // The raw combo rows do NOT encode gender — the male/female mapping below comes from
  // the game's DT_PalCombiUnique rows 80/81 (extracted by palcalc-tools, MIT). Entry
  // order is [maleParent, femaleParent, child]. The gate fails if the data ever contains
  // a directional pair we don't know, forcing a human to supply the gender semantics.
  const KNOWN_DIRECTIONAL = {
    'CatMage|FoxMage': [
      ['CatMage', 'FoxMage', 'FoxMage_Dark'], // Katress (male) + Wixen (female) -> Wixen Noct
      ['FoxMage', 'CatMage', 'CatMage_Fire'], // Wixen (male) + Katress (female) -> Katress Ignis
    ],
  };

  const byPair = new Map();
  for (const [a, b, c] of palcalc.unique) {
    const k = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (!byPair.has(k)) byPair.set(k, []);
    byPair.get(k).push([a, b, c]);
  }
  const directional = {};
  for (const [k, entries] of byPair) {
    const children = new Set(entries.map((e) => e[2]));
    if (children.size <= 1) continue;
    const known = KNOWN_DIRECTIONAL[k];
    if (!known) {
      errors.push(`directional pair ${k} (children: ${[...children].join(', ')}) not in KNOWN_DIRECTIONAL — add gender semantics`);
      continue;
    }
    const knownChildren = new Set(known.map((e) => e[2]));
    for (const c of children) if (!knownChildren.has(c)) errors.push(`directional pair ${k}: child ${c} missing from KNOWN_DIRECTIONAL`);
    directional[k] = known;
  }

  // gate: structural integrity
  if (pals.length !== 299) errors.push(`expected 299 pals, got ${pals.length}`);
  const codes = new Set(pals.map((p) => p.code));
  if (codes.size !== pals.length) errors.push('duplicate pal codes');
  for (const p of pals) {
    if (!Number.isInteger(p.rank) || p.rank <= 0 || p.rank > 4000) errors.push(`bad rank for ${p.code}: ${p.rank}`);
    if (!p.name) errors.push(`missing name for ${p.code}`);
  }
  for (const [a, b, c] of palcalc.unique) {
    if (!codes.has(a) || !codes.has(b) || !codes.has(c)) errors.push(`combo references unknown code: ${a}+${b}=${c}`);
  }
  if (noStats.length > 5) errors.push(`${noStats.length} pals missing stats: ${noStats.slice(0, 5).join(', ')}...`);

  // gate: cross-check vs paldb's own farm page (ranks + unique combos)
  let rankMismatch = 0;
  let comboMismatch = 0;
  if (farm) {
    for (const p of pals) {
      const fr = farm.ranks.get(p.name);
      if (fr !== undefined && fr !== p.rank) {
        rankMismatch++;
        if (rankMismatch <= 3) errors.push(`rank mismatch ${p.name}: paldb=${fr} palcalc=${p.rank}`);
      }
    }
    const palcalcCombos = new Set(
      palcalc.unique.map(([a, b, c]) => [nameOf(pals, a), nameOf(pals, b)].sort().join('|') + '=' + nameOf(pals, c)),
    );
    for (const combo of farm.combos) {
      if (!palcalcCombos.has(combo)) {
        comboMismatch++;
        if (comboMismatch <= 3) errors.push(`farm-only combo: ${combo}`);
      }
    }
    for (const combo of palcalcCombos) {
      if (!farm.combos.has(combo)) {
        comboMismatch++;
        if (comboMismatch <= 3) errors.push(`palcalc-only combo: ${combo}`);
      }
    }
  }

  if (errors.length) {
    console.error('dataset gate FAILED:');
    for (const e of errors) console.error('  -', e);
    throw new Error(`gate failed (${errors.length} errors, ${rankMismatch} rank / ${comboMismatch} combo mismatches)`);
  }

  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    gameVersion: '1.0.2',
    sources: [
      { name: 'paldb.cc /json/iv_en.json', url: 'https://paldb.cc/json/iv_en.json', license: 'no license published by paldb.cc; compilation CC BY 4.0 (see LICENSE.data)' },
      { name: 'paldb.cc /Breeding_Farm', url: 'https://paldb.cc/Breeding_Farm', license: 'no license published by paldb.cc; compilation CC BY 4.0 (see LICENSE.data)' },
      {
        name: 'palcalc-tools/palworld-1.0-calculator',
        url: 'https://github.com/palcalc-tools/palworld-1.0-calculator',
        license: 'MIT',
      },
    ],
    pals,
    uniqueCombos: palcalc.unique,
    directional,
  };
}

function nameOf(pals, code) {
  const p = pals.find((x) => x.code === code);
  return p ? p.name : code;
}

// ---------- main ----------

async function main() {
  console.log(`[dataset] mode: ${fetchMode ? 'fetch (network)' : `local (${rawDir})`}`);
  const [ivRaw, palcalcRaw, farmRaw] = await Promise.all([
    readRaw('paldb_iv.json', 'https://paldb.cc/json/iv_en.json?_=' + Date.now()),
    readRaw('palcalc_index.html', 'https://raw.githubusercontent.com/palcalc-tools/palworld-1.0-calculator/main/index.html'),
    readRaw('paldb_farm.html', 'https://paldb.cc/Breeding_Farm').catch((e) => {
      console.warn(`[dataset] farm page unavailable (${e.message}) — skipping cross-check`);
      return null;
    }),
  ]);

  const iv = parseIvJson(ivRaw);
  const palcalc = parsePalcalc(palcalcRaw);
  const farm = farmRaw ? { ranks: parseFarmRanks(farmRaw), combos: parseFarmCombos(farmRaw) } : null;
  const dataset = buildDataset(iv, palcalc, farm);

  mkdirSync(dirname(OUT), { recursive: true });
  const tmp = OUT + '.tmp';
  writeFileSync(tmp, JSON.stringify(dataset, null, 1) + '\n');
  renameSync(tmp, OUT);
  console.log(`[dataset] OK: ${dataset.pals.length} pals, ${dataset.uniqueCombos.length} unique combos, ` +
    `${Object.keys(dataset.directional).length} directional pair(s), ${dataset.pals.filter((p) => !p.rankResult).length} non-rank-result` +
    ` -> ${OUT}`);
}

main().catch((e) => {
  console.error(`[dataset] ${e.message}`);
  process.exit(1);
});
