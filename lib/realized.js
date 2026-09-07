/**
 * realized.js — the instrument.
 *
 * Advertised LP APR is fees-only and annualized. It has no price term, so it is
 * POSITIVE BY CONSTRUCTION: a pool cannot advertise a loss. That is the defect.
 *
 * Realized return = fee income + impermanent loss (IL is <= 0 always).
 * Both terms come from The Graph's historical poolDayData — per-day feesUSD and
 * token0Price at each day's close. There is no RPC path to this: lifetime/daily
 * fee aggregates in USD are DERIVED by the indexer and exist nowhere on-chain.
 */

import { concentratedIlPct, outOfRange, RANGES } from './concentrated.js';

const UNISWAP_V3_MAINNET = '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV';

export { RANGES };

export const STABLES = new Set([
  'USDC', 'USDT', 'DAI', 'FRAX', 'LUSD', 'TUSD', 'USDS', 'USDE',
  'GUSD', 'BUSD', 'PYUSD', 'USDP', 'crvUSD',
]);

/** Default liveness gate. Exported so callers can move it and re-check the finding. */
export const DEFAULT_LIVENESS = { minActiveDays: 25, minRecent7dVolumeUsd: 50_000, minTvlUsd: 250_000 };

export function gatewayUrl(apiKey, subgraphId = UNISWAP_V3_MAINNET) {
  if (!apiKey) throw new Error('GRAPH_API_KEY is required (Subgraph Studio gateway key)');
  return `https://gateway.thegraph.com/api/${apiKey}/subgraphs/id/${subgraphId}`;
}

export async function query(url, graphql, { timeoutMs = 60_000 } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: graphql }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Graph gateway HTTP ${res.status}`);
    const json = await res.json();
    if (json.errors) throw new Error(`Subgraph error: ${JSON.stringify(json.errors).slice(0, 300)}`);
    return json.data;
  } finally {
    clearTimeout(t);
  }
}

/**
 * Constant-product impermanent loss for a price ratio r = price_exit / price_entry.
 * IL(1) = 0, IL(2) = IL(0.5) ≈ -5.72%, IL(0) = -100%. Never positive.
 */
export function impermanentLossPct(r) {
  if (r === null || r === undefined || Number.isNaN(r)) return null;
  if (r < 0) return null;
  if (r === 0) return -100;
  return (2 * Math.sqrt(r) / (1 + r) - 1) * 100;
}

const POOL_FIELDS = `
  id feeTier totalValueLockedUSD
  token0 { symbol } token1 { symbol }
  poolDayData(first: $DAYS, orderBy: date, orderDirection: desc) {
    date volumeUSD feesUSD tvlUSD token0Price
  }
