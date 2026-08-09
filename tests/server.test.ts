/**
 * End-to-end stdio harness: spawns the real MCP server and drives it over the
 * MCP protocol - the same path a client (Hermes, Claude Desktop, ...) uses.
 *
 * Runs against the compiled-or-tsx server with the shipped dataset.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DATA = join(ROOT, 'data', 'dataset.json');
const TSX_CLI = resolve(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const SERVER = join(ROOT, 'src', 'index.ts');

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms)),
  ]);
}

test('MCP server: listTools + seven tools over stdio', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, SERVER],
    env: { ...process.env, PALWORLD_MCP_DATA: DATA },
  });
  const client = new Client({ name: 'harness', version: '1.0.0' }, { capabilities: {} });

  try {
    await withTimeout(client.connect(transport), 20000, 'connect');

    const tools = await withTimeout(client.listTools(), 10000, 'listTools');
    assert.deepEqual(
      tools.tools.map((x) => x.name).sort(),
      ['breeding_plan', 'find_breeding_pairs', 'get_breeding_result', 'get_item', 'get_pal', 'search_items', 'search_pals'],
    );

    const search = await withTimeout(client.callTool({ name: 'search_pals', arguments: { query: 'anub' } }), 10000, 'search_pals');
    const searchOut = JSON.parse(search.content[0].text);
    assert.ok(searchOut.count >= 1);
    assert.ok(searchOut.pals.some((p: { name: string }) => p.name === 'Anubis'));

    const pal = await withTimeout(client.callTool({ name: 'get_pal', arguments: { name: 'Anubis' } }), 10000, 'get_pal');
    const palOut = JSON.parse(pal.content[0].text);
    assert.equal(palOut.found, true);
    assert.equal(palOut.pal.rank, 480);
    assert.equal(palOut.pal.name, 'Anubis');
    assert.equal(palOut.pal.url, 'https://paldb.cc/Anubis');
    assert.equal(palOut.pal.breeding.breedableAsResult, true);
    assert.equal(palOut.pal.breeding.canActAsParent, true);

    const ji = await withTimeout(client.callTool({ name: 'get_pal', arguments: { name: 'Jormuntide Ignis' } }), 10000, 'get_pal ji');
    const jiOut = JSON.parse(ji.content[0].text);
    assert.equal(jiOut.pal.breeding.breedableAsResult, false);
    assert.equal(jiOut.pal.breeding.canActAsParent, true);
    assert.equal(jiOut.pal.breeding.uniqueCombos.length, 0);
    assert.equal(jiOut.pal.breeding.obtainedVia.length, 1);
    assert.deepEqual(
      [jiOut.pal.breeding.obtainedVia[0].parent1, jiOut.pal.breeding.obtainedVia[0].parent2].sort(),
      ['Blazehowl', 'Jormuntide'],
    );

    const breed = await withTimeout(
      client.callTool({ name: 'get_breeding_result', arguments: { parent1: 'Lamball', parent2: 'Foxparks' } }),
      10000,
      'get_breeding_result',
    );
    const breedOut = JSON.parse(breed.content[0].text);
    assert.equal(breedOut.found, true);
    assert.equal(breedOut.result.kind, 'rank');
    assert.equal(breedOut.result.child.name, 'Lifmunk');
    assert.equal(breedOut.result.rankMath.childRank, 3020);
    assert.match(breedOut.result.note, /nearest eligible pal/);

    const unique = await withTimeout(
      client.callTool({ name: 'get_breeding_result', arguments: { parent1: 'Relaxaurus', parent2: 'Sparkit' } }),
      10000,
      'unique combo',
    );
    const uniqueOut = JSON.parse(unique.content[0].text);
    assert.equal(uniqueOut.result.kind, 'unique');
    assert.equal(uniqueOut.result.child.name, 'Relaxaurus Lux');

    const directional = await withTimeout(
      client.callTool({ name: 'get_breeding_result', arguments: { parent1: 'Katress', parent2: 'Wixen' } }),
      10000,
      'directional combo',
    );
    const dirOut = JSON.parse(directional.content[0].text);
    assert.equal(dirOut.result.kind, 'directional');
    assert.equal(dirOut.result.child.name, 'Wixen Noct');
    assert.equal(dirOut.result.child2.name, 'Katress Ignis');
    assert.match(dirOut.result.note, /which parent is male/);

    const missing = await withTimeout(
      client.callTool({ name: 'get_breeding_result', arguments: { parent1: 'Lamball', parent2: 'zzzz' } }),
      10000,
      'missing pal',
    );
    assert.equal(missing.isError, true);
    assert.match(missing.content[0].text, /unknown pal/);

    const ambiguous = await withTimeout(client.callTool({ name: 'get_pal', arguments: { name: 'lamb' } }), 10000, 'ambiguous');
    assert.equal(ambiguous.isError, true);
    assert.match(ambiguous.content[0].text, /candidates/);

    // find_breeding_pairs: first call pays for the lazy reverse-index build.
    const fp = await withTimeout(client.callTool({ name: 'find_breeding_pairs', arguments: { target: 'Anubis' } }), 30000, 'find_breeding_pairs');
    const fpOut = JSON.parse(fp.content[0].text);
    assert.equal(fpOut.found, true);
    assert.ok(fpOut.totalPairs > 100);
    assert.ok(fpOut.pairs.length > 0);
    assert.ok(
      fpOut.pairs.every(
        (p: { parent1: string; parent2: string; kind: string; parent1Rank: number; parent2Rank: number; usesTarget: boolean }) =>
          p.parent1 && p.parent2 && p.kind && Number.isInteger(p.parent1Rank) && Number.isInteger(p.parent2Rank) && typeof p.usesTarget === 'boolean',
      ),
    );
    assert.ok(fpOut.pairs.some((p: { usesTarget: boolean }) => p.usesTarget));
    assert.ok(fpOut.pairs.some((p: { usesTarget: boolean }) => !p.usesTarget));

    const fpJi = await withTimeout(
      client.callTool({ name: 'find_breeding_pairs', arguments: { target: 'Jormuntide Ignis' } }),
      10000,
      'fp unique',
    );
    const fpJiOut = JSON.parse(fpJi.content[0].text);
    assert.equal(fpJiOut.totalPairs, 1);
    assert.equal(fpJiOut.pairs[0].kind, 'unique');
    assert.equal(fpJiOut.pairs[0].usesTarget, false);
    assert.deepEqual([fpJiOut.pairs[0].parent1, fpJiOut.pairs[0].parent2].sort(), ['Blazehowl', 'Jormuntide']);

    const fpGiven = await withTimeout(
      client.callTool({ name: 'find_breeding_pairs', arguments: { target: 'Anubis', givenParent: 'Lamball' } }),
      10000,
      'fp givenParent',
    );
    assert.equal(JSON.parse(fpGiven.content[0].text).totalPairs, 0);

    const fpBad = await withTimeout(client.callTool({ name: 'find_breeding_pairs', arguments: { target: 'zzzz' } }), 10000, 'fp unknown');
    assert.equal(fpBad.isError, true);
    assert.match(fpBad.content[0].text, /unknown pal/);

    // breeding_plan
    const bp = await withTimeout(
      client.callTool({ name: 'breeding_plan', arguments: { target: 'Jormuntide Ignis', owned: ['Jormuntide', 'Blazehowl'] } }),
      20000,
      'breeding_plan unique',
    );
    const bpOut = JSON.parse(bp.content[0].text);
    assert.equal(bpOut.found, true);
    assert.equal(bpOut.unbreedable, false);
    assert.equal(bpOut.totalPlans, 1);
    assert.equal(bpOut.plans[0].stepCount, 1);
    assert.equal(bpOut.plans[0].steps[0].kind, 'unique');
    assert.equal(bpOut.plans[0].newCatches, 0);

    const bpJet = await withTimeout(
      client.callTool({ name: 'breeding_plan', arguments: { target: 'Jetragon', owned: [] } }),
      20000,
      'breeding_plan unbreedable',
    );
    assert.equal(JSON.parse(bpJet.content[0].text).unbreedable, true);

    const bpGreen = await withTimeout(
      client.callTool({ name: 'breeding_plan', arguments: { target: 'Anubis', owned: [] } }),
      20000,
      'breeding_plan greenfield',
    );
    const bpGreenOut = JSON.parse(bpGreen.content[0].text);
    assert.ok(bpGreenOut.totalPlans > 0);
    assert.equal(bpGreenOut.plans[0].stepCount, 1);
    assert.equal(bpGreenOut.plans[0].newCatches, 2);

    const bpBad = await withTimeout(
      client.callTool({ name: 'breeding_plan', arguments: { target: 'Anubis', owned: ['zzzz'] } }),
      10000,
      'breeding_plan unknown owned',
    );
    assert.equal(bpBad.isError, true);
    assert.match(bpBad.content[0].text, /unknown pal/);

    // items
    const si = await withTimeout(client.callTool({ name: 'search_items', arguments: { query: 'sphere' } }), 10000, 'search_items');
    const siOut = JSON.parse(si.content[0].text);
    assert.ok(siOut.count >= 1);
    assert.ok(siOut.items.some((i: { name: string }) => i.name.toLowerCase().includes('sphere')));

    const gi = await withTimeout(client.callTool({ name: 'get_item', arguments: { name: 'Wool' } }), 10000, 'get_item');
    const giOut = JSON.parse(gi.content[0].text);
    assert.equal(giOut.found, true);
    assert.equal(giOut.item.code, 'Wool');
    assert.equal(giOut.item.rarity, 'Common');
    assert.ok(giOut.item.droppedBy.some((d: { item: string }) => d.item === 'Melpaca'));

    const giBad = await withTimeout(client.callTool({ name: 'get_item', arguments: { name: 'zzzz' } }), 10000, 'get_item unknown');
    assert.equal(giBad.isError, true);
    assert.match(giBad.content[0].text, /unknown item/);

    // get_item product-side recipes (reverse of usedInCrafting)
    const giProduct = await withTimeout(client.callTool({ name: 'get_item', arguments: { name: 'Laser Gatling Gun' } }), 10000, 'get_item product recipes');
    const giProductOut = JSON.parse(giProduct.content[0].text);
    assert.ok(Array.isArray(giProductOut.item.recipes) && giProductOut.item.recipes.length > 0, 'expected producing recipes');
    const base = giProductOut.item.recipes.find((r: { materials: { item: string; qty: number | null }[] }) =>
      r.materials.some((m) => m.item === 'Hexolite' && m.qty === 100),
    );
    assert.ok(base, 'expected a 100-Hexolite craft tier for Laser Gatling Gun');

    // get_pal enrichment (schema v2 fields)
    const enriched = await withTimeout(client.callTool({ name: 'get_pal', arguments: { name: 'Anubis' } }), 10000, 'get_pal enriched');
    const enrichedOut = JSON.parse(enriched.content[0].text);
    assert.equal(enrichedOut.pal.food, 540);
    assert.ok(Array.isArray(enrichedOut.pal.activeSkills) && enrichedOut.pal.activeSkills.length > 0);
    assert.ok(enrichedOut.pal.workSuitability.some((w: { work: string }) => w.work === 'Mining'));

    // search_pals workSuitability filter
    const ws = await withTimeout(
      client.callTool({ name: 'search_pals', arguments: { workSuitability: 'Mining', limit: 5 } }),
      10000,
      'search_pals work',
    );
    const wsOut = JSON.parse(ws.content[0].text);
    assert.ok(wsOut.count >= 1);

    // search_pals dropItem + minWorkLevel filters
    const drop = await withTimeout(
      client.callTool({ name: 'search_pals', arguments: { dropItem: 'wool', limit: 5 } }),
      10000,
      'search_pals dropItem',
    );
    const dropOut = JSON.parse(drop.content[0].text);
    assert.ok(dropOut.pals.some((p: { name: string }) => p.name === 'Melpaca'), 'Melpaca drops Wool');

    const lvl = await withTimeout(
      client.callTool({ name: 'search_pals', arguments: { workSuitability: 'Mining', minWorkLevel: 7, limit: 10 } }),
      10000,
      'search_pals minWorkLevel',
    );
    const lvlOut = JSON.parse(lvl.content[0].text);
    assert.ok(!lvlOut.pals.some((p: { name: string }) => p.name === 'Anubis'), 'Anubis is Mining 6, must not match >= 7');

    const lvlBad = await withTimeout(
      client.callTool({ name: 'search_pals', arguments: { minWorkLevel: 3 } }),
      10000,
      'search_pals minWorkLevel without work',
    );
    assert.equal(lvlBad.isError, true);
    assert.match(lvlBad.content[0].text, /minWorkLevel requires workSuitability/);
  } finally {
    await client.close().catch(() => {});
    // Hard-kill the server child if it is still alive (prevents stray tsx processes).
    const proc = (transport as unknown as { _process?: { pid?: number; kill: (sig: string) => void } })._process;
    if (proc?.pid) {
      try {
        proc.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }
  }
});
