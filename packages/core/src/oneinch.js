/**
 * oneinch.js — an INDEPENDENT price source, used to cross-check the one number this whole
 * project stands or falls on.
 *
 * WHY THIS EXISTS. Every realized-return figure we compute is a function of a price ratio:
 * IL is entirely determined by (exit price / entry price). That ratio comes from the Uniswap
 * subgraph's own `token0Price`. So the subgraph is BOTH the fee source and the price source,
 * and a tool whose entire thesis is "the advertised number is wrong" cannot also assume its
 * own single price feed is beyond question. That's the exact circularity we call out in other
 * people's numbers.
 *
 * 1inch's Spot Price API aggregates on-chain prices across DEXes independently of any single
 * pool. We use it as a SECOND opinion on the *current* price: if 1inch and the subgraph agree,
 * our price leg is corroborated; if they diverge past a threshold, we say so rather than
 * reporting a realized number built on a price only one source vouches for.
 *
 * It is deliberately NON-LOAD-BEARING. The product works without it (The Graph remains the
 * source of truth for the historical series RPC cannot provide). This is a confidence layer,
 * and it degrades honestly: no key -> { available:false, reason }, never a fabricated match.
 *
 * Key: process.env.ONEINCH_API_KEY, or ~/.config/cadence-secure/1inch.json {"api_key":"..."}.
 * Free from https://portal.1inch.dev.
 */

const SPOT_BASE = 'https://api.1inch.dev/price/v1.1';

// 1inch chain ids match EVM chain ids; we only map the chains our venues cover.
const CHAIN_IDS = { mainnet: 1, arbitrum: 42161, polygon: 137, base: 8453 };

/**
 * Fetch the spot price of token0 denominated in token1 from 1inch, for comparison with the
 * subgraph's token0Price. Both token addresses are required (the subgraph carries them).
 *
 * Returns one of:
 *   { available:true,  oneInchPrice, subgraphPrice, divergencePct, agrees, threshold }
 *   { available:false, reason }              // no key, unsupported chain, or upstream error
 *
 * Never throws: a price cross-check that crashes the position endpoint would be worse than
 * no cross-check at all.
 */
export async function crossCheckPrice({
  token0,
  token1,
  subgraphPrice,
  chain = 'mainnet',
  apiKey = process.env.ONEINCH_API_KEY,
  thresholdPct = 2,
  timeoutMs = 8000,
} = {}) {
  if (!apiKey) {
    return { available: false, reason: 'no ONEINCH_API_KEY set — cross-check skipped (get a free key at portal.1inch.dev)' };
  }
  const chainId = CHAIN_IDS[chain];
  if (!chainId) return { available: false, reason: `1inch spot price not wired for chain "${chain}"` };
  if (!token0 || !token1) return { available: false, reason: 'token addresses missing from subgraph record' };

  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // 1inch returns USD (or wei-denominated) prices per address; we request both tokens and
    // form the ratio ourselves so the comparison is apples-to-apples with token0Price.
    const url = `${SPOT_BASE}/${chainId}/${token0},${token1}?currency=USD`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (!res.ok) return { available: false, reason: `1inch HTTP ${res.status}` };
    const body = await res.json();
    const p0 = Number(body[token0.toLowerCase()] ?? body[token0]);
    const p1 = Number(body[token1.toLowerCase()] ?? body[token1]);
    if (!(p0 > 0) || !(p1 > 0)) return { available: false, reason: '1inch returned no usable price for this pair' };

    // CONVENTION, verified empirically 2026-09-10 against two pools with OPPOSITE token
    // ordering (USDC/WETH t0=USDC, and WETH/USDT t0=WETH):
    //
    //   subgraph token0Price = price of token0 expressed in token1
    //                        = (USD value of token1) / (USD value of token0)   <-- p1/p0
    //
    // The naive reading is p0/p1, and it is wrong: it returned 0.000405 against a subgraph
    // 2458.08 (exactly the reciprocal), which rendered as a -100% divergence warning on every
    // position. Both orderings agree with p1/p0 to within 0.33%, so this is one convention,
    // not a per-pool flip -- which is why the fix is NOT "detect and invert per pool".
    const oneInchPrice = p1 / p0;
    const sg = Number(subgraphPrice);
    if (!(sg > 0)) {
      return { available: true, oneInchPrice, subgraphPrice: null, divergencePct: null, agrees: null,
        note: 'subgraph price unavailable for comparison; 1inch spot price reported alone' };
    }
    const divergencePct = ((oneInchPrice - sg) / sg) * 100;
    const agrees = Math.abs(divergencePct) <= thresholdPct;
    return {
      available: true,
      source: '1inch Spot Price API v1.1',
      oneInchPrice,
      subgraphPrice: sg,
      divergencePct,
      agrees,
      threshold: thresholdPct,
      note: agrees
        ? `Independent 1inch spot price agrees with the subgraph within ${thresholdPct}% — the price leg of this realized figure is corroborated.`
        : `1inch spot price diverges from the subgraph by ${divergencePct.toFixed(2)}% — treat this realized figure's price leg as unconfirmed.`,
    };
  } catch (e) {
    return { available: false, reason: `1inch cross-check failed: ${String(e.message || e).slice(0, 120)}` };
  } finally {
    clearTimeout(t);
  }
}
