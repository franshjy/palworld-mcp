/**
 * Dataset loading + indexing for palworld-mcp.
 *
 * The dataset (data/dataset.json) ships with the repo — users never contact
 * paldb.cc. Build it with `npm run refresh` (owner-side, throttled fetch) or
 * `node scripts/build-dataset.mjs`.
 */
import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BreedingEngine, type BreedingKind, type ComboTuple, type DirectionalMap } from './breeding.js';

export interface PalStats {
  hp: number;
  attack: number;
  defense: number;
}

export interface PalRecord {
  code: string;
  name: string;
  slug: string;
  deck: string;
  element: string[];
  stats: PalStats | null;
  friendship: { hp: number; attack: number; defense: number } | null;
  captureRate: number | null;
  ignoreCombi: boolean;
  boss: { hp: number; attack: number; defense: number; captureRate: number } | null;
  rank: number;
  rankResult: boolean;
  maleRatio: number;
  // schema v2 enrichment (from mirrored pal pages)
  size?: string;
  rarity?: string;
  food?: number;
  workSpeed?: number;
  genus?: string;
  summary?: string;
  partnerSkill?: { name: string; description?: string | null };
  activeSkills?: { level: number | null; name: string; element: string | null; power: number | null; cooldown: number | null }[];
  passiveSkills?: { name: string; description?: string | null }[];
  workSuitability?: { work: string; level: number }[];
  drops?: { item: string; qty?: string | null; probability?: string | null }[];
  spawns?: { level: string; location: string }[];
}

/** An item from the mirrored item pages (schema v2). */
export interface ItemRecord {
  code: string;
  name: string;
  slug: string;
  rarity: string | null;
  type: string | null;
  rank: number | null;
  price: number | null;
  weight: number | null;
  maxStackCount: number | null;
  typeA: string | null;
  typeB: string | null;
  droppedBy?: { item: string; qty?: string | null; probability?: string | null }[];
  soldBy?: string[];
  usedInCrafting?: { materials: { item: string; qty: number | null }[]; product: string | null }[];
}

/** A crafting recipe as seen from the product side (reverse of usedInCrafting). */
export interface CraftRecipe {
  product: string | null;
  materials: { item: string; qty: number | null }[];
}

/** A parent pair from the reverse breeding index, enriched for consumers. */
export interface ParentPair {
  parent1: string;
  parent2: string;
  kind: BreedingKind;
  /** Breeding rank (CombiRank) of each parent — lower = rarer in the breeding pool. */
  rank1: number;
  rank2: number;
  /** True when the target itself is one of the parents (circular for acquisition: you already need one). */
  usesTarget: boolean;
}

export interface Dataset {
  schemaVersion: number;
  generatedAt: string;
  gameVersion: string;
  sources: { name: string; url: string; license: string }[];
  pals: PalRecord[];
  uniqueCombos: ComboTuple[];
  directional: DirectionalMap;
  items?: ItemRecord[];
  coverage?: { pals: number; items: number; at: string };
}

const DEFAULT_DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dataset.json');

export function loadDataset(path?: string): Dataset {
  const p = path ?? process.env.PALWORLD_MCP_DATA ?? DEFAULT_DATA_PATH;
  const resolved = isAbsolute(p) ? p : resolve(p);
  const raw = readFileSync(resolved, 'utf8');
  const ds = JSON.parse(raw) as Dataset;
  if ((ds.schemaVersion < 1 || ds.schemaVersion > 2) || !Array.isArray(ds.pals) || ds.pals.length === 0) {
    throw new Error(`unrecognized dataset schema at ${resolved}`);
  }
  return ds;
}

export class PalworldData {
  readonly dataset: Dataset;
  readonly engine: BreedingEngine;
  private readonly byCode = new Map<string, PalRecord>();
  private readonly byNameLower = new Map<string, PalRecord>();
  private readonly itemByCode = new Map<string, ItemRecord>();
  private readonly itemByNameLower = new Map<string, ItemRecord>();
  private readonly recipesByProduct = new Map<string, CraftRecipe[]>();

