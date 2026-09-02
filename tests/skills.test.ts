/**
 * Skill reverse-index tests: index counts, skill -> pals lookup, element alias
 * mapping, power/cooldown sorting, and passive description cleanup.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, PalworldData } from '../src/dataset.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const ds = loadDataset(join(ROOT, 'data', 'dataset.json'));
const data = new PalworldData(ds);

test('skill index: unique counts per kind (307 active / 21 passive / 289 partner)', () => {
  const byKind = (k: string) => data.skills.filter((s) => s.kind === k).length;
  assert.equal(byKind('active'), 307);
  assert.equal(byKind('passive'), 21);
  assert.equal(byKind('partner'), 289);
  assert.equal(data.palsWithPassives, 44, 'passive coverage is partial - flag if dataset changes');
});

test('searchSkills: reverse lookup - Rock Lance is learned by Anubis at level 50', () => {
  const hits = data.searchSkills({ query: 'Rock Lance' });
  const rl = hits.find((s) => s.name === 'Rock Lance');
  assert.ok(rl, `expected Rock Lance in results, got: ${hits.map((s) => s.name).join(', ')}`);
  assert.equal(rl!.kind, 'active');
  const anubis = rl!.pals.find((p) => p.name === 'Anubis');
  assert.ok(anubis, 'Anubis must learn Rock Lance');
  assert.equal(anubis!.unlockLevel, 50);
});

test('searchSkills: element input is trimmed and case/whitespace tolerant; typos filter to empty', () => {
  const padded = data.searchSkills({ element: '  LeAf ', kind: 'active', limit: 50 });
  const plain = data.searchSkills({ element: 'Leaf', kind: 'active', limit: 50 });
  assert.deepEqual(padded.map((s) => s.name), plain.map((s) => s.name));
  assert.deepEqual(data.searchSkills({ element: 'leafy', kind: 'active' }), [], 'unknown element must filter to empty, not throw');
});

test('searchSkills: full dialect symmetry - every pal spelling maps to the skill spelling', () => {
  const pairs: [string, string][] = [
    ['Leaf', 'Grass'],
    ['Earth', 'Ground'],
    ['Electricity', 'Electric'],
    ['Normal', 'Neutral'],
  ];
  for (const [palEl, skillEl] of pairs) {
    const viaPal = data.searchSkills({ element: palEl, kind: 'active', limit: 50 });
    const viaSkill = data.searchSkills({ element: skillEl, kind: 'active', limit: 50 });
    assert.ok(viaSkill.length > 0, `${skillEl} skills must exist`);
    assert.deepEqual(
      viaPal.map((s) => s.name),
      viaSkill.map((s) => s.name),
      `${palEl} should equal ${skillEl}`,
    );
  }
  // The canonical elements are unchanged - non-dialect elements still match by identity.
  const fire = data.searchSkills({ element: 'Fire', kind: 'active', limit: 50 });
  assert.ok(fire.length > 0);
  for (const s of fire) assert.equal(s.element, 'Fire');
});

test('searchSkills: query also matches description text (partner effect lookup)', () => {
  // Gobfin's partner skill "Angry Shark": "While in party, increases the player's Attack by (10~20)%".
  const hits = data.searchSkills({ query: "player's attack", kind: 'partner' });
  const angryShark = hits.find((s) => s.name === 'Angry Shark');
  assert.ok(angryShark, `expected Angry Shark from description search, got: ${hits.map((s) => s.name).join(', ')}`);
  assert.ok(angryShark!.pals.some((p) => p.name === 'Gobfin'));
});

test('searchSkills: minPower excludes weaker and non-active skills; sortBy power descends', () => {
  const hits = data.searchSkills({ minPower: 500, sortBy: 'power', limit: 50 });
  assert.ok(hits.length > 0);
  for (const s of hits) {
    assert.equal(s.kind, 'active', 'minPower must only match active skills');
    assert.ok((s.power ?? 0) >= 500, `${s.name} power ${s.power} < 500`);
  }
  for (let i = 1; i < hits.length; i++) {
    assert.ok((hits[i - 1]!.power ?? 0) >= (hits[i]!.power ?? 0), 'power must sort descending');
  }
});

test('searchSkills: passive descriptions stripped of raw trailing metadata', () => {
  const hw = data.searchSkills({ query: 'Heavyweight', kind: 'passive' });
  assert.equal(hw.length, 1);
  assert.ok(hw[0]!.description, 'Heavyweight must keep a real description');
  assert.ok(!/Weight \d+/.test(hw[0]!.description!), `noise left in: ${hw[0]!.description}`);
  // Hooligan's raw description is ONLY noise ("Weight 100 Pal") -> null, not empty string.
  const hool = data.searchSkills({ query: 'Hooligan', kind: 'passive' });
  assert.equal(hool.length, 1);
  assert.equal(hool[0]!.description, null);
});

test('searchSkills: partner skill lookup - Guardian of the Desert belongs to Anubis', () => {
  const hits = data.searchSkills({ query: 'Guardian of the Desert', kind: 'partner' });
  assert.equal(hits.length, 1);
  assert.ok(hits[0]!.pals.some((p) => p.name === 'Anubis'));
  assert.ok(hits[0]!.description, 'partner skills carry user-facing descriptions');
});

test('searchSkills: sortBy cooldown puts actives first and non-decreasing', () => {
  const hits = data.searchSkills({ sortBy: 'cooldown', limit: 50 });
  assert.equal(hits[0]!.kind, 'active', 'null cooldowns (passive/partner) must sort last');
  for (let i = 1; i < hits.length; i++) {
    assert.ok(
      (hits[i - 1]!.cooldown ?? Infinity) <= (hits[i]!.cooldown ?? Infinity),
      'cooldowns must sort ascending, nulls last',
    );
  }
});

test('searchSkills: kind filter and pals sorted by unlock level', () => {
  const actives = data.searchSkills({ kind: 'active', limit: 50 });
  assert.ok(actives.every((s) => s.kind === 'active'));
  for (const s of actives) {
    for (let i = 1; i < s.pals.length; i++) {
      assert.ok(
        (s.pals[i - 1]!.unlockLevel ?? Infinity) <= (s.pals[i]!.unlockLevel ?? Infinity),
        `${s.name}: pals must sort by unlock level`,
      );
    }
  }
});
