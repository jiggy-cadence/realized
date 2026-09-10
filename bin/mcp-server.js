#!/usr/bin/env node
/**
 * realized-lp-mcp — MCP server exposing LP ground truth from The Graph.
 *
 * Tools:
 *   realized_return(poolId, days)  -> what LPs actually earned vs what the UI advertises
 *   audit_pools(limit, gate)       -> corpus-wide audit + canary + sensitivity
 *   explain_gap(poolId)            -> plain-language verdict with the evidence chain
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import {
  gatewayUrl, fetchPool, fetchPoolFrom, fetchTopPools, scorePool, positionRealized, summarize, sensitivity, DEFAULT_LIVENESS,
} from '../lib/realized.js';
import { concentratedIlPct, outOfRange, RANGES } from '../lib/concentrated.js';

const API_KEY = process.env.GRAPH_API_KEY;
const URL = () => gatewayUrl(API_KEY);

const TOOLS = [
  {
    name: 'find_pool',
    description:
      'Look up a pool by token symbols (e.g. "WETH/USDC" or just "WETH") instead of a raw 0x '
      + 'address. Returns candidate pools ranked by TVL with their poolId, ready to pass into '
      + 'realized_return or explain_gap. Use this FIRST -- you should never need to already know '
      + 'a pool address to use this server.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Token symbol or pair, case-insensitive, e.g. "WETH/USDC" or "PEPE"' },
        limit: { type: 'number', description: 'Max candidates to return (default 5)', default: 5 },
      },
      required: ['query'],
    },
  },
  {
    name: 'realized_return',
    description:
      'What LPs ACTUALLY earned in a Uniswap v3 pool over a historical window: fee income minus '
      + 'impermanent loss, from The Graph. Compares against the fees-only APR that DEX UIs advertise '
      + '(which cannot go negative by construction). Returns measurable:false rather than a fake zero '
      + 'when the window cannot be priced.',
    inputSchema: {
      type: 'object',
      properties: {
        poolId: { type: 'string', description: 'Uniswap v3 pool address (0x...)' },
        days: { type: 'number', description: 'Window length in days (default 30)', default: 30 },
        rangeWidthX: {
          type: 'number',
          description: 'Your concentrated-liquidity range as a half-width factor: 1.25 = a tight +/-25% band, '
            + '2 = a typical managed position, 4 = wide, omit for full-range. This MATTERS: v3 IL is amplified '
            + 'inside a band, and if price left your band the loss is realized, not impermanent. Full-range is '
            + 'the most generous case for the pool.',
        },
      },
      required: ['poolId'],
    },
  },
  {
    name: 'position_realized',
    description:
      'What YOU actually made on a SPECIFIC position: this pool, entered on this date, at this '
      + 'concentrated range. Different from realized_return, which reports the average LP outcome '
      + 'over a fixed recent window -- this anchors to an actual entry date, however long ago, and '
      + 'is the tool to use when someone says "I put money into this pool on <date>, what have I '
      + 'made since." Returns measurable:false rather than a fake number if fewer than 2 days of '
      + 'data exist since entry.',
    inputSchema: {
      type: 'object',
      properties: {
        poolId: { type: 'string', description: 'Uniswap v3 pool address (0x...)' },
        entryDate: { type: 'string', description: 'ISO date (YYYY-MM-DD) or unix timestamp (seconds) you entered the position' },
        rangeWidthX: {
          type: 'number',
          description: 'Your concentrated range as a half-width factor: 1.25 tight, 2 typical, 4 wide, '
            + '1e8 or omit for full-range. If price left this band the loss is realized, not impermanent.',
          default: 2,
        },
      },
      required: ['poolId', 'entryDate'],
    },
  },
  {
    name: 'audit_pools',
    description:
      'Audit many live pools at once: how many advertise a positive APR while LPs actually lost money. '
      + 'Includes a self-canary (stable/stable pairs must show ~0 impermanent loss) and a sensitivity '
      + 'table across three liveness gates, so a finding that only exists at one cutoff is visible as a parameter.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many pools to fetch (default 250)', default: 250 },
        days: { type: 'number', default: 30 },
      },
    },
  },
  {
    name: 'explain_gap',
    description: 'Plain-language verdict for one pool with the numbers that produced it.',
    inputSchema: {
      type: 'object',
      properties: { poolId: { type: 'string' }, days: { type: 'number', default: 30 } },
      required: ['poolId'],
    },
  },
];

const GATES = [
  { label: 'loose  (>=20d, $10k 7d vol, $100k TVL)', gate: { minActiveDays: 20, minRecent7dVolumeUsd: 10_000, minTvlUsd: 100_000 } },
  { label: 'mid    (>=25d, $50k 7d vol, $250k TVL)', gate: DEFAULT_LIVENESS },
  { label: 'strict (>=28d, $250k 7d vol, $1M TVL)', gate: { minActiveDays: 28, minRecent7dVolumeUsd: 250_000, minTvlUsd: 1_000_000 } },
];

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

async function findPool({ query: q, limit = 5 }) {
  if (!q || !q.trim()) return { error: 'query is required, e.g. "WETH/USDC" or "PEPE"' };
  const terms = q.toUpperCase().split(/[/\s-]+/).filter(Boolean);
  // Reuse the same top-pools fetch the audit uses -- one code path, no second query shape
  // to drift out of sync with what audit_pools/the app actually see.
  const pools = await fetchTopPools(URL(), { first: 500, minTvlUsd: 10_000 });
  const matches = pools
    .map((p) => ({ p, sym0: (p.token0?.symbol || '').toUpperCase(), sym1: (p.token1?.symbol || '').toUpperCase() }))
    .filter(({ sym0, sym1 }) => terms.every((t) => sym0.includes(t) || sym1.includes(t)))
    .sort((a, b) => Number(b.p.totalValueLockedUSD) - Number(a.p.totalValueLockedUSD))
    .slice(0, limit)
    .map(({ p, sym0, sym1 }) => ({
      poolId: p.id,
      pair: `${sym0}/${sym1}`,
      feeTierPct: Number(p.feeTier) / 10_000,
      tvlUsd: Math.round(Number(p.totalValueLockedUSD)),
    }));
  if (!matches.length) {
    return { query: q, matches: [], note: 'no pool found among the top 500 mainnet pools by TVL for that query' };
  }
  return {
    query: q,
    matches,
    note: 'pass any matches[].poolId into realized_return or explain_gap',
  };
}

async function realizedReturn({ poolId, days = 30, rangeWidthX }) {
  const pool = await fetchPool(URL(), poolId, days);
  if (!pool) return { error: `pool ${poolId} not found in the Uniswap v3 subgraph` };
  const scored = scorePool(pool);
  if (!scored.measurable || !(rangeWidthX > 1)) return scored;
  const il = concentratedIlPct(scored.priceRatio, rangeWidthX);
  const realizedPct = scored.feeReturnPct + il;
  const realizedApr = (realizedPct / scored.windowDays) * 365;
  const left = outOfRange(scored.priceRatio, rangeWidthX);
  return {
    ...scored,
    yourRange: {
      rangeWidthX,
      impermanentLossPct: il,
      realizedReturnPct: realizedPct,
      realizedAprPct: realizedApr,
      outOfRange: left,
      note: left
        ? 'Price LEFT your band during this window. You are fully converted into the losing asset — this loss is realized, not impermanent.'
        : 'Price stayed inside your band for the whole window.',
    },
  };
}

async function positionRealizedTool({ poolId, entryDate, rangeWidthX = 2 }) {
  if (!poolId) return { error: 'poolId is required' };
  if (!entryDate) return { error: 'entryDate is required, e.g. "2026-08-01" or a unix timestamp' };
  let ts;
  if (/^\d+$/.test(String(entryDate))) {
    ts = Number(entryDate);
  } else {
    const d = new Date(entryDate);
    if (Number.isNaN(d.getTime())) return { error: `could not parse entryDate "${entryDate}" as an ISO date or unix timestamp` };
    ts = Math.floor(d.getTime() / 1000);
  }
  const pool = await fetchPoolFrom(URL(), poolId, ts);
  if (!pool) return { error: `pool ${poolId} not found in the Uniswap v3 subgraph` };
  const pos = positionRealized(pool, rangeWidthX);
  if (!pos.measurable) return pos;
  return {
    ...pos,
    verdict: pos.outOfRange
      ? `Price left your +/-${rangeWidthX}x range: realized ${pos.realizedAprPct.toFixed(1)}% annualized, and this loss is LOCKED IN, not impermanent.`
      : `In-range the whole time: realized ${pos.realizedAprPct.toFixed(1)}% annualized (fees ${pos.feeReturnPct.toFixed(2)}% + IL ${pos.impermanentLossPct.toFixed(2)}%).`,
  };
}

async function auditPools({ limit = 250, days = 30 }) {
  const pools = await fetchTopPools(URL(), { first: limit, days });
  const scored = pools.map(scorePool);
  const s = summarize(scored);
  return {
    ...s,
    sensitivity: sensitivity(scored, GATES),
    interpretation: s.canary.passed
      ? `${s.misleadingCount}/${s.counts.liveVolatile} live pools advertise a positive APR while realized return (fees - IL) was negative.`
      : 'CANARY FAILED OR UNPROVEN — do not quote these numbers.',
  };
}

async function explainGap({ poolId, days = 30 }) {
  const r = await realizedReturn({ poolId, days });
  if (r.error || r.measurable === false) return r;
  const verdict = r.misleading
    ? `MISLEADING: advertises ${r.advertisedAprPct.toFixed(1)}% APR, LPs actually realized ${r.realizedAprPct.toFixed(1)}% annualized.`
    : `Consistent: advertised ${r.advertisedAprPct.toFixed(1)}% APR vs realized ${r.realizedAprPct.toFixed(1)}% annualized.`;
  return {
    ...r,
    verdict,
    evidence: [
      `window: ${r.windowDays} days of poolDayData from The Graph`,
      `fees earned: $${Math.round(r.totalFeesUsd).toLocaleString()} on $${Math.round(r.entryTvlUsd).toLocaleString()} entry TVL = ${r.feeReturnPct.toFixed(2)}%`,
      `price ratio ${r.priceRatio.toFixed(4)} -> impermanent loss ${r.impermanentLossPct.toFixed(2)}% (full-range)`,
      `realized = ${r.feeReturnPct.toFixed(2)}% + (${r.impermanentLossPct.toFixed(2)}%) = ${r.realizedReturnPct.toFixed(2)}%`,
      'advertised APR is fees-only and annualized: it has no price term and cannot be negative.',
      r.byRange
        ? `concentrated: tight(+/-1.25x) ${r.byRange.tight?.realizedReturnPct?.toFixed(2)}%${r.byRange.tight?.outOfRange ? ' OUT OF RANGE' : ''}, `
          + `moderate(+/-2x) ${r.byRange.moderate?.realizedReturnPct?.toFixed(2)}%${r.byRange.moderate?.outOfRange ? ' OUT OF RANGE' : ''} `
          + '— full-range is the generous case; real v3 LPs concentrate and eat amplified IL.'
        : '',
    ],
  };
}

const server = new Server({ name: 'realized-lp-mcp', version: '0.1.0' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === 'find_pool') return ok(await findPool(args));
    if (name === 'realized_return') return ok(await realizedReturn(args));
    if (name === 'position_realized') return ok(await positionRealizedTool(args));
    if (name === 'audit_pools') return ok(await auditPools(args));
    if (name === 'explain_gap') return ok(await explainGap(args));
    return ok({ error: `unknown tool ${name}` });
  } catch (e) {
    return ok({ error: String(e.message || e) });
  }
});

await server.connect(new StdioServerTransport());
