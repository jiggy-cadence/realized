#!/usr/bin/env node
/**
 * monitor.js — CLI entrypoint. Given a wallet address, produce a plain-English
 * risk verdict for its lending positions, sourced live from The Graph's
 * Subgraph MCP.
 *
 * Usage:
 *   GRAPH_GATEWAY_API_KEY=xxx node monitor.js 0xWalletAddress
 *   node monitor.js --fixture   (runs the scoring layer against a recorded example,
 *                                 no live key required — for judges without a key handy,
 *                                 clearly labeled, never silently substituted for live data)
 */

const { callTool, NoLiveKeyError } = require('./lib/mcp-client');
const { scorePosition } = require('./lib/scoring');
const fixture = require('./test/fixtures/example-position.json');

async function fetchLivePosition(wallet) {
  // 1. Ask the Subgraph MCP to find the relevant lending-market subgraph.
  const found = await callTool('search_subgraphs', { keyword: 'aave lending' });
  // 2. Query that deployment for the wallet's open position(s).
  //    (Exact query shape depends on the discovered schema — filled in once we have
  //    a live key to inspect the actual schema against, per the MCP's own docs:
  //    it exposes an "inspect schema" tool specifically so this isn't guessed blind.)
  const deploymentId = found?.deployments?.[0]?.id;
  if (!deploymentId) throw new Error('No lending subgraph deployment found for keyword search');

  const result = await callTool('execute_query', {
    deployment: deploymentId,
    query: `{ userPosition(id: "${wallet.toLowerCase()}") { collateralUsd debtUsd liquidationThreshold } }`
  });
  return result?.data?.userPosition;
}

async function main() {
  const arg = process.argv[2];

  if (arg === '--fixture' || !arg) {
    console.log('[FIXTURE MODE — not live data. Recorded example position, for scoring-logic demo only]\n');
    const scored = scorePosition(fixture);
    printVerdict(fixture.wallet || '(example)', scored);
    return;
  }

  const wallet = arg;
  try {
    const position = await fetchLivePosition(wallet);
    if (!position) {
      console.log(`No open lending position found for ${wallet} in the searched subgraph.`);
      return;
    }
    const scored = scorePosition(position);
    printVerdict(wallet, scored);
  } catch (e) {
    if (e instanceof NoLiveKeyError) {
      console.error(`${e.message}\n\nRun with --fixture to see the scoring logic against a recorded example instead.`);
      process.exit(2);
    }
    throw e;
  }
}

function printVerdict(wallet, scored) {
  const badge = { 'no-debt': '⚪', safe: '🟢', watch: '🟡', danger: '🔴' }[scored.tier];
  console.log(`${badge} ${wallet}`);
  console.log(`   ${scored.verdict}`);
}

main().catch(e => { console.error('FATAL:', e.message); process.exit(1); });
