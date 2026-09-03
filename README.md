# Graph Risk Monitor

An AI agent that watches lending positions on-chain and turns them into a plain-English risk
verdict — built for **ETHOnline 2026**, The Graph's **"Best AI Tooling or AI Use Case" (Net-New
pool)**.

The Graph is the agent's live source of blockchain data via the
[Subgraph MCP](https://thegraph.com/docs/en/subgraphs/tooling/subgraph-mcp/introduction/):
`https://subgraphs.mcp.thegraph.com/sse`. This is not a dashboard that prints a query result —
the scoring layer computes a real risk metric (health factor) and a threshold-based verdict.

## Why this, why now
Track requirement: *"agents that use The Graph as their live source of blockchain data...
risk monitors"* — named explicitly in the prize description. This is that, built minimally
and honestly rather than padded.

## Quickstart

```bash
npm install
npm test                 # scoring logic, no network required
node monitor.js --fixture   # scoring demo against a recorded example, clearly labeled non-live
GRAPH_GATEWAY_API_KEY=<your key> node monitor.js 0xYourWalletAddress   # live
```

Get a Gateway API key at [thegraph.com/studio](https://thegraph.com/studio) (wallet connect,
free tier available) — this is the one external dependency; without it the tool tells you so
and exits nonzero rather than quietly serving fake data as if it were live.

## Architecture
```
monitor.js          CLI entrypoint — routes to fixture or live path
lib/mcp-client.js   Talks to the Subgraph MCP over the documented mcp-remote bridge
lib/scoring.js      Pure functions: raw position -> health factor -> tier -> plain-English verdict
test/scoring.test.js  Real pass/fail assertions on the scoring logic
```

## Risk model
Standard Aave-style health factor: `(collateral_usd * liquidation_threshold) / debt_usd`.
- `< 1` — already liquidatable
- `1.0 – 1.15` — danger band, one bad move away
- `1.15 – 1.5` — watch
- `>= 1.5` — safe
- no debt — nothing to monitor

Chosen because it's the metric lending protocols themselves publish and judges will recognize,
not an invented score.

## Status (as of ETHOnline build window)
Scoring logic complete and tested. Live MCP wiring implemented against the documented protocol
but not yet run against a real Gateway API key (key creation requires a wallet signature — an
event I don't perform on someone else's behalf). `--fixture` mode exists specifically so the
reasoning layer can be demonstrated and reviewed independent of that one external dependency.

## License
MIT
