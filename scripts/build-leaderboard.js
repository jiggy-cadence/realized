#!/usr/bin/env node
/**
 * build-leaderboard.js — turn the autopsy into a decision tool.
 *
 * Everything else in this repo answers "did this pool lie?" after the fact.
 * This answers the question an LP actually has BEFORE putting money in:
 * "which pools' advertised APR can I currently trust?"
 *
 * Method: score every live pool at every concentration range (same instrument
 * as everywhere else in this repo, same canary discipline), then rank by the
 * GAP between advertised and realized APR -- smallest gap = most honest,
 * largest = most misleading. This is NOT a new measurement; it is the
 * existing scorePool()/byRange() output re-sorted into something you'd
 * actually look at before choosing a pool, instead of a corpus JSON file.
 *
 * Two lists, because "honest" and "misleading" are not mirror images of one
 * finding -- they are two different, both-useful answers:
 *   MOST HONEST   -- smallest |advertised - realized| gap. Low regret either way.
 *   MOST MISLEADING -- largest positive gap AND realized < 0. Avoid these.
 * A pool with a tiny gap because it's simply dead (no fees, no IL) is NOT
 * "honest" in the useful sense -- excluded via the same liveness gate as the
 * corpus-wide headline, so this can't be gamed by inactivity.
 *
 * Run: GRAPH_API_KEY=*** node scripts/build-leaderboard.js
 */
import { writeFileSync } from 'fs';
import { gatewayUrl, fetchTopPools, scorePool, isLive, DEFAULT_LIVENESS } from '../lib/realized.js';

const KEY = process.env.GRAPH_API_KEY;
if (!KEY) { console.error('GRAPH_API_KEY is required'); process.exit(1); }
const url = gatewayUrl(KEY);

async function main() {
  console.log('fetching live pool sample...');
  const pools = await fetchTopPools(url, { first: 100, minTvlUsd: 250_000 });
  const scored = pools.map((p) => scorePool(p)).filter((s) => s.measurable && isLive(s, DEFAULT_LIVENESS));

  // Canary FIRST. If this can't prove itself on this fetch, refuse to write a
  // leaderboard at all -- a ranked list built on an unproven instrument is
  // worse than no list, because ranking implies confidence the run hasn't earned.
  const stables = scored.filter((s) => s.stablePair);
  const worstStableIl = stables.length ? Math.max(...stables.map((s) => Math.abs(s.impermanentLossPct))) : null;
  const canaryPassed = worstStableIl !== null && worstStableIl < 1.0;
  if (!canaryPassed) {
    console.error(`CANARY ${stables.length ? 'FAILED' : 'UNPROVEN'} -- refusing to write leaderboard.json`);
    console.error(stables.length
      ? `worst stable |IL| = ${worstStableIl}%, expected <1%`
      : 'no stable/stable pair in this sample');
    process.exit(2);
  }
  console.log(`canary PASS (worst stable |IL| = ${worstStableIl.toFixed(4)}%)`);

  const volatile = scored.filter((s) => !s.stablePair);
  console.log(`${volatile.length} live, non-stable pools scored`);

  // Rank on FULL-RANGE gap -- the most-generous-to-the-pool case, so "honest"
  // here is the hardest bar to fail and "misleading" is the hardest to dodge.
  //
  // First cut sorted signed gap ascending, which put pools where realized beat
  // advertised (a NEGATIVE gap, e.g. WBTC/WETH advertising 4% and returning
  // 11.7%) at the top of "most honest". That is wrong: underselling is not the
  // same claim as accurate, and a leaderboard that rewards it teaches the
  // opposite lesson from the one this repo exists to teach. "Honest" means the
  // advertised number was a good PREDICTOR, in either direction -- rank by
  // |gap|, not signed gap.
  const ranked = volatile
    .filter((s) => s.byRange?.full?.measurable)
    .map((s) => ({
      pair: s.pair,
      poolId: s.pool,
      feeTierPct: s.feeTierPct,
      currentTvlUsd: s.currentTvlUsd,
      advertisedAprPct: s.advertisedAprPct,
      realizedAprPct: s.byRange.full.realizedAprPct,
      gapPts: s.advertisedAprPct - s.byRange.full.realizedAprPct,
      absGapPts: Math.abs(s.advertisedAprPct - s.byRange.full.realizedAprPct),
      misleading: s.byRange.full.misleading,
    }));

  const mostHonest = [...ranked].sort((a, b) => a.absGapPts - b.absGapPts).slice(0, 10);
  const mostMisleading = [...ranked]
    .filter((r) => r.misleading)
    .sort((a, b) => b.gapPts - a.gapPts)
    .slice(0, 10);

  const out = {
    generatedAt: new Date().toISOString(),
    method: 'full-range advertised-vs-realized gap, ranked. Live sample, same canary/liveness gate as the corpus-wide audit.',
    canary: { worstStableIlPct: worstStableIl, passed: true },
    sampleSize: volatile.length,
    mostHonest,
    mostMisleading,
  };
  writeFileSync(new URL('../data/leaderboard.json', import.meta.url), JSON.stringify(out, null, 2));
  console.log(`\nwrote data/leaderboard.json — ${mostHonest.length} honest, ${mostMisleading.length} misleading`);
  console.log('\nMOST HONEST (advertised ~= realized):');
  for (const r of mostHonest.slice(0, 5)) console.log(`  ${r.pair.padEnd(16)} gap ${r.gapPts.toFixed(2)}pts  adv ${r.advertisedAprPct.toFixed(1)}%  realized ${r.realizedAprPct.toFixed(1)}%`);
  console.log('\nMOST MISLEADING (advertised positive, realized negative, biggest gap):');
  for (const r of mostMisleading.slice(0, 5)) console.log(`  ${r.pair.padEnd(16)} gap ${r.gapPts.toFixed(2)}pts  adv ${r.advertisedAprPct.toFixed(1)}%  realized ${r.realizedAprPct.toFixed(1)}%`);
}

main().catch((e) => { console.error('FAILED (error, not a finding):', e.message); process.exit(1); });
