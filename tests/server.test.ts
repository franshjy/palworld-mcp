/**
 * End-to-end stdio harness: spawns the real MCP server and drives it over the
 * MCP protocol — the same path a client (Hermes, Claude Desktop, ...) uses.
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

test('MCP server: listTools + three tools over stdio', async (t) => {
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
      ['get_breeding_result', 'get_pal', 'search_pals'],
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
