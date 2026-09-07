#!/usr/bin/env node
/**
 * build-pools.js — compact per-pool payload for the interactive page.
 *
 * The page needs to recompute realized return live as the user drags a range slider. IL is a
 * closed-form function of (priceRatio, rangeWidth), so the browser can do that itself from a
 * tiny payload — no API key in client code, no backend, no rate limit, instant response.
 *
 * We ship only what the math needs: priceRatio, feeReturnPct, advertisedAprPct, plus labels.
 * Everything the page displays is derived from these by the same formula the tests cover.
 *
 * Run: GRAPH_API_KEY=*** node scripts/build-pools.js
 */
import { writeFileSync, mkdirSync, readFileSync } from 'fs';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { scorePool, isLive, DEFAULT_LIVENESS, STABLES } from '../lib/realized.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = `${__dirname}/../data/pools.json`;

const VENUES = {
  'uniswap-v3': {
    mainnet: '5zvR82QoaXYFyDEKLZ9t6v9adgnptxYpKpSbxtgVENFV',
    arbitrum: 'FbCGRftH4a3yZugY7TnbYgPJVEv2LvMT6oF1fxPe9aJM',
    polygon: '3hCPRGf4z88VC5rsBKU5AA9FBBq5nF3jbKJG7VZCbhjm',
    base: '43Hwfi3dJSoGpyas9VwNoDAv55yjgGrPpNSmbQZArzMG',
  },
  aerodrome: { base: 'GENunSHWLBXm59mBSgPzQ8metBEp9YDfdqwFr91Av1UM' },
};

const key = process.env.GRAPH_API_KEY || readFileSync('/tmp/gk.txt', 'utf8').trim();
const gql = async (id, query) => {
  const r = await fetch(`https://gateway.thegraph.com/api/${key}/subgraphs/id/${id}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ query }),
  });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors) throw new Error(JSON.stringify(j.errors).slice(0, 160));
  return j.data;
};

const FIELDS = `id feeTier totalValueLockedUSD token0{symbol} token1{symbol}
  poolDayData(first:30,orderBy:date,orderDirection:desc){date volumeUSD feesUSD tvlUSD token0Price}`;

async function main() {
  const out = [];
  const canaryByVenue = {};

  for (const [dex, chains] of Object.entries(VENUES)) {
    for (const [chain, id] of Object.entries(chains)) {
      process.stdout.write(`${dex}/${chain}: `);
      let pools;
      try {
        const d = await gql(id, `{pools(first:150,orderBy:volumeUSD,orderDirection:desc,where:{totalValueLockedUSD_gt:"250000"}){${FIELDS}}}`);
        pools = d.pools || [];
      } catch (e) { console.log(`FAILED ${e.message.slice(0, 50)}`); continue; }

      const scored = pools.map(scorePool).filter((s) => s.measurable);

      // Same canary discipline as everywhere else: stable/stable pairs must show ~0 IL or this
      // venue's rows are not published. A page that renders unvalidated numbers is the failure.
      const stables = scored.filter((s) => s.stablePair);
      const worst = stables.length ? Math.max(...stables.map((s) => Math.abs(s.impermanentLossPct))) : null;
      const passed = worst !== null && worst < 1.0;
      canaryByVenue[`${dex}/${chain}`] = { stablePairs: stables.length, worstAbsIlPct: worst, passed };
      if (!passed) { console.log(`CANARY UNPROVEN (${stables.length} stable pairs) — venue excluded`); continue; }

      const live = scored.filter((s) => !s.stablePair && isLive(s, DEFAULT_LIVENESS));
      for (const s of live) {
        out.push({
          id: s.pool.slice(0, 10),
          pair: s.pair,
          dex,
          chain,
          fee: s.feeTierPct,
          tvl: Math.round(s.currentTvlUsd),
          r: Number(s.priceRatio.toFixed(6)),      // price ratio over the window
          fees: Number(s.feeReturnPct.toFixed(4)), // fee return %, window
          adv: Number(s.advertisedAprPct.toFixed(3)),
          days: s.windowDays,
        });
      }
      console.log(`${live.length} live pools (canary worst |IL| ${worst.toExponential(1)}%)`);
    }
  }

  out.sort((a, b) => b.tvl - a.tvl);
  const payload = {
    generatedAt: new Date().toISOString(),
    windowDays: 30,
    source: 'The Graph decentralized network',
    note: 'Client recomputes IL from r (price ratio) and the chosen range width using the same '
      + 'closed form as lib/concentrated.js. Only validated venues appear.',
    canaryByVenue,
    pools: out,
  };
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(payload));
  console.log(`\nwrote ${OUT} — ${out.length} pools, ${(JSON.stringify(payload).length / 1024).toFixed(0)} KB`);
}

main().catch((e) => { console.error(e); process.exit(1); });
