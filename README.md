# REALIZED

**Advertised LP APR carries almost no information about what liquidity providers actually take home.**

Measured on live Uniswap v3 data via The Graph: `corr(advertised APR, realized return) = 0.06`.

Not "sometimes wrong." Statistically uninformative — and every yield ranking in DeFi sorts on it.

---

## The defect

Advertised APR is fee income, annualized. It has no price term. So it is **positive by
construction**: a pool cannot advertise a loss, no matter what happened to the people in it.

Realized return = fee income **+ impermanent loss** (IL is always ≤ 0).

This isn't academic. Our own trading stack scored an LP position `+1.7% WIN` when the real
outcome was about **−14%**, because resolution was fee-only and arithmetically could not lose.
That call is the negative control in [`test/canary.test.js`](test/canary.test.js) — the test
that failure never had.

## What this is

An MCP server + library that computes **realized** LP return from The Graph's historical
`poolDayData`, and compares it to the advertised number.

- `realized_return(pool)` — fees, IL, realized vs advertised, for one pool
- `audit_pools(n)` — corpus-wide scan with sensitivity + canary
- `explain_gap(pool)` — where the difference came from

Why The Graph specifically: per-day fee totals in USD are **derived aggregates** produced by
the indexer. They do not exist on-chain. There is no RPC path to this dataset.

## Findings (live, reproducible)

Regenerate everything with `GRAPH_API_KEY=... node scripts/build-corpus.js` →
[`data/corpus.json`](data/corpus.json). Diff it against the subgraph yourself.

| finding | value | knob-proof? |
|---|---|---|
| corr(advertised, realized) | **0.06** | yes — 0.06 at all 3 liveness gates |
| median gap (advertised − realized) | +1.4 to +1.9 pts | yes — same sign/scale at all gates |
| live pools advertising + while realized is − | 41% / 35% / 34% | **no — moves with the gate** |

### Per-pool trust: which pools' advertised APR has historically been honest

Walk-forward: does advertised APR at day *T* predict realized return over *T..T+30*?

- **0% sign-flip rate** (advertised APR trustworthy): `USDT/USDf`, `AUSD/USDC`, `cbETH/WETH`,
  `WBTC/cbBTC`, `tBTC/WBTC`, `LINK/WETH`
- **60–71% sign-flip rate** (advertised APR routinely lied): `FET/WETH`, `DAI/WETH`,
  `QNT/WETH`, `PEPE/WETH`

The trustworthy set is entirely correlated pairs and the untrustworthy set is entirely
divergent ones — the instrument is sorting by the mechanism that actually causes the error,
which is evidence it measures something real rather than noise.

## Honesty box

Things that are true and inconvenient, kept here on purpose:

- **"1 in 3 pools mislead you" is retracted.** It moves 41%→34% depending on the liveness
  cutoff. A number that changes when you move a knob is a parameter, not a finding. The 0.06
  correlation is reported instead because it does *not* move.
- **An earlier correlation of +0.42 was wrong.** It had lookahead in the liveness gate and
  included dead pools. Removing both gave 0.06.
- **"LPs lose to HODL" is not our discovery.** Topaze Blue / Bancor established that in 2021.
  Our contribution is not the loss — it is the *calibration of the advertised metric*.
- **DefiLlama already ships yield predictions** (11,489 pools carry `predictedClass` /
  `predictedProbability`). What nobody publishes is whether those predictions were *right*.
- **The liveness gate is imperfect.** Activity/volume/TVL alone let dead tokens through;
  `priceCollapsed()` closes most of that, with the threshold set from *observed* depeg data
  (real depegs bottomed at 2–4% of peak, so a <1% cutoff would have caught none of them).

## Canaries

Every number here is gated on instruments proving they can find a known-present signal first:

- Stable/stable pairs **must** show ~0 impermanent loss, or the whole run is marked untrusted
  and `build-corpus.js` **refuses to write output** (exit 1). Live: worst |IL| = 0.0007%.
- IL math is checked against closed-form constant-product values (r=2 → −5.72%, r=4 → −20%).
- "Unmeasurable" stays distinguishable from "zero" — a missing price returns
  `measurable: false`, never a fabricated 0.
- Every headline is reported at **three** liveness cutoffs. If a finding flips across them,
  it is labeled a parameter, not a finding.

## Run it

```bash
npm install
node test/canary.test.js                  # offline math + negative control
GRAPH_API_KEY=... node test/canary.test.js --live
GRAPH_API_KEY=... node scripts/build-corpus.js
```

MCP client config:

```json
{ "mcpServers": { "realized": {
    "command": "node",
    "args": ["bin/mcp-server.js"],
    "env": { "GRAPH_API_KEY": "your-subgraph-studio-key" } } } }
```

## License

MIT
