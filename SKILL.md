---
name: realized-lp
description: Check what liquidity providers ACTUALLY earned in a Uniswap v3 or Aerodrome pool — fee income minus impermanent loss — against the fees-only APR that DEX UIs advertise. Use when asked whether an LP position, pool, or yield number is actually profitable, whether an advertised APR is trustworthy, or to audit many pools at once for misleading yield. Backed by live Graph subgraph data.
---

# Realized LP

Advertised LP APR is fee income, annualized. **It has no price term, so it cannot go negative.**
A pool cannot advertise a loss no matter what happened to the people in it. This skill computes
the number that can: `realized = fees + impermanent loss`.

## When to use this

- "Is this pool actually profitable?" / "Is this APR real?"
- "I'm LPing WETH/USDC, am I making money?"
- "Find me pools where the advertised yield is lying"
- Any yield-farming or LP decision where the advertised number is the only evidence on offer

## Quick start (no install, no API key)

```bash
curl -s https://drainfun.xyz/api/pools.json
```

202 live pools across 4 validated venues. The response embeds its own `schema` and the exact
impermanent-loss formula in `howToComputeRealizedReturn`, so you can compute any range yourself
with no further docs. Fields per pool:

| field | meaning |
|---|---|
| `pair` | token0/token1 symbols |
| `dex` / `chain` | `uniswap-v3` \| `aerodrome` / `mainnet` \| `arbitrum` \| `polygon` \| `base` |
| `r` | price ratio over the window (exit ÷ entry) |
| `fees` | fee income over window, % of entry TVL |
| `adv` | **advertised** APR % — what the DEX UI shows |
| `days` | window length |

### Compute realized return for any range

```js
function il(r, w) {                      // w = range half-width: 1.25 tight, 2 typical, 1e8 full
  const sa = Math.sqrt(1 / w), sb = Math.sqrt(w);
  let pos;
  if (r <= 1 / w) pos = (1 / sa - 1 / sb) * r;
  else if (r >= w) pos = sb - sa;
  else pos = 2 * Math.sqrt(r) - sa - r / sb;
  return ((pos / ((1 - sa) + (1 - 1 / sb) * r)) - 1) * 100;
}
const realizedPct = pool.fees + il(pool.r, 2);
const realizedApr = (realizedPct / pool.days) * 365;
const misleading  = pool.adv > 0 && realizedApr < 0;   // advertised a profit you didn't get
```

**`r <= 1/w` or `r >= w` means price left the band** — the LP is fully converted into the losing
asset and the loss is realized, not impermanent. Always say so; it changes the advice.

## Live queries (MCP server)

For pools not in the cached set, or a custom window, run the MCP server. Needs a free
[Subgraph Studio](https://thegraph.com/studio/) API key.

```bash
git clone https://github.com/jiggy-cadence/realized && cd realized && npm install
```

```json
{ "mcpServers": { "realized": {
  "command": "node", "args": ["/abs/path/to/realized/bin/mcp-server.js"],
  "env": { "GRAPH_API_KEY": "<your-key>" } } } }
```

| tool | use |
|---|---|
| `find_pool(query)` | **start here** — resolve `"WETH/USDC"` or `"PEPE"` to ranked poolIds. You never need to know an address. |
| `realized_return(poolId, days?, rangeWidthX?)` | fees vs IL vs advertised for one pool |
| `explain_gap(poolId)` | plain-language verdict + the evidence chain that produced it |
| `audit_pools(limit?)` | corpus-wide sweep: how many pools advertise a profit LPs didn't get |

## Reporting rules (these matter more than the numbers)

1. **Always state the range.** The same pool can be honest full-range and misleading at ±1.25×.
   Full-range is the *most generous possible case for the pool* — never quote it alone.
2. **`measurable: false` is not zero.** It means the window couldn't be priced. Say "couldn't
   measure," never "no loss."
3. **Check the canary before quoting an aggregate.** `audit_pools` returns
   `canary.passed` — stable/stable pairs must show ~0 IL. If it's false the instrument is
   unproven and every number in that response is untrusted.
4. **Fees are held constant across ranges**, which is unfair to *this tool*: concentrating earns
   more fees too, so some IL is earned back. The **direction** is reliable; treat magnitudes as
   bounded by that caveat.
5. **This is backward-looking measurement, not a forecast.** It says what happened over the
   window, not what will happen.

## What holds this up

110 independent (non-overlapping) 30-day windows across 4 chains, plus the same instrument run
unchanged on Aerodrome Slipstream — different team, codebase, incentive model — showing the same
defect with the same shape. Venues whose stable pairs can't prove ~0 IL are **excluded, not
reported as clean**. Full tables: <https://drainfun.xyz/realized.html>

Data: The Graph. Per-day `feesUSD` are indexer-derived aggregates that exist nowhere on-chain —
there is no RPC path to this dataset.