`;

export async function fetchPool(url, poolId, days = 30) {
  const data = await query(url, `{ pool(id: "${poolId.toLowerCase()}") {
    ${POOL_FIELDS.replace('$DAYS', String(days))}
  } }`);
  return data?.pool ?? null;
}

export async function fetchTopPools(url, { first = 250, minTvlUsd = 250_000, days = 30 } = {}) {
  const data = await query(url, `{ pools(first: ${first}, orderBy: volumeUSD, orderDirection: desc,
      where: { totalValueLockedUSD_gt: "${minTvlUsd}" }) {
    ${POOL_FIELDS.replace('$DAYS', String(days))}
  } }`);
  return data?.pools ?? [];
}

/**
 * Score one pool. Returns null when the window is not measurable — never a
 * fabricated zero. "Unpriceable" must stay distinguishable from "no loss".
 */
export function scorePool(pool) {
  const days = pool?.poolDayData ?? [];
  if (days.length < 25) return { pool: pool?.id, measurable: false, reason: 'window shorter than 25 days' };

  const entry = days[days.length - 1];
  const exit = days[0];
  const entryTvl = Number(entry.tvlUSD || 0);
  const nowTvl = Number(exit.tvlUSD || 0);
  const pEntry = Number(entry.token0Price || 0);
  const pExit = Number(exit.token0Price || 0);

  if (entryTvl <= 0 || nowTvl <= 0) return { pool: pool.id, measurable: false, reason: 'zero TVL at a window edge' };
  if (pEntry <= 0 || pExit <= 0) return { pool: pool.id, measurable: false, reason: 'missing price at a window edge' };

  const ratio = pExit / pEntry;
  if (!(ratio > 0.01 && ratio < 100)) {
    return { pool: pool.id, measurable: false, reason: `price ratio ${ratio.toExponential(2)} outside sane band` };
  }

  const n = days.length;
  const totalFeesUsd = days.reduce((s, d) => s + Number(d.feesUSD || 0), 0);
  const feeReturnPct = (totalFeesUsd / entryTvl) * 100;
  const ilPct = impermanentLossPct(ratio);
  const realizedPct = feeReturnPct + ilPct;

  // What a DEX UI shows: most recent day's fees, annualized on current TVL.
  const advertisedApr = (Number(exit.feesUSD || 0) / nowTvl) * 365 * 100;
  const realizedApr = (realizedPct / n) * 365;

  const activeDays = days.filter((d) => Number(d.feesUSD || 0) > 0).length;
  const recent7dVolumeUsd = days.slice(0, 7).reduce((s, d) => s + Number(d.volumeUSD || 0), 0);

  const sym0 = pool.token0?.symbol ?? '?';
  const sym1 = pool.token1?.symbol ?? '?';

  return {
    pool: pool.id,
    pair: `${sym0}/${sym1}`,
    feeTierPct: Number(pool.feeTier) / 10_000,
    measurable: true,
    windowDays: n,
    entryTvlUsd: entryTvl,
    currentTvlUsd: nowTvl,
    priceRatio: ratio,
    totalFeesUsd,
    feeReturnPct,
    impermanentLossPct: ilPct,
    realizedReturnPct: realizedPct,
    advertisedAprPct: advertisedApr,
    realizedAprPct: realizedApr,
    gapPts: advertisedApr - realizedApr,
    misleading: advertisedApr > 0 && realizedApr < 0,
    stablePair: STABLES.has(sym0) && STABLES.has(sym1),
    liveness: { activeDays, recent7dVolumeUsd },
    collapsed: priceCollapsed(pool),
    byRange: byRange(ratio, feeReturnPct, n, advertisedApr),
  };
}

/**
 * The same pool scored at several concentration ranges. The v2 formula (full-range) is the
 * MOST GENEROUS case for the pool; real v3 LPs concentrate and eat amplified IL. Reporting
 * one range would be picking a parameter, so we report all of them — same discipline as the
 * liveness gates.
 */
export function byRange(ratio, feeReturnPct, windowDays, advertisedApr) {
  const out = {};
  for (const { label, w } of RANGES) {
    const il = concentratedIlPct(ratio, w);
    if (il === null) { out[label] = { measurable: false }; continue; }
    const realizedPct = feeReturnPct + il;
    const realizedApr = (realizedPct / windowDays) * 365;
    out[label] = {
      measurable: true,
      rangeWidthX: w,
      impermanentLossPct: il,
      realizedReturnPct: realizedPct,
      realizedAprPct: realizedApr,
      outOfRange: outOfRange(ratio, w),
      misleading: advertisedApr > 0 && realizedApr < 0,
    };
  }
  return out;
}

/** Pearson correlation. Returns null on a degenerate input rather than NaN. */
export function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3 || ys.length !== n) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < n; i++) { const a = xs[i] - mx, b = ys[i] - my; sxy += a * b; sxx += a * a; syy += b * b; }
  if (sxx === 0 || syy === 0) return null;
  return sxy / Math.sqrt(sxx * syy);
}

const ranks = (v) => {
  const idx = v.map((x, i) => [x, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(v.length);
  idx.forEach(([, i], k) => { r[i] = k + 1; });
  return r;
};

/** Spearman = Pearson on ranks. Robust to the fat tail that Pearson chases. */
export function spearman(xs, ys) {
  if (xs.length < 3 || ys.length !== xs.length) return null;
  return pearson(ranks(xs), ranks(ys));
}

/**
 * Price-collapse check. Activity/volume/TVL gates alone let a DEAD TOKEN through:
 * a pool can show 7 active days and real volume for months while the underlying
 * token bleeds to near-zero (UST/WETH survives the activity gate at every
 * cutoff tested 2026-09-06 — this function is the fix). If price fell >99%
 * peak-to-current within the observed window, treat the pool as a collapse,
 * not ordinary volatility: IL alone already prices ordinary moves correctly,
 * this only catches the case a token effectively went to zero.
 */
export function priceCollapsed(pool) {
  const days = pool?.poolDayData ?? [];
  const prices = days.map((d) => Number(d.token0Price || 0)).filter((p) => p > 0);
  if (prices.length < 5) return false;
  const peak = Math.max(...prices);
  const current = prices[0]; // index 0 = most recent (desc order)
  if (peak <= 0) return false;
  // Threshold checked against real depegs, not a guess: UST/USDC on this subgraph
  // bottomed at ~2-6% of peak (2026-09-06 spot check, 5 real pools), never <1%.
  // A <1% cutoff would MISS every one of them. 5% catches all 3 observed depegs
  // in the sample without flagging LINK/WETH-style ordinary volatility (worst
  // ordinary swing seen was ~identical price start/end, ratio ~1).
  return current / peak < 0.05;
}

export function isLive(scored, gate = DEFAULT_LIVENESS) {
  if (!scored?.measurable) return false;
  if (scored.collapsed) return false;
  return scored.liveness.activeDays >= gate.minActiveDays
    && scored.liveness.recent7dVolumeUsd > gate.minRecent7dVolumeUsd
    && scored.currentTvlUsd > gate.minTvlUsd;
}

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Aggregate + SELF-CANARY. Stable/stable pairs must show ~0 IL; if they do not,
 * the instrument is broken and every number here is untrusted. A zero is only
 * evidence if the thing producing it proved it can find a known-present item.
 */
export function summarize(scoredList, gate = DEFAULT_LIVENESS) {
  const measurable = scoredList.filter((s) => s.measurable);
  const stables = measurable.filter((s) => s.stablePair);
  const worstStableIl = stables.length ? Math.max(...stables.map((s) => Math.abs(s.impermanentLossPct))) : null;
  const canary = {
    stablePairsFound: stables.length,
    worstAbsIlPct: worstStableIl,
    passed: worstStableIl !== null && worstStableIl < 1.0,
    note: stables.length
      ? 'stable/stable pairs must show ~0 impermanent loss'
      : 'NO stable/stable pair in sample — canary UNPROVEN, treat results as untrusted',
  };

  const live = measurable.filter((s) => !s.stablePair && isLive(s, gate));
  const misleading = live.filter((s) => s.misleading);

  return {
    canary,
    counts: { fetched: scoredList.length, measurable: measurable.length, liveVolatile: live.length },
    medianAdvertisedAprPct: median(live.map((s) => s.advertisedAprPct)),
    medianRealizedAprPct: median(live.map((s) => s.realizedAprPct)),
    medianGapPts: median(live.map((s) => s.gapPts)),
    misleadingCount: misleading.length,
    misleadingPct: live.length ? (misleading.length / live.length) * 100 : null,
    worstOffenders: [...live].sort((a, b) => b.gapPts - a.gapPts).slice(0, 10),
  };
}

/** Report the headline at several gates. A finding that flips with the knob is a parameter. */
export function sensitivity(scoredList, gates) {
  return gates.map(({ label, gate }) => {
    const s = summarize(scoredList, gate);
    return {
      label,
      n: s.counts.liveVolatile,
      misleadingPct: s.misleadingPct,
      medianGapPts: s.medianGapPts,
    };
  });
}
