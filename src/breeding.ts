/**
 * Palworld breeding engine.
 *
 * Exact port of the algorithm validated in research against paldb.cc's own
 * calculator (9/9 live API pairs), manual in-game/calculator checks (3/3), and
 * palcalc-tools' engine (2,853/2,853 pairs). Rules, in order:
 *
 *   1. Directional unique combos (one pair in 1.0: Katress|Wixen) — child depends
 *      on which parent is male. Returns BOTH children (no gender input in MCP).
 *   2. Unique combos (136 fixed pairs) override rank math.
 *   3. Identity: A + A = A, always.
 *   4. Rank math: childRank = floor((rankA + rankB + 1) / 2), result = nearest
 *      pal by rank among rankResult-eligible pals; equidistant ties -> HIGHER rank.
 */

export type BreedingKind = 'directional' | 'unique' | 'identity' | 'rank';

export interface BreedingInput {
  code: string;
  rank: number;
  rankResult: boolean;
}

export type ComboTuple = [string, string, string];
export type DirectionalEntry = [string, string, string];
export type DirectionalMap = Record<string, DirectionalEntry[]>;

export interface BreedingResult {
  /** Child pal code. */
  child: string;
  /** Second child code — only for directional combos. */
  child2?: string;
  kind: BreedingKind;
  /** Present for rank-math results: the computed child rank and the parent ranks used. */
  rankMath?: {
    childRank: number;
    rankA: number;
    rankB: number;
  };
}

export class BreedingEngine {
  private readonly rankByCode = new Map<string, number>();
  private readonly umap = new Map<string, string>();
  private readonly directional = new Map<string, DirectionalEntry[]>();
  private readonly eligible: { code: string; rank: number }[] = [];
  private readonly eranks: number[] = [];

  constructor(pals: BreedingInput[], uniqueCombos: ComboTuple[], directional: DirectionalMap) {
    for (const p of pals) this.rankByCode.set(p.code, p.rank);
    for (const [k, entries] of Object.entries(directional)) this.directional.set(k, entries);
    for (const [a, b, c] of uniqueCombos) {
      const k = a < b ? `${a}|${b}` : `${b}|${a}`;
      if (!this.directional.has(k)) this.umap.set(k, c);
    }
    this.eligible = pals
      .filter((p) => p.rankResult)
      .map((p) => ({ code: p.code, rank: p.rank }))
      .sort((x, y) => x.rank - y.rank);
    this.eranks = this.eligible.map((e) => e.rank);
  }

  breed(a: string, b: string): BreedingResult {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;

    const dir = this.directional.get(key);
    if (dir) {
      // Directional entries are guaranteed 2 rows by the dataset gate ([male, female, child]).
      const maleFirst = dir[0]!;
      const femaleFirst = dir[1]!;
      return { child: maleFirst[2], child2: femaleFirst[2], kind: 'directional' };
    }
    const uniqueChild = this.umap.get(key);
    if (uniqueChild !== undefined) {
      return { child: uniqueChild, kind: 'unique' };
    }
    if (a === b) {
      return { child: a, kind: 'identity' };
    }
    const rankA = this.rankByCode.get(a);
    const rankB = this.rankByCode.get(b);
    if (rankA === undefined || rankB === undefined) {
      throw new Error(`unknown pal code: ${rankA === undefined ? a : b}`);
    }
    const childRank = Math.floor((rankA + rankB + 1) / 2);
    return {
      child: this.nearest(childRank),
      kind: 'rank',
      rankMath: { childRank, rankA, rankB },
    };
  }

  /** Nearest eligible rank; equidistant ties resolve to the HIGHER rank. */
  private nearest(target: number): string {
    const eranks = this.eranks;
    const eligible = this.eligible;
    let lo = 0;
    let hi = eranks.length - 1;
    while (lo < hi) {
      const m = (lo + hi) >> 1;
      if (eranks[m]! < target) lo = m + 1;
      else hi = m;
    }
    let best = eligible[lo]!;
    let bestDist = Math.abs(eranks[lo]! - target);
    for (const i of [lo - 1, lo + 1]) {
      if (i < 0 || i >= eranks.length) continue;
      const d = Math.abs(eranks[i]! - target);
      if (d < bestDist || (d === bestDist && eranks[i]! > best.rank)) {
        best = eligible[i]!;
        bestDist = d;
      }
    }
    return best.code;
  }
}
