/**
 * breeding_plan planner tests.
 *
 * Every plan produced must be verifiable: each step's child must equal the
 * engine's result for that parent pair, step parents must be owned or produced
 * by an earlier step, and the final step must produce the target.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadDataset, PalworldData } from '../src/dataset.js';
import { breedingPlan, type PlanStep } from '../src/planner.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const data = new PalworldData(loadDataset(join(ROOT, 'data', 'dataset.json')));
const codeOf = (name: string) => data.resolve(name).pal!.code;
const nameOf = (code: string) => data.byCodeLookup(code)?.name ?? code;

/** Verify a plan end-to-end against the engine. */
function assertPlanValid(targetName: string, ownedNames: string[], plan: { steps: PlanStep[] }, allowCatches = false) {
  const owned = new Set(ownedNames.map(codeOf));
  const produced = new Set<string>();
  for (const s of plan.steps) {
    if (!allowCatches) {
      for (const p of [s.parent1, s.parent2]) {
        assert.ok(owned.has(p) || produced.has(p), `step parent ${nameOf(p)} neither owned nor produced`);
      }
    }
    const r = data.engine.breed(s.parent1, s.parent2);
    assert.ok([r.child, r.child2].filter(Boolean).includes(s.child), `step child ${nameOf(s.child)} not an engine result`);
    produced.add(s.child);
  }
  assert.equal(produced.has(codeOf(targetName)), true, 'final step must produce the target');
}

test('planner: unique combo target with both parents owned — one step', () => {
  const r = breedingPlan(data, codeOf('Jormuntide Ignis'), [codeOf('Jormuntide'), codeOf('Blazehowl')]);
  assert.equal(r.found, true);
  assert.equal(r.totalPlans, 1);
  assert.equal(r.plans[0]?.stepCount, 1);
  assert.equal(r.plans[0]?.steps[0]?.kind, 'unique');
  assert.equal(r.plans[0]?.newCatches, 0);
});

test('planner: unbreedable target (Jetragon) is reported, never fabricated', () => {
  const r = breedingPlan(data, codeOf('Jetragon'), [codeOf('Lamball'), codeOf('Foxparks')]);
  assert.equal(r.unbreedable, true);
  assert.equal(r.plans.length, 0);
});

test('planner: already-owned target', () => {
  const r = breedingPlan(data, codeOf('Anubis'), [codeOf('Anubis'), codeOf('Lamball')]);
  assert.equal(r.alreadyOwned, true);
  assert.equal(r.found, true);
});

test('planner: greenfield (owned=[]) returns direct acquisition plans only', () => {
  const r = breedingPlan(data, codeOf('Anubis'), []);
  assert.equal(r.found, true);
  assert.ok(r.totalPlans > 0);
  for (const p of r.plans) {
    assert.equal(p.stepCount, 1);
    assert.equal(p.newCatches, 2);
    // no circular usesTarget pairs
    assert.notEqual(p.steps[0]?.parent1, codeOf('Anubis'));
    assert.notEqual(p.steps[0]?.parent2, codeOf('Anubis'));
    assertPlanValid('Anubis', [], p, true); // greenfield parents are meant to be caught
  }
});

test('planner: directional target with both parents owned — gender note present', () => {
  const r = breedingPlan(data, codeOf('Wixen Noct'), [codeOf('Katress'), codeOf('Wixen')]);
  assert.equal(r.found, true);
  assert.equal(r.plans[0]?.steps[0]?.kind, 'directional');
  assert.match(r.plans[0]?.steps[0]?.note ?? '', /which parent is male/);
  assertPlanValid('Wixen Noct', ['Katress', 'Wixen'], r.plans[0]!);
});

test('planner: multi-step plan from a mix of owned pals — all plans verifiable', () => {
  // Jormuntide + Blazehowl -> Jormuntide Ignis (unique), then Ignis + Pengullet -> Felbat (rank).
  const owned = ['Jormuntide', 'Blazehowl', 'Pengullet'];
  const r = breedingPlan(data, codeOf('Felbat'), owned.map(codeOf), 3);
  assert.equal(r.found, true, 'expected a multi-step path to Felbat within 3 steps');
  assert.ok(r.totalPlans > 0);
  for (const p of r.plans) assertPlanValid('Felbat', owned, p);
  // BFS property: all returned plans share the minimum step count
  const counts = new Set(r.plans.map((p) => p.stepCount));
  assert.equal(counts.size, 1, 'BFS must return only minimum-step plans');
  assert.equal(r.plans[0]?.stepCount, 2);
  assert.equal(r.plans[0]?.newCatches, 0);
  assert.equal(r.plans[0]?.steps[0]?.kind, 'unique');
});

test('planner: unreachable target from a common-pal band answers "no path", not a fabrication', () => {
  // All four pals are rank ~3000 (common); every breed among them stays in that band,
  // so Anubis (rank 480) is unreachable at ANY depth without catching mid-rank pals.
  const owned = ['Lamball', 'Foxparks', 'Chikipi', 'Pengullet'];
  const r = breedingPlan(data, codeOf('Anubis'), owned.map(codeOf), 8);
  assert.equal(r.found, false);
  assert.equal(r.plans.length, 0);
});

test('planner: maxSteps bound respected and depth-limited answers empty', () => {
  const owned = ['Jormuntide', 'Blazehowl', 'Pengullet'];
  const deep = breedingPlan(data, codeOf('Felbat'), owned.map(codeOf), 3);
  const shallow = breedingPlan(data, codeOf('Felbat'), owned.map(codeOf), 1);
  assert.ok(deep.totalPlans > 0);
  assert.equal(shallow.totalPlans, 0, 'Felbat needs 2 steps — a 1-step cap must find nothing');
});

test('planner: fewer than two owned pals cannot start', () => {
  const r = breedingPlan(data, codeOf('Anubis'), [codeOf('Lamball')]);
  assert.equal(r.found, false);
  assert.equal(r.plans.length, 0);
});
