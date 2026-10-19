/**
 * breeding_plan - multi-step breeding path solver.
 *
 * Given a target pal and the pals you own, find ranked step-by-step breeding
 * plans. Search: iterative-deepening BFS over owned-set growth - each step
 * picks two owned (or already-produced) pals and breeds them; the child joins
 * the set. States that cannot reach the target within the step bound are
 * pruned (exactly for the last two steps), so the frontier cap holds useful
 * states. The first bound with a plan is the fewest-step count; ties rank by
 * fewest new catches (parents the plan needs but you don't own and can't
 * produce earlier in the path).
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

/** Every pair's child as pal indices (child2 = -1 unless directional), computed once per dataset. */
interface BreedTable {
  codes: string[];
  index: Map<string, number>;
  child1: Int16Array;
  child2: Int16Array;
}

const tables = new WeakMap<PalworldData, BreedTable>();

function breedTable(data: PalworldData): BreedTable {
  let t = tables.get(data);
  if (t) return t;
  const codes = data.dataset.pals.map((p) => p.code);
  const n = codes.length;
  const index = new Map(codes.map((c, i) => [c, i]));
  const child1 = new Int16Array(n * n).fill(-1);
  const child2 = new Int16Array(n * n).fill(-1);
  for (let a = 0; a < n; a++) {
    for (let b = a + 1; b < n; b++) {
      const r = data.engine.breed(codes[a]!, codes[b]!);
      child1[a * n + b] = child1[b * n + a] = index.get(r.child)!;
      if (r.child2) child2[a * n + b] = child2[b * n + a] = index.get(r.child2)!;
    }
  }
  t = { codes, index, child1, child2 };
  tables.set(data, t);
  return t;
}

