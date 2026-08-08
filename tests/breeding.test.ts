/**
 * Breeding engine tests.
 *
 * Every vector below was verified against paldb.cc's own calculator API (9 pairs)
 * and by manual checks (3 pairs) during research. The self-checks cover all 136
 * unique combos in the dataset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, PalworldData } from '../src/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = new PalworldData(loadDataset(join(ROOT, 'data', 'dataset.json')));

function codeOf(name: string): string {
  const p = data.resolve(name).pal ?? data.resolve(name).matches.find((m) => m.name === name);
  if (!p) throw new Error(`test pal not found: ${name}`);
  return p.code;
}

function childName(a: string, b: string): string {
  const r = data.engine.breed(codeOf(a), codeOf(b));
  return data.byCodeLookup(r.child)?.name ?? r.child;
}

// Verified against paldb's live API (9) + manual checks (3).
const VECTORS: [string, string, string][] = [
  ['Lamball', 'Foxparks', 'Lifmunk'],
  ['Chikipi', 'Penking', 'Galeclaw'],
  ['Cattiva', 'Sparkit', 'Cremis'],
  ['Warsect', 'Blazehowl Noct', 'Warsect'],
  ['Orserk', 'Eidrolon Ignis', 'Ophydia'],
  ['Blazamut Ryu', 'Orserk', 'Aegidron'],
  ['Frostallion', 'Frostallion Noct', 'Ophydia'],
  ['Green Slime', 'Green Slime', 'Green Slime'],
  ['Anubis', 'Penking', 'Warsect'],
  ['Jetragon', 'Jetragon', 'Jetragon'],
  ['Chikipi', 'Pengullet', 'Lifmunk'],
  ['Relaxaurus', 'Sparkit', 'Relaxaurus Lux'],
];

test('verified breeding vectors (9 API + 3 manual)', () => {
  for (const [a, b, expected] of VECTORS) {
    assert.equal(childName(a, b), expected, `${a} + ${b} should be ${expected}`);
  }
});

test('identity rule: A + A = A (incl. non-breedable pals)', () => {
  for (const name of ['Lamball', 'Jetragon', 'Anubis', 'Aegidron', 'Ophydia', 'Green Slime']) {
    assert.equal(childName(name, name), name);
  }
});

test('unique-combo self-check: all 136 combos reproduce their child', () => {
  for (const [a, b, c] of data.dataset.uniqueCombos) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    const dir = data.dataset.directional[key];
    const r = data.engine.breed(a, b);
    if (dir) {
      // Directional rows appear twice (once per child); breed() returns both via child/child2.
      const children = dir.map((e) => e[2]);
      assert.ok(children.includes(r.child), `${a} + ${b} should yield one of ${children.join(', ')}, got ${r.child}`);
      assert.equal(r.kind, 'directional');
    } else {
      assert.equal(r.child, c, `${a} + ${b} should be ${c}, got ${r.child}`);
      assert.equal(r.kind, 'unique');
    }
  }
});

test('directional pair: Katress + Wixen yields both children', () => {
  const r = data.engine.breed('CatMage', 'FoxMage');
  assert.equal(r.kind, 'directional');
  assert.equal(r.child, 'FoxMage_Dark');
  assert.equal(r.child2, 'CatMage_Fire');
  assert.equal(data.byCodeLookup('FoxMage_Dark')?.name, 'Wixen Noct');
  assert.equal(data.byCodeLookup('CatMage_Fire')?.name, 'Katress Ignis');
});

test('kind classification', () => {
  assert.equal(data.engine.breed(codeOf('Relaxaurus'), codeOf('Sparkit')).kind, 'unique');
  assert.equal(data.engine.breed(codeOf('Lamball'), codeOf('Lamball')).kind, 'identity');
  assert.equal(data.engine.breed(codeOf('Lamball'), codeOf('Foxparks')).kind, 'rank');
  assert.equal(data.engine.breed(codeOf('Warsect'), codeOf('Blazehowl Noct')).kind, 'rank');
});

test('rank math is reported with parent ranks', () => {
  const r = data.engine.breed(codeOf('Lamball'), codeOf('Foxparks'));
  assert.equal(r.kind, 'rank');
  assert.equal(r.rankMath?.childRank, 3020);
  assert.equal(r.rankMath?.rankA, 3050);
  assert.equal(r.rankMath?.rankB, 2990);
});

test('eligibility: exactly 116 pals are excluded from rank results', () => {
  const excluded = data.dataset.pals.filter((p) => !p.rankResult).length;
  assert.equal(excluded, 116);
});

test('unknown code throws', () => {
  assert.throws(() => data.engine.breed('Lamball', 'Not_A_Pal'), /unknown pal code/);
});
