#!/usr/bin/env node
/**
 * build-corpus.js — regenerate the public ground-truth corpus.
 *
 * This IS the differentiator, not the MCP server. Anyone can wrap a subgraph in
 * natural language. Nobody else publishes a falsifiable, canary-gated table of
 * which live pools actually paid LPs vs which ones only look like they did.
 *
 * Output: data/corpus.json — judges (or anyone) can diff this against the live
 * subgraph themselves. Run: GRAPH_API_KEY=... node scripts/build-corpus.js
 */
import { writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { gatewayUrl, fetchTopPools, scorePool, summarize, sensitivity, DEFAULT_LIVENESS } from '../lib/realized.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = `${__dirname}/../data/corpus.json`;

const GATES = [
  { label: 'loose', gate: { minActiveDays: 20, minRecent7dVolumeUsd: 10_000, minTvlUsd: 100_000 } },
  { label: 'mid', gate: DEFAULT_LIVENESS },
  { label: 'strict', gate: { minActiveDays: 28, minRecent7dVolumeUsd: 250_000, minTvlUsd: 1_000_000 } },
];

async function main() {
  const apiKey = process.env.GRAPH_API_KEY;
  if (!apiKey) {
    console.error('GRAPH_API_KEY is required');
    process.exit(2);
  }
  const url = gatewayUrl(apiKey);
  console.log('fetching pools from The Graph (Uniswap v3 mainnet)...');
  const pools = await fetchTopPools(url, { first: 250, days: 30 });
  console.log(`fetched ${pools.length} pools`);

  const scored = pools.map(scorePool);
  const s = summarize(scored);
  const sens = sensitivity(scored, GATES);

  if (!s.canary.passed) {
    console.error('CANARY FAILED — refusing to publish an untrusted corpus.');
    console.error(JSON.stringify(s.canary, null, 2));
    process.exit(1);
  }

  const corpus = {
    generatedAt: new Date().toISOString(),
    source: 'The Graph — Uniswap v3 mainnet subgraph (5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV)',
    method: 'realized = fee income - impermanent loss over a 30-day poolDayData window; ' +
      'advertised = most recent day fees, annualized on current TVL (the standard DEX-UI formula)',
    canary: s.canary,
    counts: s.counts,
    headline: {
      medianAdvertisedAprPct: s.medianAdvertisedAprPct,
      medianRealizedAprPct: s.medianRealizedAprPct,
      medianGapPts: s.medianGapPts,
      misleadingCount: s.misleadingCount,
      misleadingPct: s.misleadingPct,
    },
    sensitivity: sens,
    worstOffenders: s.worstOffenders,
    allScoredPools: scored.filter((p) => p.measurable),
  };

  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(corpus, null, 2));
  console.log(`\nwrote ${OUT}`);
  console.log(`canary: ${s.canary.passed ? 'PASS' : 'FAIL'} (worst stable |IL| = ${s.canary.worstAbsIlPct?.toFixed(4)}%)`);
  console.log(`headline: ${s.misleadingCount}/${s.counts.liveVolatile} live pools mislead (${s.misleadingPct?.toFixed(0)}%)`);
  console.log('sensitivity:');
  for (const row of sens) console.log(`  ${row.label.padEnd(8)} n=${row.n}  misleading=${row.misleadingPct?.toFixed(0)}%  medGap=${row.medianGapPts?.toFixed(2)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
