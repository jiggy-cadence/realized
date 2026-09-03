# ETHOnline 2026 — The Graph "AI Tooling or AI Use Case" (Net-New pool)

## What we're building
**Risk-monitor agent**: watches a wallet or set of wallets across EVM protocols via The Graph's
Subgraph MCP, and turns raw position data into a plain-language risk read + alert — not just a
dashboard that prints numbers.

Why this shape, specifically:
- It's the "AI Use Case" half of the track ("agents that use The Graph as their live source of
  blockchain data — research assistants, trading agents, **risk monitors**"), named explicitly
  in the prize text. Not guessing at fit.
- It clears "meaningful work with the data: reasoning, decisions, automation... not just printing
  a raw query result" — the deliverable is a risk verdict + reasoning, not a table.
- It's honestly buildable solo in ~10 days: one MCP client, a handful of Subgraph queries
  (lending positions — Aave/Compound-style health factors are the standard "risk" query shape
  across many protocols), a scoring pass, a plain-English summary.
- It reuses skills we already have (the whole alfalfa/insider-daemon stack is "turn on-chain data
  into a verdict, be honest about confidence") without reusing any of its actual code — this has
  to be genuinely net-new per the pool rules.

## Architecture (minimal, judge-runnable)
1. **MCP client** — calls `https://subgraphs.mcp.thegraph.com/sse` with a Gateway API key
   (`Authorization: Bearer <key>`), using `mcp-remote` as the bridge (documented pattern).
2. **Query layer** — given a wallet address, ask the Subgraph MCP to find relevant lending-market
   Subgraphs (it has a "discover top Subgraph deployments by keyword/contract" tool), pull open
   positions: collateral, debt, liquidation threshold.
3. **Reasoning layer** — compute a risk score to a real threshold (health factor / distance to
   liquidation), classify (safe / watch / danger), write a 2-3 sentence plain-English verdict
   with the actual numbers cited, not vibes.
4. **Output** — CLI first (`node monitor.js <wallet>` → verdict), stretch: cron/webhook alert if
   risk crosses a threshold (this is the "automation" the qualification bar wants).

## What's blocked on Jiggy (one thing)
**Subgraph Studio Gateway API key.** Requires connecting a wallet at thegraph.com/studio →
API Keys → Create. That's a wallet-signature action — not something I should do with his wallet
without him present. Everything else below gets built against this being the only missing piece;
the moment the key exists the whole thing goes from scaffolded to live.

## What I build without the key (tonight)
- Repo scaffold, MCP client wiring (works once env var is set)
- Query + reasoning logic against a **recorded real example** (a known Aave position, data taken
  from public block explorers as a placeholder to develop the scoring logic against — swapped for
  live Subgraph MCP calls the moment the key lands; never presented as the live path)
- README + SKILL.md judges can run
- Demo video script

## Non-goals / explicit fit check against qualification requirements
- ❌ Not submitting insider-daemon (no Graph usage in that codebase — checked 09-03).
- ❌ Not printing a raw query result and calling it done — must ship the scoring/verdict layer.
- ✅ Public repo, README/SKILL.md, live Subgraph Studio key at demo time, 2-4 min video.
- Pool: **Net-new (Start Fresh)** — confirmed no usable public repo to extend as of 09-03.
