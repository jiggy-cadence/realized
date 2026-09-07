# REALIZED

**Advertised LP APR is positive by construction. It cannot tell you that you lost money.
On live Uniswap v3 data, 34–62% of pools advertised a positive APR while liquidity providers
actually went backwards — and the number rises the tighter your range.**

Measured on live Uniswap v3 data via The Graph, regenerated end-to-end by
[`scripts/build-corpus.js`](scripts/build-corpus.js) into [`data/corpus.json`](data/corpus.json).

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

### The defect survives every knob we can turn

Uniswap v3 LPs **concentrate** their liquidity into a price band. Inside a band, impermanent
loss is amplified; once price leaves the band you are fully converted into the losing asset and
the loss is no longer "impermanent" at all. Full-range is therefore the **most generous possible
case for the pool** — so we report every range, and the finding has to survive all of them.

| range (±width) | median IL | median realized | knocked out of range | advertised + while real − |
|---|---|---|---|---|
| tight ±1.25x | −1.28% | −0.86% | 25/102 | **62%** |
| moderate ±2x | −0.46% | −0.04% | 0/102 | **50%** |
| wide ±4x | −0.27% | +0.02% | 0/102 | **45%** |
| full-range (v2-equivalent) | −0.13% | +0.06% | 0/102 | **34%** |

Every row is the same 102 live volatile pools over the same 30-day window. Only the assumed
LP range changes. The direction never flips: **the tighter and more realistic your position,
the more the advertised number lies to you.**

> The fee term is held constant across ranges, which is deliberately unfair to us —
> concentrating earns more fees too, so some of that IL is earned back. We did not model the
> fee uplift because we cannot measure per-position fees from pool-level data. The
> **direction** of the defect is what survives; treat the magnitudes as bounded by that caveat.

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

- **RETRACTED: `corr(advertised, realized) = 0.06` was this README's headline and it does not
  reproduce.** It existed in no committed code. Recomputed honestly (`lib/realized.js`
  `pearson`/`spearman`, run by `build-corpus.js`) it lands at **Pearson 0.08–0.16, Spearman
  0.30–0.33 raw; 0.33–0.38 trimmed** across three liveness gates. That is a real spread driven
  by outlier choice and rank-vs-linear, so quoting any single number as *the* correlation was
  the mistake. The correlation is reported as a **range with its estimator named**, and the
  headline is now the pool-count finding, which is measured directly rather than estimated.
  Found 2026-09-07 by grepping our own repo for the number and not finding it.
- **An earlier correlation of +0.42 was also wrong** (lookahead in the liveness gate, dead pools
  included). Two bad correlations in a row is why this metric no longer leads the README.
- **The v2 formula was being applied to a v3 venue.** Until 2026-09-07 every realized return
  here used constant-product IL, which is correct only for full-range positions. That silently
  reported the best case for every pool. Fixed in [`lib/concentrated.js`](lib/concentrated.js);
  the old number is kept as the `full` row above so the change is auditable rather than
  overwritten.
- **Our convergence canary failed us first, and it was right to.** The new v3 math was checked
  by asserting it converges to the v2 formula as range → ∞. Against a hand-picked epsilon it
  "failed" and nearly got correct code deleted. The error actually falls at the analytic rate —
  11.0x, 10.1x, 10.0x per 100x range — so the test now asserts **the rate, not a threshold**.
  A tolerance you tune until it passes is a parameter; a convergence rate is not.
- **"1 in 3 pools mislead you" was retracted as a headline** because it moved 41%→34% with the
  liveness cutoff. It appears above only as a full grid across ranges *and* gates, labeled as
  what it is.
- **"LPs lose to HODL" is not our discovery.** Topaze Blue / Bancor established that in 2021.
  Our contribution is not the loss — it is the *calibration of the advertised metric*.
- **DefiLlama already ships yield predictions** (11,489 pools carry `predictedClass` /
  `predictedProbability`). What nobody publishes is whether those predictions were *right* —
  **so we graded them**, twice, because the first grade was wrong in two different ways.
  Attempt 1: wrongly concluded no retrospective archive exists (it does — Wayback Machine,
  517 snapshots of `/pools` back to Oct 2022, full predictions payload intact). Attempt 2
  (n=69 pools, capped by rate-limiting): reported a clean **+3.2pp edge over baseline**.
  Attempt 3, same method with backoff and no fetch failures (n=459 pools, 8,092 graded
  instances): **the edge flips sign across bands** (strict 0%: −1.4pp: WORSE than guessing;
  mid 5%: +4.5pp; loose 10%: +1.5pp). Overall accuracy is not a finding — it moves with the
  band, and the small sample's clean number was a fluke of which pools survived rate-limiting.
  **What DID survive the 6x larger sample: their stated confidence is genuinely calibrated.**
  bin1 n=1987 edge −0.3pp, bin2 n=2639 edge +3.1pp, bin3 n=3466 edge **+8.3pp** — monotonic,
  wide spread, holds up. The model's raw accuracy is a mirage; its self-reported confidence is
  an honest, usable signal. See `data/llama-grade-backdated.json` and
  `scripts/grade-llama-backdated.py`. Either way: the target variable (fee-only apy) was
  already shown near-orthogonal to actual LP outcome (ceiling test above, corr=−0.008).
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
- **The correlation estimator has its own canary.** `corr(advertised APR, fee return)` must come
  back clearly positive — both are fee-derived, so a weak value means the estimator is broken,
  not that the market is strange. Live: **0.726**. `build-corpus.js` exits non-zero and refuses
  to write if it drops below 0.3.
- **Concentrated IL is checked against the v2 closed form at four range widths**, asserting the
  convergence *rate* rather than a tuned tolerance.

## Run it

```bash
npm install
node test/canary.test.js                  # offline math + negative control
GRAPH_API_KEY=... node test/canary.test.js --live
GRAPH_API_KEY=... node scripts/build-corpus.js   # single-window corpus
GRAPH_API_KEY=... node scripts/walk-forward.js   # 13 overlapping windows, mainnet
GRAPH_API_KEY=... node scripts/history-run.js    # 110 independent months, 4 chains
```

The `realized_return` tool takes an optional **`rangeWidthX`** — your actual concentrated
position (1.25 = a tight ±25% band, 2 = typical, 4 = wide, omit for full-range). It answers the
question no yield dashboard answers: *given the range I was actually in, what did I actually
make?* — including whether price left your band, in which case the loss is realized, not
impermanent.

Live example (USDC/WETH, 30d, price ratio 1.3091):

```
full-range realized:  -0.58%
  tight  ±1.25x       -7.95%   OUT OF RANGE
  moderate ±2x        -2.75%
  wide   ±4x          -1.48%
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