/** True if `target` can be produced from `owned` at any depth (each pair of the closure tried once). */
function reachable(t: BreedTable, owned: number[], target: number): boolean {
  const n = t.codes.length;
  const inSet = new Uint8Array(n);
  const list: number[] = [];
  for (const o of owned) if (!inSet[o]) (inSet[o] = 1), list.push(o);
  for (let i = 0; i < list.length && !inSet[target]; i++) {
    for (let j = 0; j < i; j++) {
      for (const c of [t.child1[list[i]! * n + list[j]!]!, t.child2[list[i]! * n + list[j]!]!]) {
        if (c >= 0 && !inSet[c]) (inSet[c] = 1), list.push(c);
      }
    }
  }
  return inSet[target] === 1;
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

/**
 * BFS state: the pals in hand plus `avail` - for every pal not in hand, one pair in hand
 * that breeds it (a * n + b, or -1). Adding pal c only creates the pairs (c, x), so a
 * child state is derived in O(set size) instead of re-breeding all O(set size^2) pairs.
 */
interface State {
  members: Uint8Array;
  list: number[];
  avail: Int32Array;
  /** Per pal: how many of its target-breeding partners are in hand. */
  partnerCount: Uint16Array;
  path: PlanStep[];
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

  const t = breedTable(data);
  const n = t.codes.length;
  const target = t.index.get(targetCode)!;
  const ownedIdx = [...owned].map((c) => t.index.get(c)!);
  // Unreachable targets would otherwise exhaust every BFS depth.
  if (owned.size < 2 || !reachable(t, ownedIdx, target)) {
    return { found: false, plans: [], totalPlans: 0 };
  }

  const childrenOf = (a: number, b: number) => [t.child1[a * n + b]!, t.child2[a * n + b]!].filter((c) => c >= 0);
  const stepOf = (a: number, b: number, c: number): PlanStep => {
    const r = data.engine.breed(t.codes[a]!, t.codes[b]!);
    const note = r.kind === 'directional' ? directionalNote(data, t.codes[a]!, t.codes[b]!) : undefined;
    return { parent1: t.codes[a]!, parent2: t.codes[b]!, child: t.codes[c]!, kind: r.kind, note };
  };
  // Every pair that breeds the target (a < b), filtered per state at the final step.
  const targetPairs: [number, number][] = [];
  for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++) if (childrenOf(a, b).includes(target)) targetPairs.push([a, b]);

  const partners: number[][] = Array.from({ length: n }, () => []);
  for (const [a, b] of targetPairs) partners[a]!.push(b), partners[b]!.push(a);

  const root: State = { members: new Uint8Array(n), list: ownedIdx, avail: new Int32Array(n).fill(-1), partnerCount: new Uint16Array(n), path: [] };
  for (const o of ownedIdx) {
    root.members[o] = 1;
    for (const p of partners[o]!) root.partnerCount[p]!++;
  }
  for (let i = 0; i < ownedIdx.length; i++) {
    for (let j = i + 1; j < ownedIdx.length; j++) {
      const [a, b] = [ownedIdx[i]!, ownedIdx[j]!];
      for (const c of childrenOf(a, b)) if (!root.members[c] && root.avail[c]! < 0) root.avail[c] = a * n + b;
    }
  }

  /** Can `s` still breed the target within `r` steps? Exact for r <= 2, optimistic beyond. */
  const canFinish = (s: State, r: number): boolean => {
    if (s.avail[target]! >= 0) return true;
    if (r === 1) return false;
    if (r > 2) return true;
    // Two steps: breed some m now, then m + a partner already in hand -> target.
    for (let m = 0; m < n; m++) if (!s.members[m] && s.avail[m]! >= 0 && s.partnerCount[m]! > 0) return true;
    return false;
  };

  const keyOf = (m: Uint8Array) => Buffer.from(m.buffer, m.byteOffset, m.length).toString('latin1');
  const plans: BreedingPlan[] = [];
  const planKeys = new Set<string>();

  // Iterative deepening: try each step bound in turn, pruning states that cannot finish
  // within it - the first bound with a plan is the minimum step count.
  for (let bound = 1; bound <= maxSteps && plans.length === 0; bound++) {
    if (!canFinish(root, bound)) continue;
    let frontier: State[] = [root];
    const seen = new Set<string>([keyOf(root.members)]);
    for (let depth = 1; depth < bound && frontier.length > 0; depth++) {
      const next: State[] = [];
      for (const s of frontier) {
        for (let c = 0; c < n && next.length < MAX_STATES; c++) {
          const pair = s.avail[c]!;
          if (pair < 0 || c === target) continue;
          s.members[c] = 1;
          const key = keyOf(s.members);
          s.members[c] = 0;
          if (seen.has(key)) continue;
          seen.add(key);
          const members = s.members.slice();
          members[c] = 1;
          const avail = s.avail.slice();
          avail[c] = -1;
          for (const x of s.list) {
            for (const ch of childrenOf(c, x)) if (!members[ch] && avail[ch]! < 0) avail[ch] = c * n + x;
          }
          const partnerCount = s.partnerCount.slice();
          for (const p of partners[c]!) partnerCount[p]!++;
          const a = Math.floor(pair / n);
          const state: State = { members, list: [...s.list, c], avail, partnerCount, path: [...s.path, stepOf(a, pair % n, c)] };
          if (canFinish(state, bound - depth)) next.push(state);
        }
      }
      frontier = next;
    }
    for (const s of frontier) {
      if (s.avail[target]! < 0) continue;
      for (const [a, b] of targetPairs) {
        if (!s.members[a] || !s.members[b]) continue;
        const newPath = [...s.path, stepOf(a, b, target)];
        const key = JSON.stringify(newPath.map((st) => [st.parent1, st.parent2, st.child]));
        if (!planKeys.has(key)) {
          planKeys.add(key);
          plans.push({ steps: newPath, stepCount: newPath.length, newCatches: countCatches(owned, newPath) });
        }
      }
    }
  }

  plans.sort((x, y) => x.stepCount - y.stepCount || x.newCatches - y.newCatches);
  return { found: plans.length > 0, plans: plans.slice(0, MAX_PLANS), totalPlans: plans.length };
}
