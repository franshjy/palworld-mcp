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

test('dataset shape: 299 pals, 136 unique combos, 1 directional pair, items present', () => {
  assert.equal(ds.schemaVersion, 2);
  assert.equal(ds.pals.length, 299);
  assert.equal(ds.uniqueCombos.length, 136);
  assert.deepEqual(Object.keys(ds.directional), ['CatMage|FoxMage']);
  assert.ok((ds.items?.length ?? 0) > 700, `expected 700+ items, got ${ds.items?.length}`);
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

test('findParentPairs: reverse lookup for a generic-breedable pal', () => {
  const anubis = data.resolve('Anubis').pal!;
  const { total, pairs } = data.findParentPairs(anubis.code);
  assert.ok(total > 100, `expected many pairs for Anubis, got ${total}`);
  assert.ok(pairs.length > 0);
  // self-check: every returned pair really produces Anubis, identity excluded
  for (const p of pairs) {
    assert.notEqual(p.parent1, p.parent2);
    assert.equal(data.engine.breed(p.parent1, p.parent2).child, anubis.code);
    // enriched fields
    assert.ok(Number.isInteger(p.rank1) && Number.isInteger(p.rank2));
    assert.equal(typeof p.usesTarget, 'boolean');
  }
  assert.ok(!pairs.some((p) => p.parent1 === anubis.code && p.parent2 === anubis.code));
  // ordering: pairs sorted by min(parent rank) descending (fixed combos first)
  for (let i = 1; i < pairs.length; i++) {
    const prev = Math.min(pairs[i - 1]!.rank1, pairs[i - 1]!.rank2);
    const cur = Math.min(pairs[i]!.rank1, pairs[i]!.rank2);
    assert.ok(prev >= cur, `sort broken at ${i}: ${prev} < ${cur}`);
  }
  // acquisition noise exists and is flagged: some pairs use Anubis itself, some don't
  assert.ok(pairs.some((p) => p.usesTarget));
  assert.ok(pairs.some((p) => !p.usesTarget));
});

test('findParentPairs: unique-combo child has exactly its fixed pair', () => {
  const ji = data.resolve('Jormuntide Ignis').pal!;
  const { total, pairs } = data.findParentPairs(ji.code);
  assert.equal(total, 1);
  assert.equal(pairs[0]?.kind, 'unique');
  assert.equal(pairs[0]?.usesTarget, false);
  assert.deepEqual(
    [data.byCodeLookup(pairs[0]!.parent1)?.name, data.byCodeLookup(pairs[0]!.parent2)?.name].sort(),
    ['Blazehowl', 'Jormuntide'],
  );
});

test('findParentPairs: givenParent filters and can answer "no direct pair"', () => {
  const anubis = data.resolve('Anubis').pal!;
  const lamball = data.resolve('Lamball').pal!;
  assert.equal(data.findParentPairs(anubis.code, lamball.code).total, 0); // rank 3050 can never land on 480
  const ji = data.resolve('Jormuntide Ignis').pal!;
  const blazehowl = data.resolve('Blazehowl').pal!;
  const r = data.findParentPairs(ji.code, blazehowl.code);
  assert.equal(r.total, 1);
  assert.equal(r.pairs[0]?.kind, 'unique');
});

test('findParentPairs: directional pair is reachable from both children', () => {
  for (const childName of ['Wixen Noct', 'Katress Ignis']) {
    const child = data.resolve(childName).pal!;
    const { total, pairs } = data.findParentPairs(child.code);
    assert.equal(total, 1, `${childName}: expected exactly the directional pair`);
    assert.equal(pairs[0]?.kind, 'directional');
    assert.deepEqual(
      [data.byCodeLookup(pairs[0]!.parent1)?.name, data.byCodeLookup(pairs[0]!.parent2)?.name].sort(),
      ['Katress', 'Wixen'],
    );
  }
});

test('schema v2: pal enrichment from mirrored pages', () => {
  const anubis = data.resolve('Anubis').pal!;
  assert.equal(anubis.food, 540);
  assert.equal(anubis.size, 'M');
  assert.ok((anubis.workSuitability ?? []).some((w) => w.work === 'Mining'));
  assert.ok((anubis.activeSkills ?? []).length > 0);
  assert.ok((anubis.drops ?? []).length > 0);
  // every pal that can rank-breed should have skills parsed (coverage sanity)
  const noSkills = ds.pals.filter((p) => p.rankResult && !(p.activeSkills ?? []).length).length;
  assert.ok(noSkills <= 3, `expected almost all breedable pals to have skills, ${noSkills} missing`);
});

test('schema v2: items - resolution, search, known values', () => {
  const wool = data.resolveItem('Wool');
  assert.equal(wool.item?.code, 'Wool');
  assert.equal(wool.item?.rarity, 'Common');
  assert.equal(wool.item?.type, 'Material');
  assert.ok((wool.item?.droppedBy ?? []).some((d) => d.item === 'Melpaca'));
  // substring resolution
  const fuzzy = data.resolveItem('ancient civ');
  assert.ok(fuzzy.matches.some((i) => i.name.includes('Ancient Civilization')));
  // search filters
  const weapons = data.searchItems({ type: 'Weapon', limit: 50 });
  assert.ok(weapons.length > 0);
  assert.ok(weapons.every((i) => (i.type ?? '').toLowerCase().includes('weapon')));
  const legendary = data.searchItems({ rarity: 'Legendary', limit: 50 });
  assert.ok(legendary.length > 0);
  assert.ok(legendary.every((i) => (i.rarity ?? '').toLowerCase().includes('legendary')));
  // items are unique by slug (some facility pages share an internal code, e.g. MonsterFarm)
  const slugs = new Set(ds.items!.map((i) => i.slug));
  assert.equal(slugs.size, ds.items!.length);
});

test('search: workSuitability filter', () => {
  const miners = data.search({ workSuitability: 'Mining', limit: 50 });
  assert.ok(miners.length > 0);
  assert.ok(miners.every((p) => (p.workSuitability ?? []).some((w) => w.work === 'Mining')));
  const none = data.search({ workSuitability: 'NotAWorkType', limit: 50 });
  assert.equal(none.length, 0);
});
