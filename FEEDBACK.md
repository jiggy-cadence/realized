# FEEDBACK.md — Uniswap developer feedback from building REALIZED

**Project:** [REALIZED](https://realized.drainfun.xyz) · [jiggy-cadence/realized](https://github.com/jiggy-cadence/realized)
**Event:** ETHOnline 2026
**What we integrated:** Uniswap v3 subgraphs (4 chains, position-state reads) and the Uniswap v4
mainnet subgraph (position reconstruction from `ModifyLiquidity` events).

This is written from things that actually cost us time during the build, with the file and line
that each one produced. Nothing here is a feature wish we didn't hit ourselves.

---

## 1. The v4 `Position` entity carries no tick range, and that is the whole product

This was the single biggest surprise of the build, and it changed what we could offer per venue.

In **v3**, a position's range is state on the NFT. We query it directly
([`packages/core/src/wallet.js`](packages/core/src/wallet.js), `POSITION_FIELDS`):

```
tickLower { tickIdx }
tickUpper { tickIdx }
depositedToken0 / withdrawnToken0 / collectedFeesToken0 / feeGrowthInside0LastX128 ...
```

So "what range is this LP actually in, and what did they realize?" is one query.

In **v4**, the `Position` entity exposes only
`id / tokenId / owner / origin / createdAtTimestamp / subscriptions / unsubscriptions / transfers`.
There is **no `tickLower`, no `tickUpper`, no `pool`, no `liquidity`**. The range exists only in the
`ModifyLiquidity` event log.

We had to reconstruct it ([`packages/core/src/v4.js`](packages/core/src/v4.js)): group a wallet's
events by `(pool, tickLower, tickUpper)` and sum the **signed** `amount`, where a net-positive key is
an open position.

**Why this matters beyond our project:** reconstruction is a strictly weaker evidence class than a
state read, and the difference is user-visible. We ship v3 with `realizedReturn: true,
exitSimulation: true` and v4 with **both false** — on purpose — because we will not price an exit off
reconstructed liquidity ([`packages/core/src/venues.js`](packages/core/src/venues.js), `CAPABILITIES`).
An entire class of portfolio/PnL tooling either degrades on v4 or, worse, doesn't notice and reports
confident wrong numbers.

**Concrete ask:** expose `tickLower` / `tickUpper` / `pool` / current `liquidity` on the v4 `Position`
entity, or publish an official derived entity that does. It would collapse ~300 lines of
reconstruction and three classes of edge case (below) into one query, and would let integrators offer
the same answers on v4 that they offer on v3.

---

## 2. `sender` is the position manager contract, not the human — and the failure is silent

Querying `ModifyLiquidity` by `sender` for a wallet that **definitely has positions** returned
**zero rows**. Not an error — an empty, plausible-looking result. Switching to `origin` (the EOA)
returned that wallet's events.

This is the worst shape a mistake can have: it looks like "this user has no positions" rather than
"you used the wrong field." A brand-new integrator can ship that and never know.

**Concrete ask:** call this out explicitly in the v4 subgraph schema docs/field descriptions —
`sender` = position manager contract, `origin` = EOA, use `origin` for wallet lookups. One sentence
in the schema description would have saved us an hour of doubting our address handling.

(Documented at [`packages/core/src/v4.js`](packages/core/src/v4.js) lines 15–16.)

---

## 3. ~48% of v4 `ModifyLiquidity` events are `amount: 0`

Fee-collection / no-op modifies come through as events at **real-looking tick ranges** with
`amount: 0`. In our first sample, 4 of the first 5 events were `amount: 0`.

Counting them **invents positions the wallet does not hold**. We skip them and report
`zeroAmountEvents` in the response so the number is auditable rather than hidden — it's also the stat
that explains why an address with thousands of events holds few positions.

**Concrete ask:** either a documented event subtype/flag distinguishing liquidity modification from
fee collection, or a note in the docs that `amount: 0` events must be filtered for position
reconstruction. This is a trap every v4 position integrator will hit independently.

---

## 4. Net-negative liquidity keys are legitimate, and there's no way to tell why

Some `(pool, tickLower, tickUpper)` keys sum **negative**: removes with no matching adds. Measured on
`0x996d…ad77`, 3 of 294 keys, each `adds=0 / removes=1`, all in one pool.

That is not an arithmetic bug — it's a position **transferred in**, or opened via a manager that
recorded a different `origin`. The removal is real; this wallet's history just doesn't contain the
position's whole life.

We can detect the situation but **cannot resolve it** from the subgraph, so we classify these as
`incompleteHistory` and deliberately withhold their size rather than invent liquidity or silently
drop a real on-chain event.

**Concrete ask:** linking transfers to the underlying liquidity history (or exposing the position's
full lifecycle across owners) would let integrators report these honestly instead of excluding them.

---

## 5. What worked well, specifically

- **v3 subgraph schema is excellent for exactly this use case.** `feeGrowthInside*X128` alongside
  `collectedFees*` let us distinguish *accrued* from *collected* fees — that distinction is load-
  bearing for us: of 150 positions reading zero collected fees, **71 had real accrued fees**. Without
  both fields we would have reported `$0` and been wrong 47% of the time.
- **Schema consistency across chains is genuinely good.** The same v3 query shape runs unmodified
  against mainnet, Arbitrum, Polygon and Base — our venue map is just four subgraph IDs
  ([`packages/core/src/venues.js`](packages/core/src/venues.js)), not four code paths. One
  implementation of the math serves all four.
- **`poolDayData` made the core product possible.** Realized return = fees + impermanent loss needs
  per-day historical pool state for both tokens. We verified the alternative: `feeGrowthGlobal0X128`
  is readable at any historical block from an archive node, but the join (block lookup per day
  boundary + historical price for both tokens, per pool, × 256 pools × 5 chains) is thousands of
  archive calls per rebuild. The subgraph publishes that join already computed.
- **`ModifyLiquidity` cursor pagination on `id_gt` has no skip ceiling**, so complete event history
  is retrievable for busy wallets — our busiest sample needed 6 pages (5,205 events) in ~4s.

---

## 6. One documentation note

The v4 subgraph is a different *evidence model* from v3, not just a different version number, and we
didn't discover that until we had already designed around v3 semantics. A short "migrating position
tooling from v3 to v4" page — Position entity differences, `origin` vs `sender`, `amount: 0` events —
would have saved us most of a build day, and would likely prevent a wave of v4 portfolio tools that
report reconstructed numbers as if they were state reads.

---

## Where to verify our integration

| what | where |
|---|---|
| v3 position-state reads | [`packages/core/src/wallet.js`](packages/core/src/wallet.js) |
| v4 event reconstruction + self-audit | [`packages/core/src/v4.js`](packages/core/src/v4.js) |
| Subgraph IDs + per-venue capability map | [`packages/core/src/venues.js`](packages/core/src/venues.js) |
| API routes (`/api/wallet`, `/api/position`, `/api/simulate-exit`) | [`bin/api.js`](bin/api.js) |
| MCP server (7 agent tools) | [`bin/mcp-server.js`](bin/mcp-server.js) |

Live, no API key required:

```bash
curl "https://realized.drainfun.xyz/api/venues"
curl "https://realized.drainfun.xyz/api/position/0x88e6a0c2ddd26feeb64f039a2c41296fcb3f5640?entry=2026-07-28&range=2"
```
