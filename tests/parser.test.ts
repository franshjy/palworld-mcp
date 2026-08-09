/**
 * Parser tests against real paldb.cc page fixtures (tests/fixtures/).
 * Guards against silent field drift when paldb changes its page template.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseItemPage, parsePalPage, parseCraftingRows } from '../scripts/parse-lib.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => readFileSync(join(ROOT, 'tests', 'fixtures', f), 'utf8');

test('parseItemPage: Wool fixture → canonical record', () => {
  const item = parseItemPage(read('item-wool.html'), 'Wool');
  assert.ok(item, 'expected an item record');
  assert.equal(item.name, 'Wool');
  assert.equal(item.code, 'Wool');
  assert.equal(item.rarity, 'Common');
  assert.equal(item.type, 'Material');
  assert.equal(item.price, 200);
  assert.equal(item.weight, 1);
  assert.equal(item.typeA, 'Material');
  assert.equal(item.typeB, 'MaterialMonster');
  assert.ok((item.droppedBy ?? []).some((d) => d.item === 'Melpaca'), 'Wool is dropped by Melpaca');
});

test('parseItemPage: pal-style page is rejected (returns null)', () => {
  assert.equal(parseItemPage(read('pal-melpaca.html'), 'Melpaca'), null);
});

test('parsePalPage: Melpaca fixture → enrichment fields', () => {
  const pal = parsePalPage(read('pal-melpaca.html'));
  assert.equal(pal.size, 'M');
  assert.equal(pal.rarity, '3');
  assert.equal(pal.food, 150);
  assert.equal(pal.genus, 'FourLegged');
  assert.deepEqual(pal.workSuitability, [{ work: 'Farming', level: 2 }]);
  assert.ok((pal.drops ?? []).some((d) => d.item === 'Wool'));
  assert.equal(pal.partnerSkill?.name, 'Pacapaca Wool');
  assert.ok(pal.partnerSkill?.description?.startsWith('Can be ridden'), 'expected the description prose');
  assert.ok(!pal.partnerSkill?.description?.includes('Technology'), 'description must not swallow the unlock table');
  assert.ok((pal.activeSkills ?? []).length > 0, 'expected active skills');
  assert.ok(pal.summary && pal.summary.includes('fluffy'), 'expected the paldeck summary text');
  assert.ok(!pal.summary.includes('Partner Skill'), 'summary must not swallow the partner skill header');
});

test('parsePalPage: item page yields no pal-specific fields', () => {
  const pal = parsePalPage(read('item-wool.html'));
  assert.equal(pal.food, undefined);
  assert.equal(pal.workSuitability, undefined);
  assert.equal(pal.summary, undefined);
  assert.equal(pal.drops, undefined);
  assert.equal(pal.partnerSkill, undefined);
});

test('parseCraftingRows: Wool fixture lists the crafting recipes that consume it', () => {
  const item = parseItemPage(read('item-wool.html'), 'Wool');
  assert.ok((item.usedInCrafting ?? []).length > 0, 'Wool page has a Crafting Materials section');
  const helmet = item.usedInCrafting!.find((r) => r.product === 'Helmet 1');
  assert.deepEqual(helmet?.materials, [
    { item: 'Ingot', qty: 20 },
    { item: 'Wool', qty: 5 },
  ]);
  assert.ok(item.usedInCrafting!.some((r) => r.product === 'Cloth 1' && r.materials.some((m) => m.item === 'Wool' && m.qty === 2)));
});

test('parseCraftingRows: empty section yields no rows', () => {
  assert.deepEqual(parseCraftingRows(''), []);
});
