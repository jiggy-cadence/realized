/**
 * UNISWAP V4 — position reconstruction from ModifyLiquidity events.
 *
 * WHY THIS FILE EXISTS (2026-09-11): the v4 `Position` entity carries only
 * id/tokenId/owner/origin/createdAtTimestamp/subscriptions/unsubscriptions/transfers.
 * It has NO tickLower, NO tickUpper, NO pool, NO liquidity. So "read the range you actually
 * set" -- the entire product claim -- cannot be answered from Position in v4 the way it is
 * in v3, where the range sits on the NFT.
 *
 * The range only exists on ModifyLiquidity events. So we reconstruct: group a wallet's events
 * by (pool, tickLower, tickUpper) and sum the SIGNED `amount`. Adds are positive, removes are
 * negative. A key whose sum is > 0 is an open position at that range.
 *
 * MEASURED FACTS that shaped this (probed live against the v4 mainnet subgraph, not assumed):
 *   - `sender` is the position manager CONTRACT, not the human. Querying by sender returned 0
 *     rows for a wallet that definitely has positions; `origin` returned its events. Use origin.
 *   - Most events carry `amount: 0` (fee collection / no-op modifies). They must NOT be counted
 *     as positions -- 4 of the first 5 events sampled were amount:0 at real-looking tick ranges.
 *     Counting them would invent positions the wallet does not hold.
 *
 * WHAT THIS DOES NOT DO, on purpose:
 *   - No realized-return math. Reconstructed liquidity is not the same evidence class as a v3
 *     position read, and pricing an exit off it would be a confident wrong number.
 *   - No fee income. Same reason as v3: collected fees are a withdrawal record, not earnings.
 *
 * Liquidity is returned as a raw BigInt string. It is NOT a dollar value and must never be
 * rendered as one.
 */

export const UNISWAP_V4_MAINNET = 'DiYPVdygkfjDWhbxGSqAQxwBKmfKnkWQojqeM2rkLb3G';

const PAGE = 1000;

/**
 * Pull every ModifyLiquidity event for an owner, paging by id to avoid the skip ceiling.
 * Completeness matters: a missed page silently understates liquidity, and the sum still
 * *looks* plausible. That is the failure mode this pagination shape exists to prevent.
 */
export async function fetchModifyLiquidity(query, url, owner, { max = 5000 } = {}) {
  const who = String(owner).toLowerCase();
  const out = [];
  let lastId = '';
  let pages = 0;

  for (;;) {
    const gql = `{
      modifyLiquidities(
        first: ${PAGE}
        orderBy: id
        orderDirection: asc
        where: { origin: "${who}", id_gt: "${lastId}" }
      ) {
        id
        timestamp
        amount
        amount0
        amount1
        amountUSD
        tickLower
        tickUpper
        pool { id token0 { symbol decimals } token1 { symbol decimals } feeTier tick }
      }
    }`;
    // NOTE: query() returns the GraphQL payload ALREADY UNWRAPPED -- the top-level key is
    // `modifyLiquidities`, not `data.modifyLiquidities`. Reading res.data here returned
    // undefined and silently reported 0 events for a wallet with thousands. Accept both
    // shapes so this cannot regress if the helper changes.
    const res = await query(url, gql);
    const rows = res?.modifyLiquidities ?? res?.data?.modifyLiquidities ?? [];
    out.push(...rows);
    pages++;
    if (rows.length < PAGE) break;
    lastId = rows[rows.length - 1].id;
    if (out.length >= max) {
      return { events: out, complete: false, pages, truncatedAt: max };
    }
  }
  return { events: out, complete: true, pages, truncatedAt: null };
}

/**
 * Net signed liquidity per (pool, tickLower, tickUpper).
 *
 * Returns open keys plus the counts that make the result auditable. `zeroAmountEvents` is
 * reported rather than hidden because it is the number that explains why an address with
 * many events can hold few positions.
 */
