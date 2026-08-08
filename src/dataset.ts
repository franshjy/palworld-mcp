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
import { BreedingEngine, type ComboTuple, type DirectionalMap } from './breeding.js';

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
}

export interface Dataset {
  schemaVersion: number;
  generatedAt: string;
  gameVersion: string;
  sources: { name: string; url: string; license: string }[];
  pals: PalRecord[];
  uniqueCombos: ComboTuple[];
  directional: DirectionalMap;
}

const DEFAULT_DATA_PATH = join(dirname(fileURLToPath(import.meta.url)), '..', 'data', 'dataset.json');

export function loadDataset(path?: string): Dataset {
  const p = path ?? process.env.PALWORLD_MCP_DATA ?? DEFAULT_DATA_PATH;
  const resolved = isAbsolute(p) ? p : resolve(p);
  const raw = readFileSync(resolved, 'utf8');
  const ds = JSON.parse(raw) as Dataset;
  if (ds.schemaVersion !== 1 || !Array.isArray(ds.pals) || ds.pals.length === 0) {
    throw new Error(`unrecognized dataset schema at ${resolved}`);
  }
  return ds;
}

export class PalworldData {
  readonly dataset: Dataset;
  readonly engine: BreedingEngine;
  private readonly byCode = new Map<string, PalRecord>();
  private readonly byNameLower = new Map<string, PalRecord>();

  constructor(dataset: Dataset) {
    this.dataset = dataset;
    for (const p of dataset.pals) {
      this.byCode.set(p.code, p);
      this.byNameLower.set(p.name.toLowerCase(), p);
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

  search(opts: {
    query?: string;
    element?: string;
    minHp?: number;
    minAttack?: number;
    minDefense?: number;
    maxCaptureRate?: number;
    bossOnly?: boolean;
    breedableOnly?: boolean;
    sortBy?: 'name' | 'rank' | 'attack';
    limit?: number;
  }): PalRecord[] {
    const ql = opts.query?.trim().toLowerCase();
    const el = opts.element?.trim().toLowerCase();
    let pals = this.dataset.pals.filter((p) => {
      if (ql && !p.name.toLowerCase().includes(ql)) return false;
      if (el && !p.element.some((e) => e.toLowerCase() === el)) return false;
      if (opts.minHp !== undefined && (p.stats?.hp ?? -1) < opts.minHp) return false;
      if (opts.minAttack !== undefined && (p.stats?.attack ?? -1) < opts.minAttack) return false;
      if (opts.minDefense !== undefined && (p.stats?.defense ?? -1) < opts.minDefense) return false;
      if (opts.maxCaptureRate !== undefined && (p.captureRate ?? Infinity) > opts.maxCaptureRate) return false;
      if (opts.bossOnly && !p.boss) return false;
      if (opts.breedableOnly && !p.rankResult) return false;
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
}
