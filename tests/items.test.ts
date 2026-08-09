/**
 * Item database tests: reverse recipe index (product-side recipes), drop filter,
 * and work-level filter.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, PalworldData } from '../src/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ds = loadDataset(join(ROOT, 'data', 'dataset.json'));
const data = new PalworldData(ds);

test('itemRecipes: product-side recipes resolve - Laser Gatling Gun tiers (base = 100 Hexolite)', () => {
  const recipes = data.itemRecipes('Laser Gatling Gun');
  assert.ok(recipes.length > 0, 'expected recipes producing Laser Gatling Gun');
  // All five craft tiers share the product name "Laser Gatling Gun 1" - deduped across
  // the material pages that each list them. Base tier needs 100 Hexolite.
  assert.equal(recipes.length, 5, `expected 5 craft tiers, got ${recipes.length}`);
  assert.ok(recipes.every((r) => r.product === 'Laser Gatling Gun 1'));
  const base = recipes.find((r) => r.materials.some((m) => m.item === 'Hexolite' && m.qty === 100));
  assert.ok(base, `expected a 100-Hexolite tier, got: ${recipes.map((r) => r.materials.find((m) => m.item === 'Hexolite')?.qty).join(', ')}`);
});

test('itemRecipes: smelting recipe resolves onto Coralum Ingot', () => {
  const recipes = data.itemRecipes('Coralum Ingot');
  const smelt = recipes.find((r) => r.product === 'Coralum Ingot 1');
  assert.ok(smelt, `expected smelting recipe, got: ${recipes.map((r) => r.product).join(', ')}`);
  assert.deepEqual(smelt!.materials, [
    { item: 'Coralum Ore', qty: 2 },
    { item: 'Coal', qty: 5 },
  ]);
});

test('itemRecipes: dropped-only items have no producing recipes', () => {
  assert.deepEqual(data.itemRecipes('Wool'), []);
});

test('itemRecipes: xN self-production rows normalize to the canonical item', () => {
  const oreRecipes = data.itemRecipes('Coralum Ore');
  assert.ok(oreRecipes.some((r) => r.product === 'Coralum Ore x1'));
  const hq = data.itemRecipes('Hexolite Quartz');
  assert.ok(hq.some((r) => r.product === 'Hexolite Quartz x1'));
});

test('items: broken-name pages fall back to the code (Gasoline)', () => {
  const r = data.resolveItem('Gasoline');
  assert.equal(r.item?.name, 'Gasoline');
  assert.equal(r.item?.code, 'Gasoline');
});

test('search: dropItem filter (substring) - Melpaca drops Wool', () => {
  const hits = data.search({ dropItem: 'wool' });
  assert.ok(hits.some((p) => p.name === 'Melpaca'), 'Melpaca drops Wool and must match');
  for (const p of hits) {
    assert.ok(
      (p.drops ?? []).some((d) => d.item.toLowerCase().includes('wool')),
      `${p.name} has no drop matching "wool"`,
    );
  }
});

test('search: dropItem filter - Paldium Fragment droppers exist', () => {
  const hits = data.search({ dropItem: 'Paldium Fragment' });
  assert.ok(hits.length > 0, 'expected some pal to drop Paldium Fragment');
  for (const p of hits) {
    assert.ok((p.drops ?? []).some((d) => d.item.toLowerCase().includes('paldium fragment')));
  }
});

test('search: minWorkLevel filters within a work suitability', () => {
  const all = data.search({ workSuitability: 'Mining' });
  const lvl3 = data.search({ workSuitability: 'Mining', minWorkLevel: 3 });
  const lvl7 = data.search({ workSuitability: 'Mining', minWorkLevel: 7 });
  assert.ok(all.some((p) => p.name === 'Anubis'));
  assert.ok(lvl3.some((p) => p.name === 'Anubis'), 'Anubis is Mining 6, must match >= 3');
  assert.ok(!lvl7.some((p) => p.name === 'Anubis'), 'Anubis is Mining 6, must NOT match >= 7');
  assert.ok(lvl3.length <= all.length);
  assert.ok(lvl7.length < lvl3.length);
  for (const p of lvl3) {
    assert.ok((p.workSuitability ?? []).some((w) => w.work === 'Mining' && w.level >= 3));
  }
});
