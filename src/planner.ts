/**
 * breeding_plan - multi-step breeding path solver.
 *
 * Given a target pal and the pals you own, find ranked step-by-step breeding
 * plans. Search: BFS over owned-set growth - each step picks two owned (or
 * already-produced) pals and breeds them; the child joins the set. BFS finds
 * the fewest-step plans first; ties rank by fewest new catches (parents the
 * plan needs but you don't own and can't produce earlier in the path).
 *
 * Correctness:
 *   - Unbreedable targets (rankResult:false with no unique combo, e.g. Jetragon)
 *     are reported via `unbreedable` - never a fabricated path.
 *   - Every step is computed by the validated engine, so the 116 excluded pals,
 *     136 unique combos and the Katress|Wixen directional pair are respected.
 *   - Directional steps carry a gender note (both children are treated as
 *     producible - the planner has no gender input).
 *   - Greenfield mode (owned = []): direct acquisition plans only - "catch
 *     these two parents and breed", circular usesTarget pairs excluded.
 */
import type { PalworldData } from './dataset.js';
import type { BreedingKind } from './breeding.js';

export interface PlanStep {
  parent1: string;
  parent2: string;
  child: string;
  kind: BreedingKind;
  note?: string;
}

export interface BreedingPlan {
  steps: PlanStep[];
  stepCount: number;
  newCatches: number;
}

export interface PlanResult {
  found: boolean;
  unbreedable?: boolean;
  alreadyOwned?: boolean;
  plans: BreedingPlan[];
  totalPlans: number;
}

/** Frontier cap per BFS depth - bounds the exponential owned-set growth. */
const MAX_STATES = 4000;
/** Plans returned per query. */
const MAX_PLANS = 5;

function directionalNote(data: PalworldData, a: string, b: string): string | undefined {
  const key = a < b ? `${a}|${b}` : `${b}|${a}`;
  const entries = data.dataset.directional[key];
  if (!entries) return undefined;
  return (
    entries
      .map(([m, f, c]) => `${data.byCodeLookup(m)?.name ?? m} (male) + ${data.byCodeLookup(f)?.name ?? f} (female) -> ${data.byCodeLookup(c)?.name ?? c}`)
      .join('; ') + ' - child depends on which parent is male.'
  );
}

/** Parents the plan needs that are neither owned nor produced by an earlier step. */
function countCatches(owned: Set<string>, path: PlanStep[]): number {
  const produced = new Set<string>();
  const caught = new Set<string>();
  for (const s of path) {
    for (const p of [s.parent1, s.parent2]) {
      if (!owned.has(p) && !produced.has(p)) caught.add(p);
    }
    produced.add(s.child);
  }
  return caught.size;
}

export function breedingPlan(data: PalworldData, targetCode: string, ownedCodes: string[], maxSteps = 5): PlanResult {
  const owned = new Set(ownedCodes);
  if (owned.has(targetCode)) return { found: true, alreadyOwned: true, plans: [], totalPlans: 0 };

  const direct = data.findParentPairs(targetCode, undefined, 100);
  if (direct.total === 0) return { found: true, unbreedable: true, plans: [], totalPlans: 0 };

  // Greenfield mode: no owned pals - direct acquisition plans (skip circular usesTarget pairs).
  if (ownedCodes.length === 0) {
    const plans: BreedingPlan[] = direct.pairs
      .filter((p) => !p.usesTarget)
      .slice(0, MAX_PLANS)
      .map((p) => ({
        steps: [{ parent1: p.parent1, parent2: p.parent2, child: targetCode, kind: p.kind }],
        stepCount: 1,
        newCatches: 2,
      }));
    return { found: plans.length > 0, plans, totalPlans: plans.length };
  }

  if (ownedCodes.length < 2) {
    return { found: false, plans: [], totalPlans: 0 };
  }

  const plans: BreedingPlan[] = [];
  const planKeys = new Set<string>();
  let frontier: { set: string[]; path: PlanStep[] }[] = [{ set: [...owned], path: [] }];
  const seen = new Set<string>([[...owned].sort().join(',')]);

  for (let depth = 1; depth <= maxSteps; depth++) {
    const next: { set: string[]; path: PlanStep[] }[] = [];
    for (const { set, path } of frontier) {
      for (let i = 0; i < set.length; i++) {
        for (let j = i + 1; j < set.length; j++) {
          const a = set[i]!;
          const b = set[j]!;
          const r = data.engine.breed(a, b);
          const children = r.child2 ? [r.child, r.child2] : [r.child];
          const note = r.kind === 'directional' ? directionalNote(data, a, b) : undefined;
          for (const c of children) {
            if (set.includes(c)) continue; // no progress: child already owned/produced
            const step: PlanStep = { parent1: a, parent2: b, child: c, kind: r.kind, note };
            const newPath = [...path, step];
            if (c === targetCode) {
              const key = JSON.stringify(newPath.map((s) => [s.parent1, s.parent2, s.child]));
              if (!planKeys.has(key)) {
                planKeys.add(key);
                plans.push({ steps: newPath, stepCount: newPath.length, newCatches: countCatches(owned, newPath) });
              }
            } else if (next.length < MAX_STATES) {
              const newSet = [...set, c];
              const key = newSet.sort().join(',');
              if (!seen.has(key)) {
                seen.add(key);
                next.push({ set: newSet, path: newPath });
              }
            }
          }
        }
      }
    }
    frontier = next;
    // BFS: the first depth with any plan is the minimum-step depth - stop there.
    if (plans.length > 0) break;
    if (frontier.length === 0) break;
  }

  plans.sort((x, y) => x.stepCount - y.stepCount || x.newCatches - y.newCatches);
  return { found: plans.length > 0, plans: plans.slice(0, MAX_PLANS), totalPlans: plans.length };
}
