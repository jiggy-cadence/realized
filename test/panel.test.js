/**
 * Regression checks for the 2026-11-17 review-panel findings. Offline: no Graph key, no network.
 * Run: node test/panel.test.js
 */
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { positionRealized, calendarDaysSpanned } from '../packages/core/src/realized.js';
import { concentratedIlPct, realizedVsHodlPct, feeVsHodlPct, isFullRange, FULL_RANGE_MIN_W } from '../packages/core/src/concentrated.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

let failed = 0;
const check = (name, ok, detail = '') => {
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const near = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;

// --- SKILL.md snippet computes the corrected (same-basis) number ----------------------
{
  const skill = read('SKILL.md');
  const start = skill.indexOf('function il(r, w)');
  const end = skill.indexOf('const realizedApr', start);
  const snippet = skill.slice(start, end);
  check('SKILL.md: retracted formula is gone', !/pool\.fees \+ il\(pool\.r/.test(snippet.replace(/\/\/.*$/gm, '')));
  let worst = 0;
  for (const pool of [{ fees: 0.42, r: 1.37 }, { fees: 3.1, r: 0.55 }, { fees: 1.2, r: 2.6 }, { fees: 0.9, r: 1 }]) {
    const got = new Function('pool', `${snippet}; return realizedPct;`)(pool);
    const want = realizedVsHodlPct(pool.fees, concentratedIlPct(pool.r, 2), pool.r, 2);
    worst = Math.max(worst, Math.abs(got - want));
  }
  check('SKILL.md: snippet equals realizedVsHodlPct at w=2', worst < 1e-9, `worst diff ${worst.toExponential(1)}`);
}

// --- APR annualises by calendar days, not row count -----------------------------------
{
  const day = (i, price) => ({ date: 1756684800 + i * 86400, tvlUSD: '1000000', token0Price: String(price), feesUSD: '1000' });
  const dense = { token0: { symbol: 'A' }, token1: { symbol: 'B' }, poolDayData: Array.from({ length: 30 }, (_, i) => day(i, 1)) };
  const gappy = { ...dense, poolDayData: [0, 3, 9, 14, 20, 29].map((i) => day(i, 1)) };
  const d = positionRealized(dense, 2), g = positionRealized(gappy, 2);
  check('APR: dense series unchanged (rows == calendar days)', d.measurable && d.daysHeld === 30 && d.calendarDaysHeld === 30
    && near(d.realizedAprPct, (d.realizedReturnPct / 30) * 365, 0.02), `apr ${d.realizedAprPct}`);
  check('APR: gappy series annualised over 30 calendar days, not 6 rows', g.measurable && g.daysHeld === 6 && g.calendarDaysHeld === 30
    && near(g.realizedAprPct, (g.realizedReturnPct / 30) * 365, 0.02) && !near(g.realizedAprPct, (g.realizedReturnPct / 6) * 365, 0.02),
  `apr ${g.realizedAprPct} on return ${g.realizedReturnPct}`);
  check('calendarDaysSpanned: ISO dates, either order, and undated rows', calendarDaysSpanned([{ date: '2026-08-01' }, { date: '2026-08-10' }]) === 10
    && calendarDaysSpanned([{ date: '2026-08-10' }, { date: '2026-08-01' }]) === 10 && calendarDaysSpanned([{}, {}, {}]) === 3);
}

// --- one full-range threshold ------------------------------------------------------------
{
  check('full-range threshold is shared', FULL_RANGE_MIN_W === 1e6 && isFullRange(1e6) && isFullRange(1e8) && !isFullRange(999999));
  check('feeVsHodlPct uses the v2 ratio at and above the threshold', near(feeVsHodlPct(1, 1.5, 1e7), 2 / 2.5) && near(feeVsHodlPct(1, 1.5, 1e8), 2 / 2.5));
}

// --- generated page escapes subgraph token symbols ---------------------------------------
{
  const src = read('scripts/build-app.js');
  const raw = src.match(/\$\{(?:shock|r|p|w)\.pair\}/g) || [];
  check('build-app.js: no raw ${x.pair} interpolation left', raw.length === 0, `${raw.length} raw`);
  const m = src.match(/^const escH = (.+);$/m);
  const escH = new Function(`return ${m[1]}`)();
  const out = escH('<img src=x onerror=alert(1)>/"W\'ETH&');
  check('build-app.js: escH neutralises markup and quotes', !/[<>"']/.test(out) && out.includes('&lt;img') && out.includes('&amp;'), out);
  check('build-app.js: inlined DATA cannot close the script tag', /JSON\.stringify\(pools\.pools\)\.replace\(\/<\/g/.test(src));
}

// --- api.js scrubs the Graph key out of 500 bodies ----------------------------------------
{
  const src = read('bin/api.js');
  check('api.js: 500 handler does not return the raw message', !/error: String\(e\.message \|\| e\)/.test(src) && /json\(res, 500, \{ error: safeError\(e\) \}\)/.test(src));
  const body = src.match(/export const safeError = (\(e, key[\s\S]*?\n\});/)[1];
  const safeError = new Function(`return ${body.replace(/process\.env\.GRAPH_API_KEY/, 'undefined').replace(/;\s*$/, '')}`)();
  const msg = 'fetch failed https://gateway.thegraph.com/api/abc123def/subgraphs/id/X';
  check('api.js: safeError redacts the key and the gateway path', !safeError(new Error(msg), 'abc123def').includes('abc123def')
    && !safeError(new Error(msg), undefined).includes('abc123def'), safeError(new Error(msg), undefined));
}

// --- CI cannot pass on a crashed test run ---------------------------------------------------
{
  const yml = read('.github/workflows/test.yml');
  check('CI: pipefail set before the tee pipeline', yml.indexOf('set -o pipefail') > 0 && yml.indexOf('set -o pipefail') < yml.indexOf('| tee test.log'));
}

// --- spike-hunt8: integer-safe LCG, honest header -------------------------------------------
{
  const src = read('scripts/spike-hunt8.js');
  const lcgNext = new Function(`return ${src.match(/^const lcgNext = (.+);$/m)[1]}`)();
  let s = 20260910, b = 20260910n, ok = true;
  for (let i = 0; i < 5000; i++) { s = lcgNext(s); b = (b * 1103515245n + 12345n) & 0x7fffffffn; if (BigInt(s) !== b) { ok = false; break; } }
  check('spike-hunt8: LCG matches exact integer arithmetic for 5000 steps', ok);
  let o = 20260910, e = 20260910n, drift = false;
  for (let i = 0; i < 5000; i++) { o = (o * 1103515245 + 12345) & 0x7fffffff; e = (e * 1103515245n + 12345n) & 0x7fffffffn; if (BigInt(o) !== e) { drift = true; break; } }
  check('spike-hunt8: negative control, the old float multiply does diverge', drift);
  check('spike-hunt8: rnd() stays below 1', /seed \/ 0x80000000/.test(src));
  check('spike-hunt8: header states the real step and the overlap', /STEP by 7 days/.test(src) && /OVERLAP/.test(src) && !/STEP by 15 days so/.test(src));
  check('spike-hunt8: Monte Carlo p uses the +1 correction', /\(better \+ 1\) \/ \(draws \+ 1\)/.test(src));
  check('spike-hunt8: provenance string no longer says "identical to spike-hunt3"', !/identical to spike-hunt3/.test(src));
  for (const i of [5, 6, 7, 8]) {
    const h = read(`scripts/spike-hunt${i}.js`).split('\n');
    check(`spike-hunt${i}: header and Run line name the right file`, h[2].includes(`spike-hunt${i}.js`) && h.some((l) => l.includes(`node scripts/spike-hunt${i}.js`)));
  }
}

if (failed) { console.log(`\n${failed} panel check(s) FAILED`); process.exit(1); }
console.log('\nall panel checks passed');
