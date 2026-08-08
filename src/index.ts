/**
 * palworld-mcp — MCP server for Palworld database queries.
 *
 * Tools:
 *   - search_pals          text/stat/element filters over the full pal roster
 *   - get_pal              full record for one pal (stats, breeding data, combos)
 *   - get_breeding_result  breeding outcome for a parent pair (offline engine)
 *   - find_breeding_pairs  reverse lookup: which parent pairs produce a child
 *
 * All data is served from the shipped dataset (data/dataset.json) — no network.
 * Override the dataset location with PALWORLD_MCP_DATA.
 *
 * Logs go to stderr only: stdout is reserved for the MCP stdio protocol.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { loadDataset, PalworldData, type PalRecord } from './dataset.js';

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
  return {
    ...palSummary(p),
    friendship: p.friendship,
    maleRatio: p.maleRatio,
    ignoreCombi: p.ignoreCombi,
    breeding: {
      rank: p.rank,
      // Producible by generic rank-math breeding (false = unique-combo/legendary/raid only).
      breedableAsResult: p.rankResult,
      // Every pal can be used as a parent — eligibility only restricts who can be a result.
      canActAsParent: true,
      uniqueCombos: uniqueCombos.sort((x, y) => x.parent.localeCompare(y.parent)),
      obtainedVia,
    },
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
    return { error: `unknown pal "${missing}"` + (matches.length ? ` — did you mean: ${matches.join(', ')}?` : '') };
  }
  const r = data.engine.breed(a.pal.code, b.pal.code);
  const child = data.byCodeLookup(r.child);
  if (!child) return { error: `engine returned unknown child code ${r.child}` };

  let note: string | undefined;
  if (r.kind === 'directional') {
    const entries = data.dataset.directional[`${a.pal.code < b.pal.code ? a.pal.code + '|' + b.pal.code : b.pal.code + '|' + a.pal.code}`] ?? [];
    note = entries
      .map(([m, f, c]) => `${data.byCodeLookup(m)?.name ?? m} (male) + ${data.byCodeLookup(f)?.name ?? f} (female) -> ${data.byCodeLookup(c)?.name ?? c}`)
      .join('; ') + ' — child depends on which parent is male.';
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
      sortBy: z.enum(['name', 'rank', 'attack']).optional().describe('rank: lower = rarer'),
      limit: z.number().int().min(1).max(50).optional().describe('Max results (default 20)'),
    },
  },
  async ({ query, element, minHp, minAttack, minDefense, maxCaptureRate, bossOnly, breedableOnly, sortBy, limit }) => {
    const pals = data.search({ query, element, minHp, minAttack, minDefense, maxCaptureRate, bossOnly, breedableOnly, sortBy, limit });
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
        ? fail(`ambiguous "${name}" — candidates: ${r.matches.map((p) => p.name).join(', ')}`)
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
      'Reverse lookup: which parent pairs produce a given child (the inverse of get_breeding_result). Optional givenParent filters to pairs containing that parent — answers "I have A, what do I breed it with to get X?". Identity (target + target) always works and is not listed. Fixed unique combos are listed first, then rank-math pairs by ease (common parents first); capped at 25 with the total count.',
    inputSchema: {
      target: z.string().min(1).describe('Desired child pal name or code'),
      givenParent: z.string().min(1).optional().describe('If you already own one parent, find the other'),
    },
  },
  async ({ target, givenParent }) => {
    const rt = data.resolve(target);
    if (!rt.pal) {
      return rt.matches.length
        ? fail(`ambiguous "${target}" — candidates: ${rt.matches.map((p) => p.name).join(', ')}`)
        : fail(`unknown pal "${target}"`);
    }
    let givenCode: string | undefined;
    let givenName: string | null = null;
    if (givenParent) {
      const rg = data.resolve(givenParent);
      if (!rg.pal) {
        return rg.matches.length
          ? fail(`ambiguous "${givenParent}" — candidates: ${rg.matches.map((p) => p.name).join(', ')}`)
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
      })),
      note: 'Identity (target + target = target) always works if you already own it. Pairs are sorted: fixed unique combos first, then rank-math pairs by ease (common parents first).',
    });
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
