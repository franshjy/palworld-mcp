# Palworld MCP

MCP (Model Context Protocol) server for Palworld database queries — pals, breeding, items, recipes. Data is sourced from [paldb.cc](https://paldb.cc) and [palcalc-tools](https://github.com/palcalc-tools/palworld-1.0-calculator), compiled into a single offline dataset that ships with this repository.

**Offline-first:** all tools read from the shipped `data/dataset.json` at runtime. Users never contact paldb.cc.

## Tools

| Tool | What it does |
|---|---|
| `search_pals` | Search the pal roster by name, element, base stats (HP/ATK/DEF), capture rate, boss availability, breedability, or work suitability |
| `get_pal` | Full record for one pal: stats, element, breeding rank, skills, drops, work suitability, spawns, food |
| `get_breeding_result` | Offspring of two parents (unique combos, identity, rank math with eligible-pal exclusion) |
| `find_breeding_pairs` | Reverse lookup: which parent pairs produce a given child (optional `givenParent` filter) |
| `breeding_plan` | Multi-step breeding path solver: target pal + owned pals → ranked step-by-step plans |
| `search_items` | Search items by name, type, or rarity |
| `get_item` | Full item record: rarity, price, weight, drops, shops, and every crafting recipe it appears in |

## Requirements

- Node.js ≥ 18
- npm

## Install & build

```bash
npm install
npm run build
```

`dist/` is gitignored — build once after cloning (the MCP server runs from `dist/index.js`).

## Register with an MCP client

Any MCP-compatible client (Claude Desktop, Hermes, opencode, etc.) — the server speaks stdio:

```json
{
  "mcpServers": {
    "palworld": {
      "command": "node",
      "args": ["C:/absolute/path/to/pal-mcp/dist/index.js"]
    }
  }
}
```

To serve a dataset from another location, set `PALWORLD_MCP_DATA` to the path of a `dataset.json`.

## Example queries

- **"Find a fast mining pal"** → `search_pals { workSuitability: "Mining", sortBy: "rank" }`
- **"What does Anubis look like?"** → `get_pal { name: "Anubis" }`
- **"What do I get from Jetragon + Frostallion?"** → `get_breeding_result { parent1: "Jetragon", parent2: "Frostallion" }`
- **"I have Lamball and Foxparks, what can I breed towards?"** → `breeding_plan { target: "Anubis", owned: ["Lamball", "Foxparks", "Chikipi", "Pengullet"] }`
- **"Which weapons use Hexolite?"** → `get_item { name: "Hexolite" }` → read `usedInCrafting`

## Breeding model

- Child rank = `floor((rankA + rankB + 1) / 2)`; the result is the nearest **eligible** pal to that rank (116 pals are excluded from being results), ties resolve to the higher rank.
- 136 fixed unique combos override rank math; one directional pair (Katress + Wixen) depends on which parent is male.
- Breeding a pal with itself yields the same pal.
- Rank reflects breeding rarity, **not** catch difficulty.

## Data pipeline (owner-side only)

The dataset is rebuilt by the maintainer; end users just use it.

```bash
npm run refresh     # fetch pal stats + breeding table (paldb.cc, palcalc) and build the base dataset
npm run mirror      # crawl pal + item pages from paldb.cc into data/raw/ (throttled, resumable)
npm run parse-pages # parse the mirror: items + pal enrichment, merge into dataset.json (schema v2)
```

`data/raw/` (mirrored HTML) is gitignored — only the parsed `data/dataset.json` ships. The build is gated: 299 pals, every combo referencing known codes, ranks cross-checked against paldb's farm page and palcalc, and a canary on `iv_en.json`. Refresh after major game updates; the dataset records `gameVersion` for reference.

## Dataset

`data/dataset.json` (schema v2): 299 pals + 2,169 items, with skills, drops, work suitability, spawns, food, and crafting recipes. The `sources` field records provenance and license status for each upstream.

## Development

```bash
npm test        # node:test suite (server harness over stdio + breeding vectors)
npm run dev     # run from source via tsx (no build step)
```

## Licensing

- **Code** (src/, scripts/, tests/): MIT — see [LICENSE](LICENSE).
- **Dataset** (`data/dataset.json`): CC BY 4.0 — see [LICENSE.data](LICENSE.data).
- **Provenance & attribution** (paldb.cc, palcalc, Pocketpair game data): see [NOTICE](NOTICE).

Palworld is a trademark of Pocketpair, Inc. This is an unofficial fan project, not affiliated with or endorsed by Pocketpair.