  constructor(dataset: Dataset) {
    this.dataset = dataset;
    for (const p of dataset.pals) {
      this.byCode.set(p.code, p);
      this.byNameLower.set(p.name.toLowerCase(), p);
    }
    for (const i of dataset.items ?? []) {
      this.itemByCode.set(i.code, i);
      this.itemByNameLower.set(i.name.toLowerCase(), i);
    }
    // Reverse recipe index: every usedInCrafting entry, indexed under the item it PRODUCES.
    // The same recipe row appears on every material's page — dedupe by product + materials.
    for (const i of dataset.items ?? []) {
      for (const r of i.usedInCrafting ?? []) {
        if (!r.product) continue;
        const target = this.itemByProductName(r.product);
        if (!target) continue;
        const key = target.name.toLowerCase();
        const seen = this.recipesByProduct.get(key);
        const dedupeKey = `${r.product}\u0000${JSON.stringify(r.materials)}`;
        if (seen) {
          if (seen.some((x) => `${x.product}\u0000${JSON.stringify(x.materials)}` === dedupeKey)) continue;
        }
        const arr = seen ?? [];
        arr.push(r);
        this.recipesByProduct.set(key, arr);
      }
    }
    this.engine = new BreedingEngine(dataset.pals, dataset.uniqueCombos, dataset.directional);
  }

  byCodeLookup(code: string): PalRecord | undefined {
    return this.byCode.get(code);
  }

  /**
   * Resolve a user-supplied name: exact internal code -> exact display name
   * (case-insensitive) -> substring matches. Returns the candidates on any
   * non-exact hit so callers can report ambiguity.
   */
  resolve(input: string): { pal?: PalRecord; matches: PalRecord[] } {
    const q = input.trim();
    if (!q) return { matches: [] };
    const exact = this.byCode.get(q) ?? this.byNameLower.get(q.toLowerCase());
    if (exact) return { pal: exact, matches: [] };
    const ql = q.toLowerCase();
    const matches = this.dataset.pals
      .filter((p) => p.name.toLowerCase().includes(ql))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { matches };
  }

  /** Same resolution semantics for items. */
  resolveItem(input: string): { item?: ItemRecord; matches: ItemRecord[] } {
    const q = input.trim();
    if (!q) return { matches: [] };
    const exact = this.itemByCode.get(q) ?? this.itemByNameLower.get(q.toLowerCase());
    if (exact) return { item: exact, matches: [] };
    const ql = q.toLowerCase();
    const matches = (this.dataset.items ?? [])
      .filter((i) => i.name.toLowerCase().includes(ql))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { matches };
  }

  /**
   * Resolve a recipe product string ("Laser Gatling Gun 1", "Rocket Ammo 10",
   * "Coralum Ore x1") to the canonical item it produces: exact name match first,
   * then a trailing tier/count suffix stripped.
   */
  private itemByProductName(product: string): ItemRecord | undefined {
    const exact = this.itemByNameLower.get(product.toLowerCase());
    if (exact) return exact;
    const stripped = product.replace(/ x?\d+$/, '').trim();
    if (stripped && stripped !== product) return this.itemByNameLower.get(stripped.toLowerCase());
    return undefined;
  }

  /** Recipes that produce the given item (exact name), the reverse of usedInCrafting. */
  itemRecipes(itemName: string): CraftRecipe[] {
    return this.recipesByProduct.get(itemName.toLowerCase()) ?? [];
  }

  /** Item search: name substring + type + rarity filters, sorted by name. */
  searchItems(opts: { query?: string; type?: string; rarity?: string; limit?: number }): ItemRecord[] {
    const ql = opts.query?.trim().toLowerCase();
    const type = opts.type?.trim().toLowerCase();
    const rarity = opts.rarity?.trim().toLowerCase();
    let items = (this.dataset.items ?? []).filter((i) => {
      if (ql && !i.name.toLowerCase().includes(ql)) return false;
      if (type && !(i.type ?? '').toLowerCase().includes(type)) return false;
      if (rarity && !(i.rarity ?? '').toLowerCase().includes(rarity)) return false;
      return true;
    });
    items = [...items].sort((a, b) => a.name.localeCompare(b.name));
    return items.slice(0, Math.min(opts.limit ?? 20, 50));
  }