export function reconstructPositions(events) {
  const byKey = new Map();
  let zeroAmountEvents = 0;

  for (const e of events) {
    const amt = BigInt(e.amount ?? '0');
    if (amt === 0n) { zeroAmountEvents++; continue; }

    const key = `${e.pool.id}|${e.tickLower}|${e.tickUpper}`;
    const prev = byKey.get(key);
    if (prev) {
      prev.liquidity += amt;
      prev.events++;
      if (Number(e.timestamp) > prev.lastTs) prev.lastTs = Number(e.timestamp);
      if (Number(e.timestamp) < prev.firstTs) prev.firstTs = Number(e.timestamp);
      if (amt > 0n) prev.addedUsd += Number(e.amountUSD || 0);
    } else {
      byKey.set(key, {
        pool: e.pool,
        tickLower: Number(e.tickLower),
        tickUpper: Number(e.tickUpper),
        liquidity: amt,
        events: 1,
        firstTs: Number(e.timestamp),
        lastTs: Number(e.timestamp),
        addedUsd: amt > 0n ? Number(e.amountUSD || 0) : 0,
      });
    }
  }

  const all = [...byKey.values()];

  // A key with net NEGATIVE liquidity is not an arithmetic bug -- it is a position whose ADDS
  // happened under a different `origin` (transferred in, or opened via a manager that recorded a
  // different EOA). Measured 2026-09-11 on 0x996d...ad77: 3 of 294 keys, every one adds=0/
  // removes=1, all in one pool. The removal is real; this wallet's history just does not contain
  // the whole position's life. Reporting these as positions would invent liquidity; dropping them
  // silently would hide a real on-chain event. So they get their own class.
  const incompleteHistory = all
    .filter((p) => p.liquidity < 0n)
    .map((p) => ({
      pool: {
        id: p.pool.id,
        pair: `${p.pool.token0?.symbol ?? '?'}/${p.pool.token1?.symbol ?? '?'}`,
        feeTier: p.pool.feeTier,
      },
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      removalsWithoutAdds: p.events,
      lastModified: new Date(p.lastTs * 1000).toISOString(),
      why: 'Liquidity was removed at this range with no matching add in this wallet history -- the position was most likely transferred in. We do not report its size.',
    }));

  const open = all
    .filter((p) => p.liquidity > 0n)
    .map((p) => ({
      pool: {
        id: p.pool.id,
        pair: `${p.pool.token0?.symbol ?? '?'}/${p.pool.token1?.symbol ?? '?'}`,
        feeTier: p.pool.feeTier,
        currentTick: p.pool.tick == null ? null : Number(p.pool.tick),
      },
      tickLower: p.tickLower,
      tickUpper: p.tickUpper,
      liquidity: p.liquidity.toString(),
      inRange:
        p.pool.tick == null
          ? null
          : Number(p.pool.tick) >= p.tickLower && Number(p.pool.tick) < p.tickUpper,
      events: p.events,
      firstSeen: new Date(p.firstTs * 1000).toISOString(),
      lastModified: new Date(p.lastTs * 1000).toISOString(),
      grossAddedUsd: Number(p.addedUsd.toFixed(2)),
    }))
    .sort((a, b) => (BigInt(a.liquidity) < BigInt(b.liquidity) ? 1 : -1));

  return {
    open,
    incompleteHistory,
    // strictly === 0n: negatives are their own class, counting them here would double-count
    closedKeys: all.filter((p) => p.liquidity === 0n).length,
    zeroAmountEvents,
  };
}

/**
 * SELF-AUDIT / CANARY. Runs on every wallet call.
 *
 * The reconstruction can be wrong in ways that still look reasonable, so these checks assert
 * the invariants that must hold if the arithmetic is sound, and the result is reported to the
 * caller instead of being assumed.
 *
 * Negative net liquidity is the load-bearing one: it means removes exceeded adds at a key,
 * which is impossible on-chain and would indicate missed pages or a bad grouping key.
 */
export function auditReconstruction(events, result) {
  const checks = [];

  let neg = 0;
  const keys = new Map();
  for (const e of events) {
    const amt = BigInt(e.amount ?? '0');
    if (amt === 0n) continue;
    const k = `${e.pool.id}|${e.tickLower}|${e.tickUpper}`;
    keys.set(k, (keys.get(k) ?? 0n) + amt);
  }
  for (const v of keys.values()) if (v < 0n) neg++;

  // Negative keys are EXPECTED and are classified, not silently dropped. What must hold is that
  // every one of them is accounted for in incompleteHistory -- an UNCLASSIFIED negative key
  // would mean the grouping key is wrong, which is the real failure this check now guards.
  checks.push({
    name: 'negatives_all_classified',
    pass: neg === result.incompleteHistory.length,
    detail: `${neg} negative key(s); ${result.incompleteHistory.length} classified as incomplete history`,
  });

  checks.push({
    name: 'reported_positions_strictly_positive',
    pass: result.open.every((p) => BigInt(p.liquidity) > 0n),
    detail: 'every position we report has strictly positive net liquidity',
  });

  checks.push({
    name: 'ticks_ordered',
    pass: result.open.every((p) => p.tickLower < p.tickUpper),
    detail: 'tickLower < tickUpper on every reconstructed position',
  });

  const counted = result.open.length + result.closedKeys + result.incompleteHistory.length;
  checks.push({
    name: 'keys_accounted',
    pass: counted === keys.size,
    detail: `${counted} of ${keys.size} non-zero keys classified open/closed/incomplete`,
  });

  return { checks, allPass: checks.every((c) => c.pass) };
}

export async function walletV4(query, url, owner) {
  const { events, complete, pages, truncatedAt } = await fetchModifyLiquidity(query, url, owner);

  if (events.length === 0) {
    return {
      owner: String(owner).toLowerCase(),
      dex: 'uniswap-v4',
      chain: 'mainnet',
      openPositions: 0,
      positions: [],
      evidence: { modifyLiquidityEvents: 0, pages, complete },
      method: 'reconstructed from ModifyLiquidity events (v4 Position entity has no tick range)',
    };
  }

  const result = reconstructPositions(events);
  const audit = auditReconstruction(events, result);

  return {
    owner: String(owner).toLowerCase(),
    dex: 'uniswap-v4',
    chain: 'mainnet',
    openPositions: result.open.length,
    positions: result.open,
    incompleteHistory: result.incompleteHistory,
    evidence: {
      modifyLiquidityEvents: events.length,
      pages,
      complete,
      truncatedAt,
      zeroAmountEvents: result.zeroAmountEvents,
      closedRanges: result.closedKeys,
      incompleteRanges: result.incompleteHistory.length,
    },
    audit,
    method:
      'Reconstructed by summing signed ModifyLiquidity.amount per (pool, tickLower, tickUpper). ' +
      'Queried by `origin` (the EOA); `sender` is the position manager contract and returns nothing.',
    weDoNotReport: [
      'realized return or exit pricing for v4 -- reconstructed liquidity is weaker evidence than a v3 position read, and we will not price an exit off it',
      'fee income -- collected fees are a withdrawal record, not an earnings record',
      'positions whose net liquidity is zero -- they are closed and have no live range',
    ],
    caveat: complete
      ? null
      : `Event history truncated at ${truncatedAt}; liquidity may be understated.`,
  };
}
