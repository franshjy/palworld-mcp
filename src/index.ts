/**
 * palworld-mcp - MCP server for Palworld database queries.
 *
 * Tools:
 *   - search_pals          text/stat/element filters over the full pal roster
 *   - get_pal              full record for one pal (stats, breeding data, combos)
 *   - get_breeding_result  breeding outcome for a parent pair (offline engine)
 *   - find_breeding_pairs  reverse lookup: which parent pairs produce a child
 *
 * All data is served from the shipped dataset (data/dataset.json) - no network.
 * Override the dataset location with PALWORLD_MCP_DATA.
 *
 * Logs go to stderr only: stdout is reserved for the MCP stdio protocol.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDataset, PalworldData, type ItemRecord, type PalRecord } from './dataset.js';
import { breedingPlan } from './planner.js';

function fail(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true };
}

function ok(payload: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] };
}

function palSummary(p: PalRecord) {
  return {
    code: p.code,
    name: p.name,
    deck: p.deck,
    element: p.element,
    stats: p.stats,
    captureRate: p.captureRate,
    rank: p.rank,
    breedableAsResult: p.rankResult,
    boss: p.boss ? true : false,
    url: `https://paldb.cc/${p.slug}`,
  };
}

function palDetail(p: PalRecord, data: PalworldData) {
  const nameOf = (code: string) => data.byCodeLookup(code)?.name ?? code;
  // Unique combos where THIS pal is a parent (the offspring it can create).
  const uniqueCombos = data.dataset.uniqueCombos
    .filter(([a, b]) => a === p.code || b === p.code)
    .map(([a, b, c]) => ({ parent: nameOf(a === p.code ? b : a), child: nameOf(c) }));
  // Unique combos where THIS pal is the child (how it is obtained).
  const obtainedVia = data.dataset.uniqueCombos
    .filter(([, , c]) => c === p.code)
    .map(([a, b]) => ({ parent1: nameOf(a), parent2: nameOf(b) }))
    .sort((x, y) => x.parent1.localeCompare(y.parent1) || x.parent2.localeCompare(y.parent2));
  const detail = {
    ...palSummary(p),
    friendship: p.friendship,
    maleRatio: p.maleRatio,
    ignoreCombi: p.ignoreCombi,
    breeding: {
      rank: p.rank,
      // Producible by generic rank-math breeding (false = unique-combo/legendary/raid only).
      breedableAsResult: p.rankResult,
      // Every pal can be used as a parent - eligibility only restricts who can be a result.
      canActAsParent: true,
      uniqueCombos: uniqueCombos.sort((x, y) => x.parent.localeCompare(y.parent)),
      obtainedVia,
    },
  };
  // Schema-v2 enrichment (only when the mirrored page provided it).
  for (const key of ['size', 'rarity', 'food', 'workSpeed', 'genus', 'summary', 'partnerSkill', 'activeSkills', 'passiveSkills', 'workSuitability', 'drops', 'spawns'] as const) {
    if (p[key] !== undefined) (detail as Record<string, unknown>)[key] = p[key];
  }
  return detail;
}

function itemSummary(i: ItemRecord) {
  return {
    code: i.code,
    name: i.name,
    slug: i.slug,
    rarity: i.rarity,
    type: i.type,
    rank: i.rank,
    price: i.price,
    weight: i.weight,
    url: `https://paldb.cc/${i.slug}`,
  };
}

interface RankMathInfo {
  childRank: number;
  rankA: number;
  rankB: number;
}

interface BreedingToolResult {
  result?: {
    kind: string;
    parents: string[];
    child: ReturnType<typeof palSummary>;
    child2?: ReturnType<typeof palSummary>;
    rankMath?: RankMathInfo;
    note?: string;
  };
  error?: string;
}

function buildRankMathNote(rm: RankMathInfo | undefined): string {
  if (!rm) return '';
  return (
    `child rank = floor((${rm.rankA} + ${rm.rankB} + 1) / 2) = ${rm.childRank}; ` +
    `result = nearest eligible pal to rank ${rm.childRank} (ties resolve to the higher rank).`
  );
}

function breedResultOf(data: PalworldData, name1: string, name2: string): BreedingToolResult {
  const a = data.resolve(name1);
  const b = data.resolve(name2);
  if (!a.pal || !b.pal) {
    const missing = !a.pal ? name1 : name2;
    const matches = (!a.pal ? a : b).matches.map((p) => p.name);
    return { error: `unknown pal "${missing}"` + (matches.length ? ` - did you mean: ${matches.join(', ')}?` : '') };
  }
  const r = data.engine.breed(a.pal.code, b.pal.code);
  const child = data.byCodeLookup(r.child);
  if (!child) return { error: `engine returned unknown child code ${r.child}` };

  let note: string | undefined;
  if (r.kind === 'directional') {
    const entries = data.dataset.directional[`${a.pal.code < b.pal.code ? a.pal.code + '|' + b.pal.code : b.pal.code + '|' + a.pal.code}`] ?? [];
    note = entries
      .map(([m, f, c]) => `${data.byCodeLookup(m)?.name ?? m} (male) + ${data.byCodeLookup(f)?.name ?? f} (female) -> ${data.byCodeLookup(c)?.name ?? c}`)
      .join('; ') + ' - child depends on which parent is male.';
  } else if (r.kind === 'unique') {
    note = 'fixed unique combination (overrides rank math).';
  } else if (r.kind === 'identity') {
    note = 'breeding a pal with itself yields the same pal.';
  } else if (r.rankMath) {
    note = buildRankMathNote(r.rankMath);
  }

  return {
    result: {
      kind: r.kind,
      parents: [a.pal.name, b.pal.name],
      child: palSummary(child),
      child2: r.child2 ? (data.byCodeLookup(r.child2) ? palSummary(data.byCodeLookup(r.child2)!) : undefined) : undefined,
      rankMath: r.rankMath,
      note,
    },
    error: undefined,
  };
}

let data: PalworldData;
try {
  const ds = loadDataset();
  data = new PalworldData(ds);
  console.error(`[palworld-mcp] dataset v${ds.schemaVersion} (game ${ds.gameVersion}, built ${ds.generatedAt}): ${ds.pals.length} pals`);
} catch (e) {
  console.error(`[palworld-mcp] failed to load dataset: ${(e as Error).message}`);
  console.error('[palworld-mcp] run "node scripts/build-dataset.mjs" first, or set PALWORLD_MCP_DATA');
  process.exit(1);
}

const server = new McpServer({ name: 'palworld-mcp', version: '0.1.0' });

server.registerTool(
  'search_pals',
  {
    title: 'Search pals',
    description:
      'Search the Palworld pal roster by name, element, base stats (HP/ATK/DEF), capture rate, boss availability or breedability. All filters are optional and combined with AND.',
    inputSchema: {
      query: z.string().optional().describe('Name substring, e.g. "anub"'),
      element: z.string().optional().describe('Element: Fire, Water, Leaf, Electricity, Ice, Earth, Dark, Dragon, Normal'),
      minHp: z.number().int().nonnegative().optional(),
      minAttack: z.number().int().nonnegative().optional(),
      minDefense: z.number().int().nonnegative().optional(),
      maxCaptureRate: z.number().positive().optional().describe('Lower capture rate = rarer catch'),
      bossOnly: z.boolean().optional().describe('Only pals that have an alpha/boss variant'),
      breedableOnly: z.boolean().optional().describe('Only pals obtainable via standard breeding'),
      workSuitability: z.string().optional().describe('Only pals with this work suitability, e.g. "Mining" or "Kindling"'),
      dropItem: z.string().optional().describe('Only pals that drop this item (substring match on drop name)'),
      minWorkLevel: z.number().int().min(1).optional().describe('Require at least this work level - only applies together with workSuitability'),
      sortBy: z.enum(['name', 'rank', 'attack']).optional().describe('rank: lower = rarer'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
    },
  },
  async ({ query, element, minHp, minAttack, minDefense, maxCaptureRate, bossOnly, breedableOnly, workSuitability, dropItem, minWorkLevel, sortBy, limit }) => {
    if (minWorkLevel !== undefined && !workSuitability) {
      return fail('minWorkLevel requires workSuitability');
    }
    const pals = data.search({ query, element, minHp, minAttack, minDefense, maxCaptureRate, bossOnly, breedableOnly, workSuitability, dropItem, minWorkLevel, sortBy, limit });
    return ok({ count: pals.length, pals: pals.map(palSummary) });
  },
);

server.registerTool(
  'get_pal',
  {
    title: 'Get pal details',
    description:
      'Full record for one pal: stats, element, capture rate, boss block, breeding rank, eligibility, unique combos it participates in as a parent, and how it is obtained (unique combos where it is the child). Accepts exact name, internal code, or a unique substring.',
    inputSchema: { name: z.string().min(1) },
  },
  async ({ name }) => {
    const r = data.resolve(name);
    if (!r.pal) {
      return r.matches.length
        ? fail(`ambiguous "${name}" - candidates: ${r.matches.map((p) => p.name).join(', ')}`)
        : fail(`unknown pal "${name}"`);
    }
    return ok({ found: true, pal: palDetail(r.pal, data) });
  },
);

server.registerTool(
  'get_breeding_result',
  {
    title: 'Get breeding result',
    description:
      'Compute the offspring of two pals using the offline breeding engine (unique combos, identity, rank math with eligible-pal exclusion and higher-rank tie-break). Returns the child with its stats and a short explanation.',
    inputSchema: {
      parent1: z.string().min(1).describe('Parent pal name or code'),
      parent2: z.string().min(1).describe('Parent pal name or code'),
    },
  },
  async ({ parent1, parent2 }) => {
    const { result, error } = breedResultOf(data, parent1, parent2);
    if (error) return fail(error);
    return ok({ found: true, result });
  },
);

server.registerTool(
  'find_breeding_pairs',
  {
    title: 'Find breeding pairs',
    description:
      'Reverse lookup: which parent pairs produce a given child (the inverse of get_breeding_result). Optional givenParent filters to pairs containing that parent - answers "I have A, what do I breed it with to get X?". Identity (target + target) always works and is not listed. Fixed unique combos first, then rank-math pairs by breeding-rank ease; pairs that already require owning the target are flagged usesTarget. Capped at 25 with the total count.',
    inputSchema: {
      target: z.string().min(1).describe('Desired child pal name or code'),
      givenParent: z.string().min(1).optional().describe('If you already own one parent, find the other'),
    },
  },
  async ({ target, givenParent }) => {
    const rt = data.resolve(target);
    if (!rt.pal) {
      return rt.matches.length
        ? fail(`ambiguous "${target}" - candidates: ${rt.matches.map((p) => p.name).join(', ')}`)
        : fail(`unknown pal "${target}"`);
    }
    let givenCode: string | undefined;
    let givenName: string | null = null;
    if (givenParent) {
      const rg = data.resolve(givenParent);
      if (!rg.pal) {
        return rg.matches.length
          ? fail(`ambiguous "${givenParent}" - candidates: ${rg.matches.map((p) => p.name).join(', ')}`)
          : fail(`unknown pal "${givenParent}"`);
      }
      givenCode = rg.pal.code;
      givenName = rg.pal.name;
    }
    const { total, pairs } = data.findParentPairs(rt.pal.code, givenCode);
    return ok({
      found: true,
      target: {
        name: rt.pal.name,
        code: rt.pal.code,
        rank: rt.pal.rank,
        breedableAsResult: rt.pal.rankResult,
        url: `https://paldb.cc/${rt.pal.slug}`,
      },
      givenParent: givenName,
      totalPairs: total,
      pairs: pairs.map((p) => ({
        parent1: data.byCodeLookup(p.parent1)?.name ?? p.parent1,
        parent2: data.byCodeLookup(p.parent2)?.name ?? p.parent2,
        kind: p.kind,
        parent1Rank: p.rank1,
        parent2Rank: p.rank2,
        usesTarget: p.usesTarget,
      })),
      note: 'Identity (target + target = target) always works if you already own it. Fixed unique combos are listed first, then rank-math pairs by rank-distance ease (the harder-to-get parent\'s breeding rank, descending - lower rank = rarer in the breeding pool). Rank reflects breeding rarity, not catch difficulty. Pairs flagged usesTarget: true already require owning the target (circular for acquisition).',
    });
  },
);

server.registerTool(
  'breeding_plan',
  {
    title: 'Breeding plan',
    description:
      'Multi-step breeding path solver: given a target pal and the pals you own, returns ranked step-by-step plans (fewest steps, then fewest new catches). owned is required - pass [] for greenfield mode (direct pairs whose parents you only need to catch). Unbreedable targets (e.g. Jetragon) are reported as unbreedable. Depth capped at maxSteps (default 5).',
    inputSchema: {
      target: z.string().min(1).describe('Desired child pal name or code'),
      owned: z.array(z.string().min(1)).describe('Pal names/codes you own (empty array = greenfield)'),
      maxSteps: z.number().int().min(1).max(8).optional().describe('Max breeding steps per plan (default 5)'),
    },
  },
  async ({ target, owned, maxSteps }) => {
    const rt = data.resolve(target);
    if (!rt.pal) {
      return rt.matches.length
        ? fail(`ambiguous "${target}" - candidates: ${rt.matches.map((p) => p.name).join(', ')}`)
        : fail(`unknown pal "${target}"`);
    }
    const codes: string[] = [];
    const names: string[] = [];
    for (const o of owned) {
      const r = data.resolve(o);
      if (!r.pal) {
        return r.matches.length
          ? fail(`ambiguous "${o}" - candidates: ${r.matches.map((p) => p.name).join(', ')}`)
          : fail(`unknown pal "${o}"`);
      }
      codes.push(r.pal.code);
      names.push(r.pal.name);
    }
    const result = breedingPlan(data, rt.pal.code, codes, maxSteps ?? 5);
    const nameOf = (c: string) => data.byCodeLookup(c)?.name ?? c;
    return ok({
      found: result.found,
      target: {
        name: rt.pal.name,
        code: rt.pal.code,
        rank: rt.pal.rank,
        breedableAsResult: rt.pal.rankResult,
        url: `https://paldb.cc/${rt.pal.slug}`,
      },
      owned: names,
      alreadyOwned: result.alreadyOwned ?? false,
      unbreedable: result.unbreedable ?? false,
      totalPlans: result.totalPlans,
      plans: result.plans.map((p) => ({
        stepCount: p.stepCount,
        newCatches: p.newCatches,
        steps: p.steps.map((s) => ({
          parent1: nameOf(s.parent1),
          parent2: nameOf(s.parent2),
          child: nameOf(s.child),
          kind: s.kind,
          ...(s.note ? { note: s.note } : {}),
        })),
      })),
      note: 'Plans are sorted by fewest steps, then fewest new catches. Each step breeds two owned (or already-produced) pals; newCatches counts parents the plan needs that you neither own nor produce earlier in the path.',
    });
  },
);

server.registerTool(
  'search_items',
  {
    title: 'Search items',
    description:
      'Search the item database by name, type or rarity (e.g. "sphere", "weapon", "Legendary"). Returns compact summaries with price and weight; use get_item for full records (drops, shops, recipes).',
    inputSchema: {
      query: z.string().min(1).optional().describe('Name substring, e.g. "sphere"'),
      type: z.string().min(1).optional().describe('Item type, e.g. "Weapon", "Material", "Food"'),
      rarity: z.string().min(1).optional().describe('Rarity tier: Common, Uncommon, Rare, Epic, Legendary'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
    },
  },
  async ({ query, type, rarity, limit }) => {
    const items = data.searchItems({ query, type, rarity, limit });
    return ok({ count: items.length, items: items.map(itemSummary) });
  },
);

server.registerTool(
  'get_item',
  {
    title: 'Get item details',
    description:
      'Full record for one item: rarity, type, rank, price, weight, stack count, which pals drop it, which shops sell it, every crafting recipe it appears in, and the recipes that produce it. Accepts exact name, internal code, or a unique substring.',
    inputSchema: { name: z.string().min(1) },
  },
  async ({ name }) => {
    const r = data.resolveItem(name);
    if (!r.item) {
      return r.matches.length
        ? fail(`ambiguous "${name}" - candidates: ${r.matches.map((p) => p.name).join(', ')}`)
        : fail(`unknown item "${name}"`);
    }
    return ok({ found: true, item: { ...r.item, recipes: data.itemRecipes(r.item.name) } });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    await server.close();
    process.exit(0);
  });
}
