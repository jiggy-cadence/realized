/**
 * concentrated.js — impermanent loss for CONCENTRATED liquidity (Uniswap v3).
 *
 * WHY THIS EXISTS. lib/realized.js shipped `impermanentLossPct(r)`, the constant-product
 * (v2) formula. It is correct only for a FULL-RANGE position. Uniswap v3's entire premise
 * is that LPs concentrate into a band, and inside a band IL is amplified; once price leaves
 * the band the position is 100% converted into the losing asset and the loss stops being
 * "impermanent" at all. Measuring a v3 venue with the v2 formula reports the most generous
 * possible outcome for the pool — which understates the exact defect this project claims to
 * expose. Found 2026-09-07 while looking for the weakest load-bearing assumption.
 *
 * Position is over [p0/w, p0*w], w > 1, normalized to p0 = 1. Liquidity L cancels in the
 * value ratio, so it is set to 1 and never passed in.
 */

/** Value of the LP position at price p, for a symmetric range of half-width factor w. */
export function positionValue(p, w) {
  const sa = Math.sqrt(1 / w);
  const sb = Math.sqrt(w);
  if (p <= 1 / w) return (1 / sa - 1 / sb) * p; // fully in token0
  if (p >= w) return sb - sa;                    // fully in token1
  return 2 * Math.sqrt(p) - sa - p / sb;
}

/** Value of simply holding the same entry basket to price p. */
export function hodlValue(p, w) {
  const sa = Math.sqrt(1 / w);
  const sb = Math.sqrt(w);
  const x0 = 1 - 1 / sb; // token0 amount at p=1
  const y0 = 1 - sa;     // token1 amount at p=1
  return y0 + x0 * p;
}

/**
 * IL for a concentrated position over [1/w, w] at price ratio r.
 * w -> Infinity converges to the v2 constant-product formula at rate O(1/sqrt(w));
 * that convergence is asserted as a canary in test/canary.test.js rather than trusted.
 */
export function concentratedIlPct(r, w) {
  if (r === null || r === undefined || Number.isNaN(r) || r < 0) return null;
  if (!(w > 1)) return null;
  if (r === 0) return -100;
  return (positionValue(r, w) / hodlValue(r, w) - 1) * 100;
}

/**
 * Fee income restated on the SAME basis as IL. IL is a fraction of HODL value at exit
 * (V_lp/V_hodl - 1), but feesUSD/entryTvl is a fraction of ENTRY value. Adding the two
 * directly mixes denominators. LP-vs-HODL is (V_lp + F)/V_hodl - 1 = IL + F/V_hodl, so
 * the fee term is rescaled by V_entry/V_hodl(r). Full range: 2/(1+r). Found 2026-11-17
 * by the review panel; error was largest exactly where IL is (big moves).
 */
export function feeVsHodlPct(feeReturnPct, r, w = 1e8) {
  if (!(r > 0) || !(w > 1)) return null;
  return feeReturnPct * (isFullRange(w) ? 2 / (1 + r) : hodlValue(1, w) / hodlValue(r, w));
}

/** LP-vs-HODL realized return, both terms on the HODL-at-exit basis. */
export function realizedVsHodlPct(feeReturnPct, ilPct, r, w = 1e8) {
  const f = feeVsHodlPct(feeReturnPct, r, w);
  return f === null || ilPct === null ? null : f + ilPct;
}

/**
 * One threshold for "this width is full range, use the v2 formula". RANGES labels full
 * range as w = 1e8, but any w at or above FULL_RANGE_MIN_W is treated the same way by
 * both the fee term here and the IL term in realized.js, so the two never disagree.
 */
export const FULL_RANGE_MIN_W = 1e6;
export const isFullRange = (w) => w >= FULL_RANGE_MIN_W;

/** Did price leave the band? Then the loss is realized, not impermanent. */
export function outOfRange(r, w) {
  return r <= 1 / w || r >= w;
}

/**
 * The ranges we report at. Same discipline as the liveness gates: report the headline at
 * several, and if the finding flips it is a parameter, not a finding.
 * FULL is the v2-equivalent baseline (what the project shipped before 2026-09-07).
 */
export const RANGES = [
  { label: 'tight', w: 1.25, note: 'active LP, rebalanced band' },
  { label: 'moderate', w: 2, note: 'typical managed position' },
  { label: 'wide', w: 4, note: 'passive wide band' },
  { label: 'full', w: 1e8, note: 'full-range = v2-equivalent, the generous baseline' },
];
