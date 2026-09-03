---
name: graph-risk-monitor
description: Check a wallet's on-chain lending position risk (health factor) using The Graph as the live data source. Use when asked to assess liquidation risk, monitor DeFi positions, or check how close a wallet is to liquidation.
---

# Graph Risk Monitor

Given a wallet address, this SKILL fetches its open lending position(s) via The Graph's Subgraph
MCP and returns a plain-English risk verdict with the underlying health factor.

## When to use
- "Is wallet 0x... at risk of liquidation?"
- "What's the health factor on this Aave position?"
- "Monitor this wallet for liquidation risk."

## How to run
```bash
GRAPH_GATEWAY_API_KEY=<key from thegraph.com/studio> node monitor.js <wallet-address>
```
Exits 0 with a verdict on success. Exits 2 with an explicit error if no Gateway API key is set
(no silent fallback to fixture data under the live path). Exits 1 on unexpected errors.

## Output contract
One badge (⚪ no-debt / 🟢 safe / 🟡 watch / 🔴 danger) plus one sentence citing the actual
health factor and the % collateral drawdown that would trigger liquidation — never a bare
number without the reasoning that produced it.

## Data source
The Graph Subgraph MCP (`https://subgraphs.mcp.thegraph.com/sse`) — live Subgraph queries, not
mocked or cached data. See `lib/mcp-client.js` for the exact call shape.
