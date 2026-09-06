/**
 * canary.test.js — prove the instrument can tell a win from a loss.
 *
 * Origin: our own trading stack scored an LP call +1.7% WIN when the real result was
 * about -14%, because resolution was fee income with no price term. Fee APR is always
 * positive, so the lane arithmetically could not lose. This test is the negative control
 * that failure never had.
 *
 * Run offline (pure math): node test/canary.test.js
 * Run with live data too:  GRAPH_API_KEY=xxx node test/canary.test.js --live
 */
import { impermanentLossPct, scorePool, summarize, gatewayUrl, fetchTopPools, priceCollapsed, isLive } from '../lib/realized.js';

let failed = 0;
const check = (name, got, want, tol = 0.01) => {
  const ok = (got === null || want === null)
    ? got === want
    : Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  (got ${got}, want ${want})`}`);
};

console.log('--- impermanent loss: known constant-product values ---');
check('IL at r=1 (no divergence) is exactly 0', impermanentLossPct(1), 0, 1e-9);
check('IL at r=2 (price doubled) ~ -5.72%', impermanentLossPct(2), -5.719);
check('IL at r=0.5 (price halved) ~ -5.72%', impermanentLossPct(0.5), -5.719);
check('IL at r=4 ~ -20.0%', impermanentLossPct(4), -20.0, 0.05);
check('IL at r=0.3 (down 70%) ~ -15.75%', impermanentLossPct(0.3), -15.75, 0.05);
check('IL of a dead token (r=0) is -100', impermanentLossPct(0), -100, 0);
check('IL is never positive', impermanentLossPct(1.0001) <= 0 ? 0 : 1, 0, 0);

console.log('\n--- NEGATIVE CONTROL: the real call that was scored a win ---');
// call_lp_1785388443061: 1233% advertised APR, held 12.13h, token was -70% over the hold.
{
  const feePnl = (1232.695836788408 / 365) * (12.13 / 24); // the +1.7% it was credited
  const il = impermanentLossPct(0.3);
  const net = feePnl + il;
  console.log(`  fees +${feePnl.toFixed(2)}%  IL ${il.toFixed(2)}%  net ${net.toFixed(2)}%`);
  check('re-scores as a LOSS', net < 0 ? 0 : 1, 0, 0);
  check('  ...and by a wide margin, not a rounding call', net < -10 ? 0 : 1, 0, 0);
}

console.log('\n--- unmeasurable must stay distinguishable from zero ---');
check('missing price -> measurable:false, not 0',
  scorePool({ id: '0x1', feeTier: '3000', token0: { symbol: 'A' }, token1: { symbol: 'B' },
    poolDayData: Array.from({ length: 30 }, () => ({ date: 1, volumeUSD: '1', feesUSD: '1', tvlUSD: '1000000', token0Price: '0' })) }).measurable ? 1 : 0, 0, 0);
check('short window -> measurable:false',
  scorePool({ id: '0x2', feeTier: '3000', token0: { symbol: 'A' }, token1: { symbol: 'B' },
    poolDayData: [{ date: 1, feesUSD: '1', tvlUSD: '1000000', token0Price: '1', volumeUSD: '1' }] }).measurable ? 1 : 0, 0, 0);

console.log('\n--- collapse detector: dead tokens must not pass the liveness gate ---');
// Shape modeled on UST/WETH: real activity/volume/TVL for months, price -> ~0.
// This is the exact pool that survived every activity-only gate on 2026-09-06.
{
  const collapsedPool = {
    id: '0xdead', feeTier: '3000', token0: { symbol: 'UST' }, token1: { symbol: 'WETH' },
    poolDayData: [
      // most-recent-first (desc), price near zero now
      ...Array.from({ length: 20 }, (_, i) => ({ date: i, feesUSD: '500', volumeUSD: '80000', tvlUSD: '2000000', token0Price: '0.0002' })),
      // older days at a normal ~$1 peg
      ...Array.from({ length: 20 }, (_, i) => ({ date: 20 + i, feesUSD: '500', volumeUSD: '80000', tvlUSD: '2000000', token0Price: '1.0' })),
    ],
  };
  check('priceCollapsed detects a >99% peak-to-current drop', priceCollapsed(collapsedPool) ? 0 : 1, 0, 0);
  const scored = scorePool(collapsedPool);
  check('collapsed pool is excluded by isLive() despite passing activity/volume/TVL',
    isLive(scored) ? 1 : 0, 0, 0);

  const ordinaryPool = {
    id: '0xalive', feeTier: '3000', token0: { symbol: 'LINK' }, token1: { symbol: 'WETH' },
    poolDayData: Array.from({ length: 30 }, (_, i) => ({ date: i, feesUSD: '500', volumeUSD: '80000', tvlUSD: '2000000', token0Price: String(1 + i * 0.002) })),
  };
  check('ordinary volatility (not a collapse) is NOT flagged', priceCollapsed(ordinaryPool) ? 1 : 0, 0, 0);
}

console.log('\n--- summarize() refuses to certify without a stable-pair canary ---');
{
  const noStables = summarize([{ measurable: true, stablePair: false, impermanentLossPct: -3, misleading: true,
    advertisedAprPct: 5, realizedAprPct: -2, gapPts: 7, currentTvlUsd: 1e6,
    liveness: { activeDays: 30, recent7dVolumeUsd: 1e6 } }]);
  check('canary.passed is false when no stable pair is present', noStables.canary.passed ? 1 : 0, 0, 0);
}

if (process.argv.includes('--live')) {
  console.log('\n--- LIVE: real pools from The Graph ---');
  const url = gatewayUrl(process.env.GRAPH_API_KEY);
  const pools = await fetchTopPools(url, { first: 120, days: 30 });
  const scored = pools.map(scorePool);
  const s = summarize(scored);
  console.log(`  fetched=${s.counts.fetched} measurable=${s.counts.measurable} liveVolatile=${s.counts.liveVolatile}`);
  console.log(`  canary: ${s.canary.stablePairsFound} stable pairs, worst |IL| = ${s.canary.worstAbsIlPct?.toFixed(4)}% -> ${s.canary.passed ? 'PASS' : 'FAIL'}`);
  console.log(`  misleading: ${s.misleadingCount}/${s.counts.liveVolatile} (${s.misleadingPct?.toFixed(0)}%)`);
  check('live canary passes', s.canary.passed ? 0 : 1, 0, 0);
  check('live sample produced measurable pools', s.counts.liveVolatile > 10 ? 0 : 1, 0, 0);
}

console.log(`\n${failed ? `${failed} FAILED` : 'ALL PASS'}`);
process.exit(failed ? 1 : 0);