  search(opts: {
    query?: string;
    element?: string;
    minHp?: number;
    minAttack?: number;
    minDefense?: number;
    maxCaptureRate?: number;
    bossOnly?: boolean;
    breedableOnly?: boolean;
    workSuitability?: string;
    dropItem?: string;
    minWorkLevel?: number;
    sortBy?: 'name' | 'rank' | 'attack';
    limit?: number;
  }): PalRecord[] {
    const ql = opts.query?.trim().toLowerCase();
    const el = opts.element?.trim().toLowerCase();
    const work = opts.workSuitability?.trim().toLowerCase();
    const drop = opts.dropItem?.trim().toLowerCase();
    let pals = this.dataset.pals.filter((p) => {
      if (ql && !p.name.toLowerCase().includes(ql)) return false;
      if (el && !p.element.some((e) => e.toLowerCase() === el)) return false;
      if (opts.minHp !== undefined && (p.stats?.hp ?? -1) < opts.minHp) return false;
      if (opts.minAttack !== undefined && (p.stats?.attack ?? -1) < opts.minAttack) return false;
      if (opts.minDefense !== undefined && (p.stats?.defense ?? -1) < opts.minDefense) return false;
      if (opts.maxCaptureRate !== undefined && (p.captureRate ?? Infinity) > opts.maxCaptureRate) return false;
      if (opts.bossOnly && !p.boss) return false;
      if (opts.breedableOnly && !p.rankResult) return false;
      if (work && !(p.workSuitability ?? []).some((w) => w.work.toLowerCase() === work && (opts.minWorkLevel === undefined || w.level >= opts.minWorkLevel))) return false;
      if (drop && !(p.drops ?? []).some((d) => d.item.toLowerCase().includes(drop))) return false;
      return true;
    });
    const sort = opts.sortBy ?? 'name';
    pals = [...pals].sort((a, b) => {
      if (sort === 'rank') return a.rank - b.rank;
      if (sort === 'attack') return (b.stats?.attack ?? -1) - (a.stats?.attack ?? -1);
      return a.name.localeCompare(b.name);
    });
    return pals.slice(0, Math.min(opts.limit ?? 20, 50));
  }

  /** Lazy reverse index: child code -> producing parent pairs (identity pairs excluded). */
  private producersCache: Map<string, { parent1: string; parent2: string; kind: BreedingKind }[]> | null = null;

  private producers(): Map<string, { parent1: string; parent2: string; kind: BreedingKind }[]> {
    if (this.producersCache) return this.producersCache;
    const map = new Map<string, { parent1: string; parent2: string; kind: BreedingKind }[]>();
    const pals = this.dataset.pals;
    for (let i = 0; i < pals.length; i++) {
      for (let j = i + 1; j < pals.length; j++) {
        const a = pals[i]!.code;
        const b = pals[j]!.code;
        const r = this.engine.breed(a, b);
        const entry = { parent1: a, parent2: b, kind: r.kind };
        // Directional pairs produce TWO children — register the pair under both.
        for (const child of r.child2 ? [r.child, r.child2] : [r.child]) {
          const arr = map.get(child);
          if (arr) arr.push(entry);
          else map.set(child, [entry]);
        }
      }
    }
    this.producersCache = map;
    return map;
  }

  /**
   * Reverse breeding lookup: distinct parent pairs whose offspring is `targetCode`.
   * Identity pairs (target + target) are excluded by construction — they always work.
   * Optional `givenParent` restricts to pairs containing that parent.
   * Sorted: fixed unique/directional combos first, then rank-math pairs by rank-distance
   * ease — the harder-to-get parent of the pair is as high-ranked as possible (min(rank)
   * descending, then rank sum descending). Rank is the game's hidden breeding weight
   * (lower = rarer); it reflects breeding rarity, not catch difficulty.
   */
  findParentPairs(
    targetCode: string,
    givenParent?: string,
    limit = 25,
  ): { total: number; pairs: ParentPair[] } {
    const rankOf = (c: string) => this.byCode.get(c)?.rank ?? Infinity;
    const isFixed = (k: BreedingKind) => k === 'unique' || k === 'directional';
    const filtered = (this.producers().get(targetCode) ?? []).filter(
      (p) => !givenParent || p.parent1 === givenParent || p.parent2 === givenParent,
    );
    const sorted = [...filtered].sort((x, y) => {
      if (isFixed(x.kind) !== isFixed(y.kind)) return isFixed(x.kind) ? -1 : 1;
      const xMin = Math.min(rankOf(x.parent1), rankOf(x.parent2));
      const yMin = Math.min(rankOf(y.parent1), rankOf(y.parent2));
      if (xMin !== yMin) return yMin - xMin;
      return rankOf(y.parent1) + rankOf(y.parent2) - (rankOf(x.parent1) + rankOf(x.parent2));
    });
    return {
      total: filtered.length,
      pairs: sorted.slice(0, limit).map((p) => ({
        parent1: p.parent1,
        parent2: p.parent2,
        kind: p.kind,
        rank1: rankOf(p.parent1),
        rank2: rankOf(p.parent2),
        usesTarget: p.parent1 === targetCode || p.parent2 === targetCode,
      })),
    };
  }
}
