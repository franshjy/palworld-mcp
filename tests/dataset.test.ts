/**
 * Dataset integrity + name resolution tests.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, PalworldData } from '../src/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ds = loadDataset(join(ROOT, 'data', 'dataset.json'));
const data = new PalworldData(ds);

test('dataset shape: 299 pals, 136 unique combos, 1 directional pair', () => {
  assert.equal(ds.schemaVersion, 1);
  assert.equal(ds.pals.length, 299);
  assert.equal(ds.uniqueCombos.length, 136);
  assert.deepEqual(Object.keys(ds.directional), ['CatMage|FoxMage']);
});

test('every pal has code, name and an integer rank in range', () => {
  for (const p of ds.pals) {
    assert.ok(p.code, `missing code`);
    assert.ok(p.name, `missing name for ${p.code}`);
    assert.ok(Number.isInteger(p.rank) && p.rank > 0 && p.rank <= 4000, `bad rank ${p.rank} for ${p.code}`);
    assert.ok(Array.isArray(p.element), `missing element for ${p.code}`);
  }
});

test('stats coverage: at most 5 pals may lack stats (they still carry breeding data)', () => {
  const missing = ds.pals.filter((p) => !p.stats);
  assert.ok(missing.length <= 5, `${missing.length} pals missing stats: ${missing.map((p) => p.code).join(', ')}`);
});

test('known values spot-check', () => {
  const anubis = data.byCodeLookup('Anubis');
  assert.equal(anubis?.rank, 480);
  assert.equal(anubis?.deck, '139');
  assert.equal(anubis?.rankResult, true);
  assert.equal(anubis?.element[0], 'Earth');
  const jetragon = data.byCodeLookup('JetDragon');
  assert.equal(jetragon?.name, 'Jetragon');
  assert.equal(jetragon?.rank, 70);
  assert.equal(jetragon?.rankResult, false);
  const slime = data.byCodeLookup('YakushimaMonster001');
  assert.equal(slime?.name, 'Green Slime');
  assert.equal(slime?.rank, 3100);
  assert.equal(slime?.ignoreCombi, true);
  assert.equal(slime?.rankResult, false);
  const katress = data.byCodeLookup('CatMage');
  assert.equal(katress?.name, 'Katress');
});

test('resolve: exact code, exact name, case-insensitive', () => {
  assert.equal(data.resolve('Anubis').pal?.code, 'Anubis');
  assert.equal(data.resolve('anubis').pal?.code, 'Anubis');
  assert.equal(data.resolve('JetDragon').pal?.name, 'Jetragon');
  assert.equal(data.resolve(' LAMBALL ').pal?.name, 'Lamball');
});

test('resolve: unique substring yields matches, not an exact hit', () => {
  const r = data.resolve('anub');
  assert.equal(r.pal, undefined);
  assert.ok(r.matches.some((p) => p.name === 'Anubis'));
});

test('resolve: gibberish yields nothing', () => {
  const r = data.resolve('zzzzzz');
  assert.equal(r.pal, undefined);
  assert.equal(r.matches.length, 0);
});

test('search filters', () => {
  const byElement = data.search({ element: 'Fire', limit: 50 });
  assert.ok(byElement.length > 0);
  assert.ok(byElement.every((p) => p.element.includes('Fire')));

  const byStats = data.search({ minAttack: 120, limit: 50 });
  assert.ok(byStats.every((p) => (p.stats?.attack ?? -1) >= 120));

  const breedable = data.search({ breedableOnly: true, limit: 50 });
  assert.ok(breedable.every((p) => p.rankResult));

  const bosses = data.search({ bossOnly: true, limit: 50 });
  assert.ok(bosses.every((p) => p.boss));

  const rare = data.search({ sortBy: 'rank', limit: 5 });
  assert.equal(rare[0]?.rank, Math.min(...ds.pals.map((p) => p.rank)));

  const query = data.search({ query: 'anub' });
  assert.ok(query.some((p) => p.name === 'Anubis'));
});
